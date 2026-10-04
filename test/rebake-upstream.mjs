// The rebake upstream check. Its pure half (scripts/_rebake-upstream.mjs): what a probe
// declares, what a sent request lacks of the bundle, the verdict on each probe, and the
// text of the check. And the runner (scripts/rebake-upstream-check.mjs) with the proxy
// it starts (scripts/_rebake-probe-proxy.mjs), in a staged checkout: the request builder
// and the bundle are the real ones, and dist/proxy.js is a stand-in in front of a local
// upstream stub, so nothing leaves the machine.

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';
import { probeTools, probeBody, carriedBundleTools, missingFromSent, probeBlocked, probeVerdict, summarizeProbes, errorDetail, formatUpstreamCheck, RENEWAL_MARKER } from '../scripts/_rebake-upstream.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const DASH = String.fromCharCode(0x2014);
// A probe as the runner records it: what the proxy answered, and what upstream
// answered each request the proxy sent for it.
const ok = (model) => ({ model, status: 200, claim: 'five_hour', bucket: 'subscription', served: model, upstream: [200] });
const rejected = (model, status = 400) => ({ model, status, claim: '', bucket: 'unknown', served: '', upstream: [status] });
const renewing = (model) => ({ model, status: 401, claim: '', bucket: 'unknown', served: '', blocked: true, upstream: [] });
const unanswered = (model) => ({ model, status: 0, claim: '', bucket: 'unknown', served: '', upstream: [] });
const META = { version: '2.1.289', captured: '2026-10-04T21:27:34.373Z', tools: { carried: 2, total: 3, left: ['advisor'] } };
const def = (name, description) => ({ name, description, input_schema: { type: 'object', properties: { a: { type: 'string' } } } });

header('what a probe declares');
{
  const bundle = { tools: [def('Bash', 'runs'), def('Read', 'reads'), def('mcp__x__y', 'operator tool')] };
  const declared = probeTools(bundle);
  check('every bundled tool by name, without the operator MCP ones', declared.map((t) => t.name).join(',') === 'Bash,Read');
  check('with an empty schema, so the bundled definition is what can match', declared.every((t) => JSON.stringify(t.input_schema) === '{"type":"object","properties":{}}'));
  const body = probeBody('claude-sonnet-5', declared);
  check('the body asks for the model, declares the tools and forbids calling them', body.model === 'claude-sonnet-5' && body.tools === declared && body.tool_choice.type === 'none' && body.max_tokens === 16);

  check('a rebuilt request that carries the bundled definitions is recognised', carriedBundleTools([def('Bash', 'runs'), def('Read', 'reads')], bundle).join(',') === 'Bash,Read');
  check('a tool sent with another description is not counted', carriedBundleTools([def('Bash', 'runs'), def('Read', 'the client wrote this')], bundle).join(',') === 'Bash');
  check('a tool sent with another schema is not counted', carriedBundleTools([{ ...def('Bash', 'runs'), input_schema: { type: 'object', properties: {} } }], bundle).length === 0);
  check('a request with no tools carries none', carriedBundleTools(undefined, bundle).length === 0);
}

header('what a request sent upstream lacks of the bundle');
{
  const bundle = { tools: [def('Bash', 'runs'), def('Read', 'reads'), def('advisor', 'advises')] };
  const whole = { system: [{ type: 'text', text: 'a billing tag' }, { type: 'text', text: 'Before it. THE PROMPT. After it.' }], tools: [def('Bash', 'runs'), def('Read', 'reads')] };
  const expected = { prompt: 'THE PROMPT', declared: ['Bash', 'Read'], bundle };
  check('the prompt in a system block and every declared tool: nothing', missingFromSent(whole, expected).length === 0);
  check('a bundled tool the probe did not declare is not asked for', !whole.tools.some((t) => t.name === 'advisor') && missingFromSent(whole, expected).length === 0);
  check('another prompt is named', missingFromSent({ ...whole, system: [{ type: 'text', text: 'a shorter prompt' }] }, expected).join('|') === 'the bundled system prompt for its model');
  check('a tool sent with other text is counted', missingFromSent({ ...whole, tools: [def('Bash', 'runs'), def('Read', 'the client wrote this')] }, expected).join('|') === 'the bundled definition of 1 of the 2 declared tools');
  check('a request with no tools lacks every declared one', missingFromSent({ system: whole.system }, expected).join('|') === 'the bundled definition of 2 of the 2 declared tools');
  check('a request with neither names both', missingFromSent({ system: [], tools: [] }, expected).length === 2);
  check('a system prompt sent as one string is read', missingFromSent({ system: 'x THE PROMPT y', tools: whole.tools }, expected).length === 0);
  check('a request that could not be read lacks both', missingFromSent({}, expected).length === 2 && missingFromSent(null, expected).length === 2);
  check('a bundle with no prompt for the model is never satisfied', missingFromSent(whole, { ...expected, prompt: '' }).length === 1 && missingFromSent(whole, { ...expected, prompt: undefined }).length === 1);
}

header('whether a probe was stopped by token renewal');
{
  const startup = `[dario] Startup refresh failed for login: token refresh is disabled (${RENEWAL_MARKER}=1)`;
  check('an auth status with the marker logged during the probe is blocked', probeBlocked({ status: 401, logDuringProbe: startup }) === true);
  check('503 and 403 count as auth statuses too', probeBlocked({ status: 503, logDuringProbe: startup }) && probeBlocked({ status: 403, logDuringProbe: startup }));
  check('an upstream rejection is not blocked, even with the marker in the log', probeBlocked({ status: 400, logDuringProbe: startup }) === false);
  check('an auth status with nothing logged during the probe is not blocked', probeBlocked({ status: 401, logDuringProbe: '' }) === false);
  check('a success is never blocked', probeBlocked({ status: 200, logDuringProbe: startup }) === false);
  check('no response is not blocked', probeBlocked({ status: 0, logDuringProbe: startup }) === false);
}

header('one probe');
{
  const kind = (probe) => probeVerdict(probe).kind;
  const why = (probe) => probeVerdict(probe).why;
  check('200 from upstream, billed to the subscription, passes', kind(ok('claude-sonnet-5')) === 'pass');
  check('the fallback subscription bucket passes', kind({ ...ok('m'), bucket: 'subscription_fallback' }) === 'pass');
  check('a served model that differs is not a failure of the bundle', kind({ ...ok('claude-opus-5'), served: 'claude-sonnet-5' }) === 'pass');
  check('200 billed as extra usage fails', kind({ ...ok('m'), bucket: 'extra_usage' }) === 'fail' && why({ ...ok('m'), bucket: 'extra_usage' }) === 'billed to extra_usage');
  check('200 billed to the API fails', kind({ ...ok('m'), bucket: 'api' }) === 'fail');
  check('200 with no readable claim fails', kind({ ...ok('m'), bucket: 'unknown' }) === 'fail');

  check('a request upstream rejected fails and says the status', kind(rejected('m')) === 'fail' && why(rejected('m')) === 'HTTP 400');
  check('403, 404 and 422 from upstream are rejections', [403, 404, 422].every((s) => kind(rejected('m', s)) === 'fail'));
  check('a rejection the proxy recovered from is still a rejection', kind({ ...ok('m'), upstream: [400, 200] }) === 'fail' && why({ ...ok('m'), upstream: [400, 200] }) === 'HTTP 400');
  check('a rejection counts whatever the proxy answered, or did not', kind({ ...unanswered('m'), upstream: [400] }) === 'fail' && kind({ ...renewing('m'), upstream: [403] }) === 'fail');

  check('a probe stopped by token renewal is neither a pass nor a failure', kind(renewing('m')) === 'incomplete' && why(renewing('m')) === 'the access token needed renewing');
  check('upstream refusing the token is not about the bundle', kind(rejected('m', 401)) === 'incomplete' && why(rejected('m', 401)) === 'upstream refused the borrowed token (HTTP 401)');
  check('a rate limit is not about the bundle', kind(rejected('m', 429)) === 'incomplete' && why(rejected('m', 429)) === 'upstream answered HTTP 429');
  check('an upstream failure is not about the bundle', kind(rejected('m', 529)) === 'incomplete' && kind(rejected('m', 500)) === 'incomplete' && kind(rejected('m', 408)) === 'incomplete');
  check('upstream not answering is not about the bundle', kind({ ...rejected('m', 502), upstream: [0] }) === 'incomplete' && why({ ...rejected('m', 502), upstream: [0] }) === 'upstream did not answer');
  check('a rate limit the proxy got past is a pass', kind({ ...ok('m'), upstream: [429, 200] }) === 'pass');

  check('a probe the proxy did not answer is an error, not a failure', kind(unanswered('m')) === 'error' && why(unanswered('m')) === 'the proxy did not answer');
  check('an answer of the proxy with nothing sent upstream is an error', kind({ ...rejected('m', 503), upstream: [] }) === 'error' && why({ ...rejected('m', 503), upstream: [] }) === 'the proxy answered HTTP 503 without sending anything upstream');
  check('a 400 of the proxy with nothing sent upstream is an error too', kind({ ...rejected('m', 400), upstream: [] }) === 'error');
  check('200 with no request recorded upstream is an error', kind({ ...ok('m'), upstream: [] }) === 'error' && kind({ ...ok('m'), upstream: undefined }) === 'error');
  check('an error of the proxy after upstream accepted is an error', kind({ ...rejected('m', 502), upstream: [200] }) === 'error' && why({ ...rejected('m', 502), upstream: [200] }) === 'the proxy answered HTTP 502 after upstream answered HTTP 200');
}

header('the run');
{
  check('every probe passing is a pass', summarizeProbes([ok('a'), ok('b')]) === 'pass');
  check('one rejected probe fails the run', summarizeProbes([ok('a'), rejected('b')]) === 'fail');
  check('no probes is an error, not a verdict', summarizeProbes([]) === 'error');
  check('a completed probe followed by a renewal-blocked one is incomplete', summarizeProbes([ok('a'), renewing('b')]) === 'incomplete');
  check('every probe blocked is incomplete', summarizeProbes([renewing('a'), renewing('b')]) === 'incomplete');
  check('a rate-limited probe leaves the run incomplete', summarizeProbes([ok('a'), rejected('b', 429)]) === 'incomplete');
  check('a rejection stays a failure when a later probe is blocked', summarizeProbes([rejected('a'), renewing('b')]) === 'fail');
  check('a rejection stays a failure when another probe got no answer', summarizeProbes([rejected('a'), unanswered('b')]) === 'fail');
  check('a probe that got no answer makes the run an error, not a failure', summarizeProbes([ok('a'), unanswered('b')]) === 'error' && summarizeProbes([unanswered('a')]) === 'error');
  check('an error outranks incomplete', summarizeProbes([renewing('a'), unanswered('b')]) === 'error');
  check('the error names each probe that could not be run', errorDetail([ok('a'), unanswered('b'), { ...rejected('c', 503), upstream: [] }]) === 'the proxy did not answer (b); the proxy answered HTTP 503 without sending anything upstream (c)');
  check('and says so when there were no probes', errorDetail([]) === 'no probe was run');
}

header('the text of the check');
{
  const results = [ok('claude-opus-4-8'), ok('claude-fable-5'), ok('claude-opus-5'), ok('claude-sonnet-5')];
  const passed = formatUpstreamCheck({ outcome: 'pass', results, ...META }).join('\n');
  check('a pass names the bundle that was checked', passed.includes('Claude Code 2.1.289, captured 2026-10-04T21:27:34.373Z'), passed);
  check('a pass says what each request carried upstream, and which tool it did not', passed.includes("Every request the proxy sent upstream was recorded on its way, and each carried the bundled definitions of 2 of the bundle's 3 tools (not `advisor`, which the request builder does not take from the bundle) and the bundled system prompt for its model."), passed);
  check('a pass says what could not shape the requests', passed.includes('started in code') && passed.includes('no live capture and no live template cache') && passed.includes('`DARIO_*`') && passed.includes('`~/.dario/config.json`'), passed);
  check('a pass lists every model with its bucket', results.every((r) => passed.includes(`| \`${r.model}\` | HTTP 200 | \`five_hour\` (subscription) |`)), passed);
  const everyTool = formatUpstreamCheck({ outcome: 'pass', results, ...META, tools: { carried: 3, total: 3, left: [] } }).join('\n');
  check('with every tool carried there is no exception to name', everyTool.includes("of 3 of the bundle's 3 tools and the bundled system prompt"), everyTool);

  const failed = formatUpstreamCheck({ outcome: 'fail', results: [ok('claude-opus-4-8'), rejected('claude-sonnet-5')], ...META }).join('\n');
  check('a failure says not to merge', failed.includes('Do not merge'), failed);
  check('a failure shows which model and why', failed.includes('| `claude-sonnet-5` | HTTP 400 | unknown | not readable |'), failed);
  check('a failure does not claim acceptance', !failed.includes('and accepted'));
  const overage = formatUpstreamCheck({ outcome: 'fail', results: [{ ...ok('claude-opus-5'), claim: 'overage', bucket: 'extra_usage' }], ...META }).join('\n');
  check('an accepted request billed elsewhere says where', overage.includes('| `claude-opus-5` | HTTP 200, billed to extra_usage | `overage` (extra_usage) | `claude-opus-5` |'), overage);
  const recovered = formatUpstreamCheck({ outcome: 'fail', results: [{ ...ok('claude-opus-5'), upstream: [400, 200] }], ...META }).join('\n');
  check('a rejection the proxy recovered from shows the rejection', recovered.includes('| `claude-opus-5` | HTTP 400 | `five_hour` (subscription) | `claude-opus-5` |'), recovered);
  const failedAndUnanswered = formatUpstreamCheck({ outcome: 'fail', results: [rejected('claude-opus-4-8'), unanswered('claude-fable-5')], ...META }).join('\n');
  check('a failure keeps the row of a probe that could not be run', failedAndUnanswered.includes('| `claude-fable-5` | not run: the proxy did not answer | | |'), failedAndUnanswered);

  const partial = formatUpstreamCheck({ outcome: 'incomplete', results: [ok('claude-opus-4-8'), renewing('claude-fable-5'), rejected('claude-opus-5', 429)], ...META }).join('\n');
  check('incomplete keeps the probe that completed', partial.includes('| `claude-opus-4-8` | HTTP 200 | `five_hour` (subscription) | `claude-opus-4-8` |'), partial);
  check('incomplete says why each other probe did not', partial.includes('| `claude-fable-5` | not completed: the access token needed renewing | | |') && partial.includes('| `claude-opus-5` | not completed: upstream answered HTTP 429 | | |'), partial);
  check('incomplete counts what completed', partial.includes('1 of the 3 requests'), partial);
  check('incomplete does not say nothing was sent', !partial.includes('No request built from'), partial);
  check('incomplete does not claim the run was accepted', !partial.includes('by this run and accepted'), partial);
  const rejectedThenBlocked = [rejected('claude-opus-4-8'), renewing('claude-fable-5')];
  const mixed = formatUpstreamCheck({ outcome: summarizeProbes(rejectedThenBlocked), results: rejectedThenBlocked, ...META }).join('\n');
  check('a rejection before the token ran out is reported as a failure, with both rows', mixed.includes('Do not merge') && mixed.includes('| `claude-opus-4-8` | HTTP 400 |') && mixed.includes('| `claude-fable-5` | not completed'), mixed);
  const noneDone = formatUpstreamCheck({ outcome: 'incomplete', results: [renewing('claude-opus-4-8')], ...META }).join('\n');
  check('incomplete with nothing completed says so', noneDone.includes('none of the 1 requests') && noneDone.includes('That says nothing about the bundle'), noneDone);

  const blocked = formatUpstreamCheck({ outcome: 'blocked', ...META }).join('\n');
  check('blocked says nothing was sent and why', blocked.includes('could not run') && blocked.includes('never renews it') && blocked.includes('No request built from'), blocked);
  const errored = formatUpstreamCheck({ outcome: 'error', detail: 'port 3459 is already in use', ...META }).join('\n');
  check('an error carries its reason and gives no verdict', errored.includes('port 3459 is already in use') && errored.includes('It gives no verdict on the bundle'), errored);
  const strayed = formatUpstreamCheck({ outcome: 'error', results, detail: 'a request the proxy sent upstream for claude-sonnet-5 lacked the bundled system prompt for its model', ...META }).join('\n');
  check('a run whose proxy sent something else is an error, whatever upstream answered', strayed.includes('lacked the bundled system prompt for its model') && strayed.includes('It gives no verdict on the bundle') && !strayed.includes('| Model |') && !strayed.includes('accepted'), strayed);
  check('an error does not say that nothing was sent', !errored.includes('No request built from') && !strayed.includes('No request built from'));
  check('no outcome tells the reader to dispatch the watcher: an open rebake PR is not re-checked', ![passed, failed, partial, blocked, errored, strayed].some((t) => /dispatch/i.test(t)));

  for (const [name, text] of [['pass', passed], ['fail', failed], ['incomplete', partial], ['blocked', blocked], ['error', errored]]) {
    check(`${name}: no em dash`, !text.includes(DASH));
  }
}

if (process.platform === 'win32') {
  console.log('\nthe runner: skipped on win32, it signals process groups');
} else {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { TEMPLATE_BASE_MODEL, VARIANT_FAMILIES } = await import('../dist/live-fingerprint.js');
  const models = [TEMPLATE_BASE_MODEL, ...VARIANT_FAMILIES.map((f) => f.captureModel)];
  const root = mkdtempSync(join(tmpdir(), 'rebake-upstream-runner-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  for (const f of ['rebake-upstream-check.mjs', '_rebake-probe-proxy.mjs', '_rebake-upstream.mjs', '_tracked-process.mjs']) copyFileSync(join(REPO, 'scripts', f), join(root, 'scripts', f));
  cpSync(join(REPO, 'dist'), join(root, 'dist'), { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(root, 'package.json'));
  copyFileSync(join(REPO, 'src', 'cc-template-data.json'), join(root, 'src', 'cc-template-data.json'));
  copyFileSync(join(REPO, 'src', 'cc-template-data.json'), join(root, 'dist', 'cc-template-data.json'));
  const bundle = JSON.parse(readFileSync(join(root, 'src', 'cc-template-data.json'), 'utf8'));
  // The stand-in for dist/proxy.js. It has the real proxy's local key gate, builds
  // each request with the real request builder, and sends it through the fetch it
  // was started with, to the upstream stub. It tells the stub what it was started
  // with. STAND_IN makes it misbehave.
  writeFileSync(join(root, 'dist', 'proxy.js'), `
import { createServer } from 'node:http';
import { buildCCRequest } from './cc-template.js';
export async function startProxy(opts) {
  const key = process.env.DARIO_API_KEY;
  const mode = process.env.STAND_IN ?? '';
  const standIn = {
    env: Object.keys(process.env).filter((name) => /^(DARIO|ANTHROPIC)_/.test(name)).sort(),
    callersKey: key === 'operator-secret',
    options: Object.fromEntries(Object.entries(opts).filter(([, value]) => typeof value !== 'function')),
  };
  createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('{}'); return; }
    if (key && req.headers['x-api-key'] !== key) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    if (mode === 'drops the connection') { req.socket.destroy(); return; }
    if (mode === 'refuses on its own') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
    let text = '';
    for await (const chunk of req) text += chunk;
    const built = buildCCRequest(JSON.parse(text), 'stand-in', { type: 'ephemeral' }, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }).body;
    if (mode === 'sends another prompt') built.system = [{ type: 'text', text: 'another prompt' }];
    if (mode === 'sends the client tools') built.tools = JSON.parse(text).tools;
    const up = await opts.fetchImpl(process.env.STUB_UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ...built, standIn })) });
    res.writeHead(up.status, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-representative-claim': up.headers.get('anthropic-ratelimit-unified-representative-claim') ?? '' });
    res.end(await up.text());
  }).listen(opts.port, opts.host);
}
`);

  // The upstream stub answers as upstream does for subscription traffic, with
  // another status, or not at all.
  let upstreamHits = [];
  let answerWith = 200;
  let onHit = () => {};
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, tools, standIn } = JSON.parse(body);
    upstreamHits.push({ model, tools: (tools ?? []).length, standIn });
    onHit();
    if (answerWith === null) return;
    res.writeHead(answerWith, { 'content-type': 'application/json', ...(answerWith === 200 ? { 'anthropic-ratelimit-unified-representative-claim': 'five_hour' } : {}) });
    res.end(JSON.stringify(answerWith === 200 ? { model } : { type: 'error' }));
  });
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  // PATH holds only Node's directory, so the runner starts the proxy on Node unless Bun sits beside it.
  const envFor = (port, extra) => ({ ...process.env, ...extra, REBAKE_CHECK_PORT: String(port), STUB_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1/messages`, PATH: dirname(process.execPath) });
  const runCheck = async (extra = {}, upstreamAnswers = 200) => {
    upstreamHits = [];
    answerWith = upstreamAnswers;
    const port = await freePort();
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(root, 'scripts', 'rebake-upstream-check.mjs')], { cwd: root, env: envFor(port, extra) });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    return { ...run, port, hits: upstreamHits, report: JSON.parse(readFileSync(join(root, 'upstream-check.json'), 'utf8')) };
  };

  // Each of these changes how a proxy started through the CLI builds or sends a request,
  // or refuses the probes at its local key gate.
  header('the runner, with settings of the caller in its environment');
  {
    const run = await runCheck({ DARIO_API_KEY: 'operator-secret', DARIO_SYSTEM_PROMPT: 'aggressive', DARIO_SKIP_FIELDS: 'tools', DARIO_PASSTHROUGH_BETAS: 'x-1', ANTHROPIC_UPSTREAM_API_KEY: 'sk-of-the-caller' });
    check('exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
    check('every probe reached upstream, once', run.hits.map((h) => h.model).join(',') === models.join(','), JSON.stringify(run.hits.map((h) => h.model)));
    check('no probe was refused by the local key gate, and each has its upstream answer', run.report.outcome === 'pass' && run.report.results.length === models.length && run.report.results.every((r) => r.status === 200 && r.upstream.join(',') === '200'), JSON.stringify(run.report.results));
    const started = run.hits[0]?.standIn ?? { env: [], options: {} };
    check('the proxy saw only the variables the check sets', started.env.join(',') === 'DARIO_API_KEY,DARIO_LIVE_TEMPLATE_CACHE,DARIO_NO_TOKEN_REFRESH' && started.callersKey === false, JSON.stringify(started.env));
    check('the proxy was started with the bundle as its only template and no host state', started.options.noLiveCapture === true && started.options.ledger === false && started.options.keys === false && started.options.host === '127.0.0.1' && started.options.port === run.port, JSON.stringify(started.options));
    check('and with nothing else: the rest is the proxy defaults', Object.keys(started.options).sort().join(',') === 'host,keys,ledger,noLiveCapture,overageGuardNotifyOs,port', Object.keys(started.options).sort().join(','));
    check('the runner found bundled tool definitions that the request builder carries', run.report.tools.carried > 0 && run.report.tools.carried + run.report.tools.left.length === run.report.tools.total && run.report.tools.total === bundle.tools.length, JSON.stringify(run.report.tools));
    check('every request sent upstream carried exactly those tools', run.hits.every((h) => h.tools === run.report.tools.carried), JSON.stringify(run.hits.map((h) => h.tools)));
    check('the text of the check names the bundle it was run on', run.out.includes(`Claude Code ${bundle._version}, captured ${bundle._captured}`), run.out);
  }

  // Upstream accepting a request says nothing about the bundle when the request did
  // not carry the bundle.
  header('the runner, when the proxy sends something other than the bundle');
  {
    const prompt = await runCheck({ STAND_IN: 'sends another prompt' });
    check('another prompt: upstream was reached and answered 200', prompt.hits.length === models.length && prompt.report.results.every((r) => r.status === 200), JSON.stringify(prompt.report.results));
    check('another prompt: the run is an error, not a pass', prompt.code === 1 && prompt.report.outcome === 'error', `exit ${prompt.code}, ${prompt.report.outcome}`);
    check('another prompt: the text says what was missing and gives no verdict', prompt.out.includes('lacked the bundled system prompt for its model') && prompt.out.includes('It gives no verdict on the bundle') && !prompt.out.includes('accepted'), prompt.out);
    const clientTools = await runCheck({ STAND_IN: 'sends the client tools' });
    const n = clientTools.report.tools.carried;
    check('the tools as the client declared them: an error that counts them', clientTools.code === 1 && clientTools.report.outcome === 'error' && clientTools.out.includes(`lacked the bundled definition of ${n} of the ${n} declared tools`), clientTools.out);
  }

  // Only an answer from upstream is a verdict on the bundle.
  header('the runner, by what upstream answered');
  {
    const refused = await runCheck({}, 400);
    check('upstream rejects every request: a failure, with the rejections on record', refused.code === 1 && refused.report.outcome === 'fail' && refused.report.results.every((r) => r.upstream.join(',') === '400'), JSON.stringify(refused.report.results));
    check('the failure names the status and says not to merge', refused.out.includes('Do not merge') && models.every((m) => refused.out.includes(`| \`${m}\` | HTTP 400 |`)), refused.out);
    const limited = await runCheck({}, 429);
    check('upstream rate-limits every request: incomplete, not a failure', limited.code === 1 && limited.report.outcome === 'incomplete' && limited.out.includes('not completed: upstream answered HTTP 429') && !limited.out.includes('Do not merge'), limited.out);
    const dropped = await runCheck({ STAND_IN: 'drops the connection' });
    check('the proxy drops every probe: nothing reaches upstream', dropped.hits.length === 0 && dropped.report.results.every((r) => r.status === 0 && r.upstream.length === 0), JSON.stringify(dropped.report.results));
    check('and the run is an error, not a failure', dropped.code === 1 && dropped.report.outcome === 'error' && dropped.out.includes('the proxy did not answer') && dropped.out.includes('It gives no verdict on the bundle') && !dropped.out.includes('Do not merge') && !dropped.out.includes('| Model |'), dropped.out);
    const own = await runCheck({ STAND_IN: 'refuses on its own' });
    check('the proxy answers 503 on its own: an error that says so', own.hits.length === 0 && own.code === 1 && own.report.outcome === 'error' && own.out.includes('the proxy answered HTTP 503 without sending anything upstream'), own.out);
  }

  // A cancelled job signals the runner while a probe waits on upstream. A proxy
  // left on the port would make the next run report the port taken.
  header('the runner, ended by a signal while a probe waits on upstream');
  {
    const scratch = join(root, 'tmp');
    mkdirSync(scratch);
    upstreamHits = [];
    answerWith = null;
    const reached = new Promise((resolve) => { onHit = () => resolve('reached'); });
    const port = await freePort();
    const child = spawn(process.execPath, [join(root, 'scripts', 'rebake-upstream-check.mjs')], { cwd: root, env: envFor(port, { TMPDIR: scratch }), stdio: 'ignore' });
    const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code)));
    const answers = async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        return true;
      } catch {
        return false;
      }
    };
    const gone = async () => {
      for (let i = 0; i < 50 && await answers(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      return !(await answers());
    };
    const first = await Promise.race([reached, ended]);
    check('a probe reaches upstream and waits', first === 'reached', String(first));
    check('the proxy answers and the scratch directory is there', await answers() && readdirSync(scratch).length === 1, readdirSync(scratch).join(','));
    child.kill('SIGTERM');
    const how = await ended;
    check('the runner ends by the signal', how === 'SIGTERM', String(how));
    check('its proxy is gone from the port', await gone());
    check('its scratch directory is gone', readdirSync(scratch).length === 0, readdirSync(scratch).join(','));
  }
  upstream.closeAllConnections();
  upstream.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

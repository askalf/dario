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
import { probeTools, probeBody, carriedBundleTools, missingFromSent, probeVerdict, summarizeProbes, errorDetail, formatUpstreamCheck } from '../scripts/_rebake-upstream.mjs';

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
const answered = (model, status) => ({ model, status, claim: '', bucket: 'unknown', served: '', upstream: [status] });
const rejected = (model) => answered(model, 400);
// The proxy answered on its own: nothing was sent upstream.
const refused = (model, status = 503) => ({ model, status, claim: '', bucket: 'unknown', served: '', upstream: [] });
// ...with its marker for seats inside a rate-limit window, or with /health reporting no seat.
const held = (model) => ({ ...refused(model, 429), marker: 'pool_parked' });
const seatless = (model) => ({ ...refused(model, 503), seatless: true });
const unanswered = (model) => refused(model, 0);
const HELD = 'not sent: the proxy answered HTTP 429 itself, with every seat for the model inside a rate-limit window';
const NO_SEAT = 'not sent: the proxy answered HTTP 503 itself and reported no seat it could serve from';
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
  check('403, 404 and 422 from upstream are rejections', [403, 404, 422].every((s) => kind(answered('m', s)) === 'fail'));
  check('a rejection is a verdict even when the proxy then did not answer', kind({ ...unanswered('m'), upstream: [400] }) === 'fail');

  // The proxy sends a request again on another seat after a refused token or a rate
  // limit, and changed after upstream refused part of it. The last answer is the verdict.
  check('a request accepted on a second seat after a refused token passes', kind({ ...ok('m'), upstream: [403, 200] }) === 'pass' && kind({ ...ok('m'), upstream: [401, 200] }) === 'pass');
  check('a request accepted after the proxy dropped what upstream refused passes', kind({ ...ok('m'), upstream: [400, 200] }) === 'pass');
  check('a rate limit the proxy got past is a pass', kind({ ...ok('m'), upstream: [429, 200] }) === 'pass');
  check('a request rejected on the second try fails with that status', kind({ ...answered('m', 400), upstream: [429, 400] }) === 'fail' && why({ ...answered('m', 400), upstream: [429, 400] }) === 'HTTP 400');
  check('a request rate-limited on the second try is unjudged, whatever came first', kind({ ...answered('m', 429), upstream: [403, 429] }) === 'incomplete' && kind({ ...answered('m', 429), upstream: [400, 429] }) === 'incomplete');

  check('upstream refusing the token is not about the bundle', kind(answered('m', 401)) === 'incomplete' && why(answered('m', 401)) === 'upstream refused the borrowed token (HTTP 401)');
  check('a rate limit is not about the bundle', kind(answered('m', 429)) === 'incomplete' && why(answered('m', 429)) === 'upstream answered HTTP 429');
  check('an upstream failure is not about the bundle', kind(answered('m', 529)) === 'incomplete' && kind(answered('m', 500)) === 'incomplete' && kind(answered('m', 408)) === 'incomplete');
  check('upstream not answering is not about the bundle', kind({ ...answered('m', 502), upstream: [0] }) === 'incomplete' && why({ ...answered('m', 502), upstream: [0] }) === 'upstream did not answer');
  check('the proxy\'s marker on an answer that came from upstream changes nothing', kind({ ...answered('m', 429), marker: 'rate_limited' }) === 'incomplete' && kind({ ...rejected('m'), marker: 'pool_parked' }) === 'fail');

  check('a probe the proxy did not answer is an error, not a failure', kind(unanswered('m')) === 'error' && why(unanswered('m')) === 'the proxy did not answer');
  check('and stays one whatever upstream answered, short of a rejection', [[429], [401], [529], [0], [200], [429, 200]].every((upstream) => kind({ ...unanswered('m'), upstream }) === 'error'));
  check('saying what upstream had answered', why({ ...unanswered('m'), upstream: [429] }) === 'the proxy did not answer after upstream answered HTTP 429' && why({ ...unanswered('m'), upstream: [0] }) === 'the proxy did not answer after upstream did not answer');
  check('200 with no request recorded upstream is an error', kind({ ...ok('m'), upstream: [] }) === 'error' && kind({ ...ok('m'), upstream: undefined }) === 'error');
  check('200 that the last upstream answer does not account for is an error', kind({ ...ok('m'), upstream: [429] }) === 'error' && why({ ...ok('m'), upstream: [429] }) === 'the proxy answered HTTP 200 after upstream answered HTTP 429' && why({ ...ok('m'), upstream: [200, 0] }) === 'the proxy answered HTTP 200 after upstream did not answer');
  check('an error of the proxy after upstream accepted is an error', kind({ ...answered('m', 502), upstream: [200] }) === 'error' && why({ ...answered('m', 502), upstream: [200] }) === 'the proxy answered HTTP 502 after upstream answered HTTP 200');
}

// The proxy answers a probe itself, with nothing sent upstream, when no seat can
// take it. Two things say so: the marker on that answer, and /health afterwards.
header('a probe the proxy answered itself');
{
  const kind = (probe) => probeVerdict(probe).kind;
  const why = (probe) => probeVerdict(probe).why;
  check('with neither sign of a missing seat, it is an error', kind(refused('m')) === 'error' && why(refused('m')) === 'the proxy answered HTTP 503 without sending anything upstream');
  check('whatever its status', kind(refused('m', 400)) === 'error' && kind(refused('m', 429)) === 'error' && kind(refused('m', 500)) === 'error');
  check('with the marker for seats inside a rate-limit window, it is unjudged', kind(held('m')) === 'incomplete' && why(held('m')) === HELD);
  check('the marker for every provider being rate-limited counts the same', kind({ ...refused('m', 429), marker: 'all-providers-rate-limited' }) === 'incomplete');
  check('with /health reporting no seat, it is unjudged', kind(seatless('m')) === 'incomplete' && why(seatless('m')) === NO_SEAT);
  check('another marker is not about a seat', kind({ ...refused('m', 400), marker: 'model_unroutable' }) === 'error' && kind({ ...refused('m', 503), marker: 'credential_rejected' }) === 'error');
  check('neither sign turns a probe that got no answer into anything but an error', kind({ ...unanswered('m'), marker: 'pool_parked', seatless: true }) === 'error');
  check('nor a 200 with no request recorded', kind({ ...ok('m'), upstream: [], marker: 'pool_parked', seatless: true }) === 'error');
}

header('the run');
{
  check('every probe passing is a pass', summarizeProbes([ok('a'), ok('b')]) === 'pass');
  check('one rejected probe fails the run', summarizeProbes([ok('a'), rejected('b')]) === 'fail');
  check('no probes is an error, not a verdict', summarizeProbes([]) === 'error');
  check('a rate-limited probe leaves the run incomplete', summarizeProbes([ok('a'), answered('b', 429)]) === 'incomplete');
  check('a rate limit, then the proxy holding the rest back: incomplete, not an error', summarizeProbes([answered('a', 429), held('b'), held('c')]) === 'incomplete');
  check('a refused token, then a proxy with no seat left: incomplete', summarizeProbes([ok('a'), answered('b', 401), seatless('c')]) === 'incomplete');
  check('a proxy with no seat from the first probe on: incomplete', summarizeProbes([seatless('a'), seatless('b')]) === 'incomplete');
  check('a rejection stays a failure when later probes were not sent', summarizeProbes([answered('a', 403), seatless('b')]) === 'fail');
  check('a rejection stays a failure when another probe got no answer', summarizeProbes([rejected('a'), unanswered('b')]) === 'fail');
  check('a probe that got no answer makes the run an error, not a failure', summarizeProbes([ok('a'), unanswered('b')]) === 'error' && summarizeProbes([unanswered('a')]) === 'error');
  check('an answer of the proxy that is not about a seat makes the run an error, even after a rate limit', summarizeProbes([answered('a', 429), refused('b', 503)]) === 'error');
  check('an error outranks incomplete', summarizeProbes([answered('a', 529), unanswered('b')]) === 'error');
  check('the error names each probe that could not be run', errorDetail([ok('a'), unanswered('b'), refused('c')]) === 'the proxy did not answer (b); the proxy answered HTTP 503 without sending anything upstream (c)');
  check('and leaves out the ones the proxy held back for want of a seat', errorDetail([answered('a', 429), held('b'), seatless('c'), unanswered('d')]) === 'the proxy did not answer (d)');
  check('and says so when there were no probes', errorDetail([]) === 'no probe was run');
}

header('the text of the check');
{
  const results = [ok('claude-opus-4-8'), ok('claude-fable-5'), ok('claude-opus-5'), ok('claude-sonnet-5')];
  const passed = formatUpstreamCheck({ outcome: 'pass', results, ...META }).join('\n');
  check('a pass names the bundle that was checked', passed.includes('Claude Code 2.1.289, captured 2026-10-04T21:27:34.373Z'), passed);
  check('a pass says how many of the bundle\'s tools each probe declared, and which it did not', passed.includes('Each probe declared 2 of the 3 tools in the bundle by name (not `advisor`, which the request builder does not take from the bundle).'), passed);
  check('a pass says what the recorded requests carried', passed.includes('Every `/v1/messages` request the proxy sent upstream was recorded on its way, and each carried the bundled definitions of those tools and the bundled system prompt for its model.'), passed);
  check('a pass says what could not shape the requests', passed.includes('started in code') && passed.includes('no live capture and no live template cache') && passed.includes('`DARIO_*`') && passed.includes('`~/.dario/config.json`'), passed);
  check('a pass lists every model with its bucket', results.every((r) => passed.includes(`| \`${r.model}\` | HTTP 200 | \`five_hour\` (subscription) |`)), passed);
  check('a pass in which nothing was sent twice does not speak of it', !passed.includes('more than once'));
  const everyTool = formatUpstreamCheck({ outcome: 'pass', results, ...META, tools: { carried: 3, total: 3, left: [] } }).join('\n');
  check('with every tool declared there is no exception to name', everyTool.includes('Each probe declared all 3 tools in the bundle by name. Every'), everyTool);
  const resent = formatUpstreamCheck({ outcome: 'pass', results: [ok('claude-opus-4-8'), { ...ok('claude-opus-5'), upstream: [403, 200] }], ...META }).join('\n');
  check('a request the proxy sent twice shows both answers', resent.includes('| `claude-opus-5` | HTTP 200 after HTTP 403 | `five_hour` (subscription) | `claude-opus-5` |') && resent.includes('| `claude-opus-4-8` | HTTP 200 | '), resent);
  check('and the text says that the last answer is the one judged', resent.includes('Where the proxy sent a request more than once, the row gives every answer and the last one is judged.'), resent);

  const failed = formatUpstreamCheck({ outcome: 'fail', results: [ok('claude-opus-4-8'), rejected('claude-sonnet-5')], ...META }).join('\n');
  check('a failure says not to merge', failed.includes('Do not merge'), failed);
  check('a failure shows which model and why', failed.includes('| `claude-sonnet-5` | HTTP 400 | unknown | not readable |'), failed);
  check('a failure does not claim acceptance', !failed.includes('and accepted'));
  const overage = formatUpstreamCheck({ outcome: 'fail', results: [{ ...ok('claude-opus-5'), claim: 'overage', bucket: 'extra_usage' }], ...META }).join('\n');
  check('an accepted request billed elsewhere says where', overage.includes('| `claude-opus-5` | HTTP 200, billed to extra_usage | `overage` (extra_usage) | `claude-opus-5` |'), overage);

  // Every row of a request the proxy sent more than once gives every answer, whatever the verdict.
  const tries = [
    { ...answered('claude-opus-4-8', 400), upstream: [429, 400] },
    { ...answered('claude-fable-5', 429), upstream: [403, 429] },
    { ...unanswered('claude-opus-5'), upstream: [429] },
    { ...ok('claude-sonnet-5'), claim: 'overage', bucket: 'extra_usage', upstream: [429, 200] },
  ];
  const tried = formatUpstreamCheck({ outcome: summarizeProbes(tries), results: tries, ...META }).join('\n');
  check('a rejection on a later try shows what came before it', tried.includes('| `claude-opus-4-8` | HTTP 400 after HTTP 429 | unknown | not readable |'), tried);
  check('an unjudged last answer shows the answer before it', tried.includes('| `claude-fable-5` | not completed: upstream answered HTTP 429 after HTTP 403 | | |'), tried);
  check('a probe the proxy left unanswered shows what upstream had answered', tried.includes('| `claude-opus-5` | not run: the proxy did not answer after upstream answered HTTP 429 | | |'), tried);
  check('an accepted request billed elsewhere shows the answer before it', tried.includes('| `claude-sonnet-5` | HTTP 200 after HTTP 429, billed to extra_usage |'), tried);
  check('and the run is a failure that says the last answer is judged', tried.includes('Do not merge') && tried.includes('the last one is judged'), tried);

  const limited = [ok('claude-opus-4-8'), answered('claude-fable-5', 429), held('claude-opus-5'), seatless('claude-sonnet-5')];
  const partial = formatUpstreamCheck({ outcome: summarizeProbes(limited), results: limited, ...META }).join('\n');
  check('incomplete keeps the probe that completed', partial.includes('| `claude-opus-4-8` | HTTP 200 | `five_hour` (subscription) | `claude-opus-4-8` |'), partial);
  check('incomplete says why each other probe did not', partial.includes('| `claude-fable-5` | not completed: upstream answered HTTP 429 | | |') && partial.includes(`| \`claude-opus-5\` | not completed: ${HELD} | | |`) && partial.includes(`| \`claude-sonnet-5\` | not completed: ${NO_SEAT} | | |`), partial);
  check('incomplete counts what completed', partial.includes('1 of the 4 requests'), partial);
  check('incomplete does not claim the run was accepted, or failed', !partial.includes('by this run and accepted') && !partial.includes('Do not merge'), partial);
  const rejectedThenSeatless = [answered('claude-opus-4-8', 403), seatless('claude-fable-5')];
  const mixed = formatUpstreamCheck({ outcome: summarizeProbes(rejectedThenSeatless), results: rejectedThenSeatless, ...META }).join('\n');
  check('a rejection is reported as a failure, with the row of the probe that was not sent', mixed.includes('Do not merge') && mixed.includes('| `claude-opus-4-8` | HTTP 403 |') && mixed.includes('| `claude-fable-5` | not completed: not sent'), mixed);
  const noneDone = formatUpstreamCheck({ outcome: 'incomplete', results: [seatless('claude-opus-4-8'), seatless('claude-fable-5')], ...META }).join('\n');
  check('incomplete with nothing completed says so', noneDone.includes('none of the 2 requests') && noneDone.includes('That says nothing about the bundle') && noneDone.includes(`not completed: ${NO_SEAT}`), noneDone);

  const errored = formatUpstreamCheck({ outcome: 'error', detail: 'port 3459 is already in use', ...META }).join('\n');
  check('an error carries its reason and gives no verdict', errored.includes('port 3459 is already in use') && errored.includes('It gives no verdict on the bundle'), errored);
  const strayed = formatUpstreamCheck({ outcome: 'error', results, detail: 'a request the proxy sent upstream for claude-sonnet-5 lacked the bundled system prompt for its model', ...META }).join('\n');
  check('a run whose proxy sent something else is an error, whatever upstream answered', strayed.includes('lacked the bundled system prompt for its model') && strayed.includes('It gives no verdict on the bundle') && !strayed.includes('| Model |') && !strayed.includes('accepted'), strayed);
  check('no outcome tells the reader to dispatch the watcher: an open rebake PR is not re-checked', ![passed, failed, partial, errored, strayed].some((t) => /dispatch/i.test(t)));

  for (const [name, text] of [['pass', passed], ['resent', resent], ['fail', failed], ['tried', tried], ['incomplete', partial], ['error', errored]]) {
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
  // with. STAND_IN makes it misbehave, or behave as the real proxy does around a
  // seat: send again after a 403, hold probes back with the pool_parked marker
  // once a 429 has parked its seat, and answer 503 on /health and to every probe
  // when no seat can serve.
  writeFileSync(join(root, 'dist', 'proxy.js'), `
import { createServer } from 'node:http';
import { buildCCRequest } from './cc-template.js';
export async function startProxy(opts) {
  const key = process.env.DARIO_API_KEY;
  const mode = process.env.STAND_IN ?? '';
  if (mode === 'exits at startup') {
    console.log('[dario] Startup refresh failed for login: token refresh is disabled (DARIO_NO_TOKEN_REFRESH=1)');
    process.exit(1);
  }
  const standIn = {
    env: Object.keys(process.env).filter((name) => /^(DARIO|ANTHROPIC)_/.test(name)).sort(),
    callersKey: key === 'operator-secret',
    options: Object.fromEntries(Object.entries(opts).filter(([, value]) => typeof value !== 'function')),
  };
  const json = { 'content-type': 'application/json' };
  let parked = false;
  let served = 0;
  const noSeat = () => mode === 'has no seat' || (mode === 'loses its seat after one probe' && served > 0);
  createServer(async (req, res) => {
    if (req.url === '/health') {
      if (mode === 'has no account') { res.writeHead(503, json); res.end(JSON.stringify({ status: 'degraded', oauth: 'none' })); return; }
      if (noSeat()) { res.writeHead(503, json); res.end(JSON.stringify({ status: 'degraded', oauth: 'broken', expiresIn: 'all tokens expired' })); return; }
      res.writeHead(200, json); res.end('{"status":"ok","oauth":"healthy"}'); return;
    }
    if (key && req.headers['x-api-key'] !== key) { res.writeHead(401, json); res.end('{"error":"unauthorized"}'); return; }
    if (mode === 'drops the connection') { req.socket.destroy(); return; }
    if (mode === 'refuses on its own') { res.writeHead(503, json); res.end('{}'); return; }
    if (noSeat()) { res.writeHead(503, json); res.end('{"error":"No accounts available in pool"}'); return; }
    if (parked) { res.writeHead(429, { ...json, 'x-dario-upstream-rejection': 'pool_parked' }); res.end('{}'); return; }
    let text = '';
    for await (const chunk of req) text += chunk;
    const built = buildCCRequest(JSON.parse(text), 'stand-in', { type: 'ephemeral' }, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }).body;
    if (mode === 'sends another prompt') built.system = [{ type: 'text', text: 'another prompt' }];
    if (mode === 'sends the client tools') built.tools = JSON.parse(text).tools;
    const send = () => opts.fetchImpl(process.env.STUB_UPSTREAM, { method: 'POST', headers: json, body: new TextEncoder().encode(JSON.stringify({ ...built, standIn })) });
    let up = await send();
    if (mode === 'sends again after a 403' && up.status === 403) { await up.text(); up = await send(); }
    if (mode === 'parks its seat on a 429' && up.status === 429) parked = true;
    served += 1;
    res.writeHead(up.status, { ...json, 'anthropic-ratelimit-unified-representative-claim': up.headers.get('anthropic-ratelimit-unified-representative-claim') ?? '' });
    res.end(await up.text());
  }).listen(opts.port, opts.host);
}
`);

  // The upstream stub answers as upstream does for subscription traffic, with
  // another status, or not at all. `answerWith` is a status, null for silence,
  // or a function of the model and of how many requests for it came before.
  let upstreamHits = [];
  let answerWith = 200;
  let onHit = () => {};
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, tools, standIn } = JSON.parse(body);
    const before = upstreamHits.filter((h) => h.model === model).length;
    upstreamHits.push({ model, tools: (tools ?? []).length, standIn });
    onHit();
    if (answerWith === null) return;
    const status = typeof answerWith === 'function' ? answerWith(model, before) : answerWith;
    res.writeHead(status, { 'content-type': 'application/json', ...(status === 200 ? { 'anthropic-ratelimit-unified-representative-claim': 'five_hour' } : {}) });
    res.end(JSON.stringify(status === 200 ? { model } : { type: 'error' }));
  });
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  // PATH holds only Node's directory, so the runner starts the proxy on Node unless Bun sits beside it.
  const envFor = (port, extra) => ({ ...process.env, ...extra, REBAKE_CHECK_PORT: String(port), STUB_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1/messages`, PATH: dirname(process.execPath) });
  // `out` is the text of the check, which the watcher publishes. `err` is what goes to the job log.
  const runCheck = async (extra = {}, upstreamAnswers = 200) => {
    upstreamHits = [];
    answerWith = upstreamAnswers;
    const port = await freePort();
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(root, 'scripts', 'rebake-upstream-check.mjs')], { cwd: root, env: envFor(port, extra) });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    return { ...run, port, hits: upstreamHits, report: JSON.parse(readFileSync(join(root, 'upstream-check.json'), 'utf8')) };
  };

  // Each of these changes how a proxy started through the CLI builds or sends a request,
  // or refuses the probes at its local key gate.
  header('the runner, with settings of the caller in its environment');
  {
    const run = await runCheck({ DARIO_API_KEY: 'operator-secret', DARIO_SYSTEM_PROMPT: 'aggressive', DARIO_SKIP_FIELDS: 'tools', DARIO_PASSTHROUGH_BETAS: 'x-1', ANTHROPIC_UPSTREAM_API_KEY: 'sk-of-the-caller' });
    check('exits 0', run.code === 0, `exit ${run.code}: ${run.out}${run.err}`);
    check('every probe reached upstream, once', run.hits.map((h) => h.model).join(',') === models.join(','), JSON.stringify(run.hits.map((h) => h.model)));
    check('no probe was refused by the local key gate, and each has its upstream answer', run.report.outcome === 'pass' && run.report.results.length === models.length && run.report.results.every((r) => r.status === 200 && r.upstream.join(',') === '200'), JSON.stringify(run.report.results));
    const started = run.hits[0]?.standIn ?? { env: [], options: {} };
    check('the proxy saw only the variables the check sets', started.env.join(',') === 'DARIO_API_KEY,DARIO_LIVE_TEMPLATE_CACHE,DARIO_NO_TOKEN_REFRESH' && started.callersKey === false, JSON.stringify(started.env));
    check('the proxy was started with the bundle as its only template and no host state', started.options.noLiveCapture === true && started.options.ledger === false && started.options.keys === false && started.options.host === '127.0.0.1' && started.options.port === run.port, JSON.stringify(started.options));
    check('and with nothing else: the rest is the proxy defaults', Object.keys(started.options).sort().join(',') === 'host,keys,ledger,noLiveCapture,overageGuardNotifyOs,port', Object.keys(started.options).sort().join(','));
    check('the runner found bundled tool definitions that the request builder carries', run.report.tools.carried > 0 && run.report.tools.carried + run.report.tools.left.length === run.report.tools.total && run.report.tools.total === bundle.tools.length, JSON.stringify(run.report.tools));
    check('every request sent upstream carried exactly those tools', run.hits.every((h) => h.tools === run.report.tools.carried), JSON.stringify(run.hits.map((h) => h.tools)));
    check('the text of the check names the bundle it was run on', run.out.includes(`Claude Code ${bundle._version}, captured ${bundle._captured}`), run.out);
    check('and how many of the bundle\'s tools each probe declared', run.out.includes(`Each probe declared ${run.report.tools.carried === run.report.tools.total ? `all ${run.report.tools.total}` : `${run.report.tools.carried} of the ${run.report.tools.total}`} tools in the bundle by name`), run.out);
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
    const refusedAll = await runCheck({}, 400);
    check('upstream rejects every request: a failure, with the rejections on record', refusedAll.code === 1 && refusedAll.report.outcome === 'fail' && refusedAll.report.results.every((r) => r.upstream.join(',') === '400'), JSON.stringify(refusedAll.report.results));
    check('the failure names the status and says not to merge', refusedAll.out.includes('Do not merge') && models.every((m) => refusedAll.out.includes(`| \`${m}\` | HTTP 400 |`)), refusedAll.out);
    const limited = await runCheck({}, 429);
    check('upstream rate-limits every request: incomplete, not a failure', limited.code === 1 && limited.report.outcome === 'incomplete' && limited.out.includes('not completed: upstream answered HTTP 429') && !limited.out.includes('Do not merge'), limited.out);
    const dropped = await runCheck({ STAND_IN: 'drops the connection' });
    check('the proxy drops every probe: nothing reaches upstream', dropped.hits.length === 0 && dropped.report.results.every((r) => r.status === 0 && r.upstream.length === 0), JSON.stringify(dropped.report.results));
    check('and the run is an error, not a failure', dropped.code === 1 && dropped.report.outcome === 'error' && dropped.out.includes('the proxy did not answer') && dropped.out.includes('It gives no verdict on the bundle') && !dropped.out.includes('Do not merge') && !dropped.out.includes('| Model |'), dropped.out);
    const again = await runCheck({ STAND_IN: 'sends again after a 403' }, (model, before) => (before === 0 ? 403 : 200));
    check('a 403 then a 200 for every probe: a pass, with both answers on record', again.code === 0 && again.report.outcome === 'pass' && again.hits.length === 2 * models.length && again.report.results.every((r) => r.upstream.join(',') === '403,200'), JSON.stringify(again.report.results));
    check('the text shows both answers and says which is judged', models.every((m) => again.out.includes(`| \`${m}\` | HTTP 200 after HTTP 403 |`)) && again.out.includes('the last one is judged'), again.out);
  }

  // The proxy answers a probe itself when no seat can take it. Its marker and its
  // /health say so. An answer of its own with neither is a fault of the check.
  header('the runner, when the proxy answers a probe itself');
  {
    const own = await runCheck({ STAND_IN: 'refuses on its own' });
    check('503 from a proxy that reports itself healthy: an error that says so', own.hits.length === 0 && own.code === 1 && own.report.outcome === 'error' && own.out.includes('the proxy answered HTTP 503 without sending anything upstream'), own.out);
    const parked = await runCheck({ STAND_IN: 'parks its seat on a 429' }, 429);
    check('a 429 on the first probe, then the proxy holding the rest back: one request upstream', parked.hits.length === 1 && parked.report.results[0].upstream.join(',') === '429' && parked.report.results.slice(1).every((r) => r.status === 429 && r.upstream.length === 0 && r.marker === 'pool_parked'), JSON.stringify(parked.report.results));
    check('the run is incomplete, not an error', parked.code === 1 && parked.report.outcome === 'incomplete', `exit ${parked.code}, ${parked.report.outcome}`);
    check('the text gives the reason for each probe', parked.out.includes(`| \`${models[0]}\` | not completed: upstream answered HTTP 429 | | |`) && models.slice(1).every((m) => parked.out.includes(`| \`${m}\` | not completed: ${HELD} | | |`)), parked.out);
    const lost = await runCheck({ STAND_IN: 'loses its seat after one probe' });
    check('a seat lost after the first probe: one request upstream, the rest asked of /health', lost.hits.length === 1 && lost.report.results[0].status === 200 && lost.report.results.slice(1).every((r) => r.status === 503 && r.upstream.length === 0 && r.seatless === true), JSON.stringify(lost.report.results));
    check('the run is incomplete, and keeps the probe that completed', lost.code === 1 && lost.report.outcome === 'incomplete' && lost.out.includes(`| \`${models[0]}\` | HTTP 200 |`) && models.slice(1).every((m) => lost.out.includes(`| \`${m}\` | not completed: ${NO_SEAT} | | |`)), lost.out);
  }

  // A borrowed token inside its expiry margin: the proxy comes up, answers 503 on
  // /health and has no seat for any probe. That is the state of the credential,
  // so the next run tries again. A proxy that does not come up, or has no account
  // at all, is a fault of the check.
  header('the runner, when its proxy is not healthy');
  {
    const noSeat = await runCheck({ STAND_IN: 'has no seat' });
    check('no seat from the start: the probes are sent to the proxy, and none goes upstream', noSeat.hits.length === 0 && noSeat.report.results.length === models.length && noSeat.report.results.every((r) => r.status === 503 && r.seatless === true), JSON.stringify(noSeat.report.results));
    check('the run is incomplete, not an error', noSeat.code === 1 && noSeat.report.outcome === 'incomplete' && noSeat.out.includes(`none of the ${models.length} requests`) && noSeat.out.includes(`not completed: ${NO_SEAT}`), noSeat.out);
    const noAccount = await runCheck({ STAND_IN: 'has no account', REBAKE_CHECK_HEALTH_TRIES: '2' });
    check('no account at all: an error, with no probe sent', noAccount.code === 1 && noAccount.report.outcome === 'error' && noAccount.report.results.length === 0 && noAccount.out.includes('the proxy did not become healthy in 2 checks a second apart'), noAccount.out);
    const down = await runCheck({ STAND_IN: 'exits at startup' });
    check('a proxy that exits: an error', down.code === 1 && down.report.outcome === 'error' && down.hits.length === 0, `exit ${down.code}, ${down.report.outcome}`);
    check('the text says the proxy exited and gives no verdict', down.out.includes('the proxy exited before it became healthy') && down.out.includes('It gives no verdict on the bundle'), down.out);
    check('the proxy\'s log is in the job log and not in the text', down.err.includes('token refresh is disabled') && !down.out.includes('token refresh is disabled') && !down.out.includes('DARIO_NO_TOKEN_REFRESH'), down.out);
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

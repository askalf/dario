// The verdict and the PR text of the rebake upstream check (scripts/_rebake-upstream.mjs),
// and the runner (scripts/rebake-upstream-check.mjs) run in a staged checkout whose
// dist/cli.js is a stand-in proxy in front of a local upstream stub.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeVerdict, summarizeProbes, formatUpstreamCheck } from '../scripts/_rebake-upstream.mjs';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const ok = (model) => ({ model, status: 200, claim: 'five_hour', bucket: 'subscription', served: model });
const META = { version: '2.1.289', captured: '2026-10-04T21:27:34.373Z' };

header('one probe');
{
  check('200 billed to the subscription passes', probeVerdict(ok('claude-sonnet-5')).ok === true);
  check('the fallback subscription bucket passes', probeVerdict({ status: 200, bucket: 'subscription_fallback' }).ok === true);
  check('a rejected request fails and says the status', probeVerdict({ status: 400, bucket: 'unknown' }).why === 'HTTP 400');
  check('200 billed as extra usage fails', probeVerdict({ status: 200, bucket: 'extra_usage' }).ok === false);
  check('200 billed to the API fails', probeVerdict({ status: 200, bucket: 'api' }).ok === false);
  check('200 with no readable claim fails', probeVerdict({ status: 200, bucket: 'unknown' }).ok === false);
  check('a served model that differs is not a failure of the bundle',
    probeVerdict({ ...ok('claude-opus-5'), served: 'claude-sonnet-5' }).ok === true);
}

header('the run');
{
  const renewing = (model) => ({ model, status: 401, claim: '', bucket: 'unknown', served: '', blocked: true });
  check('a probe stopped by token renewal is neither a pass nor a failure', probeVerdict(renewing('claude-opus-5')).ok === false && probeVerdict(renewing('claude-opus-5')).incomplete === true);
  check('a completed probe followed by a renewal-blocked one is incomplete, not a pass', summarizeProbes([ok('claude-opus-4-8'), renewing('claude-fable-5')]) === 'incomplete');
  check('an upstream rejection stays a failure when a later probe is blocked', summarizeProbes([{ ...ok('claude-opus-4-8'), status: 400 }, renewing('claude-fable-5')]) === 'fail');
  check('every probe blocked is incomplete', summarizeProbes([renewing('claude-opus-4-8'), renewing('claude-fable-5')]) === 'incomplete');
  check('every probe passing is a pass', summarizeProbes([ok('claude-opus-4-8'), ok('claude-sonnet-5')]) === 'pass');
  check('one failing probe fails the run', summarizeProbes([ok('claude-opus-4-8'), { ...ok('claude-sonnet-5'), status: 400 }]) === 'fail');
  check('no probes is not a pass', summarizeProbes([]) === 'fail');
}

header('the text for the PR');
{
  const results = [ok('claude-opus-4-8'), ok('claude-fable-5'), ok('claude-opus-5'), ok('claude-sonnet-5')];
  const passed = formatUpstreamCheck({ outcome: 'pass', results, ...META }).join('\n');
  check('a pass names the bundle that was checked', passed.includes('Claude Code 2.1.289, captured 2026-10-04T21:27:34.373Z'), passed);
  check('a pass says the bundle was the only template', passed.includes('`--no-live-capture`') && passed.includes('without `--passthrough`'));
  check('a pass lists every model with its bucket', results.every((r) => passed.includes(`| \`${r.model}\` | HTTP 200 | \`five_hour\` (subscription) |`)), passed);

  const failed = formatUpstreamCheck({ outcome: 'fail', results: [ok('claude-opus-4-8'), { model: 'claude-sonnet-5', status: 400, claim: '', bucket: 'unknown', served: '' }], ...META }).join('\n');
  check('a failure says not to merge', failed.includes('Do not merge'), failed);
  check('a failure shows which model and why', failed.includes('| `claude-sonnet-5` | HTTP 400 | unknown | not readable |'), failed);
  const overage = formatUpstreamCheck({ outcome: 'fail', results: [{ model: 'claude-opus-5', status: 200, claim: 'overage', bucket: 'extra_usage', served: 'claude-opus-5' }], ...META }).join('\n');
  check('an accepted request billed elsewhere says where', overage.includes('| `claude-opus-5` | HTTP 200, billed to extra_usage | `overage` (extra_usage) | `claude-opus-5` |'), overage);
  const silent = formatUpstreamCheck({ outcome: 'fail', results: [{ model: 'claude-opus-5', status: 0, claim: '', bucket: 'unknown', served: '' }], ...META }).join('\n');
  check('a request that got no answer says so', silent.includes('| `claude-opus-5` | no response | unknown | not readable |'), silent);
  check('a failure does not claim acceptance', !failed.includes('and accepted'));

  const renewing = (model) => ({ model, status: 401, claim: '', bucket: 'unknown', served: '', blocked: true });
  const partial = formatUpstreamCheck({ outcome: 'incomplete', results: [ok('claude-opus-4-8'), renewing('claude-fable-5')], ...META }).join('\n');
  check('incomplete keeps the probe that completed', partial.includes('| `claude-opus-4-8` | HTTP 200 | `five_hour` (subscription) | `claude-opus-4-8` |'), partial);
  check('incomplete names the probe that did not', partial.includes('| `claude-fable-5` | not completed: the access token needed renewing | | |'), partial);
  check('incomplete counts what completed', partial.includes('1 of the 2 requests'), partial);
  check('incomplete does not say nothing was sent', !partial.includes('No request built from'), partial);
  check('incomplete does not claim the run was accepted', !partial.includes('by this run and accepted'), partial);
  const rejectedThenBlocked = [{ model: 'claude-opus-4-8', status: 400, claim: '', bucket: 'unknown', served: '' }, renewing('claude-fable-5')];
  const mixed = formatUpstreamCheck({ outcome: summarizeProbes(rejectedThenBlocked), results: rejectedThenBlocked, ...META }).join('\n');
  check('a rejection before the token ran out is reported as a failure, with both rows', mixed.includes('Do not merge') && mixed.includes('| `claude-opus-4-8` | HTTP 400 |') && mixed.includes('| `claude-fable-5` | not completed'), mixed);
  const noneDone = formatUpstreamCheck({ outcome: 'incomplete', results: [renewing('claude-opus-4-8')], ...META }).join('\n');
  check('incomplete with nothing completed says so', noneDone.includes('none of the 1 requests') && noneDone.includes('That says nothing about the bundle'), noneDone);

  const blocked = formatUpstreamCheck({ outcome: 'blocked', ...META }).join('\n');
  check('blocked says nothing was sent and why', blocked.includes('could not run') && blocked.includes('never renews it') && blocked.includes('No request built from'), blocked);

  const errored = formatUpstreamCheck({ outcome: 'error', detail: 'port 3459 is already in use', ...META }).join('\n');
  check('an error carries its reason', errored.includes('port 3459 is already in use'), errored);

  for (const [name, text] of [['pass', passed], ['fail', failed], ['incomplete', partial], ['blocked', blocked], ['error', errored]]) {
    check(`${name}: no em dash`, !text.includes('—'));
  }
}

header('the runner borrows the credential read-only');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rebake-upstream-check.mjs'), 'utf8');
  check('the proxy is started with token refresh disabled', src.includes("DARIO_NO_TOKEN_REFRESH: '1'"));
  check('the proxy is started as itself, not through the relaunching wrapper', src.includes("DARIO_NO_BUN: '1'") && src.includes('startTracked('));
  check('the proxy never spawns Claude Code', src.includes("'--no-live-capture'"));
  check('a live template cache on the host is not read', src.includes('DARIO_LIVE_TEMPLATE_CACHE'));
  check('the proxy is not started in passthrough mode', !/'--passthrough'|'--thin'/.test(src));
  check('a mid-run renewal marks the probe, it does not replace the results', src.includes('const blocked = status !== 200 && needsRenewal();') && src.includes('finish(summarizeProbes(results), results);'));
}

// The proxy's local gate rejects a request whose key is not DARIO_API_KEY before
// anything goes upstream. A caller's own DARIO_API_KEY must not turn every probe
// into a 401 that reads as a bundle failure.
header('the runner with DARIO_API_KEY set in its environment');
if (process.platform === 'win32') {
  console.log('  skipped on win32: the runner signals process groups');
} else {
  const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
  const root = mkdtempSync(join(tmpdir(), 'rebake-upstream-runner-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist'));
  for (const f of ['rebake-upstream-check.mjs', '_rebake-upstream.mjs', '_tracked-process.mjs']) copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
  const bundleText = JSON.stringify({ _version: '2.1.289', _captured: '2026-10-04T21:27:34.373Z' }) + '\n';
  writeFileSync(join(root, 'src', 'cc-template-data.json'), bundleText);
  writeFileSync(join(root, 'dist', 'cc-template-data.json'), bundleText);
  writeFileSync(join(root, 'dist', 'live-fingerprint.js'), "export const TEMPLATE_BASE_MODEL = 'claude-opus-4-8';\nexport const VARIANT_FAMILIES = [{ captureModel: 'claude-sonnet-5' }];\n");
  writeFileSync(join(root, 'dist', 'analytics.js'), "export function billingBucketFromClaim(claim) { return claim === 'five_hour' ? 'subscription' : 'unknown'; }\n");
  // A stand-in proxy: the same local key gate as the real one, then the request
  // goes to the upstream stub.
  writeFileSync(join(root, 'dist', 'cli.js'), `
import { createServer } from 'node:http';
const port = Number(process.argv.find((a) => a.startsWith('--port=')).slice(7));
const key = process.env.DARIO_API_KEY;
createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('{}'); return; }
  if (key && req.headers['x-api-key'] !== key) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const up = await fetch(process.env.STUB_UPSTREAM, { method: 'POST', body });
  res.writeHead(up.status, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-representative-claim': up.headers.get('anthropic-ratelimit-unified-representative-claim') ?? '' });
  res.end(await up.text());
}).listen(port, '127.0.0.1');
`);

  const upstreamHits = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model } = JSON.parse(body);
    upstreamHits.push(model);
    res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' });
    res.end(JSON.stringify({ model }));
  });
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const proxyPort = await freePort();

  const run = await new Promise((resolve) => {
    // PATH holds only Node's directory, so the runner finds no Bun and starts the stand-in on Node.
    const env = { ...process.env, DARIO_API_KEY: 'operator-secret', REBAKE_CHECK_PORT: String(proxyPort), STUB_UPSTREAM: `http://127.0.0.1:${upstreamPort}/`, PATH: dirname(process.execPath) };
    const child = spawn(process.execPath, [join(root, 'scripts', 'rebake-upstream-check.mjs')], { cwd: root, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  upstream.close();

  check('exits 0', run.code === 0, `exit ${run.code}: ${run.out}`);
  check('every probe reached upstream', upstreamHits.join(',') === 'claude-opus-4-8,claude-sonnet-5', upstreamHits.join(','));
  const report = JSON.parse(readFileSync(join(root, 'upstream-check.json'), 'utf8'));
  check('no probe was refused by the local key gate', report.outcome === 'pass' && report.results.every((r) => r.status === 200), JSON.stringify(report));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * The browser request guard through a real proxy with a scripted upstream.
 *
 * The first case is the reported attack as a browser sends it: a `no-cors`
 * POST from another site, `Content-Type: text/plain`, at an unkeyed loopback
 * proxy. Before the guard dario parsed the body as JSON and forwarded it with
 * the operator's OAuth token; the upstream call counter is the proof it no
 * longer does. The rest pin what must keep working: SDK and curl requests,
 * the dashboard's own same-origin calls, the trusted CORS origin, and a keyed
 * proxy reached by a tunnel hostname.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
// stdout, not console.log: console is captured below to keep proxy logs quiet.
const say = (line) => process.stdout.write(line + '\n');
const check = (name, cond, detail) => {
  if (cond) { say(`  OK ${name}`); pass++; }
  else { say(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT_KEY = 'root-secret-for-the-browser-guard-test';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-browser-guard-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_API_KEY; delete process.env.DARIO_CORS_ORIGIN;
delete process.env.DARIO_CODEX_BASE_URL; delete process.env.DARIO_ANALYTICS_TOKEN;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

let upstreamMessages = 0;
const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (String(url).includes('/v1/messages')) upstreamMessages++;
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const { startProxy } = await import('../dist/proxy.js');
const proxyOpts = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false };

async function boot() {
  const port = await freePort();
  await startProxy({ ...proxyOpts, port });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/livez`); break; } catch { await sleep(100); } }
  return port;
}

// node:http, not fetch, so Host and Origin go out exactly as written.
function send(port, { method = 'GET', path = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port, method, path, headers: h, setHost: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const MESSAGE = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'CSRF probe' }] });
const post = (port, headers, path = '/v1/messages', body = MESSAGE) => send(port, { method: 'POST', path, headers, body });

out('=== unkeyed loopback proxy: the reported attack ===');
const A = await boot();
{
  const before = upstreamMessages;
  let r = await post(A, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'content-type': 'text/plain' });
  check('cross-site text/plain POST to /v1/messages is 403', r.status === 403, `${r.status} ${r.body}`);
  check('…and the body says how to allow a real browser client', r.body.includes('DARIO_CORS_ORIGIN'), r.body);
  r = await post(A, { origin: 'https://attacker.example', 'content-type': 'text/plain' });
  check('same POST from a browser without Sec-Fetch-Site is 403', r.status === 403, `${r.status} ${r.body}`);
  r = await post(A, { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' });
  check('Sec-Fetch-Site cross-site with no Origin is 403', r.status === 403, r.status);
  r = await post(A, { origin: 'null', 'content-type': 'text/plain' });
  check('Origin null is 403', r.status === 403, r.status);
  r = await post(A, { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' });
  check('another localhost port (same-site) is 403', r.status === 403, r.status);
  r = await post(A, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, '/v1/chat/completions');
  check('cross-site POST to /v1/chat/completions is 403', r.status === 403, r.status);
  check('none of them reached upstream', upstreamMessages === before, upstreamMessages - before);

  r = await post(A, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, '/admin/resume', '');
  check('cross-site POST /admin/resume is 403', r.status === 403, `${r.status} ${r.body}`);
}

out('=== unkeyed loopback proxy: DNS rebinding ===');
{
  const before = upstreamMessages;
  let r = await send(A, { headers: { host: `attacker.example:${A}`, 'sec-fetch-site': 'same-origin' } });
  check('a rebound page reading /health is 403', r.status === 403, `${r.status} ${r.body}`);
  check('…and the body names the fix', r.body.includes('DARIO_API_KEY'), r.body);
  r = await post(A, { host: `attacker.example:${A}`, origin: `http://attacker.example:${A}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  check('a rebound page POSTing /v1/messages is 403', r.status === 403, r.status);
  r = await post(A, { host: `attacker.example:${A}`, origin: `http://attacker.example:${A}`, 'content-type': 'application/json' });
  check('…also from a browser without Sec-Fetch-Site (Origin equals Host)', r.status === 403, r.status);
  r = await send(A, { path: '/accounts', headers: { host: `attacker.example:${A}`, 'sec-fetch-site': 'same-origin', authorization: 'Bearer anything' } });
  check('a made-up Authorization header does not get it past', r.status === 403, r.status);
  check('none of them reached upstream', upstreamMessages === before, upstreamMessages - before);
}

out('=== unkeyed loopback proxy: what keeps working ===');
{
  let before = upstreamMessages;
  let r = await post(A, { 'content-type': 'application/json' });
  check('SDK-style POST (no Origin, no Sec-Fetch-Site) is served', r.status === 200, `${r.status} ${r.body}`);
  check('…and reached upstream', upstreamMessages === before + 1, upstreamMessages - before);
  r = await post(A, { 'content-type': 'text/plain' });
  check('a non-browser text/plain POST (Node fetch default) is still served', r.status === 200, r.status);
  r = await post(A, { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' });
  check('Node fetch\'s Sec-Fetch-Mode alone is not judged', r.status === 200, r.status);
  r = await send(A, { headers: { host: `attacker.example:${A}` } });
  check('curl with a custom Host (no browser headers) is not judged', r.status === 200, r.status);

  r = await send(A, { path: '/analytics/ui', headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } });
  check('typing the dashboard URL loads it', r.status === 200, r.status);
  r = await send(A, { path: '/analytics/ui', headers: { host: `localhost:${A}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  check('following a link to the dashboard from another site loads it (GET)', r.status === 200, r.status);
  r = await post(A, { origin: `http://127.0.0.1:${A}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, '/admin/resume', '');
  check('the dashboard\'s own POST /admin/resume is served', r.status === 200, `${r.status} ${r.body}`);
  r = await post(A, { host: `localhost:${A}`, origin: `http://localhost:${A}`, 'content-type': 'application/json' });
  check('same-origin POST from a browser without Sec-Fetch-Site is served', r.status === 200, r.status);
  r = await send(A, { headers: { host: `dario.localhost:${A}`, 'sec-fetch-site': 'same-origin' } });
  check('a *.localhost name is served', r.status === 200, r.status);
  r = await send(A, { headers: { host: `[::1]:${A}`, 'sec-fetch-site': 'same-origin' } });
  check('an IPv6 literal Host is served', r.status === 200, r.status);
  r = await send(A, { method: 'OPTIONS', path: '/v1/messages', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' } });
  check('preflight is unchanged (204, own origin only)', r.status === 204, r.status);
}

out('=== unkeyed proxy with DARIO_CORS_ORIGIN ===');
process.env.DARIO_CORS_ORIGIN = 'https://app.example';
const B = await boot();
{
  let r = await post(B, { origin: 'https://app.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' });
  check('the configured origin is served cross-site', r.status === 200, `${r.status} ${r.body}`);
  r = await post(B, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' });
  check('any other origin is still 403', r.status === 403, r.status);
  r = await send(B, { headers: { host: 'app.example', 'sec-fetch-site': 'same-origin' } });
  check('the configured origin\'s host is served as a Host', r.status === 200, r.status);
  r = await send(B, { headers: { host: 'other.example', 'sec-fetch-site': 'same-origin' } });
  check('another hostname is still 403', r.status === 403, r.status);
}

out('=== keyed proxy behind a tunnel hostname ===');
process.env.DARIO_API_KEY = ROOT_KEY;
const C = await boot();
{
  const tunnel = { host: 'dario.tunnel.example', origin: 'https://dario.tunnel.example', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  let r = await post(C, { ...tunnel, 'x-api-key': ROOT_KEY });
  check('a keyed request on a tunnel hostname is served (no Host list needed)', r.status === 200, `${r.status} ${r.body}`);
  r = await post(C, tunnel);
  check('the same request without the key is 401, not 403', r.status === 401, r.status);
  r = await post(C, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', 'x-api-key': ROOT_KEY });
  check('a cross-site POST is 403 even carrying the key', r.status === 403, r.status);
  r = await post(C, { origin: 'https://app.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', 'x-api-key': ROOT_KEY });
  check('the configured origin with the key is served', r.status === 200, r.status);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail) out(log.slice(-20).join('\n'));
process.exit(fail === 0 ? 0 : 1);

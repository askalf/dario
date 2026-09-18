#!/usr/bin/env node
/**
 * /metrics, the read-only analytics token, and the dashboard routes, through
 * a real proxy with a scripted upstream (dario#1341).
 *
 * The property under test is the gate: the analytics token opens EXACTLY the
 * read-only surfaces and nothing else. A token that also let a request
 * through would be a second API key with a friendlier name.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT_KEY = 'root-secret-for-the-test';
const ANALYTICS_TOKEN = 'read-only-analytics-token';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-analytics-token-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_ANALYTICS_TOKEN = ANALYTICS_TOKEN;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
    },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const { startProxy } = await import('../dist/proxy.js');
const proxyOpts = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false };

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
await startProxy({ ...proxyOpts, port: PORT });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const get = (path, headers = {}) => fetch(`${BASE}${path}`, { headers });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

out('=== keyed proxy: the token opens the read-only surfaces only ===');
{
  let r = await get('/analytics');
  check('/analytics with no credential is 401', r.status === 401, r.status);
  r = await get('/analytics', bearer(ANALYTICS_TOKEN));
  check('/analytics with the analytics token is 200', r.status === 200, r.status);
  const body = await r.json();
  check('…and carries queue + lifetime', body.queue && 'lifetime' in body, Object.keys(body));
  r = await get('/analytics', { 'x-api-key': ROOT_KEY });
  check('/analytics with the root key still works', r.status === 200, r.status);
  r = await get('/analytics', bearer('wrong'));
  check('/analytics with a wrong token is 401', r.status === 401, r.status);

  r = await get('/metrics', bearer(ANALYTICS_TOKEN));
  check('/metrics with the analytics token is 200', r.status === 200, r.status);
  check('…as Prometheus text', (r.headers.get('content-type') || '').startsWith('text/plain; version=0.0.4'), r.headers.get('content-type'));
  const text = await r.text();
  check('…with the info gauge and queue gauges', text.includes('dario_info{version=') && text.includes('dario_queue_active 0'), text.slice(0, 200));
  r = await get('/metrics');
  check('/metrics with no credential is 401', r.status === 401, r.status);

  r = await get('/analytics/ledger', bearer(ANALYTICS_TOKEN));
  check('/analytics/ledger with the token is 200', r.status === 200, r.status);
  r = await get('/analytics/donuts.svg', bearer(ANALYTICS_TOKEN));
  check('/analytics/donuts.svg with the token is 200 svg', r.status === 200 && (r.headers.get('content-type') || '').startsWith('image/svg+xml'), `${r.status} ${r.headers.get('content-type')}`);
  r = await get('/analytics/view', bearer(ANALYTICS_TOKEN));
  check('/analytics/view with the token is 200 html', r.status === 200 && (r.headers.get('content-type') || '').startsWith('text/html'), `${r.status} ${r.headers.get('content-type')}`);
  const view = await r.text();
  check('…rendering the stats grid', view.includes('class="stats"'), view.slice(0, 200));
  r = await get('/analytics/view');
  check('/analytics/view with no credential is 401', r.status === 401, r.status);
}

out('=== the shell is open, and carries nothing ===');
{
  const r = await get('/analytics/ui');
  check('/analytics/ui needs no credential', r.status === 200, r.status);
  const html = await r.text();
  check('…is html', (r.headers.get('content-type') || '').startsWith('text/html') && html.startsWith('<!doctype html>'));
  check('…and contains no numbers, token or key', !html.includes(ANALYTICS_TOKEN) && !html.includes(ROOT_KEY) && !html.includes('dario_info'));
}

out('=== the token must NOT grant anything else ===');
{
  let r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(ANALYTICS_TOKEN) },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
  });
  check('POST /v1/messages with the analytics token is 401', r.status === 401, r.status);
  r = await get('/accounts', bearer(ANALYTICS_TOKEN));
  check('GET /accounts with the analytics token is 401', r.status === 401, r.status);
  r = await get('/status', bearer(ANALYTICS_TOKEN));
  check('GET /status with the analytics token is 401', r.status === 401, r.status);
  r = await fetch(`${BASE}/analytics`, { method: 'POST', headers: bearer(ANALYTICS_TOKEN) });
  check('a non-GET on /analytics is not opened by the token', r.status === 401 || r.status === 404 || r.status === 405, r.status);
}

out('=== a served request shows up in /metrics ===');
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ROOT_KEY },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
  });
  check('request with the root key served', r.status === 200, r.status);
  await sleep(100);
  const text = await (await get('/metrics', bearer(ANALYTICS_TOKEN))).text();
  const lines = text.split('\n');
  check('requests_total counted it', lines.includes('dario_requests_total 1'), lines.filter(l => l.startsWith('dario_requests_total')));
  check('per-model counter', lines.includes('dario_model_requests_total{model="claude-sonnet-5"} 1'), lines.filter(l => l.startsWith('dario_model_requests')));
  check('per-seat utilization from the headers', lines.includes('dario_account_utilization{account="one",window="5h"} 0.1'), lines.filter(l => l.startsWith('dario_account_utilization')));
  check('latency summary present', lines.some(l => l.startsWith('dario_request_latency_ms{quantile="0.5"}')));
  check('ledger family present (ledger on by default)', lines.some(l => l.startsWith('dario_ledger_requests_total')));
}

out('=== unkeyed proxy: the token gates nothing, and says so ===');
{
  delete process.env.DARIO_API_KEY;
  const port2 = await freePort();
  const before = log.length;
  await startProxy({ ...proxyOpts, port: port2 });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port2}/health`); break; } catch { await sleep(100); } }
  check('startup warns that the token gates nothing', log.slice(before).some(l => l.includes('gates nothing')), log.slice(before).join(' | ').slice(0, 300));
  const r = await fetch(`http://127.0.0.1:${port2}/metrics`);
  check('/metrics is open without a credential', r.status === 200, r.status);
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

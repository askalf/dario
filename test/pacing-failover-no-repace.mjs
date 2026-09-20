#!/usr/bin/env node
/**
 * A mid-flight 429 failover is not paced against the peer (review of #1373).
 *
 * The governor runs once per request, before `dispatchLoop`; every
 * `continue dispatchLoop` re-enters after it. So a request that goes out on
 * seat A, is refused with a 429 and retried on seat B never waits out B's
 * floor — even when B served another request a moment ago and its own clock
 * is hot. This file pins that down through a real proxy: B is made hot with a
 * pinned request, then an unpinned request lands on A (the fresher seat),
 * A refuses, the retry serves from B, and the request's pacing column is 0.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT_KEY = 'root-secret-for-the-failover-pacing-test';
const ADMIN_TOKEN = 'admin-token-for-the-failover-pacing-test';
// Generous, so "B's floor is still open" holds even on a slow runner.
const PACE_MIN_MS = 3000;
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-pacing-failover-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_ANALYTICS_TOKEN; delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
for (const alias of ['one', 'two']) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias, accessToken: `${alias}-token`, refreshToken: `${alias}-token-refresh`,
    expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
  }));
}

const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
const rate = (util5h) => ({
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': resetAt,
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': util5h,
  'anthropic-ratelimit-unified-7d-utilization': '0.05',
});
const dispatched = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const auth = String(new Headers(init?.headers ?? {}).get('authorization') ?? '');
  const seat = auth.includes('one-token') ? 'one' : auth.includes('two-token') ? 'two' : '?';
  dispatched.push(seat);
  if (seat === 'one') {
    // Seat A refuses: a genuine subscription 429, window named.
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
      status: 429, headers: { 'content-type': 'application/json', ...rate('1.00'), 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '3600' },
    });
  }
  // Seat B serves, and reports itself nearly drained so a fresh A is the
  // pool's first pick for an unbound conversation.
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json', ...rate('0.90') } });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const { startProxy } = await import('../dist/proxy.js');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
await startProxy({
  host: '127.0.0.1', port: PORT, verbose: false, noLiveCapture: true, fetchImpl, overageGuardEnabled: false,
  pacingMinMs: PACE_MIN_MS, pacingJitterMs: 0, maxConcurrent: 8,
});
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const post = (extraHeaders, content) => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': ROOT_KEY, ...extraHeaders },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content }] }),
});
const pacingOf = (r) => Number(r.headers.get('x-dario-pacing-ms'));

out('=== make seat B hot: one pinned request, served ===');
const hotAt = Date.now();
{
  const r = await post({ 'x-dario-account': 'two', 'x-dario-admin-token': ADMIN_TOKEN }, 'warm up B');
  check('B served', r.status === 200, r.status);
  check('B is the only seat dispatched so far', dispatched.join(',') === 'two', dispatched.join(','));
  await r.text();
}

out('=== unbound request: lands on A, A 429s, the retry serves from B — with no pacing ===');
{
  const r = await post({}, `new conversation ${Math.random()}`);
  const body = await r.text();
  check('served (the 429 never reached the client)', r.status === 200 && body.includes('PONG'), `${r.status} ${body.slice(0, 120)}`);
  check('A was dispatched to and refused, then B served', dispatched.slice(1).join(',') === 'one,two', dispatched.join(','));
  check("B's floor was still open when the retry went out", Date.now() - hotAt < PACE_MIN_MS, Date.now() - hotAt);
  check('the request was paced against A (fresh), not re-paced against B (hot): pacing 0', pacingOf(r) === 0, pacingOf(r));
}

out('=== /analytics: both served rows are on B (a failed-over 429 records no row of its own) ===');
{
  const r = await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } });
  const a = await r.json();
  check('two served rows on B, none served on A', a.perAccount?.two?.requests === 2 && !(a.perAccount?.one?.requests > 0 && a.perAccount.one.subscriptionPercent > 0), JSON.stringify(a.perAccount));
  check('no pacing in the window at all', a.window?.timing?.avgPacingMs === 0, a.window?.timing);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-25).join('\n'));
process.exit(fail === 0 ? 0 : 1);

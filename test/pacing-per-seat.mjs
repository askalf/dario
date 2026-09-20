#!/usr/bin/env node
/**
 * The rate governor paces per seat, through a real proxy (dario#1244 family).
 *
 * The inter-request floor exists so one account's cadence never looks like a
 * machine's. One clock for the whole proxy enforced that floor across ALL
 * seats — a three-seat pool could send at most one request per floor, and a
 * request to an idle seat waited for a stranger's request on another seat.
 * The property here: back-to-back requests on DIFFERENT seats are not paced
 * against each other; a second request on the SAME seat still is.
 *
 * Seats are chosen with the admin seat pin so the test never depends on
 * headroom routing or the sticky hash.
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

const ROOT_KEY = 'root-secret-for-the-pacing-test';
const ADMIN_TOKEN = 'admin-token-for-the-pacing-test';
const PACE_MIN_MS = 600;
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-pacing-seat-'));
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

const rateHeaders = {
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.10',
  'anthropic-ratelimit-unified-7d-utilization': '0.05',
};
const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json', ...rateHeaders } });
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

const post = (seat) => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': ROOT_KEY, 'x-dario-account': seat, 'x-dario-admin-token': ADMIN_TOKEN },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: `ping ${seat} ${Math.random()}` }] }),
});
const pacingOf = (r) => Number(r.headers.get('x-dario-pacing-ms'));

out('=== different seats, back to back: neither waits for the other ===');
{
  const a = await post('one');
  check('seat one served', a.status === 200, a.status);
  check('first request on seat one is not paced', pacingOf(a) === 0, pacingOf(a));
  await a.text();
  const b = await post('two');
  check('seat two served', b.status === 200, b.status);
  check('first request on seat two is not paced by seat one', pacingOf(b) === 0, pacingOf(b));
  await b.text();
}

out('=== the same seats again, in parallel: each floor holds, each on its own clock ===');
{
  // Fired together so neither waits out the other's floor first: c is seat
  // one's second request, d is seat two's. Both are inside their own seat's
  // floor, so both are paced — by their own clock, not a shared one.
  const [c, d] = await Promise.all([post('one'), post('two')]);
  check('both served', c.status === 200 && d.status === 200, `${c.status} ${d.status}`);
  const p = pacingOf(c), q = pacingOf(d);
  check('second request on seat one is paced', p > 0 && p <= PACE_MIN_MS, p);
  check('second request on seat two is paced by its own clock', q > 0 && q <= PACE_MIN_MS, q);
  await Promise.all([c.text(), d.text()]);
}

out('=== /status: the pinned requests landed where they were pinned ===');
{
  const r = await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } });
  const a = await r.json();
  check('two requests per seat', a.perAccount?.one?.requests === 2 && a.perAccount?.two?.requests === 2, JSON.stringify(a.perAccount));
  check('the window\'s pacing average is the two paced requests over four', a.window?.timing?.avgPacingMs > 0 && a.window.timing.avgPacingMs < PACE_MIN_MS, a.window?.timing);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-20).join('\n'));
process.exit(fail === 0 ? 0 : 1);

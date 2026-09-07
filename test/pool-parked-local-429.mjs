#!/usr/bin/env node
// dario#1244 follow-up — a pool with every seat parked answers locally.
//
// The report's second listing (v6.0.33, six-seat team gateway):
//   util5h 1, reset_in_ms 1288011, status rejected,
//   request_count 1, rejected_count 500
// Five hundred rejections on one seat inside one window. Every request that
// arrived while all six seats were parked re-probed the earliest-reset seat
// (`select()`'s all-exhausted fallback) and then, mid-flight, every other
// parked seat too — each a guaranteed 429, each bumping `rejectedCount`, and
// the operator read the number as a seat that needed a re-login.
//
// Now: no seat inside a live window is probed. The client gets 429 with
// `retry-after` at the earliest reset and `x-dario-upstream-rejection:
// pool_parked`, nothing goes upstream, the transition is logged once, and
// both listings say `action: wait`.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pure pool behaviour first ──────────────────────────────────────────
header('AccountPool: a seat parked inside a live window is never selected');
{
  const { AccountPool, EMPTY_SNAPSHOT, isParkedInLiveWindow, accountAction } = await import('../dist/pool.js');
  const NOW = Date.now();
  const SECS = Math.floor(NOW / 1000);
  const pool = new AccountPool();
  for (const alias of ['a', 'b', 'c']) {
    pool.add(alias, { accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`, expiresAt: NOW + 8 * 3_600_000, deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}` });
  }
  // a and b parked on live windows (b earlier), c parked with NO stated reset.
  pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 1, reset: SECS + 1800, updatedAt: NOW });
  pool.markRejected('b', { ...EMPTY_SNAPSHOT, util5h: 1.04, reset: SECS + 600, updatedAt: NOW });
  pool.markRejected('c', { ...EMPTY_SNAPSHOT, util5h: 1, reset: 0, updatedAt: NOW });
  check('a and b are parked in live windows, c is not (no reset to expire)',
    isParkedInLiveWindow(pool.get('a'), NOW) && isParkedInLiveWindow(pool.get('b'), NOW) && !isParkedInLiveWindow(pool.get('c'), NOW));
  check('with c probeable, select() returns c (the old least-used probe), not the earliest-reset seat b',
    pool.select()?.alias === 'c', pool.select()?.alias);
  check('and parkedUntil() is null — there is still something to try', pool.parkedUntil(NOW) === null);
  check('action on a parked seat is wait', accountAction(pool.get('a'), NOW) === 'wait');

  // Park c on a live window too: now nothing is probeable.
  pool.markRejected('c', { ...EMPTY_SNAPSHOT, util5h: 1, reset: SECS + 900, updatedAt: NOW });
  check('select() returns null instead of re-probing a parked seat', pool.select() === null);
  check('parkedUntil() is the earliest reset (b, +600s), in ms', pool.parkedUntil(NOW) === (SECS + 600) * 1000, pool.parkedUntil(NOW));
  check('parkedCount() is 3', pool.parkedCount(NOW) === 3);
  check('selectExcluding() does not hand a parked seat to mid-flight failover', pool.selectExcluding(new Set(['a'])) === null);

  // b's window rolls: it is eligible again on its own.
  const LATER = (SECS + 601) * 1000;
  check('after b\'s reset passes, parkedUntil() is null again', pool.parkedUntil(LATER) === null);
  check('and b reports action none (window rolled, status unknown)', accountAction(pool.get('b'), LATER) === 'none');

  // Mixed pool (the dario#1254 review case): one seat parked on a 30-minute
  // window, one seat in a 60-second auth cool-down. That is not "every seat
  // over its window": parkedUntil() must stay null so the proxy does not
  // answer pool_parked with a 30-minute retry-after and cool the provider
  // for a seat that is usable again in a minute.
  const mixed = new AccountPool();
  for (const alias of ['rl', 'auth']) {
    mixed.add(alias, { accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`, expiresAt: NOW + 8 * 3_600_000, deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}` });
  }
  mixed.markRejected('rl', { ...EMPTY_SNAPSHOT, util5h: 1, reset: SECS + 1800, updatedAt: NOW });
  mixed.markAuthFailure('auth');
  check('mixed pool: no seat is selectable right now', mixed.select() === null);
  check('mixed pool: parkedUntil() is null (not every seat is rate-limit parked)', mixed.parkedUntil(NOW) === null, mixed.parkedUntil(NOW));
  check('mixed pool: parkedCount() still reports the one parked seat', mixed.parkedCount(NOW) === 1);
  // A token-expired seat beside a parked one is the same shape.
  const mixed2 = new AccountPool();
  mixed2.add('rl', { accessToken: 'tok', refreshToken: 'ref', expiresAt: NOW + 8 * 3_600_000, deviceId: 'd', accountUuid: 'u' });
  mixed2.add('stale', { accessToken: 'tok2', refreshToken: 'ref2', expiresAt: NOW - 1, deviceId: 'd2', accountUuid: 'u2' });
  mixed2.markRejected('rl', { ...EMPTY_SNAPSHOT, util5h: 1, reset: SECS + 1800, updatedAt: NOW });
  check('parked + token-expired: parkedUntil() is null', mixed2.parkedUntil(NOW) === null, mixed2.parkedUntil(NOW));

  // Auth streak → regrant; single blip → wait.
  const p2 = new AccountPool();
  p2.add('d', { accessToken: 'tok-d', refreshToken: 'ref-d', expiresAt: NOW + 8 * 3_600_000, deviceId: 'dev-d', accountUuid: 'uuid-d' });
  p2.markAuthFailure('d');
  check('one auth failure → wait', accountAction(p2.get('d')) === 'wait', accountAction(p2.get('d')));
  // A second failure inside the cool-down does not escalate (#642-audit), so
  // stage a genuine streak the way two separate cool-downs would leave it.
  p2.get('d').consecutiveAuthFailures = 2;
  p2.get('d').lastAuthFailureAt = Date.now();
  check('a streak → regrant', accountAction(p2.get('d')) === 'regrant', accountAction(p2.get('d')));
  check('a parked seat with an auth streak still says regrant (auth outranks the window)',
    (p2.markRejected('d', { ...EMPTY_SNAPSHOT, reset: SECS + 600, updatedAt: NOW }), accountAction(p2.get('d'))) === 'regrant');
}

// ── the real proxy, in-process, every seat answering 429 ───────────────
const PORT = await freePort();
const ADMIN_TOKEN = 'parked-pool-admin-token';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-parked-pool-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_POOL_FALLBACK;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
const seat = (alias, token) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
});
await writeFile(join(tmpHome, '.dario', 'accounts', 'one.json'), seat('one', 'one-token'));
await writeFile(join(tmpHome, '.dario', 'accounts', 'two.json'), seat('two', 'two-token'));

const RESET_ONE_S = 21 * 60;   // the report's 1288011 ms
const RESET_TWO_S = 45 * 60;
const oneResetS = Math.floor(Date.now() / 1000) + RESET_ONE_S;
const twoResetS = Math.floor(Date.now() / 1000) + RESET_TWO_S;
const rateLimited = (resetS) => new Response(
  JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }),
  { status: 429, headers: {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-7d-utilization': '0.09',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(resetS),
    'anthropic-organization-id': 'org-shared',
  } },
);
const calls = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const auth = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]);
  const bearer = auth.replace(/^Bearer\s+/i, '');
  calls.push(bearer);
  return rateLimited(bearer === 'one-token' ? oneResetS : twoResetS);
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

const { startProxy } = await import('../dist/proxy.js');
await startProxy({ host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (content) => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const accounts = async () => (await (await fetch(`${BASE}/accounts`)).json()).accounts;
const adminAccounts = async () => (await (await fetch(`${BASE}/admin/accounts`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()).accounts;

header('request 1: both seats are tried once, the client gets the upstream 429');
{
  const r = await messages(`conversation 1 ${Math.random()}`);
  await r.text();
  check('client got 429', r.status === 429, r.status);
  check('each seat was probed exactly once', calls.filter((b) => b === 'one-token').length === 1 && calls.filter((b) => b === 'two-token').length === 1, calls.join(','));
}

header('requests 2..21: answered locally — nothing upstream, counters frozen');
{
  const before = calls.length;
  const statuses = [];
  let last;
  for (let i = 2; i <= 21; i++) {
    last = await messages(`conversation ${i} ${Math.random()}`);
    statuses.push(last.status);
    await last.text();
  }
  check('twenty more requests, zero upstream calls', calls.length === before, `${calls.length - before} upstream calls`);
  check('every one a 429', statuses.every((s) => s === 429), statuses.join(','));
  const retryAfter = Number(last.headers.get('retry-after'));
  check('retry-after is the earliest reset (seat one, ~21m), not a cool-down estimate',
    retryAfter > RESET_ONE_S - 60 && retryAfter <= RESET_ONE_S, retryAfter);
  check('marker x-dario-upstream-rejection: pool_parked', last.headers.get('x-dario-upstream-rejection') === 'pool_parked', last.headers.get('x-dario-upstream-rejection'));
  const one = (await accounts()).find((a) => a.alias === 'one');
  check('rejectedCount on seat one stayed at 1 (this is the 500 of the report)', one?.rejectedCount === 1, one?.rejectedCount);
  check('status rejected, action wait', one?.status === 'rejected' && one?.action === 'wait', JSON.stringify([one?.status, one?.action]));
  const adminOne = (await adminAccounts()).find((a) => a.alias === 'one');
  check('admin listing: rejected_count 1, action wait', adminOne?.rejected_count === 1 && adminOne?.action === 'wait', JSON.stringify([adminOne?.rejected_count, adminOne?.action]));
}

header('the log marks the transition once, not per request');
{
  const parked = log.filter((l) => l.includes('pool parked: all 2 seats'));
  check('exactly one "pool parked" line', parked.length === 1, JSON.stringify(parked));
  check('it names the earliest reset in minutes', /earliest resets in 2[01]m/.test(parked[0] ?? ''), parked[0]);
  check('each seat logged its own parking exactly once', log.filter((l) => l.includes('rate limited (429) on account "one"')).length === 1 && log.filter((l) => l.includes('rate limited (429) on account "two"')).length === 1);
}


out(`\npool-parked-local-429: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

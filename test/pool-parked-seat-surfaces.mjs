#!/usr/bin/env node
// dario#1244 — a seat parked on its first 429 must explain itself.
//
// Reported on a six-seat pool (v6.0.32): one seat listed as
//   util5h 1.04, claim five_hour, status rejected, request_count 0
// while the operator's own usage page for that seat read 0%. Every field was
// true — the seat's organization really had answered 429 at 104% of its
// five-hour window — but nothing said so: the client saw 200 from a peer, the
// proxy logged nothing about the seat, the listing carried no reset and no
// reading age, and `request_count: 0` (a 429 serves nothing, so the attempt
// was never counted) made the rejection read as one dario had invented.
//
// This drives the real proxy in-process with a fake upstream: seat `busy`
// answers 429 with exactly that header set, seat `spare` answers 200. Then it
// asserts what each operator surface says about the parked seat.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

// The proxy's console output is captured below; keep the real one for ours.
const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const ADMIN_TOKEN = 'parked-seat-admin-token';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-parked-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_CODEX_BASE_URL;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
const seat = (alias, token) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
});
await writeFile(join(tmpHome, '.dario', 'accounts', 'busy.json'), seat('busy', 'busy-token'));
await writeFile(join(tmpHome, '.dario', 'accounts', 'spare.json'), seat('spare', 'spare-token'));

const RESET_IN_S = 37 * 60;
const busyResetS = Math.floor(Date.now() / 1000) + RESET_IN_S;
const spareResetS = Math.floor(Date.now() / 1000) + 4 * 3600;
const unified = (status, util5h, util7d, resetS) => ({
  'content-type': 'application/json',
  'anthropic-ratelimit-unified-status': status,
  'anthropic-ratelimit-unified-5h-utilization': String(util5h),
  'anthropic-ratelimit-unified-7d-utilization': String(util7d),
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(resetS),
});
const rateLimited = (resetS) => new Response(
  JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }),
  { status: 429, headers: unified('rejected', 1.04, 0.25, resetS) },
);
const ok = (resetS) => new Response(JSON.stringify({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: unified('allowed', 0.05, 0, resetS) });

// Flipped later: spare starts answering 429 on a window that has ALREADY
// rolled, the state a seat is in once its rejection has expired.
let spareRolled = false;
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
  if (bearer === 'busy-token') return rateLimited(busyResetS);
  if (spareRolled) return rateLimited(Math.floor(Date.now() / 1000) - 5);
  return ok(spareResetS);
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const parkingLines = (alias) => log.filter((l) => l.includes(`rate limited (429) on account "${alias}"`));

const { startProxy } = await import('../dist/proxy.js');
// verbose OFF: the parking line must be there without it.
await startProxy({ host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (content) => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const accounts = async () => (await (await fetch(`${BASE}/accounts`)).json()).accounts;
const adminAccounts = async () => (await (await fetch(`${BASE}/admin/accounts`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()).accounts;
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

header('the busy seat is tried once, the client never notices');
{
  // Distinct first messages = distinct conversations, so nothing is sticky.
  // The never-measured seat (headroom 1.0) is picked as soon as the other has
  // reported any utilisation, so busy is tried within a couple of requests.
  const statuses = [];
  for (let i = 0; i < 3 && !calls.includes('busy-token'); i++) {
    const r = await messages(`conversation ${i} ${Math.random()}`);
    statuses.push(r.status);
    await r.text();
  }
  check('busy was sent exactly one request', calls.filter((b) => b === 'busy-token').length === 1, calls.join(','));
  check('every client request got 200 (failover to spare)', statuses.length > 0 && statuses.every((s) => s === 200), statuses.join(','));
}

header('GET /accounts — the parked seat says since when, until when, and that it was tried');
{
  const now = Date.now();
  const busy = (await accounts()).find((a) => a.alias === 'busy');
  check('status rejected (window still ahead)', busy?.status === 'rejected', busy?.status);
  check('the 429 reading is what upstream said', busy?.util5h === 1.04 && busy?.util7d === 0.25 && busy?.claim === 'five_hour');
  check('resetAt is the header, in ms', busy?.resetAt === busyResetS * 1000, busy?.resetAt);
  check('resetInMs counts down to it', near(busy?.resetInMs, RESET_IN_S * 1000, 15_000), busy?.resetInMs);
  check('requestCount still 0 — a 429 served nothing', busy?.requestCount === 0);
  check('rejectedCount 1 — but the seat WAS tried', busy?.rejectedCount === 1, busy?.rejectedCount);
  check('lastRejectedAt is now', near(busy?.lastRejectedAt, now, 15_000), busy?.lastRejectedAt);
  check('lastObservedAt matches the rejection', busy?.lastObservedAt === busy?.lastRejectedAt);

  const spare = (await accounts()).find((a) => a.alias === 'spare');
  check('the serving seat is allowed with its own window', spare?.status === 'allowed' && spare?.resetAt === spareResetS * 1000);
  check('and has no rejections', spare?.rejectedCount === 0 && spare?.lastRejectedAt === null);
}

header('GET /admin/accounts — same facts, snake_case (the surface in the report)');
{
  const busy = (await adminAccounts()).find((a) => a.alias === 'busy');
  check('status rejected', busy?.status === 'rejected');
  check('reset_at / reset_in_ms present', busy?.reset_at === busyResetS * 1000 && near(busy?.reset_in_ms, RESET_IN_S * 1000, 15_000), JSON.stringify([busy?.reset_at, busy?.reset_in_ms]));
  check('last_observed_at / util_age_ms present (#1032 fields, previously dropped here)',
    typeof busy?.last_observed_at === 'number' && typeof busy?.util_age_ms === 'number' && busy.util_age_ms < 15_000,
    JSON.stringify([busy?.last_observed_at, busy?.util_age_ms]));
  check('request_count 0, rejected_count 1', busy?.request_count === 0 && busy?.rejected_count === 1);
  check('last_rejected_at present', typeof busy?.last_rejected_at === 'number');
}

header('the proxy log names the seat, the reading and the reset — without -v');
{
  const lines = parkingLines('busy');
  check('exactly one parking line for busy', lines.length === 1, JSON.stringify(lines));
  check('it carries the reading', lines[0]?.includes('5h 104%, 7d 25%, claim five_hour'), lines[0]);
  check('and the reset', /resets in 3[67]m/.test(lines[0] ?? ''), lines[0]);
}

header('a re-probe of a parked seat is not a new parking (no repeat line)');
{
  // Park spare too, on a window that has already rolled. With nothing eligible
  // left, the failover falls back to the parked busy seat, which 429s again:
  // that is a repeat, not a transition, and must not log a second line.
  spareRolled = true;
  const r = await messages(`conversation exhausted ${Math.random()}`);
  await r.text();
  check('client gets the honest 429 (no seat left, no Codex leg)', r.status === 429, r.status);
  check('busy was re-probed', calls.filter((b) => b === 'busy-token').length === 2, calls.join(','));
  check('still exactly one parking line for busy', parkingLines('busy').length === 1, JSON.stringify(parkingLines('busy')));
  check('spare logged its own parking once', parkingLines('spare').length === 1, JSON.stringify(parkingLines('spare')));
  check('spare\'s line says its window had already rolled', parkingLines('spare')[0]?.includes('window already rolled'), parkingLines('spare')[0]);

  const busy = (await accounts()).find((a) => a.alias === 'busy');
  check('busy rejectedCount is now 2', busy?.rejectedCount === 2, busy?.rejectedCount);
  check('busy still rejected, requestCount still 0', busy?.status === 'rejected' && busy?.requestCount === 0);

  // A rejection whose window has passed reports `unknown` (#1232) — and now
  // shows the reset that passed, so the operator can see why it is unknown.
  const spare = (await adminAccounts()).find((a) => a.alias === 'spare');
  check('spare reports unknown (rejection expired with its window)', spare?.status === 'unknown', spare?.status);
  check('spare reset_in_ms floored at 0, reset_at in the past', spare?.reset_in_ms === 0 && spare?.reset_at < Date.now(), JSON.stringify([spare?.reset_at, spare?.reset_in_ms]));
  check('spare counts its one rejection beside the requests it served', spare?.rejected_count === 1 && spare?.request_count >= 1, JSON.stringify([spare?.rejected_count, spare?.request_count]));
}

out(`\npool-parked-seat-surfaces: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * test/codex-seat-status.mjs
 *
 * A Codex seat reports what the proxy will do with it, not what the clock says
 * (dario#1343). expiresAt alone called a seat healthy for six hours while the
 * backend rejected every request made with it.
 *
 * Hermetic: HOME in a mkdtemp dir, the admin handler driven with mock req/res
 * (as test/admin-api.mjs does), the token endpoint on loopback so a refusal can
 * be produced without OAuth, and the CLI formatter exercised as a pure function.
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-seat-status-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;

// A token endpoint that refuses: the shape of a dead refresh_token.
const tokenServer = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); });
});
await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
process.env.DARIO_CODEX_TOKEN_URL = `http://127.0.0.1:${tokenServer.address().port}/token`;

const {
  saveCodexAccount, codexSeatStatus, noteCodexDecline, clearCodexDecline,
  forceRefreshCodexAccount, _resetCodexRefreshFailuresForTest, _resetCodexPoolForTest,
} = await import('../dist/codex-accounts.js');
const { handleAdminRequest, _resetAdminStateForTest } = await import('../dist/admin-api.js');
const { formatLiveCodexListing } = await import('../dist/cli.js');

// ── admin handler harness, as test/admin-api.mjs drives it ──
const TOKEN = 't0ken';
const TOKEN_BUF = Buffer.from(TOKEN);
function mockReq(method, url) {
  const r = new EventEmitter();
  r.method = method; r.url = url; r.headers = { authorization: `Bearer ${TOKEN}` }; r.destroy = () => {};
  setImmediate(() => r.emit('end'));
  return r;
}
function mockRes() {
  return { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; return this; }, end(b) { this.body = b || ''; return this; } };
}
async function listSeats() {
  const req = mockReq('GET', '/admin/codex/accounts');
  const res = mockRes();
  await handleAdminRequest(req, res, '/admin/codex/accounts', { adminTokenBuf: TOKEN_BUF });
  return { status: res.statusCode, seats: JSON.parse(res.body).accounts };
}

const seat = { alias: 'fleet', accessToken: 'at-must-not-leak-4c1d', refreshToken: 'rt-must-not-leak-9f3a', expiresAt: Date.now() + 24 * 3600_000 };
await saveCodexAccount(seat);
_resetAdminStateForTest?.();

header('a seat nothing is known against reads ok');
{
  const s = codexSeatStatus('fleet');
  check('status ok', s.status === 'ok', JSON.stringify(s));
  check('no cooldown, no refresh error', s.cooldownRemainingMs === 0 && s.lastRefreshError === null);
  const { status, seats } = await listSeats();
  check('admin listing answers 200 with the seat', status === 200 && seats.length === 1 && seats[0].alias === 'fleet', JSON.stringify(seats));
  check('admin record carries status/cooldown/lastRefreshError', seats[0].status === 'ok' && seats[0].cooldownRemainingMs === 0 && seats[0].lastRefreshError === null, JSON.stringify(seats[0]));
  check('the clock field is still there', typeof seats[0].needsRefresh === 'boolean' && typeof seats[0].expiresAt === 'number');
}

header('the backend declined the seat: cooling, with the countdown');
{
  noteCodexDecline('fleet', 30_000);
  const s = codexSeatStatus('fleet');
  check('status cooling', s.status === 'cooling', JSON.stringify(s));
  check('cooldownRemainingMs is the remaining window', s.cooldownRemainingMs > 0 && s.cooldownRemainingMs <= 30_000, String(s.cooldownRemainingMs));
  const { seats } = await listSeats();
  check('admin listing shows cooling', seats[0].status === 'cooling' && seats[0].cooldownRemainingMs > 0, JSON.stringify(seats[0]));
  clearCodexDecline('fleet');
  check('cleared → ok again', codexSeatStatus('fleet').status === 'ok');
}

header('the token endpoint refused a refresh: refresh-failed, and it outranks cooling');
{
  await forceRefreshCodexAccount(seat).catch(() => {});
  const s = codexSeatStatus('fleet');
  check('status refresh-failed', s.status === 'refresh-failed', JSON.stringify(s));
  check('lastRefreshError carries the endpoint status and no credential', s.lastRefreshError?.status === 400 && !JSON.stringify(s).includes('must-not-leak'), JSON.stringify(s));
  noteCodexDecline('fleet', 30_000);
  check('a refresh refusal outranks a cool-down — the actionable fact wins', codexSeatStatus('fleet').status === 'refresh-failed');
  const { seats } = await listSeats();
  check('admin listing agrees, and carries no credential either', seats[0].status === 'refresh-failed' && seats[0].lastRefreshError?.status === 400 && !JSON.stringify(seats).includes('must-not-leak'), JSON.stringify(seats[0]));
  _resetCodexRefreshFailuresForTest();
  check('failure forgotten → the cool-down shows through', codexSeatStatus('fleet').status === 'cooling');
  clearCodexDecline('fleet');
}

header('formatLiveCodexListing — one line of state per seat, the clock on the next');
{
  const lines = formatLiveCodexListing([
    { alias: 'a', expiresInMs: 90 * 60_000, requestCount: 3, status: 'ok', cooldownRemainingMs: 0, lastRefreshError: null },
    { alias: 'b', expiresInMs: 0, requestCount: 1, status: 'cooling', cooldownRemainingMs: 12_400, lastRefreshError: null },
    { alias: 'c', expiresInMs: 5 * 60_000, requestCount: 0, status: 'refresh-failed', cooldownRemainingMs: 0, lastRefreshError: { at: 1, status: 400, message: 'invalid_grant' } },
  ], 3456).join('\n');
  check('names the proxy it read from', lines.includes('http://127.0.0.1:3456/codex'));
  check('ok seat', /a\s+ok\n\s+token expires in 90m, 3 requests served/.test(lines), lines);
  check('cooling seat shows the countdown and why', /b\s+cooling 13s — the backend declined it/.test(lines) && lines.includes('expired, 1 request served'), lines);
  check('refresh-failed seat shows the endpoint answer and the remedy', lines.includes('c') && lines.includes('refresh-failed (400: invalid_grant) — re-add the seat'), lines);
  const empty = formatLiveCodexListing([], 1).join('\n');
  check('empty pool says so', empty.includes('No Codex accounts.'));
}

tokenServer.close();
_resetCodexPoolForTest?.();
await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

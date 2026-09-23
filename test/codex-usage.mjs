// ChatGPT-seat utilisation: parsing, headroom, ordering, and the /wham/usage seed.
//
// codex-accounts.ts used to say the Codex backend "states nothing until it
// 429s", so the ChatGPT pool was fill-first with cool-down eviction and a
// second seat sat idle until the first one declined. The backend reports a
// seat's usage on every Responses call (the x-codex-* family the Codex CLI
// parses) and answers GET /backend-api/wham/usage without a model call. This
// file pins the parsers against both shapes, the headroom arithmetic, the
// strategy order, and the seed's two guards: it never refreshes a token and
// never sends a non-JWT one.
//
// Hermetic: sandbox HOME, a local stub for /wham/usage, no network.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'dario-codex-usage-'));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
delete process.env.DARIO_CODEX_ACCOUNT;
delete process.env.DARIO_POOL_STRATEGY;
const STUB_PORT = await freePort();
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${STUB_PORT}/backend-api/codex`;
const accountsDir = join(sandbox, '.dario', 'codex-accounts');
await mkdir(accountsDir, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const H = (o) => ({ get: (k) => (k.toLowerCase() in o ? String(o[k.toLowerCase()]) : null) });

const usage = await import('../dist/codex-usage.js');
const accounts = await import('../dist/codex-accounts.js');
const backend = await import('../dist/codex-backend.js');

const NOW = Date.parse('2026-09-23T02:00:00Z');
const inSecs = (s) => Math.floor(NOW / 1000) + s;

// ---------------------------------------------------------------------------
header('headers: the x-codex-* family the Codex CLI parses');
// ---------------------------------------------------------------------------
{
  const plus = usage.parseCodexUsageHeaders(H({
    'x-codex-primary-used-percent': '37.5', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(inSecs(3600)),
    'x-codex-secondary-used-percent': '12', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': String(inSecs(86400 * 3)),
  }), NOW);
  check('two windows read', plus && plus.primary && plus.secondary, JSON.stringify(plus));
  check('primary 37.5% of 300 min', plus.primary.usedPercent === 37.5 && plus.primary.windowMinutes === 300);
  check('reset-at is unix SECONDS, stored as ms', plus.primary.resetAt === (inSecs(3600)) * 1000, String(plus.primary.resetAt));
  check('source is headers', plus.source === 'headers' && plus.observedAt === NOW);

  const prolite = usage.parseCodexUsageHeaders(H({ 'x-codex-primary-used-percent': '6', 'x-codex-primary-window-minutes': '10080' }), NOW);
  check('one-window plan: weekly primary, null secondary', prolite.primary.windowMinutes === 10080 && prolite.secondary === null);

  // Verbatim from a real prolite answer on the fleet box, 2026-09-23: the
  // unused slot arrives zeroed with an empty reset, and is no window at all.
  const live = usage.parseCodexUsageHeaders(H({
    'x-codex-active-limit': 'premium', 'x-codex-plan-type': 'prolite',
    'x-codex-primary-used-percent': '9', 'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-at': '1790728625', 'x-codex-primary-reset-after-seconds': '597567',
    'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0', 'x-codex-secondary-reset-at': '', 'x-codex-secondary-reset-after-seconds': '0',
    'x-codex-primary-over-secondary-limit-percent': '0',
  }), NOW);
  check('live prolite headers: weekly 9%, reset 1790728625 s', live.primary.usedPercent === 9 && live.primary.windowMinutes === 10080 && live.primary.resetAt === 1790728625000, JSON.stringify(live));
  check('live prolite headers: the zeroed secondary slot is NOT a window', live.secondary === null, JSON.stringify(live.secondary));

  check('a response with no usage headers reads as null (never erases a reading)', usage.parseCodexUsageHeaders(H({ 'content-type': 'text/event-stream' }), NOW) === null);
  check('a garbage percent is not a reading', usage.parseCodexUsageHeaders(H({ 'x-codex-primary-used-percent': 'lots' }), NOW) === null);
  const reached = usage.parseCodexUsageHeaders(H({ 'x-codex-primary-used-percent': '100', 'x-codex-rate-limit-reached-type': 'primary' }), NOW);
  check('reached-type is carried', reached.limitReached === 'primary');
}

// ---------------------------------------------------------------------------
header('usage endpoint: the /wham/usage body (fleet box shape, identifiers dropped)');
// ---------------------------------------------------------------------------
const PROLITE_BODY = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: 599097, reset_at: inSecs(599097) },
    secondary_window: null,
  },
  model_usage: { 'gpt-6-astra': { available: true } },
  rate_limit_reached_type: null,
};
{
  const u = usage.parseCodexUsageEndpoint(PROLITE_BODY, NOW);
  check('weekly window, 4%', u.primary.usedPercent === 4 && u.primary.windowMinutes === 10080, JSON.stringify(u));
  check('reset_at seconds → ms', u.primary.resetAt === inSecs(599097) * 1000);
  check('no secondary, not at limit, source usage-endpoint', u.secondary === null && u.limitReached === null && u.source === 'usage-endpoint');

  const after = usage.parseCodexUsageEndpoint({ rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18000, reset_after_seconds: 60 } } }, NOW);
  check('reset_after_seconds is the fallback for a missing reset_at', after.primary.resetAt === NOW + 60_000);
  const full = usage.parseCodexUsageEndpoint({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100 } } }, NOW);
  check('limit_reached true reads as reached', full.limitReached === 'limit_reached');
  check('an empty body is not a reading', usage.parseCodexUsageEndpoint({}, NOW) === null && usage.parseCodexUsageEndpoint(null, NOW) === null);
}

// ---------------------------------------------------------------------------
header('headroom, roll-over and the long window');
// ---------------------------------------------------------------------------
{
  usage._resetCodexUsageForTest();
  check('no reading → headroom null', usage.codexHeadroom('alpha', NOW) === null);

  usage.recordCodexUsage('alpha', { primary: { usedPercent: 30, windowMinutes: 300, resetAt: NOW + 3_600_000 }, secondary: { usedPercent: 70, windowMinutes: 10080, resetAt: NOW + 86_400_000 }, limitReached: null, observedAt: NOW, source: 'headers' });
  check('headroom is set by the TIGHTEST window (70% used → 0.30)', Math.abs(usage.codexHeadroom('alpha', NOW) - 0.3) < 1e-9, String(usage.codexHeadroom('alpha', NOW)));
  check('long-window reset is the 7d one', usage.codexLongWindowResetAt('alpha', NOW) === NOW + 86_400_000);
  const later = NOW + 2 * 86_400_000;
  check('a window past its reset counts as rolled (empty)', usage.codexHeadroom('alpha', later) === 1);
  check('and its reset is no longer ahead', usage.codexLongWindowResetAt('alpha', later) === null);

  usage.recordCodexUsage('bravo', { primary: { usedPercent: 40, windowMinutes: 10080, resetAt: NOW + 3_600_000 }, secondary: null, limitReached: 'primary', observedAt: NOW, source: 'headers' });
  check('a reached flag reads as 0 headroom while its window is live', usage.codexHeadroom('bravo', NOW) === 0);
  check('and lifts once it rolls', usage.codexHeadroom('bravo', NOW + 7_200_000) === 1);

  usage.recordCodexUsage('alpha', { primary: { usedPercent: 99, windowMinutes: 300, resetAt: null }, secondary: null, limitReached: null, observedAt: NOW - 1, source: 'headers' });
  check('an OLDER reading never replaces a newer one', Math.abs(usage.codexHeadroom('alpha', NOW) - 0.3) < 1e-9);

  const view = usage.codexUsageView('alpha', NOW);
  check('the view carries windows, headroom, ISO times', view.windows.length === 2 && view.windows[1].resetAt === new Date(NOW + 86_400_000).toISOString() && Math.abs(view.headroom - 0.3) < 1e-9, JSON.stringify(view));
  check('the view carries no credential-shaped field', !/token|secret|bearer/i.test(JSON.stringify(view)));
  check('describe: "70% of 7d, resets in 1d 0h"', usage.describeCodexWindow(view.windows[1], NOW) === '70% of 7d, resets in 1d 0h', usage.describeCodexWindow(view.windows[1], NOW));
  check('describe: 5h window in hours and minutes', usage.describeCodexWindow(view.windows[0], NOW) === '30% of 5h, resets in 1h 0m', usage.describeCodexWindow(view.windows[0], NOW));
}

// ---------------------------------------------------------------------------
header('poll interval knob');
// ---------------------------------------------------------------------------
{
  const r = usage.resolveCodexUsagePollMs;
  check('unset → 30 min', r(undefined) === 1_800_000 && r('') === 1_800_000);
  check('garbage or negative → default', r('soon') === 1_800_000 && r('-5') === 1_800_000);
  check('0 → off', r('0') === 0);
  check('floored at one minute', r('1000') === 60_000 && r('900000') === 900_000);
}

// ---------------------------------------------------------------------------
header('order: the pool strategy over readings');
// ---------------------------------------------------------------------------
{
  usage._resetCodexUsageForTest();
  const seats = [{ alias: 'charlie' }, { alias: 'alpha' }, { alias: 'bravo' }];
  const order = (strategy, now = NOW) => accounts.orderCodexSeats(seats, now, { strategy, floor: 0.02 }).map((s) => s.alias).join(',');
  check('no readings: every strategy is alphabetical', order('headroom') === 'alpha,bravo,charlie' && order('fill-first') === 'alpha,bravo,charlie' && order('expiring-first') === 'alpha,bravo,charlie');

  const rec = (alias, used, resetInMs) => usage.recordCodexUsage(alias, { primary: { usedPercent: used, windowMinutes: 10080, resetAt: NOW + resetInMs }, secondary: null, limitReached: null, observedAt: NOW, source: 'headers' });
  rec('alpha', 90, 5 * 86_400_000);
  rec('bravo', 10, 6 * 86_400_000);
  check('headroom: most headroom first; an unread seat counts as full', order('headroom') === 'charlie,bravo,alpha', order('headroom'));
  check('fill-first: alphabetical while above the floor', order('fill-first') === 'alpha,bravo,charlie', order('fill-first'));
  rec('charlie', 20, 1 * 86_400_000);
  check('expiring-first: soonest long-window reset first', order('expiring-first') === 'charlie,alpha,bravo', order('expiring-first'));
  rec('alpha', 99, 5 * 86_400_000);
  check('a seat at or under the floor goes last in every strategy', order('fill-first').endsWith(',alpha') && order('expiring-first').endsWith(',alpha') && order('headroom').endsWith(',alpha'), `${order('fill-first')} | ${order('expiring-first')} | ${order('headroom')}`);
}

// ---------------------------------------------------------------------------
header('selectCodexAccount: new conversations follow headroom, bound ones stay put');
// ---------------------------------------------------------------------------
const FAR = Date.now() + 3_600_000;
const jwt = (alias) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: alias })).toString('base64url')}.sig`;
async function seat(alias, accessToken) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({ alias, accessToken, refreshToken: `rt-${alias}`, expiresAt: FAR }));
}
await seat('alpha', jwt('alpha'));
await seat('bravo', jwt('bravo'));
await seat('plain', 'at-plain');
{
  usage._resetCodexUsageForTest();
  accounts._resetCodexPoolForTest();
  accounts.setCodexRouting({ strategy: 'headroom', floor: 0.02 });
  const first = await accounts.selectCodexAccount(undefined, { stickyKey: 'conv-1' });
  check('no readings: alphabetical, alpha', first?.alias === 'alpha', first?.alias);

  const now = Date.now();
  usage.recordCodexUsage('alpha', { primary: { usedPercent: 80, windowMinutes: 10080, resetAt: now + 86_400_000 }, secondary: null, limitReached: null, observedAt: now, source: 'headers' });
  usage.recordCodexUsage('bravo', { primary: { usedPercent: 5, windowMinutes: 10080, resetAt: now + 86_400_000 }, secondary: null, limitReached: null, observedAt: now, source: 'headers' });
  usage.recordCodexUsage('plain', { primary: { usedPercent: 50, windowMinutes: 10080, resetAt: now + 86_400_000 }, secondary: null, limitReached: null, observedAt: now, source: 'headers' });
  const fresh = await accounts.selectCodexAccount(undefined, { stickyKey: 'conv-2' });
  check('a NEW conversation goes to the seat with the most headroom', fresh?.alias === 'bravo', fresh?.alias);
  const bound = await accounts.selectCodexAccount(undefined, { stickyKey: 'conv-1' });
  check('a BOUND conversation keeps its seat (its prompt cache lives there)', bound?.alias === 'alpha', bound?.alias);

  accounts.noteCodexDecline('bravo', 60_000);
  const next = await accounts.selectCodexAccount(undefined, { stickyKey: 'conv-3' });
  check('a declined seat is skipped whatever its reading says', next?.alias === 'plain', next?.alias);
  const retry = await accounts.selectCodexAccountExcluding(new Set(['plain']));
  check('mid-flight failover follows the same order, minus tried and cooling', retry?.alias === 'alpha', retry?.alias);

  accounts.setCodexRouting({ strategy: 'fill-first', floor: 0.02 });
  accounts._resetCodexPoolForTest();
  const ff = await accounts.selectCodexAccount(undefined, { stickyKey: 'conv-4' });
  check('fill-first keeps the old alphabetical placement above the floor', ff?.alias === 'alpha', ff?.alias);
}

// ---------------------------------------------------------------------------
header('seed: /wham/usage, read-only, never a non-JWT token');
// ---------------------------------------------------------------------------
const hits = [];
const stub = createServer((req, res) => {
  hits.push({ url: req.url, method: req.method, auth: req.headers['authorization'] || '', acct: req.headers['chatgpt-account-id'] || null, ctype: req.headers['content-type'] || null });
  if (req.url === '/backend-api/wham/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(PROLITE_BODY));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
{
  check('usage URL is the Responses base\'s sibling', backend.CODEX_USAGE_URL === `http://127.0.0.1:${STUB_PORT}/backend-api/wham/usage`, backend.CODEX_USAGE_URL);
  usage._resetCodexUsageForTest();
  const all = await accounts.loadAllCodexAccounts();
  const alpha = all.find((a) => a.alias === 'alpha');
  const plain = all.find((a) => a.alias === 'plain');

  const ok = await backend.seedCodexUsage(alpha);
  check('a seat is read from /wham/usage', ok && usage.codexUsageFor('alpha')?.source === 'usage-endpoint', String(ok));
  const h = hits.at(-1);
  check('it is a GET with the seat\'s own bearer and no JSON body headers', h?.method === 'GET' && h.auth === `Bearer ${alpha.accessToken}` && h.ctype === null, JSON.stringify(h));

  const before = hits.length;
  check('a non-JWT token is never sent', (await backend.seedCodexUsage(plain)) === false && hits.length === before);

  usage._resetCodexUsageForTest();
  usage.recordCodexUsage('bravo', { primary: { usedPercent: 1, windowMinutes: 10080, resetAt: null }, secondary: null, limitReached: null, observedAt: Date.now(), source: 'headers' });
  const n = hits.length;
  const read = await backend.seedStaleCodexUsage(all, 30 * 60_000);
  check('only seats without a fresh reading are read (bravo answered recently; plain is not a JWT)', read.join(',') === 'alpha' && hits.length === n + 1, `${read.join(',')} / ${hits.length - n} calls`);
}

// ---------------------------------------------------------------------------
header('dario codex list --live prints the usage line');
// ---------------------------------------------------------------------------
{
  const { formatLiveCodexListing } = await import('../dist/cli.js');
  const base = { expiresInMs: 3_600_000, requestCount: 3, status: 'ok', cooldownRemainingMs: 0, lastRefreshError: null };
  const lines = formatLiveCodexListing([
    { alias: 'fleet', ...base, usage: { headroom: 0.94, limitReached: null, source: 'usage-endpoint', observedAt: new Date(NOW).toISOString(), windows: [{ slot: 'primary', usedPercent: 6, windowMinutes: 10080, resetAt: new Date(NOW + 6 * 86_400_000 + 22 * 3_600_000).toISOString() }] } },
    { alias: 'fresh', ...base, usage: null },
    { alias: 'old-proxy', ...base },
  ], 3456, NOW).join('\n');
  check('a read seat shows used %, window, reset and headroom', lines.includes('usage: 6% of 7d, resets in 6d 22h — 94% headroom (from /wham/usage)'), lines);
  check('an unread seat says so', lines.includes('usage: no reading yet'));
  check('a proxy older than the reading prints no usage line for its seats', lines.split('\n').filter((l) => l.includes('usage:')).length === 2);
}

await new Promise((r) => stub.close(r));
await rm(sandbox, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

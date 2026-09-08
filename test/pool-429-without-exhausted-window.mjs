#!/usr/bin/env node
// dario#1244 follow-up (2026-09-08) — a 429 that names no exhausted window.
//
// The fleet box parked a seat for 546 HOURS on this exact reading:
//
//     rate limited (429) on account "pro1": 5h 0%, 7d 0%, claim unknown,
//     resets in 546h 49m — parked until the window rolls
//
// Nothing in that 429 said a window was over: no claim, 0% on both windows,
// and a reset three weeks out that was not this seat's window rolling. The
// status code alone decided, and `reset` was honoured blindly.
//
// Now the headers decide. A known claim with a utilization at or past the 1.0
// threshold (the unified headers are a ratio against `surpassed-threshold:
// 1.0`; every live rejection has read 1.00–1.06) parks until `reset` as
// before. Anything else cools for the response's own `retry-after`, or a
// minute, and stays probeable — the seat is back in rotation on its own
// terms, not three weeks later.

import {
  AccountPool, EMPTY_SNAPSHOT, parseRateLimits, isWindowRejection, isParkedInLiveWindow,
  accountIneligibility, reportedAccountStatus, accountAction, rateLimitWindowPassed,
  describeRejection, parseRetryAfterMs, NON_WINDOW_REJECTION_COOLDOWN_MS,
  isCoolingAfterRejection, isProbeable,
} from '../dist/pool.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log(`  OK ${n}`); pass++; } else { console.log(`  FAIL ${n}${d !== undefined ? ' :: ' + JSON.stringify(d) : ''}`); fail++; } };
const header = (n) => console.log(`\n=== ${n} ===`);

const NOW = Date.now();
const SECS = Math.floor(NOW / 1000);
const H = (o) => new Headers(o);
const seat = (pool, alias) => pool.add(alias, { accessToken: `t-${alias}`, refreshToken: `r-${alias}`, expiresAt: NOW + 8 * 3_600_000, deviceId: `d-${alias}`, accountUuid: `u-${alias}` });

// The fleet box's reading, as it came off the wire.
const PRO1 = H({
  'anthropic-ratelimit-unified-5h-utilization': '0',
  'anthropic-ratelimit-unified-7d-utilization': '0',
  'anthropic-ratelimit-unified-reset': String(SECS + 546 * 3600),
});
// The reporter's reading on #1244 — a genuine five-hour exhaustion.
const MATTEO = H({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1.02',
  'anthropic-ratelimit-unified-7d-utilization': '0.2',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(SECS + 85 * 60),
});

header('isWindowRejection — what the headers say, not what the status code says');
{
  check('no claim, 0% → not a window rejection', isWindowRejection(parseRateLimits(PRO1)) === false);
  check('five_hour at 1.02 → a window rejection', isWindowRejection(parseRateLimits(MATTEO)) === true);
  check('a claim at 30% → not a window rejection (some other refusal)', isWindowRejection({ ...EMPTY_SNAPSHOT, claim: 'five_hour', util5h: 0.3 }) === false);
  check('exactly 1.0 counts (the reporter read exactly 1 twice)', isWindowRejection({ ...EMPTY_SNAPSHOT, claim: 'five_hour', util5h: 1 }) === true);
  check('0.99 absorbs float formatting', isWindowRejection({ ...EMPTY_SNAPSHOT, claim: 'seven_day', util7d: 0.99 }) === true);
  check('a per-model bucket at the threshold counts', isWindowRejection({ ...EMPTY_SNAPSHOT, claim: 'seven_day_overage_included', perModel7d: { oi: 1.0 } }) === true);
}

header("the fleet box's 429: cooled for a minute, not parked for 546 hours");
{
  const pool = new AccountPool();
  seat(pool, 'pro1'); seat(pool, 'login');
  const transition = pool.markRejected('pro1', parseRateLimits(PRO1));
  const a = pool.get('pro1');
  check('the transition is reported (worth a log line)', transition === true);
  check('classified as not exhausted', a.rateLimit.exhausted === false, a.rateLimit);
  check('status is rejected while cooling', a.rateLimit.status === 'rejected' && reportedAccountStatus(a, NOW) === 'rejected');
  check('ineligible while cooling', accountIneligibility(a, NOW) === 'rate-limited');
  check('...but NOT parked in a live window: the stated reset is not this seat\'s window', isParkedInLiveWindow(a, NOW) === false);
  check('the stated reset is still on the record for the operator to see', a.rateLimit.reset > SECS + 500 * 3600);
  check('cools for the default minute when no retry-after was stated',
    a.rateLimit.cooldownUntil !== undefined && Math.abs(a.rateLimit.cooldownUntil - (a.rateLimit.updatedAt + NON_WINDOW_REJECTION_COOLDOWN_MS)) < 5, a.rateLimit.cooldownUntil);
  const later = a.rateLimit.cooldownUntil + 1;
  check('eligible again once the cool-down passes', accountIneligibility(a, later) === null && rateLimitWindowPassed(a.rateLimit, later) === true);
  check('...and reports unknown then, like any expired rejection', reportedAccountStatus(a, later) === 'unknown');
  check('action: wait while cooling (it comes back on its own), none after', accountAction(a, NOW) === 'wait' || accountAction(a, NOW) === 'none');
  check('the pool still has a seat to serve from', pool.select() !== null && pool.select().alias === 'login');
  check('the 429 is counted', a.rejectedCount === 1 && typeof a.lastRejectedAt === 'number');
  check('the log line says what happened and what was declined',
    /429 without an exhausted window \(5h 0%, 7d 0%, claim unknown; stated reset in 546h \d+m not honoured\) — cooling 1m, seat stays probeable/.test(describeRejection(a.rateLimit, NOW)),
    describeRejection(a.rateLimit, NOW));
}

header('retry-after is honoured when the upstream stated one');
{
  const pool = new AccountPool();
  seat(pool, 'a');
  const rl = parseRateLimits(H({ 'anthropic-ratelimit-unified-5h-utilization': '0.2', 'retry-after': '17' }));
  check('parsed to ms', rl.retryAfterMs === 17_000, rl.retryAfterMs);
  pool.markRejected('a', rl);
  const a = pool.get('a');
  check('cools for exactly retry-after', Math.abs(a.rateLimit.cooldownUntil - (a.rateLimit.updatedAt + 17_000)) < 5);
  check('an HTTP-date retry-after parses too', (() => { const ms = parseRetryAfterMs(new Date(NOW + 30_000).toUTCString(), NOW); return ms !== null && ms > 25_000 && ms <= 30_000; })());
  check('absent → null', parseRetryAfterMs(null) === null && parseRetryAfterMs('garbage') === null);
}

header("the reporter's 429 still parks until its reset (it named an exhausted window)");
{
  const pool = new AccountPool();
  seat(pool, 'matteo');
  pool.markRejected('matteo', parseRateLimits(MATTEO));
  const a = pool.get('matteo');
  check('classified as exhausted', a.rateLimit.exhausted === true);
  check('parked in a live window', isParkedInLiveWindow(a, NOW) === true && accountIneligibility(a, NOW) === 'rate-limited');
  check('no cool-down set', a.rateLimit.cooldownUntil === undefined);
  check('still parked a minute later', accountIneligibility(a, NOW + 61_000) === 'rate-limited');
  check('free once the window rolls', accountIneligibility(a, (SECS + 85 * 60) * 1000 + 1) === null);
  check('the log line is the parking line', /5h 102%, 7d 20%, claim five_hour, resets in 1h 25m — parked until the window rolls/.test(describeRejection(a.rateLimit, NOW)), describeRejection(a.rateLimit, NOW));
}

header('a snapshot from before the field behaves exactly as before');
{
  const pool = new AccountPool();
  seat(pool, 'old');
  // A peer-adopted or persisted reading with no `exhausted` field.
  pool.adoptSnapshot('old', { ...EMPTY_SNAPSHOT, status: 'rejected', claim: 'five_hour', util5h: 0.5, reset: SECS + 600, updatedAt: NOW }, true, 'peer');
  const a = pool.get('old');
  check('undefined exhausted → parked in its live window', isParkedInLiveWindow(a, NOW) === true);
  check('...until the reset', accountIneligibility(a, (SECS + 600) * 1000 + 1) === null);
}

header('the once-per-parking log contract survives: a repeat while cooling is not a transition');
{
  const pool = new AccountPool();
  seat(pool, 'a');
  check('first 429 → transition', pool.markRejected('a', parseRateLimits(PRO1)) === true);
  check('second 429 inside the cool-down → not a transition', pool.markRejected('a', parseRateLimits(PRO1)) === false);
}

header('the cool-down is not bypassable by the fallback paths (#1264 review)');
{
  // Redline's finding on #1264. `isParkedInLiveWindow` deliberately reports
  // false for a cooling seat, and BOTH fallback filters used that alone - so a
  // seat that had just answered `retry-after: 17` could be retried inside the
  // same client request, which is the retry storm the cool-down prevents.
  const pool = new AccountPool();
  seat(pool, 'cooling'); seat(pool, 'parked');
  pool.markRejected('cooling', parseRateLimits(H({ 'anthropic-ratelimit-unified-5h-utilization': '0.2', 'retry-after': '17' })));
  pool.markRejected('parked', parseRateLimits(MATTEO));
  const a = pool.get('cooling');

  check('the cooling seat is not parked in a live window (unchanged)', isParkedInLiveWindow(a, NOW) === false);
  check('...but it IS cooling, and therefore not probeable', isCoolingAfterRejection(a, NOW) === true && isProbeable(a, NOW) === false);
  check('select() does not hand it out while it cools', pool.select() === null, pool.select()?.alias);
  check('mid-flight failover does not hand it out either', pool.selectExcluding(new Set(['parked'])) === null, pool.selectExcluding(new Set(['parked']))?.alias);

  const until = pool.parkedUntil(NOW);
  check('parkedUntil covers the mixed parked+cooling pool, at the earliest return',
    until !== null && Math.abs(until - a.rateLimit.cooldownUntil) < 5, until);
  check('parkedCount counts both', pool.parkedCount(NOW) === 2);

  // Once the cool-down passes the seat is ordinary again - eligible, so it
  // never even reaches the fallback filter.
  const after = a.rateLimit.cooldownUntil + 1;
  check('after the cool-down it is probeable and eligible',
    isProbeable(a, after) === true && accountIneligibility(a, after) === null);
  check('parkedUntil is null again once a seat can serve', pool.parkedUntil(after) === null);
}

header('an auth cool-down is still NOT a rate limit (contract preserved)');
{
  const pool = new AccountPool();
  seat(pool, 'a'); seat(pool, 'b');
  pool.markRejected('a', parseRateLimits(MATTEO));
  pool.markAuthFailure('b');
  check('a pool mixing parked with auth-cooling is not "all over their windows"', pool.parkedUntil(NOW) === null);
}

console.log(`\npool-429-without-exhausted-window: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

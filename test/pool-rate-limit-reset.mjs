// A rate-limit rejection expires with the window that produced it.
//
// A `rejected` account is filtered out of `select()`, so it is sent no further
// requests, so `updateRateLimits` never runs for it and its snapshot never
// refreshes. The rejection therefore outlived the window it described: the only
// ways back into rotation were the all-exhausted fallback inside `select()` and
// a proxy restart.
//
// Observed on the fleet box (2026-09-06): one seat sat parked on a 106%
// five-hour reading while a second subscription carried every request. Its
// window reset twenty minutes later and it would have stayed parked regardless,
// for as long as the healthy seat held out — reported to the operator as
// `status: rejected` the whole time.
//
// `anthropic-ratelimit-unified-reset` states when the window rolls over, so the
// rejection is allowed to expire on it. The unit trap is that the header is
// epoch SECONDS while `now` is milliseconds; the units block below is what
// fails if the conversion is ever dropped.

import {
  AccountPool,
  EMPTY_SNAPSHOT,
  accountIneligibility,
  isAccountEligible,
  rateLimitWindowPassed,
  reportedAccountStatus,
  rateLimitWindow,
  describeRateLimitSnapshot,
} from '../dist/pool.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`, ...rest); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const NOW = 1_788_715_000_000;          // fixed clock, ms
const SECS = Math.floor(NOW / 1000);
const HOUR_MS = 3_600_000;
// Token expiry has to clear BOTH clocks: the frozen NOW the pure-function
// checks pass in, and the real one `select()` reads for itself. Anchoring to
// whichever is later keeps that true however long after NOW the suite runs.
const NOT_EXPIRING = Math.max(NOW, Date.now()) + 8 * HOUR_MS;

function poolWith(aliases) {
  const pool = new AccountPool();          // default strategy: max-headroom
  for (const alias of aliases) {
    pool.add(alias, {
      accessToken: `tok-${alias}`,
      refreshToken: `ref-${alias}`,
      expiresAt: NOT_EXPIRING,
      deviceId: `dev-${alias}`,
      accountUuid: `uuid-${alias}`,
    });
  }
  return pool;
}

/** Park `alias` as rate-limited, with a reset at `resetSecs` (epoch seconds). */
function park(pool, alias, resetSecs, util5h = 1.06) {
  pool.markRejected(alias, { ...EMPTY_SNAPSHOT, util5h, reset: resetSecs });
}

// ----------------------------------------------------------------------
header('rateLimitWindowPassed — the reset moment, in the header\'s own unit');
// ----------------------------------------------------------------------
{
  check('reset in the past → passed',
    rateLimitWindowPassed({ ...EMPTY_SNAPSHOT, reset: SECS - 60 }, NOW) === true);
  check('reset in the future → not passed',
    rateLimitWindowPassed({ ...EMPTY_SNAPSHOT, reset: SECS + 60 }, NOW) === false);
  check('reset exactly now → passed (the window has rolled)',
    rateLimitWindowPassed({ ...EMPTY_SNAPSHOT, reset: SECS }, NOW) === true);
  check('no reset stated (0) → never passes, nothing to expire',
    rateLimitWindowPassed({ ...EMPTY_SNAPSHOT, reset: 0 }, NOW) === false);

  // The unit trap. `reset` is epoch SECONDS; `now` is milliseconds. Drop the
  // x1000 and every future reset (~1.79e9) compares below every now (~1.79e12),
  // so EVERY rejection would read as expired and a genuinely throttled account
  // would be handed straight back to the router.
  check('a reset an hour in the FUTURE is not treated as expired (seconds vs ms)',
    rateLimitWindowPassed({ ...EMPTY_SNAPSHOT, reset: SECS + 3600 }, NOW) === false);
  check('a reset a full day ahead is not treated as expired',
    rateLimitWindowPassed({ ...EMPTY_SNAPSHOT, reset: SECS + 86400 }, NOW) === false);
}

// ----------------------------------------------------------------------
header('accountIneligibility — a parked seat returns when its window rolls');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a']);
  const acct = pool.get('a');

  park(pool, 'a', SECS + 600);
  check('rejected, reset still ahead → rate-limited',
    accountIneligibility(acct, NOW) === 'rate-limited');
  check('and therefore not eligible', isAccountEligible(acct, NOW) === false);

  park(pool, 'a', SECS - 1);
  check('rejected, reset passed → eligible again',
    accountIneligibility(acct, NOW) === null);
  check('isAccountEligible agrees', isAccountEligible(acct, NOW) === true);

  park(pool, 'a', 0);
  check('rejected with no reset stated → stays parked',
    accountIneligibility(acct, NOW) === 'rate-limited');
}

// ----------------------------------------------------------------------
header('the other ineligibility reasons still outrank an expired rejection');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a']);
  const acct = pool.get('a');
  park(pool, 'a', SECS - 1);          // expired rejection = no longer a reason

  acct.expiresAt = NOW - 1;
  check('expired token still ineligible, not resurrected by the reset',
    accountIneligibility(acct, NOW) === 'token-expired');

  acct.expiresAt = NOT_EXPIRING;
  pool.markAuthFailure('a');
  check('auth cool-down still ineligible',
    accountIneligibility(acct, Date.now()) === 'auth-cooldown');
  pool.clearAuthFailure('a');
  check('cleared → eligible again', isAccountEligible(acct, NOW) === true);
}

// ----------------------------------------------------------------------
header('reportedAccountStatus — what the operator surfaces say');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a']);
  const acct = pool.get('a');

  park(pool, 'a', SECS + 600);
  check('still inside the window → rejected', reportedAccountStatus(acct, NOW) === 'rejected');

  park(pool, 'a', SECS - 1);
  // Not 'allowed': the window rolled over, but nothing has measured the account
  // since. 'unknown' is what a never-used seat reports, and that is this state.
  check('window rolled, nothing measured since → unknown',
    reportedAccountStatus(acct, NOW) === 'unknown');

  pool.updateRateLimits('a', { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.1, reset: SECS + 600 });
  check('a real reading wins → allowed', reportedAccountStatus(acct, NOW) === 'allowed');

  pool.markAuthFailure('a');
  check('auth cool-down outranks the rate-limit reading',
    reportedAccountStatus(acct, Date.now()) === 'auth-cooldown');
}

// ----------------------------------------------------------------------
header('routing — a recovered seat is reachable again, not just re-labelled');
// ----------------------------------------------------------------------
{
  // `a` is parked on a stale rejection but has far more headroom than the
  // healthy `b`. While the rejection stands, `select()` can only see `b`.
  //
  // These offsets are anchored to the REAL clock, not the frozen NOW above:
  // `select()` reads `Date.now()` itself and takes no `now` parameter, so a
  // fixed constant silently drifts into the past and a reset meant to be in
  // the future expires for real once the suite has been around long enough.
  const realSecs = Math.floor(Date.now() / 1000);
  const pool = poolWith(['a', 'b']);
  pool.updateRateLimits('b', { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.80, reset: realSecs + 600 });

  // A 429 reading 10% shows no exhausted window, so since 6.0.39 it is not
  // parked on its stated reset at all: it cools for the response's
  // retry-after (or a minute) and stays probeable
  // (pool-429-without-exhausted-window.mjs). While it cools, select() can
  // only see `b`; once the cool-down passes, `a` is reachable again with the
  // headroom its reading actually shows.
  park(pool, 'a', realSecs + 600, 0.10);
  check('while its cool-down runs, the rejected seat is skipped', pool.select()?.alias === 'b');

  pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 0.10, reset: realSecs - 1, updatedAt: Date.now() - 120_000 });
  check('once the cool-down passes, the seat with the real headroom is chosen',
    pool.select()?.alias === 'a');
}

// ----------------------------------------------------------------------
header('an expired rejection that is still real re-parks on the next 429');
// ----------------------------------------------------------------------
{
  // Letting the rejection expire is a decision to re-probe, not a claim the
  // account is free. If it 429s again, the fresh snapshot parks it again.
  const pool = poolWith(['a']);
  const acct = pool.get('a');
  park(pool, 'a', SECS - 1);
  check('re-probe allowed', isAccountEligible(acct, NOW) === true);

  park(pool, 'a', SECS + 900);        // the 429 upstream answers with a new window
  check('re-parked on the new window', isAccountEligible(acct, NOW) === false);
  check('and reported as rejected again', reportedAccountStatus(acct, NOW) === 'rejected');
}

// ----------------------------------------------------------------------
header('rateLimitWindow — the reset, surfaced (dario#1244)');
// ----------------------------------------------------------------------
{
  // The snapshot carried `reset` all along and routing expired rejections on
  // it; no operator surface showed it, so `rejected` never said until when.
  const ahead = rateLimitWindow({ ...EMPTY_SNAPSHOT, reset: SECS + 2220 }, NOW);
  check('resetAt is the header, in ms', ahead.resetAt === (SECS + 2220) * 1000);
  check('resetInMs counts down to it', ahead.resetInMs === 2220 * 1000);
  const passed = rateLimitWindow({ ...EMPTY_SNAPSHOT, reset: SECS - 60 }, NOW);
  check('a passed reset keeps resetAt', passed.resetAt === (SECS - 60) * 1000);
  check('and floors resetInMs at 0', passed.resetInMs === 0);
  const none = rateLimitWindow(EMPTY_SNAPSHOT, NOW);
  check('no reset stated → both null, not epoch 0', none.resetAt === null && none.resetInMs === null);
}

// ----------------------------------------------------------------------
header('describeRateLimitSnapshot — the parking log line');
// ----------------------------------------------------------------------
{
  const s = { ...EMPTY_SNAPSHOT, util5h: 1.04, util7d: 0.25, claim: 'five_hour', reset: SECS + 37 * 60 };
  check('reads the way an operator would say it',
    describeRateLimitSnapshot(s, NOW) === '5h 104%, 7d 25%, claim five_hour, resets in 37m', describeRateLimitSnapshot(s, NOW));
  check('hours and minutes past an hour',
    describeRateLimitSnapshot({ ...s, reset: SECS + 4 * 3600 + 59 * 60 }, NOW).endsWith('resets in 4h 59m'));
  check('a rolled window says so',
    describeRateLimitSnapshot({ ...s, reset: SECS - 1 }, NOW).endsWith('window already rolled'));
  check('no reset says so',
    describeRateLimitSnapshot({ ...s, reset: 0 }, NOW).endsWith('no reset stated'));
}

// ----------------------------------------------------------------------
header('markRejected — counts the attempt, reports the transition');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a']);
  const acct = pool.get('a');
  check('starts with no rejections', acct.rejectedCount === 0 && acct.lastRejectedAt === undefined);

  const parked = pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 1.04, reset: SECS + 600, updatedAt: NOW });
  check('the first 429 of a window parks the seat → true', parked === true);
  check('rejectedCount 1, requestCount untouched (a 429 served nothing)', acct.rejectedCount === 1 && acct.requestCount === 0);
  check('lastRejectedAt is the snapshot time', acct.lastRejectedAt === NOW);

  // The all-exhausted fallback re-probes parked seats; a 429 there is a
  // repeat, not a transition — the caller uses the boolean to log once.
  const again = pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 1.04, reset: SECS + 600, updatedAt: NOW + 1000 });
  check('a 429 while already parked is not a new parking → false', again === false);
  check('but is still counted', acct.rejectedCount === 2 && acct.lastRejectedAt === NOW + 1000);

  // A parking carries the reading that caused it (util at the threshold): a
  // 429 that shows no exhausted window is no longer parked on its reset at
  // all — it cools briefly instead (pool-429-without-exhausted-window.mjs).
  pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 1.04, reset: SECS - 1, updatedAt: NOW + 2000 });
  const reparked = pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 1.04, reset: SECS + 900, updatedAt: NOW + 3000 });
  check('a 429 after the previous window rolled is a new parking → true', reparked === true);

  check('unknown alias → false, nothing counted', pool.markRejected('nope', EMPTY_SNAPSHOT) === false);

  const pool2 = poolWith(['b']);
  const before = Date.now();
  pool2.markRejected('b', { ...EMPTY_SNAPSHOT, reset: SECS + 600 });
  check('a snapshot with no updatedAt stamps the wall clock', pool2.get('b').lastRejectedAt >= before);
}

// ----------------------------------------------------------------------
header('add() — a re-grant under the same alias starts the seat fresh (dario#1244)');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a']);
  pool.markRejected('a', { ...EMPTY_SNAPSHOT, util5h: 1.04, reset: SECS + 600, updatedAt: NOW });
  pool.markAuthFailure('a');
  const oldIdentity = pool.get('a').identity;

  // The routine reconcile: same grant → live state kept, tokens taken.
  pool.add('a', { accessToken: 'rotated', refreshToken: 'rotated-r', expiresAt: NOT_EXPIRING, deviceId: 'dev-a', accountUuid: 'uuid-a' });
  let acct = pool.get('a');
  check('same grant keeps the rejection', acct.rateLimit.status === 'rejected' && acct.rateLimit.reset === SECS + 600);
  check('same grant keeps the counters and the cool-down', acct.rejectedCount === 1 && acct.consecutiveAuthFailures === 1);
  check('same grant keeps the identity (session continuity)', acct.identity === oldIdentity);
  check('and takes the rotated tokens', acct.accessToken === 'rotated');

  // A re-login: a new grantedAt. The old organization's window, the old
  // streak and the old identity no longer describe this credential.
  const GRANT = NOW - 1000;
  pool.add('a', { accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: NOT_EXPIRING, deviceId: 'dev-a2', accountUuid: 'uuid-a2', grantedAt: GRANT });
  acct = pool.get('a');
  check('new grant clears the rejection', acct.rateLimit.status === 'unknown' && acct.rateLimit.reset === 0);
  check('new grant is eligible at once', isAccountEligible(acct, NOW) === true);
  check('new grant clears the auth cool-down', acct.consecutiveAuthFailures === 0 && acct.lastAuthFailureAt === undefined);
  check('new grant zeroes the counters', acct.requestCount === 0 && acct.rejectedCount === 0 && acct.lastRejectedAt === undefined);
  check('new grant takes the record\'s own identity', acct.identity.accountUuid === 'uuid-a2' && acct.identity.deviceId === 'dev-a2');
  check('grantedAt recorded', acct.grantedAt === GRANT);

  // The same grant reconciled again (after a refresh, say) keeps going.
  pool.updateRateLimits('a', { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.2, reset: SECS + 900 });
  pool.add('a', { accessToken: 'fresh2', refreshToken: 'fresh2-r', expiresAt: NOT_EXPIRING, deviceId: 'dev-a2', accountUuid: 'uuid-a2', grantedAt: GRANT });
  acct = pool.get('a');
  check('reconciling the same grant keeps its reading and count', acct.rateLimit.util5h === 0.2 && acct.requestCount === 1);

  // A record with no grantedAt (a seat minted before the field existed)
  // cannot be told apart from the same grant — state is kept, as before.
  pool.markRejected('a', { ...EMPTY_SNAPSHOT, reset: SECS + 600, updatedAt: NOW });
  pool.add('a', { accessToken: 'x', refreshToken: 'x-r', expiresAt: NOT_EXPIRING, deviceId: 'dev-a2', accountUuid: 'uuid-a2' });
  check('no grantedAt on the record → state kept', pool.get('a').rateLimit.status === 'rejected' && pool.get('a').grantedAt === GRANT);
}

console.log(`\npool-rate-limit-reset: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

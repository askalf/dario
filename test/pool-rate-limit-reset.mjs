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

  park(pool, 'a', realSecs + 600, 0.10);
  check('inside its window, the parked seat is skipped', pool.select()?.alias === 'b');

  park(pool, 'a', realSecs - 1, 0.10);
  check('once the window rolls, the seat with the real headroom is chosen',
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

console.log(`\npool-rate-limit-reset: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

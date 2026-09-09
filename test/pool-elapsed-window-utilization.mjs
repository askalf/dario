// A utilization reading expires with the window it was measured in.
//
// #1232 let a *rejection* expire against `anthropic-ratelimit-unified-reset`.
// The utilization on the same snapshot never got the same treatment, and that
// asymmetry strands a seat that never 429'd at all.
//
// A seat whose last response read `5h 99%` computes headroom 0.01, under
// POOL_HEADROOM_FLOOR (0.02). Below the floor the selector skips it,
// pickFillFirst won't take it, sticky bindings rebind away, and drainQueue's
// probe loop BREAKS on it. So nothing sends it a request, so updateRateLimits
// never runs, so the reading never refreshes. A rejection at least has the
// all-exhausted fallback; this seat has nothing, because it was never
// ineligible — only permanently unattractive.
//
// Reported on a nine-seat pool (dario#1244, 2026-09-09): all nine read 0.98 to
// 1.03, every one sat at or under the floor, and waitForAccount queued until it
// timed out — the whole pool reporting exhausted while two seats carried
// `reset_in_ms: 0` and were provably free, one of them having served exactly
// ONE request 3.7 hours earlier. `rejected_count` was 0 on every seat, which is
// why no rejection-side fix (#1232, #1254, the 6.0.39 cool-down) reached it.
//
// The two traps this locks down:
//   1. `reset` is epoch SECONDS against a millisecond clock.
//   2. Only the bucket the `claim` names may be dropped. A five-hour rollover
//      clearing a seven-day reading would route traffic onto a seat whose
//      weekly quota really is spent.

import {
  AccountPool,
  EMPTY_SNAPSHOT,
  computeHeadroom,
  expireElapsedWindow,
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

const NOW = 1_788_960_840_000;           // fixed clock, ms — the reporter's timestamp
const SECS = Math.floor(NOW / 1000);
const HOUR_MS = 3_600_000;
const FLOOR = 0.02;                      // POOL_HEADROOM_FLOOR, mirrored
const NOT_EXPIRING = Math.max(NOW, Date.now()) + 8 * HOUR_MS;

const near = (a, b) => Math.abs(a - b) < 1e-9;

// ----------------------------------------------------------------------
header('expireElapsedWindow — only a rolled-over window retires a reading');
// ----------------------------------------------------------------------
{
  const live = { ...EMPTY_SNAPSHOT, claim: 'five_hour', util5h: 0.99, reset: SECS + 600 };
  check('window still live → reading untouched',
    expireElapsedWindow(live, NOW).util5h === 0.99);

  const rolled = { ...EMPTY_SNAPSHOT, claim: 'five_hour', util5h: 0.99, reset: SECS - 600 };
  check('window rolled over → 5h reading dropped',
    expireElapsedWindow(rolled, NOW).util5h === 0);

  check('reset exactly now → rolled',
    expireElapsedWindow({ ...rolled, reset: SECS }, NOW).util5h === 0);
  check('no reset stated (0) → nothing to expire, reading kept',
    expireElapsedWindow({ ...rolled, reset: 0 }, NOW).util5h === 0.99);

  // The unit trap: reset is epoch SECONDS (~1.79e9), now is ms (~1.79e12).
  // Drop the x1000 and EVERY future reset compares below now, so every reading
  // in the pool would be discarded and genuinely throttled seats would serve.
  check('a reset an hour AHEAD is not treated as elapsed (seconds vs ms)',
    expireElapsedWindow({ ...live, reset: SECS + 3600 }, NOW).util5h === 0.99);
  check('a reset a full day ahead is not treated as elapsed',
    expireElapsedWindow({ ...live, reset: SECS + 86400 }, NOW).util5h === 0.99);

  check('pure — the input snapshot is not mutated',
    (() => { const s = { ...rolled }; expireElapsedWindow(s, NOW); return s.util5h === 0.99; })());
}

// ----------------------------------------------------------------------
header('expireElapsedWindow — only the bucket the claim names');
// ----------------------------------------------------------------------
{
  const both = { util5h: 0.99, util7d: 0.85, reset: SECS - 600 };

  const fiveHour = expireElapsedWindow({ ...EMPTY_SNAPSHOT, ...both, claim: 'five_hour' }, NOW);
  check('claim five_hour → 5h dropped', fiveHour.util5h === 0);
  check('claim five_hour → 7d KEPT (a 5h rollover is not a weekly rollover)',
    fiveHour.util7d === 0.85);

  const sevenDay = expireElapsedWindow({ ...EMPTY_SNAPSHOT, ...both, claim: 'seven_day' }, NOW);
  check('claim seven_day → 7d dropped', sevenDay.util7d === 0);
  check('claim seven_day → 5h KEPT', sevenDay.util5h === 0.99);

  const overage = expireElapsedWindow(
    { ...EMPTY_SNAPSHOT, ...both, claim: 'seven_day_overage_included' }, NOW);
  check('claim seven_day_overage_included → 7d dropped (same weekly window)',
    overage.util7d === 0);

  const unknown = expireElapsedWindow({ ...EMPTY_SNAPSHOT, ...both, claim: 'unknown' }, NOW);
  check('claim unknown → nothing dropped, nothing guessed',
    unknown.util5h === 0.99 && unknown.util7d === 0.85);
}

// ----------------------------------------------------------------------
header('a non-exhausted 429 must NOT have its reading zeroed by its cool-down');
// ----------------------------------------------------------------------
{
  // The 6.0.39 cool-down path: a 429 that named no exhausted window sets
  // `exhausted: false` and cools for retry-after. `rateLimitWindowPassed`
  // reports TRUE for such a seat the moment its cool-down elapses, whatever the
  // window says — so reusing that predicate here would zero a true 99% reading
  // a minute after the 429 and send traffic the seat cannot serve.
  const cooled = {
    ...EMPTY_SNAPSHOT,
    claim: 'five_hour',
    util5h: 0.99,
    reset: SECS + 3600,          // window very much still live
    exhausted: false,
    cooldownUntil: NOW - 1,      // cool-down already elapsed
  };
  check('cool-down elapsed but window live → reading KEPT',
    expireElapsedWindow(cooled, NOW).util5h === 0.99);
  check('and headroom stays under the floor',
    computeHeadroom(cooled, null, NOW) <= FLOOR);
}

// ----------------------------------------------------------------------
header('computeHeadroom — the stranded seat becomes selectable again');
// ----------------------------------------------------------------------
{
  // architecture_iyyapa from the report: one request, 3.7h ago, window rolled.
  const stranded = {
    ...EMPTY_SNAPSHOT,
    claim: 'five_hour',
    status: 'allowed_warning',
    util5h: 0.99,
    util7d: 0.19,
    reset: SECS - 3600,
  };
  check('before: the raw reading is under the floor',
    computeHeadroom({ ...stranded, reset: SECS + 3600 }, null, NOW) <= FLOOR);
  check('after: headroom comes from the 7d bucket that did NOT roll',
    near(computeHeadroom(stranded, null, NOW), 1 - 0.19));
  check('and it is comfortably over the floor',
    computeHeadroom(stranded, null, NOW) > FLOOR);

  // A per-model bucket still binds: a rolled 5h window must not mask a family
  // whose weekly bucket is spent.
  const perModel = { ...stranded, perModel7d: { sonnet: 0.995 } };
  check('a spent per-model 7d bucket still suppresses headroom for that family',
    computeHeadroom(perModel, 'sonnet', NOW) <= FLOOR);
  check('while another family still routes',
    computeHeadroom(perModel, 'opus', NOW) > FLOOR);
}

// ----------------------------------------------------------------------
header('the reported outage — nine stale seats no longer read as exhausted');
// ----------------------------------------------------------------------
{
  // Every seat under the floor on a stale reading, every window rolled.
  const aliases = ['lilli', 'suganthi', 'sciarrone', 'nisha', 'sairama', 'luca', 'naveen', 'iyyapa'];
  const pool = new AccountPool();
  for (const alias of aliases) {
    pool.add(alias, {
      accessToken: `tok-${alias}`,
      refreshToken: `ref-${alias}`,
      expiresAt: NOT_EXPIRING,
      deviceId: `dev-${alias}`,
      accountUuid: `uuid-${alias}`,
    });
    pool.updateRateLimits(alias, {
      ...EMPTY_SNAPSHOT,
      claim: 'five_hour',
      status: 'allowed_warning',
      util5h: 0.99,
      util7d: 0.25,
      reset: Math.floor(Date.now() / 1000) - 3600,   // real clock: select() reads it
    });
  }

  const picked = pool.select();
  check('select() returns a seat', picked !== null && picked !== undefined);
  check('and that seat is over the floor, so waitForAccount will not queue',
    picked ? computeHeadroom(picked.rateLimit) > FLOOR : false);

  // The regression this guards: with the windows still live, the same pool is
  // genuinely exhausted and must stay that way.
  for (const alias of aliases) {
    pool.updateRateLimits(alias, {
      ...EMPTY_SNAPSHOT,
      claim: 'five_hour',
      status: 'allowed_warning',
      util5h: 0.99,
      util7d: 0.25,
      reset: Math.floor(Date.now() / 1000) + 3600,   // live window
    });
  }
  const live = pool.select();
  check('windows live → every seat still under the floor (no false rescue)',
    live ? computeHeadroom(live.rateLimit) <= FLOOR : true);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

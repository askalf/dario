#!/usr/bin/env node
// dario#1262 follow-up (2026-09-21) — a 429 that names an exhausted PER-MODEL
// bucket while the seat's own windows have room parks that bucket's families,
// not the seat.
//
// Wire truth, fleet box, seat `pro1` (Pro plan, included overage spent),
// 2026-09-21T21:0xZ. A Fable request:
//
//     429  5h 0.03 allowed · 7d 0.83 allowed_warning · 7d_oi 1.02 rejected
//          claim seven_day_overage_included · reset = the 7d reset (3.3 days out)
//
// and the very next request on the same seat, Opus:
//
//     200  5h 0.03 · 7d 0.83 allowed_warning · claim seven_day · NO 7d_oi header
//
// Fable is metered on `oi` (WIRE_BUCKET_BINDINGS); Opus is not. The old
// `markRejected` read any bucket at the threshold as "the seat is over a
// window" and parked the whole seat until `reset` — three days with Opus,
// Sonnet and Haiku refused on a seat that was serving them. Now:
//
//   - the seat stays eligible for every family the bucket does not bind;
//   - it is ineligible (and not re-probed) for the families it does bind;
//   - an Opus 200 in between does not erase that, because Opus responses carry
//     no `7d_oi` header to re-learn it from;
//   - `parkedUntil` for the pool is per family: all-parked for fable, not for opus;
//   - the parking lifts at the bucket's own reset;
//   - a unified-window 429 (5h at 1.02) still parks the seat for everything.

import {
  AccountPool, parseRateLimits, isWindowRejection, isUnifiedWindowRejection, exhaustedBuckets,
  isBucketScopedRejection, isParkedInLiveWindow, isProbeable, accountIneligibility, activeParkedBuckets,
  familyParkedOnBuckets, withParkedBuckets, describeRejection, familiesBoundToBuckets, EMPTY_SNAPSHOT,
  reportedAccountStatus, accountAction,
} from '../dist/pool.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log(`  OK ${n}`); pass++; } else { console.log(`  FAIL ${n}${d !== undefined ? ' :: ' + JSON.stringify(d) : ''}`); fail++; } };
const header = (n) => console.log(`\n=== ${n} ===`);

const NOW = Date.now();
const SECS = Math.floor(NOW / 1000);
const RESET_7D = SECS + 3 * 24 * 3600 + 7 * 3600;
const H = (o) => new Headers(o);
const seat = (pool, alias) => pool.add(alias, { accessToken: `t-${alias}`, refreshToken: `r-${alias}`, expiresAt: NOW + 30 * 24 * 3_600_000, deviceId: `d-${alias}`, accountUuid: `u-${alias}` });

// pro1's Fable 429, as it came off the wire.
const PRO1_FABLE_429 = H({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-utilization': '0.83',
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
  'anthropic-ratelimit-unified-7d_oi-utilization': '1.02',
  'anthropic-ratelimit-unified-7d_oi-reset': String(RESET_7D),
  'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  'anthropic-ratelimit-unified-reset': String(RESET_7D),
  'anthropic-ratelimit-unified-status': 'rejected',
});
// pro1's Opus 200 seconds later — no 7d_oi header at all.
const PRO1_OPUS_200 = H({
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-utilization': '0.83',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-reset': String(RESET_7D),
  'anthropic-ratelimit-unified-status': 'allowed_warning',
});
// A genuine five-hour exhaustion (the dario#1244 reporter's reading).
const FIVE_HOUR_429 = H({
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1.02',
  'anthropic-ratelimit-unified-7d-utilization': '0.2',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(SECS + 85 * 60),
});

header('classifying the reading');
{
  const snap = parseRateLimits(PRO1_FABLE_429, 'fable');
  check('a bucket at 1.02 is still a window rejection (parks something)', isWindowRejection(snap) === true);
  check('but not a unified-window rejection (5h 3%, 7d 83%)', isUnifiedWindowRejection(snap) === false);
  check('the exhausted bucket is named', JSON.stringify(exhaustedBuckets(snap)) === '["oi"]', exhaustedBuckets(snap));
  check('five_hour at 1.02 IS a unified-window rejection', isUnifiedWindowRejection(parseRateLimits(FIVE_HOUR_429)) === true);
  check('families a bucket binds: oi → fable', JSON.stringify(familiesBoundToBuckets(snap, ['oi'])) === '["fable"]');
  check('a bucket named for a family binds it by name', JSON.stringify(familiesBoundToBuckets(EMPTY_SNAPSHOT, ['sonnet'])) === '["sonnet"]');
}

header('markRejected on the Fable 429 parks fable, not the seat');
{
  const pool = new AccountPool();
  seat(pool, 'login'); seat(pool, 'pro1');
  const parked = pool.markRejected('pro1', parseRateLimits(PRO1_FABLE_429, 'fable'));
  const pro1 = pool.get('pro1');
  check('the transition is reported (a log line is due)', parked === true);
  check('the rejection is bucket-scoped', isBucketScopedRejection(pro1.rateLimit) === true);
  check('parkedBuckets = [oi]', JSON.stringify(pro1.rateLimit.parkedBuckets) === '["oi"]', pro1.rateLimit);
  check('parked until the bucket reset', pro1.rateLimit.parkedBucketsUntil === RESET_7D * 1000, pro1.rateLimit.parkedBucketsUntil);
  check('fable is parked on the seat', familyParkedOnBuckets(pro1.rateLimit, 'fable', NOW) === true);
  check('opus is not', familyParkedOnBuckets(pro1.rateLimit, 'opus', NOW) === false);
  check('ineligible for fable', accountIneligibility(pro1, NOW, 'fable') === 'rate-limited');
  check('eligible for opus', accountIneligibility(pro1, NOW, 'opus') === null, accountIneligibility(pro1, NOW, 'opus'));
  check('eligible for sonnet', accountIneligibility(pro1, NOW, 'sonnet') === null);
  check('the seat-level question (no family) is not rate-limited', accountIneligibility(pro1, NOW) === null, accountIneligibility(pro1, NOW));
  check('parked in a live window FOR fable', isParkedInLiveWindow(pro1, NOW, 'fable') === true);
  check('not parked in a live window for opus', isParkedInLiveWindow(pro1, NOW, 'opus') === false);
  check('not parked in a live window at seat level', isParkedInLiveWindow(pro1, NOW) === false);
  check('not probeable for fable (the 429 named the reset)', isProbeable(pro1, NOW, 'fable') === false);
  check('probeable for opus', isProbeable(pro1, NOW, 'opus') === true);
  check("reported status is the seat's own reading, not the family's verdict", reportedAccountStatus(pro1, NOW) === 'allowed_warning', reportedAccountStatus(pro1, NOW));
  check('the action is none: nothing to wait for at seat level', accountAction(pro1, NOW) === 'none', accountAction(pro1, NOW));
  const line = describeRejection(pro1.rateLimit, NOW);
  check('the log line names the bucket and the family', /7d_oi exhausted: fable parked/.test(line), line);
  check('and says the seat still serves the rest', /other families still served/.test(line), line);
}

header('routing: select() respects the family');
{
  const pool = new AccountPool();
  seat(pool, 'login'); seat(pool, 'pro1');
  // login is the busier seat on every window (busier than pro1's 7d 83% on
  // the 429 reading too), so headroom alone would pick pro1 for everything.
  pool.updateRateLimits('login', { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.5, util7d: 0.9, updatedAt: NOW });
  pool.updateRateLimits('pro1', { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.03, util7d: 0.2, updatedAt: NOW });
  check('before the 429, fable would go to pro1 (more headroom)', pool.select('fable')?.alias === 'pro1');
  pool.markRejected('pro1', parseRateLimits(PRO1_FABLE_429, 'fable'));
  check('after it, fable goes to login', pool.select('fable')?.alias === 'login', pool.select('fable')?.alias);
  check('opus still goes to pro1', pool.select('opus')?.alias === 'pro1', pool.select('opus')?.alias);
  check('a request with no family still gets pro1', pool.select()?.alias === 'pro1');
  check('selectExcluding(login) for fable finds nothing eligible or probeable', pool.selectExcluding(new Set(['login']), 'fable') === null);
  check('selectExcluding(login) for opus finds pro1', pool.selectExcluding(new Set(['login']), 'opus')?.alias === 'pro1');
  check('the pool is not parked for opus', pool.parkedUntil(NOW, 'opus') === null);
  check('nor at seat level', pool.parkedUntil(NOW) === null);
  // Park login on a real five-hour window: now every seat is parked FOR FABLE only.
  pool.markRejected('login', parseRateLimits(FIVE_HOUR_429, 'fable'));
  check('all parked for fable → the earliest reset (login\'s 5h)', pool.parkedUntil(NOW, 'fable') === (SECS + 85 * 60) * 1000, pool.parkedUntil(NOW, 'fable'));
  check('opus is not all-parked: pro1 serves it', pool.parkedUntil(NOW, 'opus') === null && pool.select('opus')?.alias === 'pro1');
}

header('an Opus 200 in between does not forget the parked bucket');
{
  const pool = new AccountPool();
  seat(pool, 'pro1');
  pool.markRejected('pro1', parseRateLimits(PRO1_FABLE_429, 'fable'));
  pool.updateRateLimits('pro1', parseRateLimits(PRO1_OPUS_200, 'opus'));
  const pro1 = pool.get('pro1');
  check('the reading is the Opus response (allowed_warning)', pro1.rateLimit.status === 'allowed_warning', pro1.rateLimit.status);
  check('no 7d_oi on it', pro1.rateLimit.perModel7d.oi === undefined);
  check('parkedBuckets carried forward', JSON.stringify(activeParkedBuckets(pro1.rateLimit, NOW)) === '["oi"]', pro1.rateLimit);
  check('still ineligible for fable', accountIneligibility(pro1, NOW, 'fable') === 'rate-limited');
  check('still eligible for opus', accountIneligibility(pro1, NOW, 'opus') === null);
  check('the learned binding survives too', JSON.stringify(pro1.rateLimit.boundBuckets) === '{"fable":["oi"]}', pro1.rateLimit.boundBuckets);
  const after = RESET_7D * 1000 + 1;
  check('after the bucket reset, fable is back', accountIneligibility(pro1, after, 'fable') === null);
  check('withParkedBuckets past the reset carries nothing', withParkedBuckets(pro1.rateLimit, { ...EMPTY_SNAPSHOT, status: 'allowed' }, after).parkedBuckets === undefined);
}

header('a unified-window 429 still parks the seat for everything');
{
  const pool = new AccountPool();
  seat(pool, 'pro1');
  pool.markRejected('pro1', parseRateLimits(FIVE_HOUR_429, 'opus'));
  const pro1 = pool.get('pro1');
  check('not bucket-scoped', isBucketScopedRejection(pro1.rateLimit) === false);
  check('ineligible for opus', accountIneligibility(pro1, NOW, 'opus') === 'rate-limited');
  check('ineligible for fable', accountIneligibility(pro1, NOW, 'fable') === 'rate-limited');
  check('ineligible at seat level', accountIneligibility(pro1, NOW) === 'rate-limited');
  check('parked in a live window at seat level', isParkedInLiveWindow(pro1, NOW) === true);
  // A seat-wide park after a bucket park replaces it: the seat is over its own window now.
  const pool2 = new AccountPool();
  seat(pool2, 'pro1');
  pool2.markRejected('pro1', parseRateLimits(PRO1_FABLE_429, 'fable'));
  pool2.markRejected('pro1', parseRateLimits(FIVE_HOUR_429, 'opus'));
  check('a later seat-wide 429 clears the bucket scoping', isBucketScopedRejection(pool2.get('pro1').rateLimit) === false && pool2.get('pro1').rateLimit.parkedBuckets === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('PASS pool bucket-scoped parking');

#!/usr/bin/env node
// dario#1262 — Fable's weekly allowance arrives as `7d_oi`, not `7d_fable`.
//
// The reporter's standalone repro, verbatim: a Fable response carrying
// `7d 0.63, 7d_oi 0.98` read 0.37 headroom because `computeHeadroom` looked
// up `perModel7d.fable`, a bucket that has never been observed on the wire.
// `oi` is the plan's included-overage credit, and it is what Fable is metered
// on: at `7d_oi ≥ 1.0` a Max account answers Fable with a hard 429 while Opus
// keeps serving (live, 2026-07-05). So for Fable it IS the binding bucket.
//
// Two mechanisms, both asserted here: the static seed (`oi → fable`, from
// that evidence) so the repro is right from the first response; and learning
// — a seat whose response for family F carries an `*_overage_included` claim,
// or a `7d_<bucket>-status: rejected`, binds that bucket to F on that seat
// from then on, so Opus drawing on included overage is bound by `oi` for Opus
// exactly when its responses say so, and never by assumption.

import {
  AccountPool, EMPTY_SNAPSHOT, parseRateLimits, computeHeadroom, modelFamily,
  bucketsBindingFamily, mergeBoundBuckets, WIRE_BUCKET_BINDINGS,
} from '../dist/pool.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log(`  OK ${n}`); pass++; } else { console.log(`  FAIL ${n}${d !== undefined ? ' :: ' + JSON.stringify(d) : ''}`); fail++; } };
const header = (n) => console.log(`\n=== ${n} ===`);
const near = (a, b) => Math.abs(a - b) < 1e-9;

const H = (o) => new Headers(o);
const REPORTER = {
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-7d-utilization': '0.63',
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.98',
};

header("the reporter's repro, verbatim");
{
  const snapshot = parseRateLimits(H(REPORTER));
  const family = modelFamily('claude-fable-5-1');
  check('family is fable', family === 'fable');
  check('the wire bucket is stored under its wire name', snapshot.perModel7d.oi === 0.98 && snapshot.perModel7d.fable === undefined, snapshot.perModel7d);
  check('headroom for Fable is 0.02, not 0.37', near(computeHeadroom(snapshot, family), 0.02), computeHeadroom(snapshot, family));
  check('the seed says why', WIRE_BUCKET_BINDINGS.oi.includes('fable') && bucketsBindingFamily(snapshot, 'fable').includes('oi'));
}

header('the seed does NOT bind oi to other families by assumption');
{
  const snapshot = parseRateLimits(H(REPORTER));
  check('Opus headroom is the weekly window, 0.37', near(computeHeadroom(snapshot, 'opus'), 0.37), computeHeadroom(snapshot, 'opus'));
  check('Sonnet likewise', near(computeHeadroom(snapshot, 'sonnet'), 0.37));
  check('no family at all → unified buckets only', near(computeHeadroom(snapshot, null), 0.37));
}

header('a named family bucket still binds its own family (7d_sonnet, observed 2026-04-25)');
{
  const snapshot = parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.90' }));
  check('sonnet sees 7d_sonnet', near(computeHeadroom(snapshot, 'sonnet'), 0.10));
  check('fable does not see 7d_sonnet, does see oi', near(computeHeadroom(snapshot, 'fable'), 0.02));
}

header('learning: an overage-included claim on a response for family F binds oi to F');
{
  const opusDrawingOnCredit = parseRateLimits(H({
    ...REPORTER,
    'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  }), 'opus');
  check('the reading records the binding for opus', JSON.stringify(opusDrawingOnCredit.boundBuckets) === JSON.stringify({ opus: ['oi'] }), opusDrawingOnCredit.boundBuckets);
  check('opus headroom is now 0.02 on that reading', near(computeHeadroom(opusDrawingOnCredit, 'opus'), 0.02));
  const opusOnBase = parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-representative-claim': 'seven_day' }), 'opus');
  check('a base-window claim binds nothing', opusOnBase.boundBuckets === undefined && near(computeHeadroom(opusOnBase, 'opus'), 0.37));
  const noFamily = parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included' }));
  check('nothing to attribute to without a family', noFamily.boundBuckets === undefined);
}

header('learning: a 7d_<bucket>-status: rejected on a 429 for family F binds that bucket to F');
{
  const rejected = parseRateLimits(H({
    ...REPORTER,
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
    'anthropic-ratelimit-unified-status': 'rejected',
  }), 'sonnet');
  check('sonnet learns oi from the rejecting bucket', rejected.boundBuckets?.sonnet?.includes('oi') === true, rejected.boundBuckets);
  const allowedBucket = parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-7d_oi-status': 'allowed' }), 'sonnet');
  check('an allowed bucket status teaches nothing', allowedBucket.boundBuckets === undefined);
}

header('the binding persists on the seat across later readings');
{
  const pool = new AccountPool();
  pool.add('a', { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 8 * 3_600_000, deviceId: 'd', accountUuid: 'u' });
  pool.updateRateLimits('a', parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included' }), 'opus'));
  check('learned', pool.get('a').rateLimit.boundBuckets?.opus?.includes('oi') === true);
  // A later plain reading (base claim, no family attribution) must not forget it.
  pool.updateRateLimits('a', parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-7d_oi-utilization': '0.99', 'anthropic-ratelimit-unified-representative-claim': 'seven_day' })));
  check('kept across a reading that taught nothing', pool.get('a').rateLimit.boundBuckets?.opus?.includes('oi') === true, pool.get('a').rateLimit.boundBuckets);
  check('and applied: opus headroom on the seat is 0.01', near(computeHeadroom(pool.get('a').rateLimit, 'opus'), 0.01), computeHeadroom(pool.get('a').rateLimit, 'opus'));
  // A 429 reading merges too.
  pool.markRejected('a', parseRateLimits(H({ ...REPORTER, 'anthropic-ratelimit-unified-7d_oi-utilization': '1.0', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 600) }), 'fable'));
  const bb = pool.get('a').rateLimit.boundBuckets;
  check('a rejection merges: opus kept, fable added', bb?.opus?.includes('oi') === true && bb?.fable?.includes('oi') === true, bb);
}

header('mergeBoundBuckets is a per-family, order-preserving union');
{
  check('undefined + x = x', JSON.stringify(mergeBoundBuckets(undefined, { a: ['oi'] })) === JSON.stringify({ a: ['oi'] }));
  check('x + undefined = x', JSON.stringify(mergeBoundBuckets({ a: ['oi'] }, undefined)) === JSON.stringify({ a: ['oi'] }));
  check('union without duplicates', JSON.stringify(mergeBoundBuckets({ a: ['oi'] }, { a: ['oi', 'x'], b: ['y'] })) === JSON.stringify({ a: ['oi', 'x'], b: ['y'] }));
}

header('routing: a Fable-saturated seat is avoided for Fable, not for Opus');
{
  const pool = new AccountPool();
  for (const a of ['A', 'B']) pool.add(a, { accessToken: `t${a}`, refreshToken: `r${a}`, expiresAt: Date.now() + 8 * 3_600_000, deviceId: `d${a}`, accountUuid: `u${a}` });
  pool.updateRateLimits('A', parseRateLimits(H({ 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-7d-utilization': '0.5', 'anthropic-ratelimit-unified-7d_oi-utilization': '0.98' })));
  pool.updateRateLimits('B', parseRateLimits(H({ 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-7d-utilization': '0.6', 'anthropic-ratelimit-unified-7d_oi-utilization': '0.10' })));
  check('fable → B (A is two points from refusal)', pool.select(modelFamily('claude-fable-5-1'))?.alias === 'B');
  check('opus → A (more weekly headroom; oi is not opus\'s bucket here)', pool.select(modelFamily('claude-opus-5'))?.alias === 'A');
}

console.log(`\noi-bucket-binds-fable: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

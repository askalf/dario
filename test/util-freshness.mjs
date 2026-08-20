#!/usr/bin/env node
// dario#1032 — util5h/util7d freeze while an account is parked, and the
// /accounts payload carried no way to tell a frozen reading from a live one.
//
// robincle measured util5h pinned at exactly 1.01 across four samples over
// eleven minutes on a rejected account, while the account actively serving
// traffic moved normally and reset to 0 on schedule. The pool DOES return
// parked accounts to service on its own (confirmed in the report's own
// correction), so this is a reporting problem, not a routing one: a dashboard
// reading /accounts rendered "5-hour window full" for an account that had
// since reset and was free.

import { utilFreshness, EMPTY_SNAPSHOT, parseRateLimits } from '../dist/pool.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const NOW = 1_760_000_000_000;

header('dario#1032 — a frozen reading reports its age');
{
  // The reported shape: parked eleven minutes ago, util frozen at 1.01.
  const parked = { ...EMPTY_SNAPSHOT, status: 'rejected', util5h: 1.01, util7d: 0.62, updatedAt: NOW - 11 * 60_000 };
  const f = utilFreshness(parked, NOW);
  check('lastObservedAt is the observation time', f.lastObservedAt === NOW - 11 * 60_000);
  check('utilAgeMs is the age of the reading', f.utilAgeMs === 11 * 60_000);
  check('a consumer can now see the reading is 11 minutes old', f.utilAgeMs > 10 * 60_000);
}

header('a live reading reports a near-zero age');
{
  const live = { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.13, updatedAt: NOW };
  const f = utilFreshness(live, NOW);
  check('lastObservedAt is now', f.lastObservedAt === NOW);
  check('utilAgeMs is 0', f.utilAgeMs === 0);
}

header('never-observed accounts report null, not 56 years');
{
  // EMPTY_SNAPSHOT.updatedAt is 0. Reporting that as an age would render an
  // account that has simply never served a request as maximally stale.
  const f = utilFreshness(EMPTY_SNAPSHOT, NOW);
  check('lastObservedAt is null', f.lastObservedAt === null);
  check('utilAgeMs is null', f.utilAgeMs === null);
  check('null is distinguishable from a real 0 age', f.utilAgeMs !== 0);
}

header('clock skew cannot produce a negative age');
{
  const future = { ...EMPTY_SNAPSHOT, updatedAt: NOW + 5_000 };
  const f = utilFreshness(future, NOW);
  check('utilAgeMs floors at 0', f.utilAgeMs === 0);
}

header('parseRateLimits stamps updatedAt, so the field is always populated');
{
  const headers = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
  });
  const snap = parseRateLimits(headers);
  const f = utilFreshness(snap, Date.now());
  check('updatedAt set from a real header parse', typeof snap.updatedAt === 'number' && snap.updatedAt > 0);
  check('freshness derives a non-null age', f.utilAgeMs !== null && f.utilAgeMs < 5_000);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

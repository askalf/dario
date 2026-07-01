#!/usr/bin/env node
// Tests for the token-bucket rate limiter (#620), src/rate-limit.js.
// Deterministic — the clock is injected, so no sleeping.

import { createTokenBucket } from '../dist/rate-limit.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('Burst up to capacity, then throttle');
{
  let t = 0;
  const b = createTokenBucket(3, 1, () => t); // 3 burst, 1/s
  check('take 1', b.tryRemove() === true);
  check('take 2', b.tryRemove() === true);
  check('take 3', b.tryRemove() === true);
  check('4th is throttled', b.tryRemove() === false);
  check('retryAfterMs ~1000 when empty', b.retryAfterMs() === 1000);
}

// ─────────────────────────────────────────────────────────────
header('Refill over time');
{
  let t = 0;
  const b = createTokenBucket(2, 1, () => t); // 2 burst, 1/s
  b.tryRemove(); b.tryRemove();
  check('empty → throttled', b.tryRemove() === false);
  t = 1000; // 1s later → +1 token
  check('after 1s a token is available', b.tryRemove() === true);
  check('and only one', b.tryRemove() === false);
}

// ─────────────────────────────────────────────────────────────
header('Refill is capped at capacity');
{
  let t = 0;
  const b = createTokenBucket(2, 1, () => t);
  b.tryRemove(); b.tryRemove();
  t = 60_000; // a minute later — would be +60, but cap is 2
  check('take 1 (capped refill)', b.tryRemove() === true);
  check('take 2 (capped refill)', b.tryRemove() === true);
  check('3rd throttled — never exceeded capacity', b.tryRemove() === false);
}

// ─────────────────────────────────────────────────────────────
header('retryAfterMs reports partial refill');
{
  let t = 0;
  const b = createTokenBucket(1, 0.5, () => t); // 1 burst, 1 per 2s
  check('take the one token', b.tryRemove() === true);
  check('retryAfterMs ~2000 (0.5/s)', b.retryAfterMs() === 2000);
  t = 1000; // half a token accrued
  check('retryAfterMs ~1000 after 1s', b.retryAfterMs() === 1000);
}

// ─────────────────────────────────────────────────────────────
header('Zero refill never recovers');
{
  let t = 0;
  const b = createTokenBucket(1, 0, () => t);
  check('take the one token', b.tryRemove() === true);
  check('throttled', b.tryRemove() === false);
  t = 10_000;
  check('still throttled at t+10s', b.tryRemove() === false);
  check('retryAfterMs is Infinity', b.retryAfterMs() === Infinity);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

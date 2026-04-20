// Regression tests for the billing bucket derivation (#34).
//
// The goal is to give users a one-glance answer to "is dario actually
// routing my traffic through my subscription, or silently to API?".
// The derivation is a pure function on the `representative-claim` header
// so these tests don't need pool or proxy state — just the Analytics
// class and synthetic records.

import { Analytics, billingBucketFromClaim } from '../dist/analytics.js';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ======================================================================
//  billingBucketFromClaim — pure derivation
// ======================================================================
header('billingBucketFromClaim — maps raw claim to user-friendly bucket');
{
  check('five_hour → subscription', billingBucketFromClaim('five_hour') === 'subscription');
  check('five_hour_fallback → subscription_fallback', billingBucketFromClaim('five_hour_fallback') === 'subscription_fallback');
  check('seven_day → subscription', billingBucketFromClaim('seven_day') === 'subscription');
  check('seven_day_fallback → subscription_fallback', billingBucketFromClaim('seven_day_fallback') === 'subscription_fallback');
  check('overage → extra_usage', billingBucketFromClaim('overage') === 'extra_usage');
  check('api → api', billingBucketFromClaim('api') === 'api');
  check('empty string → unknown', billingBucketFromClaim('') === 'unknown');
  check('null → unknown', billingBucketFromClaim(null) === 'unknown');
  check('undefined → unknown', billingBucketFromClaim(undefined) === 'unknown');
  check('garbage → unknown', billingBucketFromClaim('garbage_value') === 'unknown');
}

// ======================================================================
//  computeStats — billingBucketBreakdown and subscriptionPercent
// ======================================================================
header('Analytics.summary — billingBucketBreakdown and subscriptionPercent');
{
  const a = new Analytics();
  const base = {
    timestamp: Date.now(),
    account: 'default',
    model: 'claude-opus-4-6',
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 10,
    util5h: 0.1, util7d: 0.01, overageUtil: 0,
    latencyMs: 100, status: 200, isStream: false, isOpenAI: false,
  };

  // 8 subscription + 1 extra_usage + 1 unknown = 10 total
  for (let i = 0; i < 8; i++) a.record({ ...base, claim: 'five_hour' });
  a.record({ ...base, claim: 'overage' });
  a.record({ ...base, claim: 'unknown' });

  const s = a.summary(60);
  check('subscription bucket count = 8', s.window.billingBucketBreakdown.subscription === 8);
  check('extra_usage bucket count = 1', s.window.billingBucketBreakdown.extra_usage === 1);
  check('unknown bucket count = 1', s.window.billingBucketBreakdown.unknown === 1);
  check('api bucket count = 0', s.window.billingBucketBreakdown.api === 0);
  check('subscription_fallback count = 0', s.window.billingBucketBreakdown.subscription_fallback === 0);

  // 8 subscription of 9 classified (10 - 1 unknown) = 88.89%
  check('subscriptionPercent ≈ 88.89%', Math.abs(s.window.subscriptionPercent - 88.89) < 0.1);
  check('allTime subscription count also = 8', s.allTime.billingBucketBreakdown.subscription === 8);
  check('allTime subscriptionPercent matches window', s.allTime.subscriptionPercent === s.window.subscriptionPercent);
}

// ======================================================================
//  computeStats — clean 100% subscription
// ======================================================================
header('Analytics.summary — 100% subscription case');
{
  const a = new Analytics();
  const base = {
    timestamp: Date.now(),
    account: 'default',
    model: 'claude-opus-4-6',
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
    util5h: 0.1, util7d: 0.01, overageUtil: 0,
    latencyMs: 100, status: 200, isStream: false, isOpenAI: false,
  };
  for (let i = 0; i < 50; i++) a.record({ ...base, claim: 'five_hour' });
  const s = a.summary(60);
  check('50 subscription, 0 elsewhere', s.window.billingBucketBreakdown.subscription === 50);
  check('subscriptionPercent = 100', s.window.subscriptionPercent === 100);
}

// ======================================================================
//  computeStats — silent drain scenario (#34)
// ======================================================================
header('Analytics.summary — the bug scenario from mikelovatt (#34)');
{
  // @mikelovatt's complaint: dario appeared to be routing to subscription
  // but the subscription was draining slowly while extra_usage was burning
  // the real balance. The fix is making this case visible at a glance in
  // the /analytics summary — subscriptionPercent < 100% is the alarm.
  const a = new Analytics();
  const base = {
    timestamp: Date.now(),
    account: 'default',
    model: 'claude-opus-4-6',
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 10,
    util5h: 0.1, util7d: 0.01, overageUtil: 0,
    latencyMs: 100, status: 200, isStream: false, isOpenAI: false,
  };

  // 10 requests classified as overage (silent drain scenario)
  for (let i = 0; i < 10; i++) a.record({ ...base, claim: 'overage' });

  const s = a.summary(60);
  check('10 extra_usage, 0 subscription', s.window.billingBucketBreakdown.extra_usage === 10);
  check('subscriptionPercent = 0 — the alarm', s.window.subscriptionPercent === 0);
  check('extra_usage is the majority bucket', s.window.billingBucketBreakdown.extra_usage > s.window.billingBucketBreakdown.subscription);
}

// ======================================================================
//  Empty Analytics
// ======================================================================
header('Analytics.summary — empty state has zeroed buckets');
{
  const a = new Analytics();
  const s = a.summary(60);
  check('all buckets zero', s.window.billingBucketBreakdown.subscription === 0 &&
    s.window.billingBucketBreakdown.extra_usage === 0 &&
    s.window.billingBucketBreakdown.unknown === 0);
  check('subscriptionPercent = 0 on empty (no divide-by-zero)', s.window.subscriptionPercent === 0);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

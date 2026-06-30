/**
 * test/analytics-recording.mjs
 *
 * In-process unit tests for the Analytics class — parseUsage(), record(),
 * and summary(). Verifies that the wiring added in v3.8.0 produces the
 * right record shape and that /analytics would return real data instead of
 * placeholders.
 *
 * Runs without a live proxy or OAuth credentials.
 */

import { Analytics } from '../dist/analytics.js';

let pass = 0;
let fail = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}`);
    fail++;
  }
}

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

// ─── Synthetic response bodies ──────────────────────────────────────────────

const RESPONSE_BODY_TEXT = {
  id: 'msg_01abc',
  type: 'message',
  model: 'claude-sonnet-4-6',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello!' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 60,
  },
};

const RESPONSE_BODY_THINKING = {
  id: 'msg_02def',
  type: 'message',
  model: 'claude-opus-4-6',
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'A'.repeat(400) }, // 400 chars = ~100 tokens
    { type: 'text', text: 'Answer.' },
  ],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 200,
    output_tokens: 80,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

const RESPONSE_BODY_MINIMAL = {
  id: 'msg_03ghi',
  type: 'message',
  model: 'claude-haiku-4-5',
  role: 'assistant',
  content: [],
  stop_reason: 'end_turn',
  // No usage field
};

// ─── Test 1: Analytics.parseUsage() ─────────────────────────────────────────

console.log('\n======================================================================');
console.log('  1. Analytics.parseUsage() — standard response with cache fields');
console.log('======================================================================');
{
  const usage = Analytics.parseUsage(RESPONSE_BODY_TEXT);
  assertEq('inputTokens', usage.inputTokens, 120);
  assertEq('outputTokens', usage.outputTokens, 45);
  assertEq('cacheReadTokens', usage.cacheReadTokens, 30);
  assertEq('cacheCreateTokens', usage.cacheCreateTokens, 60);
  assertEq('thinkingTokens', usage.thinkingTokens, 0);
  assertEq('model', usage.model, 'claude-sonnet-4-6');
}

// ─── Test 2: Analytics.parseUsage() with thinking blocks ────────────────────

console.log('\n======================================================================');
console.log('  2. Analytics.parseUsage() — thinking block token estimation');
console.log('======================================================================');
{
  const usage = Analytics.parseUsage(RESPONSE_BODY_THINKING);
  assertEq('inputTokens', usage.inputTokens, 200);
  assertEq('outputTokens', usage.outputTokens, 80);
  // 400 chars / 4 = 100 thinking tokens
  assertEq('thinkingTokens', usage.thinkingTokens, 100);
  assertEq('model', usage.model, 'claude-opus-4-6');
}

// ─── Test 3: Analytics.parseUsage() — missing usage field ───────────────────

console.log('\n======================================================================');
console.log('  3. Analytics.parseUsage() — graceful zero on missing usage field');
console.log('======================================================================');
{
  const usage = Analytics.parseUsage(RESPONSE_BODY_MINIMAL);
  assertEq('inputTokens defaults to 0', usage.inputTokens, 0);
  assertEq('outputTokens defaults to 0', usage.outputTokens, 0);
  assertEq('cacheReadTokens defaults to 0', usage.cacheReadTokens, 0);
  assertEq('thinkingTokens defaults to 0', usage.thinkingTokens, 0);
  assertEq('model', usage.model, 'claude-haiku-4-5');
}

// ─── Test 4: Analytics.record() and summary() ───────────────────────────────

console.log('\n======================================================================');
console.log('  4. Analytics.record() — records stored and surfaced in summary()');
console.log('======================================================================');
{
  const a = new Analytics();

  const now = Date.now();
  const usage = Analytics.parseUsage(RESPONSE_BODY_TEXT);

  a.record({
    timestamp: now,
    account: 'account-a',
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreateTokens: usage.cacheCreateTokens,
    thinkingTokens: usage.thinkingTokens,
    claim: 'claude_max_pro',
    util5h: 0.12,
    util7d: 0.08,
    overageUtil: 0,
    latencyMs: 342,
    status: 200,
    isStream: false,
    isOpenAI: false,
  });

  const summary = a.summary();

  assertEq('allTime.requests === 1', summary.allTime.requests, 1);
  assertEq('window.requests === 1', summary.window.requests, 1);
  assertEq('allTime.totalInputTokens', summary.allTime.totalInputTokens, 120);
  assertEq('allTime.totalOutputTokens', summary.allTime.totalOutputTokens, 45);
  assert('perAccount has account-a', 'account-a' in summary.perAccount);
  assertEq('perAccount[a].requests', summary.perAccount['account-a'].requests, 1);
  assertEq('perAccount[a].lastClaim', summary.perAccount['account-a'].lastClaim, 'claude_max_pro');
  assert('perModel has claude-sonnet-4-6', 'claude-sonnet-4-6' in summary.perModel);
  assertEq('perModel[sonnet].requests', summary.perModel['claude-sonnet-4-6'].requests, 1);
  assert('estimatedCost > 0', summary.allTime.estimatedCost > 0);
  assertEq('avgLatencyMs', summary.window.avgLatencyMs, 342);
  assertEq('errorRate === 0', summary.window.errorRate, 0);

  // #600 regression — summary.utilization is the current-util object
  // {lastUtil5h,lastUtil7d}, not the old per-5min-bucket trend array (which
  // made the TUI rate-limit gauge read undefined → NaN%).
  assert('utilization is an object, not an array',
    !Array.isArray(summary.utilization) && typeof summary.utilization === 'object');
  assertEq('utilization.lastUtil5h = last record util5h', summary.utilization.lastUtil5h, 0.12);
  assertEq('utilization.lastUtil7d = last record util7d', summary.utilization.lastUtil7d, 0.08);
}

// ─── Test 5: Multiple records + error rate ───────────────────────────────────

console.log('\n======================================================================');
console.log('  5. Multiple records across two accounts — error rate + per-account');
console.log('======================================================================');
{
  const a = new Analytics();
  const now = Date.now();

  const successUsage = Analytics.parseUsage(RESPONSE_BODY_TEXT);
  const failUsage = Analytics.parseUsage(RESPONSE_BODY_MINIMAL);

  // 4 records: 3 successes + 1 429
  for (let i = 0; i < 3; i++) {
    a.record({
      timestamp: now - i * 1000,
      account: i % 2 === 0 ? 'account-a' : 'account-b',
      model: successUsage.model,
      inputTokens: successUsage.inputTokens,
      outputTokens: successUsage.outputTokens,
      cacheReadTokens: successUsage.cacheReadTokens,
      cacheCreateTokens: successUsage.cacheCreateTokens,
      thinkingTokens: 0,
      claim: 'claude_max_pro',
      util5h: 0.1, util7d: 0.05, overageUtil: 0,
      latencyMs: 200, status: 200, isStream: false, isOpenAI: false,
    });
  }

  // One 429
  a.record({
    timestamp: now - 5000,
    account: 'account-a',
    model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
    claim: 'claude_max_pro',
    util5h: 0.98, util7d: 0.85, overageUtil: 0,
    latencyMs: 50, status: 429, isStream: false, isOpenAI: false,
  });

  const summary = a.summary();
  assertEq('allTime.requests === 4', summary.allTime.requests, 4);
  assert('errorRate > 0', summary.allTime.errorRate > 0);
  assertEq('errorRate === 0.25', summary.allTime.errorRate, 0.25);
  assert('perAccount has account-a', 'account-a' in summary.perAccount);
  assert('perAccount has account-b', 'account-b' in summary.perAccount);
  assertEq('account-a requests', summary.perAccount['account-a'].requests, 3); // 2 success + 1 429
  assertEq('account-b requests', summary.perAccount['account-b'].requests, 1);
  assertEq('allTime.totalInputTokens', summary.allTime.totalInputTokens, 3 * 120); // 3 successes
}

// ─── Test 6: Streaming record with zero tokens (stream aborted early) ────────

console.log('\n======================================================================');
console.log('  6. Streaming 429 record (zero tokens) — analytic on failed stream');
console.log('======================================================================');
{
  const a = new Analytics();
  a.record({
    timestamp: Date.now(),
    account: 'account-a',
    model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
    claim: 'unknown', util5h: 1.0, util7d: 0.9, overageUtil: 0,
    latencyMs: 10, status: 429, isStream: true, isOpenAI: false,
  });
  const summary = a.summary();
  assertEq('stream 429 recorded', summary.allTime.requests, 1);
  assertEq('stream 429 tokens = 0', summary.allTime.totalInputTokens, 0);
  assertEq('errorRate = 1.0', summary.allTime.errorRate, 1);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

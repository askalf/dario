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

import { Analytics, consumerFromHeader, consumerFromBody } from '../dist/analytics.js';

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
  // Cache accounting on the summary: 30 read + 60 created beside 120 fresh
  // input, so 30 / 210 = 14.29% of prompt tokens came from cache.
  assertEq('allTime.totalCacheReadTokens', summary.allTime.totalCacheReadTokens, 30);
  assertEq('allTime.totalCacheCreateTokens', summary.allTime.totalCacheCreateTokens, 60);
  assertEq('allTime.cachedPromptPercent', summary.allTime.cachedPromptPercent, 14.29);
  assertEq('window.cachedPromptPercent', summary.window.cachedPromptPercent, 14.29);
  assert('perAccount has account-a', 'account-a' in summary.perAccount);
  assertEq('perAccount[a].requests', summary.perAccount['account-a'].requests, 1);
  assertEq('perAccount[a].cacheReadTokens', summary.perAccount['account-a'].cacheReadTokens, 30);
  assertEq('perAccount[a].cacheCreateTokens', summary.perAccount['account-a'].cacheCreateTokens, 60);
  assertEq('perAccount[a].cachedPromptPercent', summary.perAccount['account-a'].cachedPromptPercent, 14.29);
  assertEq('perModel[sonnet].avgCacheReadTokens', summary.perModel['claude-sonnet-4-6'].avgCacheReadTokens, 30);
  assertEq('perModel[sonnet].avgCacheCreateTokens', summary.perModel['claude-sonnet-4-6'].avgCacheCreateTokens, 60);
  assertEq('perModel[sonnet].cachedPromptPercent', summary.perModel['claude-sonnet-4-6'].cachedPromptPercent, 14.29);
  assertEq('empty summary carries zero cache fields', new Analytics().summary().window.cachedPromptPercent, 0);
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

// ─── Consumer attribution (dario#1244 follow-up) ────────────────────────────
console.log('\n=== consumerFromHeader ===');
assertEq('a plain token passes', consumerFromHeader('alice'), 'alice');
assertEq('trimmed', consumerFromHeader('  team-a/bob  '), 'team-a/bob');
assertEq('first value of a repeated header', consumerFromHeader(['carol', 'dave']), 'carol');
assertEq('spaces inside → absent', consumerFromHeader('alice smith'), undefined);
assertEq('non-ASCII → absent', consumerFromHeader('ålice'), undefined);
assertEq('over 64 chars → absent', consumerFromHeader('x'.repeat(65)), undefined);
assertEq('empty → absent', consumerFromHeader(''), undefined);
assertEq('missing → absent', consumerFromHeader(undefined), undefined);

console.log('\n=== consumerFromBody ===');
{
  const cc = (session) => ({ metadata: { user_id: `user_3f9a1c_account_7c1e2b3a-0000-4000-8000-000000000001_session_${session}` } });
  const a = consumerFromBody(cc('11111111-1111-4111-8111-111111111111'));
  const b = consumerFromBody(cc('22222222-2222-4222-8222-222222222222'));
  assert('a Claude Code user id yields a hashed key', typeof a === 'string' && /^u_[0-9a-f]{12}$/.test(a));
  assertEq('the same person across sessions is one key', a, b);
  assert('the account uuid never appears in the key', !a.includes('7c1e2b3a'));
  const other = consumerFromBody(cc('11111111-1111-4111-8111-111111111111').metadata ? { metadata: { user_id: 'user_ffffff_account_deadbeef-0000-4000-8000-000000000002_session_x' } } : {});
  assert('a different person is a different key', other !== a);
  const openai = consumerFromBody({ user: 'end-user-42' });
  assert('an OpenAI user field yields a hashed key', /^u_[0-9a-f]{12}$/.test(openai));
  assertEq('metadata.user_id wins over user', consumerFromBody({ metadata: { user_id: 'someone' }, user: 'else' }), consumerFromBody({ metadata: { user_id: 'someone' } }));
  assertEq('nothing to go on → absent', consumerFromBody({ model: 'x' }), undefined);
  assertEq('no body → absent', consumerFromBody(null), undefined);
}

console.log('\n=== summary().perConsumer ===');
{
  const an = new Analytics();
  const base = { model: 'claude-sonnet-5', cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0, claim: 'five_hour', util5h: 0.1, util7d: 0.1, overageUtil: 0, latencyMs: 100, status: 200, isStream: false, isOpenAI: false };
  an.record({ ...base, timestamp: Date.now(), consumer: 'alice', account: 'a', inputTokens: 100, outputTokens: 10 });
  an.record({ ...base, timestamp: Date.now(), consumer: 'alice', account: 'b', inputTokens: 300, outputTokens: 30, cacheReadTokens: 100 });
  an.record({ ...base, timestamp: Date.now(), consumer: 'bob', account: 'a', inputTokens: 50, outputTokens: 5 });
  an.record({ ...base, timestamp: Date.now(), account: 'a', inputTokens: 1, outputTokens: 1 });   // no consumer
  const s = an.summary();
  assertEq('alice: two requests', s.perConsumer.alice.requests, 2);
  assertEq('alice: input summed', s.perConsumer.alice.inputTokens, 400);
  assertEq('alice: seats she landed on, sorted', JSON.stringify(s.perConsumer.alice.accounts), '["a","b"]');
  assert('alice: cache share computed', s.perConsumer.alice.cachedPromptPercent > 0);
  assertEq('bob: one request', s.perConsumer.bob.requests, 1);
  assertEq('a record with no consumer is in no bucket', Object.keys(s.perConsumer).length, 2);
  assertEq('per-account totals unaffected', s.perAccount.a.requests, 3);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

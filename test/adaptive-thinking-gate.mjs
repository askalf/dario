#!/usr/bin/env node
// Adaptive-thinking model gate — dario#NNN.
//
// `thinking: { type: "adaptive" }` is gated per-model server-side.
// Live probe results (2026-05-15, OAuth subscription against
// api.anthropic.com):
//
//   claude-opus-4-7    ✓ 200
//   claude-opus-4-6    ✓ 200
//   claude-sonnet-4-6  ✓ 200
//   claude-opus-4-5    ✗ 400 "adaptive thinking is not supported on this model"
//   claude-sonnet-4-5  ✗ 400 same
//   claude-haiku-4-5   ✗ 400 same (but Haiku is already gated separately)
//
// The split is at the 4.6 minor — Anthropic added adaptive support in
// the 4.6 generation. Beta header state is irrelevant (verified across
// the full v2.1.142 beta set vs. minimal `oauth+claude-code` set; both
// hit the same rejection on 4-5).
//
// This file locks the gate behavior at the unit-test level so a
// regression to "always emit adaptive" breaks CI before it ships.

import { supportsAdaptiveThinking, buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('supportsAdaptiveThinking — empirical matrix (2026-05-15)');

// Models that empirically accept adaptive thinking
const adaptiveYes = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];
// Models that empirically 400 on adaptive thinking
const adaptiveNo = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-haiku-4-6',          // Haiku has never supported adaptive (matrix verified)
  'claude-opus-4-1',
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
];

for (const m of adaptiveYes) {
  check(`${m} → true`, supportsAdaptiveThinking(m) === true);
}
for (const m of adaptiveNo) {
  check(`${m} → false`, supportsAdaptiveThinking(m) === false);
}

// ─────────────────────────────────────────────────────────────
header('supportsAdaptiveThinking — forward-compat patterns');

// Future Opus 4-X (4.8, 4.10, 4.99) — assume same family extension
check('claude-opus-4-8 → true',  supportsAdaptiveThinking('claude-opus-4-8') === true);
check('claude-opus-4-10 → true', supportsAdaptiveThinking('claude-opus-4-10') === true);
check('claude-opus-4-99 → true', supportsAdaptiveThinking('claude-opus-4-99') === true);

// Future Opus 5+ (any minor or major-only)
check('claude-opus-5 → true',    supportsAdaptiveThinking('claude-opus-5') === true);
check('claude-opus-5-0 → true',  supportsAdaptiveThinking('claude-opus-5-0') === true);
check('claude-opus-10 → true',   supportsAdaptiveThinking('claude-opus-10') === true);

// Future Sonnet 5+
check('claude-sonnet-5 → true',   supportsAdaptiveThinking('claude-sonnet-5') === true);
check('claude-sonnet-5-0 → true', supportsAdaptiveThinking('claude-sonnet-5-0') === true);

// Default-deny on unrecognized shapes — never returns true for nonsense
check('empty string → false',    supportsAdaptiveThinking('') === false);
check('random string → false',   supportsAdaptiveThinking('not-a-real-model') === false);
check('gpt-4 → false',           supportsAdaptiveThinking('gpt-4') === false);
check('claude-2 → false',        supportsAdaptiveThinking('claude-2') === false);

// Dated suffixes (some 404, some work) — pattern should still match the
// generation prefix
check('claude-opus-4-7-20251024 → true',
  supportsAdaptiveThinking('claude-opus-4-7-20251024') === true);
check('claude-sonnet-4-5-20250929 → false',
  supportsAdaptiveThinking('claude-sonnet-4-5-20250929') === false);

// Case-insensitive
check('MiXeD CaSe sonnet-4-6 → true',
  supportsAdaptiveThinking('Claude-Sonnet-4-6') === true);

// ─────────────────────────────────────────────────────────────
header('buildCCRequest — gate applied on body output');

const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
const cacheControl = { type: 'ephemeral' };
const billingTag = 'x-anthropic-billing-header: cc_version=test;';

// Adaptive-supporting model: thinking + context_management present
{
  const body = buildCCRequest(
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  check('sonnet-4-6: thinking emitted',           body.thinking?.type === 'adaptive');
  check('sonnet-4-6: context_management emitted', body.context_management?.edits?.[0]?.type === 'clear_thinking_20251015');
  check('sonnet-4-6: output_config emitted',      typeof body.output_config?.effort === 'string');
}

// Non-adaptive model: both fields absent, output_config still present
for (const model of ['claude-sonnet-4-5', 'claude-opus-4-5']) {
  const body = buildCCRequest(
    { model, messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  check(`${model}: thinking is absent`,           body.thinking === undefined);
  check(`${model}: context_management is absent`, body.context_management === undefined);
  check(`${model}: output_config still emitted`,  typeof body.output_config?.effort === 'string');
}

// Haiku: nothing emitted (existing gate is unchanged)
{
  const body = buildCCRequest(
    { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  check('haiku: thinking is absent',           body.thinking === undefined);
  check('haiku: context_management is absent', body.context_management === undefined);
  check('haiku: output_config is absent',      body.output_config === undefined);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

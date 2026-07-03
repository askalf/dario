#!/usr/bin/env node
// betaForModel — fable-conditional `fallback-credit-2026-06-01` beta.
//
// Live captures (2026-06-09, CC v2.1.170): real CC appends
// `fallback-credit-2026-06-01` to the anthropic-beta set on FABLE requests
// only — the opus request from the same binary/account does not carry it.
// Subscription traffic on fable without the flag is soft-refused upstream:
// every request returns 200 with stop_reason "refusal" and empty content,
// while opus/sonnet answer normally (isolated on the live proxy 2026-06-09).
// dario therefore mirrors CC: append for the fable family, never for others.

import { betaForModel, FABLE_FALLBACK_CREDIT_BETA, CONTEXT_1M_BETA, MID_CONVERSATION_SYSTEM_BETA, EFFORT_BETA, CLAUDE_CODE_BETA, stripContext1mTag } from '../dist/proxy.js';
import { buildCCRequest } from '../dist/cc-template.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const BASE = 'claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24';

console.log('\n=== betaForModel — fable gets the fallback-credit beta ===');
check('fable full id → appended',
  betaForModel(BASE, 'claude-fable-5') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('fable [1m] id → appended',
  betaForModel(BASE, 'claude-fable-5[1m]') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('uppercase model → appended',
  betaForModel(BASE, 'CLAUDE-FABLE-5') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('already present → unchanged (no dup)',
  betaForModel(`${BASE},${FABLE_FALLBACK_CREDIT_BETA}`, 'claude-fable-5') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('empty base + fable → just the flag',
  betaForModel('', 'claude-fable-5') === FABLE_FALLBACK_CREDIT_BETA);

console.log('\n=== betaForModel — fallback-credit: every other family untouched ===');
// BASE carries no mid-conversation-system, so the per-model omissions below
// are no-ops here EXCEPT effort-2025-11-24 for haiku (which BASE does carry).
check('opus → no fallback-credit',   !betaForModel(BASE, 'claude-opus-4-8').includes(FABLE_FALLBACK_CREDIT_BETA));
check('sonnet → no fallback-credit', !betaForModel(BASE, 'claude-sonnet-4-6').includes(FABLE_FALLBACK_CREDIT_BETA));
check('haiku → no fallback-credit',  !betaForModel(BASE, 'claude-haiku-4-5').includes(FABLE_FALLBACK_CREDIT_BETA));
check('empty model → unchanged', betaForModel(BASE, '') === BASE);
check('null model → unchanged',  betaForModel(BASE, null) === BASE);
check('undefined model → unchanged', betaForModel(BASE, undefined) === BASE);

console.log('\n=== betaForModel — per-model transforms (CC v2.1.199 wire) ===');
// CC 2.1.199 (live capture 2026-07-03): sonnet-5 == opus (KEEPS
// mid-conversation-system — the 2.1.170 sonnet-4-6 drop is gone). Haiku drops
// mid-conversation-system + effort + afk-mode AND emits claude-code-20250219 in
// position 5 (before advisor-tool), not first. Fable inserts fallback-credit
// immediately before afk-mode.
{
  const FULL = 'claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31';
  const sonnetOut = betaForModel(FULL, 'claude-sonnet-5');
  check('sonnet-5 → KEEPS mid-conversation-system (2.1.199)', sonnetOut.includes(MID_CONVERSATION_SYSTEM_BETA));
  check('sonnet-5 → keeps effort', sonnetOut.includes(EFFORT_BETA));
  check('sonnet-5 → identical to base (== opus)', sonnetOut === FULL);
  const haikuOut = betaForModel(FULL, 'claude-haiku-4-5');
  check('haiku → drops mid-conversation-system', !haikuOut.includes(MID_CONVERSATION_SYSTEM_BETA));
  check('haiku → drops effort', !haikuOut.includes(EFFORT_BETA));
  check('haiku → drops afk-mode', !haikuOut.includes('afk-mode-2026-01-31'));
  check('opus → keeps everything', betaForModel(FULL, 'claude-opus-4-8') === FULL);
  check('fable → fallback-credit inserted BEFORE afk-mode',
    betaForModel(FULL, 'claude-fable-5') === 'claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,fallback-credit-2026-06-01,afk-mode-2026-01-31');
  check('haiku → claude-code-20250219 moved to position 5 (before advisor-tool)',
    haikuOut === 'interleaved-thinking-2025-05-14,claude-code-20250219,advisor-tool-2026-03-01');
}

console.log('\n=== betaForModel — context-1m rides on [1m] requests at position 2 (CC v2.1.199 wire) ===');
// Real CC sends context-1m ONLY for [1m]-labelled models, and at POSITION 2 —
// immediately after claude-code-20250219, not appended at the tail.
{
  const LEAN = 'claude-code-20250219,effort-2025-11-24'; // base without context-1m
  check('[1m] request → context-1m at position 2 (after claude-code)',
    betaForModel(LEAN, 'claude-sonnet-5[1m]') === `${CLAUDE_CODE_BETA},${CONTEXT_1M_BETA},effort-2025-11-24`);
  check('plain model → no context-1m',
    betaForModel(LEAN, 'claude-sonnet-5') === LEAN);
  check('fable[1m] → context-1m at position 2, fallback-credit at tail',
    betaForModel(LEAN, 'claude-fable-5[1m]') === `${CLAUDE_CODE_BETA},${CONTEXT_1M_BETA},effort-2025-11-24,${FABLE_FALLBACK_CREDIT_BETA}`);
  check('skipContext1m suppresses the [1m] insert (billing-cache fallback)',
    betaForModel(LEAN, 'claude-sonnet-5[1m]', true) === LEAN);
  check('skipContext1m does NOT suppress fable fallback-credit',
    betaForModel(LEAN, 'claude-fable-5[1m]', true) === `${LEAN},${FABLE_FALLBACK_CREDIT_BETA}`);
  check('base already carrying context-1m → no dup / no move',
    betaForModel(`${LEAN},${CONTEXT_1M_BETA}`, 'claude-opus-4-7[1m]') === `${LEAN},${CONTEXT_1M_BETA}`);
}

console.log('\n=== stripContext1mTag — [1m] is a label, never a wire id ===');
// Real CC sends base id + context-1m beta for `X[1m]` (capture 2026-06-09);
// the literal [1m] id 404s upstream on every family.
check('fable[1m] → base id',  stripContext1mTag('claude-fable-5[1m]') === 'claude-fable-5');
check('sonnet[1m] → base id', stripContext1mTag('claude-sonnet-4-6[1m]') === 'claude-sonnet-4-6');
check('opus[1m] → base id',   stripContext1mTag('claude-opus-4-7[1m]') === 'claude-opus-4-7');
check('uppercase tag → stripped', stripContext1mTag('claude-fable-5[1M]') === 'claude-fable-5');
check('no tag → unchanged',   stripContext1mTag('claude-fable-5') === 'claude-fable-5');
check('tag mid-string → unchanged (end-anchored)', stripContext1mTag('claude-[1m]-x') === 'claude-[1m]-x');

console.log('\n=== fable tool-less requests get CC tools + tool_choice none ===');
// Fable refuses tool-less CC-shaped multi-turn requests (replay bisect
// 2026-06-09); the same body with CC's tool array answers. tool_choice none
// pins the model from calling tools the client never declared.
{
  const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
  const cc = { type: 'ephemeral' };
  const mk = (model, tools) => buildCCRequest(
    { model, messages: [{ role: 'user', content: 'hi' }], ...(tools ? { tools } : {}) },
    'billing', cc, identity,
  ).body;

  const fable = mk('claude-fable-5');
  check('fable, no client tools → CC tools emitted', Array.isArray(fable.tools) && fable.tools.length > 0);
  check('fable, no client tools → tool_choice none', fable.tool_choice?.type === 'none');

  const opus = mk('claude-opus-4-8');
  check('opus, no client tools → no tools (legacy shape)', opus.tools === undefined);
  check('opus, no client tools → no tool_choice', opus.tool_choice === undefined);

  const fableTools = mk('claude-fable-5', [{ name: 'my_tool', description: 'd', input_schema: { type: 'object' } }]);
  check('fable, WITH client tools → no tool_choice pin', fableTools.tool_choice === undefined);
  check('fable, WITH client tools → tools present', Array.isArray(fableTools.tools) && fableTools.tools.length > 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

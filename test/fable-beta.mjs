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

import { betaForModel, FABLE_FALLBACK_CREDIT_BETA, stripContext1mTag } from '../dist/proxy.js';
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

console.log('\n=== betaForModel — every other family untouched ===');
check('opus → unchanged',   betaForModel(BASE, 'claude-opus-4-8') === BASE);
check('sonnet → unchanged', betaForModel(BASE, 'claude-sonnet-4-6') === BASE);
check('haiku → unchanged',  betaForModel(BASE, 'claude-haiku-4-5') === BASE);
check('empty model → unchanged', betaForModel(BASE, '') === BASE);
check('null model → unchanged',  betaForModel(BASE, null) === BASE);
check('undefined model → unchanged', betaForModel(BASE, undefined) === BASE);

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

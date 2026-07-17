#!/usr/bin/env node
/**
 * test/provider-adapter.mjs
 *
 * Truth table for the provider routing seam (`route`). Each row pins an input
 * context to the provider/fallback the request handler must pick; these lock in
 * the exact decision proxy.ts made inline before it was consolidated, so a
 * mismatch means the routing rule drifted.
 *
 * The mapping under test:
 *   - openai backend handles the request iff
 *       hasOpenAIBackend && isOpenAIPath && forcedProvider !== 'claude'
 *       && (forcedProvider === 'openai' || isOpenAIModel(model))
 *   - otherwise Claude handles it (incl. openai-shape + claude model, translated)
 *   - claude→openai pool fallback iff
 *       primary === claude && poolFallbackModel && hasOpenAIBackend
 *       && isOpenAIPath && poolSize > 0
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { route, openaiAdapter, claudeAdapter } from '../dist/provider-adapter.js';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

function ctx(over = {}) {
  return {
    isOpenAIPath: false,
    model: 'claude-opus-4-8',
    forcedProvider: null,
    hasOpenAIBackend: false,
    poolFallbackModel: null,
    poolSize: 1,
    ...over,
  };
}

// [label, ctx-overrides, expectedProvider, expectedFallback]
const CASES = [
  ['anthropic path, claude model, no backend', {}, 'claude', null],
  ['anthropic path, claude model, backend configured', { hasOpenAIBackend: true }, 'claude', null],

  ['chat path, gpt model, backend', { isOpenAIPath: true, model: 'gpt-4o', hasOpenAIBackend: true }, 'openai', null],
  ['chat path, o3 model, backend', { isOpenAIPath: true, model: 'o3-mini', hasOpenAIBackend: true }, 'openai', null],
  ['chat path, gpt model, NO backend → claude (translated)', { isOpenAIPath: true, model: 'gpt-4o', hasOpenAIBackend: false }, 'claude', null],
  ['chat path, claude model, backend → claude (openai→anthropic)', { isOpenAIPath: true, model: 'claude-opus-4-8', hasOpenAIBackend: true }, 'claude', null],

  ['forced openai on chat path, backend', { isOpenAIPath: true, model: 'gpt-4o', forcedProvider: 'openai', hasOpenAIBackend: true }, 'openai', null],
  ['forced openai but no backend → claude', { isOpenAIPath: true, model: 'gpt-4o', forcedProvider: 'openai', hasOpenAIBackend: false }, 'claude', null],
  ['forced claude w/ gpt model + backend → claude', { isOpenAIPath: true, model: 'gpt-4o', forcedProvider: 'claude', hasOpenAIBackend: true }, 'claude', null],
  ['forced openai on ANTHROPIC path → claude (reroute needs chat path)', { isOpenAIPath: false, model: 'gpt-4o', forcedProvider: 'openai', hasOpenAIBackend: true }, 'claude', null],

  ['fallback armed, chat path, backend, pool>0 → claude+openai', { isOpenAIPath: true, model: 'claude-opus-4-8', hasOpenAIBackend: true, poolFallbackModel: 'gpt-4o-mini', poolSize: 2 }, 'claude', 'openai'],
  ['fallback armed but anthropic path → no fallback', { isOpenAIPath: false, model: 'claude-opus-4-8', hasOpenAIBackend: true, poolFallbackModel: 'gpt-4o-mini', poolSize: 2 }, 'claude', null],
  ['fallback armed but empty pool → no fallback (503s)', { isOpenAIPath: true, model: 'claude-opus-4-8', hasOpenAIBackend: true, poolFallbackModel: 'gpt-4o-mini', poolSize: 0 }, 'claude', null],
  ['fallback armed but no backend → no fallback', { isOpenAIPath: true, model: 'claude-opus-4-8', hasOpenAIBackend: false, poolFallbackModel: 'gpt-4o-mini', poolSize: 2 }, 'claude', null],
  ['fallback + gpt model on chat path → openai primary (no fallback needed)', { isOpenAIPath: true, model: 'gpt-4o', hasOpenAIBackend: true, poolFallbackModel: 'gpt-4o-mini', poolSize: 2 }, 'openai', null],
];

header('route() reproduces the routing decision');
for (const [label, over, expProvider, expFallback] of CASES) {
  const d = route(ctx(over));
  const ok = d.provider === expProvider && d.fallback === expFallback;
  check(`${label}  →  ${d.provider}${d.fallback ? '+' + d.fallback : ''}`, ok);
  if (!ok) console.log(`      expected ${expProvider}${expFallback ? '+' + expFallback : ''}, got ${d.provider}${d.fallback ? '+' + d.fallback : ''} (${d.reason})`);
}

header('registry is order-independent (priority, not array order)');
{
  const rev = route(ctx({ isOpenAIPath: true, model: 'gpt-4o', hasOpenAIBackend: true }), [claudeAdapter, openaiAdapter]);
  check('reversed adapter array still routes gpt → openai', rev.provider === 'openai');
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);

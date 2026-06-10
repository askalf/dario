#!/usr/bin/env node
// fable-5 is baked into every model listing dario advertises.
//
// Regression guard: Claude Fable 5 (the current flagship, integrated v4.8.46)
// must appear in the OpenAI `/v1/models` response AND resolve through the
// short-alias map, so clients that enumerate models or use the `fable`
// shortcut always see it. Pairs with the doc listings (README / usage /
// commands / agent-compat) which are non-code and can't be asserted here.

import { OPENAI_MODELS_LIST, resolveClaudeAlias } from '../dist/proxy.js';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

console.log('\n=== /v1/models listing carries fable (+ [1m]) ===');
const ids = OPENAI_MODELS_LIST.data.map((m) => m.id);
check('list shape is { object: "list", data: [...] }', OPENAI_MODELS_LIST.object === 'list' && Array.isArray(OPENAI_MODELS_LIST.data));
check('claude-fable-5 present', ids.includes('claude-fable-5'));
check('claude-fable-5[1m] present', ids.includes('claude-fable-5[1m]'));
check('fable listed first (flagship)', ids[0] === 'claude-fable-5');
check('every entry is owned_by anthropic + has object:model', OPENAI_MODELS_LIST.data.every((m) => m.owned_by === 'anthropic' && m.object === 'model'));
// The full canonical set stays present alongside fable.
for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
  check(`${id} still listed`, ids.includes(id));
}

console.log('\n=== fable short aliases resolve to canonical ids ===');
check("'fable' -> claude-fable-5", resolveClaudeAlias('fable') === 'claude-fable-5');
check("'fable1m' -> claude-fable-5[1m]", resolveClaudeAlias('fable1m') === 'claude-fable-5[1m]');
// sibling aliases unaffected
check("'opus' -> claude-opus-4-8", resolveClaudeAlias('opus') === 'claude-opus-4-8');
check("'haiku' -> claude-haiku-4-5", resolveClaudeAlias('haiku') === 'claude-haiku-4-5');
check('full id passes through unchanged', resolveClaudeAlias('claude-fable-5') === 'claude-fable-5');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

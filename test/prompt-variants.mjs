#!/usr/bin/env node
// Per-model system-prompt variants: the map, the legacy fold, and the merge
// that keeps a live capture from wiping the baked variants.
//
// The bug this locks down (found live 2026-07-25): loadTemplate() returned
// EITHER the live cache OR the bundle. A live capture is one `claude --print`
// on one model, so it can never carry variants — meaning a fresh cache
// silently reverted every model-specific prompt to the base. The baked fable
// variant was therefore inert on exactly the machines that have CC installed,
// which is most of them. Verified before the fix: with a fresh cache present,
// CC_SYSTEM_PROMPT_FABLE === CC_SYSTEM_PROMPT.

import { promptVariantsOf, withBundledVariants, TEMPLATE_BASE_MODEL } from '../dist/live-fingerprint.js';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { console.log(`  OK ${name}`); pass++; } else { console.log(`  FAIL ${name}`); fail++; } };
const header = (n) => console.log(`\n=== ${n} ===`);

const liveish = (extra = {}) => ({
  _version: '2.1.220',
  _captured: new Date(0).toISOString(),
  _source: 'live',
  agent_identity: 'x',
  system_prompt: 'BASE',
  tools: [],
  tool_names: [],
  ...extra,
});

// ─────────────────────────────────────────────────────────────
header('promptVariantsOf — map plus the legacy single slot');
{
  check('no variants → empty object',
    Object.keys(promptVariantsOf(liveish())).length === 0);
  check('map passes through',
    promptVariantsOf(liveish({ system_prompt_variants: { 'opus-5': 'A' } }))['opus-5'] === 'A');
  check('legacy system_prompt_fable folds in under `fable`',
    promptVariantsOf(liveish({ system_prompt_fable: 'F' })).fable === 'F');
  check('map wins over the legacy slot for the same key',
    promptVariantsOf(liveish({ system_prompt_fable: 'OLD', system_prompt_variants: { fable: 'NEW' } })).fable === 'NEW');
  check('empty-string legacy slot is ignored, not folded as a variant',
    promptVariantsOf(liveish({ system_prompt_fable: '' })).fable === undefined);
  check('legacy and map coexist',
    (() => {
      const v = promptVariantsOf(liveish({ system_prompt_fable: 'F', system_prompt_variants: { 'opus-5': 'A' } }));
      return v.fable === 'F' && v['opus-5'] === 'A';
    })());
}

// ─────────────────────────────────────────────────────────────
header('withBundledVariants — the live cache must not wipe baked variants');
{
  // Reads the REAL bundle, so this also asserts the shipped bundle carries them.
  const merged = withBundledVariants(liveish());
  const v = promptVariantsOf(merged);
  check('bundle supplies fable to a variant-less live template', typeof v.fable === 'string' && v.fable.length > 0);
  check('bundle supplies opus-5', typeof v['opus-5'] === 'string' && v['opus-5'].length > 0);
  check('bundle supplies sonnet-5', typeof v['sonnet-5'] === 'string' && v['sonnet-5'].length > 0);
  check('the live base is left untouched', merged.system_prompt === 'BASE');
  check('every merged variant differs from the live base',
    Object.values(v).every((p) => p !== 'BASE'));

  // A future per-model live capture must supersede the bake without another change.
  const withOwn = withBundledVariants(liveish({ system_prompt_variants: { 'opus-5': 'LIVE-WINS' } }));
  check('a variant present on the live template wins over the bundle',
    promptVariantsOf(withOwn)['opus-5'] === 'LIVE-WINS');
  check('the other bundle variants still merge alongside it',
    typeof promptVariantsOf(withOwn).fable === 'string');
}

// ─────────────────────────────────────────────────────────────
header('base-model pin is shared with the bake');
{
  // An unpinned `claude --print` uses the user's DEFAULT model, which made the
  // captured "base" machine-specific (measured 10006 chars on a box defaulting
  // to Opus 5, vs 6764 pinned). capture-and-bake imports this same constant.
  check('TEMPLATE_BASE_MODEL is a concrete non-fable opus id',
    typeof TEMPLATE_BASE_MODEL === 'string' && /^claude-opus-/.test(TEMPLATE_BASE_MODEL));
  check('pin is not a floating family shorthand', TEMPLATE_BASE_MODEL !== 'opus');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

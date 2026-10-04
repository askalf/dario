#!/usr/bin/env node
// Per-model system prompt (dario#lock-step): CC 2.1.198 ships Fable a larger,
// model-specific system prompt than the shared base. dario must inject Fable's
// prompt for Fable requests and the base for everything else.

import { buildCCRequest, systemPromptForModel, resolveSystemPrompt, CC_SYSTEM_PROMPT, CC_SYSTEM_PROMPT_FABLE, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_SONNET5, CC_TEMPLATE } from '../dist/cc-template.js';
import { VARIANT_FAMILIES, missingVariantFamilies, baseVariantFamilies } from '../dist/live-fingerprint.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// Families the bundle records as sharing the base prompt: no variant is stored
// for them and they are served the base.
const BASE_FAMILIES = new Set(baseVariantFamilies(CC_TEMPLATE));

// The Fable marker is DERIVED, not pinned (#1087). A literal pin rotted twice
// in two days: CC 2.1.241 first condensed Fable's '# Communicating with the
// user' section and added '# Delivering work' (repinned in #1081), then the
// 2026-08-24 capture reverted Fable byte-for-byte to the pre-condensation
// 9220-char shape (repinned again in #1085) - same _version both times, so
// Anthropic is A/B-serving this variant at a fixed version and ANY literal
// prose pin is one remote-config flip from rot.
//
// The invariant the suite actually cares about is structural: the Fable variant
// carries content that appears in NONE of base / opus-5 / sonnet-5. That is
// what makes Fable distinct and routable, and it survives editorial drift.
//
// A Fable-only '# ' HEADING is the strongest form of that and stays the
// preferred marker - but it is not the only legitimate shape (#1089). The
// 2026-08-24T14:21Z capture dropped '# Communicating with the user' and kept
// only headings base or opus-5 also carry ('# Harness', '# Memory',
// '# Delivering work', ...), while still shipping six Fable-only paragraphs
// including the identity block. Fable was still distinct; only its HEADING SET
// had converged. So marker derivation falls back to substantial Fable-only
// LINES when no Fable-only heading exists. If BOTH are empty, Fable has
// genuinely stopped being distinct - a real regression, not rot.
//
// FABLE_IDENTITY stays a literal: it is an identity string, not editorial
// prose, and has been byte-stable across every observed shape. It is excluded
// from the marker candidates so the identity assertion stays independent of
// the structural one.
const FABLE_IDENTITY = 'This iteration of Claude is Claude Fable 5';
const OTHER_PROMPTS = [CC_SYSTEM_PROMPT, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_SONNET5];
const headings = (body) => new Set(body.match(/^# .+$/gm) ?? []);
const fableOnlyHeadings = [...headings(CC_SYSTEM_PROMPT_FABLE)].filter((h) =>
  !OTHER_PROMPTS.some((p) => headings(p).has(h)));
// Fallback marker source: whole lines long enough to be real prose and present
// in no other variant. Trimmed, so indentation drift cannot hide them.
const fableOnlyLines = CC_SYSTEM_PROMPT_FABLE.split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length >= 40 && !l.includes(FABLE_IDENTITY) &&
    !OTHER_PROMPTS.some((p) => p.includes(l)));
const fableOnlyMarkers = [...fableOnlyHeadings, ...fableOnlyLines];
// Sentinel keeps the checks below failing loudly rather than throwing on
// includes(undefined) when Fable carries nothing of its own.
const FABLE_MARKER = fableOnlyMarkers[0] ?? '<no Fable-only marker found>';

// ─────────────────────────────────────────────────────────────
header('template carries a distinct Fable variant');
{
  check('variant differs from base', CC_SYSTEM_PROMPT_FABLE !== CC_SYSTEM_PROMPT);
  check('variant is larger than base', CC_SYSTEM_PROMPT_FABLE.length > CC_SYSTEM_PROMPT.length);
  check('variant carries Fable-only content — heading or prose (structural distinctness, #1087/#1089)',
    fableOnlyMarkers.length >= 1,
    `fable headings: ${[...headings(CC_SYSTEM_PROMPT_FABLE)].join(' | ')} ;; fable-only headings: ${fableOnlyHeadings.length}, fable-only lines: ${fableOnlyLines.length}`);
  check('variant has the Fable-only section', CC_SYSTEM_PROMPT_FABLE.includes(FABLE_MARKER));
  check('variant has the Fable identity block', CC_SYSTEM_PROMPT_FABLE.includes(FABLE_IDENTITY));
  check('base has NO Fable-only section', !CC_SYSTEM_PROMPT.includes(FABLE_MARKER));
  check('base has NO Fable identity block', !CC_SYSTEM_PROMPT.includes(FABLE_IDENTITY));
}

// ─────────────────────────────────────────────────────────────
header('systemPromptForModel — selection by family');
{
  check('fable-5 → variant', systemPromptForModel('claude-fable-5') === CC_SYSTEM_PROMPT_FABLE);
  check('fable-5[1m] → variant', systemPromptForModel('claude-fable-5[1m]') === CC_SYSTEM_PROMPT_FABLE);
  check('opus-4-8 → base', systemPromptForModel('claude-opus-4-8') === CC_SYSTEM_PROMPT);
  check('haiku → base', systemPromptForModel('claude-haiku-4-5') === CC_SYSTEM_PROMPT);
  check('undefined → base', systemPromptForModel(undefined) === CC_SYSTEM_PROMPT);
  check('case-insensitive Fable → variant', systemPromptForModel('Claude-FABLE-5') === CC_SYSTEM_PROMPT_FABLE);
  // --system-prompt override strips the model-appropriate base
  check('resolveSystemPrompt(undefined, fable) → variant', resolveSystemPrompt(undefined, 'claude-fable-5') === CC_SYSTEM_PROMPT_FABLE);
  check('resolveSystemPrompt(undefined, opus) → base', resolveSystemPrompt(undefined, 'claude-opus-4-8') === CC_SYSTEM_PROMPT);
  check('resolveSystemPrompt(undefined, sonnet-5) → base', resolveSystemPrompt(undefined, 'claude-sonnet-5') === CC_SYSTEM_PROMPT);
  check('resolveSystemPrompt(custom, fable) → custom (override wins)', resolveSystemPrompt('MY PROMPT', 'claude-fable-5') === 'MY PROMPT');
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest — outbound block[2] matches the model');
{
  const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
  const cc = { type: 'ephemeral' };
  const body = (model) => buildCCRequest({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }, 'billing', cc, identity).body;

  const fableSys = body('claude-fable-5').system[2].text;
  check('fable request carries the Fable prompt', fableSys.includes(FABLE_MARKER) && fableSys.includes(FABLE_IDENTITY));

  const opusSys = body('claude-opus-4-8').system[2].text;
  check('opus request carries the base (no Fable content)', !opusSys.includes(FABLE_MARKER) && !opusSys.includes(FABLE_IDENTITY));

  const sonnetSys = body('claude-sonnet-5').system[2].text;
  check('sonnet-5 request carries the base prompt', sonnetSys === CC_SYSTEM_PROMPT);
  const sonnet1mSys = body('claude-sonnet-5[1m]').system[2].text;
  check('sonnet-5[1m] request carries the base prompt', sonnet1mSys === CC_SYSTEM_PROMPT);

  check('fable block is larger than opus block', fableSys.length > opusSys.length);
}


// ─────────────────────────────────────────────────────────────
header('opus-5 variant; sonnet-5 shares the base');
{
  check('opus-5 variant differs from base', CC_SYSTEM_PROMPT_OPUS5 !== CC_SYSTEM_PROMPT);
  check('bundle carries no sonnet-5 variant',
    CC_TEMPLATE.system_prompt_variants?.['sonnet-5'] === undefined);
  check('bundle records sonnet-5 as sharing the base', BASE_FAMILIES.has('sonnet-5'));
  check('CC_SYSTEM_PROMPT_SONNET5 is the base', CC_SYSTEM_PROMPT_SONNET5 === CC_SYSTEM_PROMPT);
  // NB: the self-naming line ('powered by the model named Opus 5') is present in
  // the RAW capture but stripped by the scrubber, so assert on a section header
  // that survives scrubbing instead.
  check('opus-5 variant has its Delivering-work section',
    CC_SYSTEM_PROMPT_OPUS5.includes('# Delivering work'));
  check('base has NO Delivering-work section', !CC_SYSTEM_PROMPT.includes('# Delivering work'));
  check('the fable and opus-5 variants are distinct',
    CC_SYSTEM_PROMPT_FABLE !== CC_SYSTEM_PROMPT_OPUS5);

  check('opus-5 → opus-5 variant', systemPromptForModel('claude-opus-5') === CC_SYSTEM_PROMPT_OPUS5);
  check('opus-5[1m] → opus-5 variant', systemPromptForModel('claude-opus-5[1m]') === CC_SYSTEM_PROMPT_OPUS5);
  check('sonnet-5 → base', systemPromptForModel('claude-sonnet-5') === CC_SYSTEM_PROMPT);
  check('sonnet-5[1m] → base', systemPromptForModel('claude-sonnet-5[1m]') === CC_SYSTEM_PROMPT);
  check('case-insensitive opus-5', systemPromptForModel('CLAUDE-OPUS-5') === CC_SYSTEM_PROMPT_OPUS5);
  // the -5 match is bounded so a future two-digit minor can't be swallowed
  check('opus-50 → base (bounded match)', systemPromptForModel('claude-opus-50') === CC_SYSTEM_PROMPT);
  check('sonnet-51 → base (bounded match)', systemPromptForModel('claude-sonnet-51') === CC_SYSTEM_PROMPT);
  // fable is checked first: a hypothetical fable-5 must not fall into the -5 arms
  check('fable-5 still wins over the -5 arms', systemPromptForModel('claude-fable-5') === CC_SYSTEM_PROMPT_FABLE);
}

// ─────────────────────────────────────────────────────────────
header('VARIANT_FAMILIES is the single source of truth (dario#lock-step)');
{
  // Every family the bake captures must be served by a selection arm — the
  // routing below goes through the SAME table the bake derives its model
  // list from, so this asserts the loaded template actually carries what
  // the table promises rather than falling back to the base.
  for (const f of VARIANT_FAMILIES) {
    if (BASE_FAMILIES.has(f.key)) {
      check(`${f.key}: capture model routes to the base (shares the base)`,
        systemPromptForModel(f.captureModel) === CC_SYSTEM_PROMPT);
    } else {
      check(`${f.key}: capture model routes to a non-base variant`,
        systemPromptForModel(f.captureModel) !== CC_SYSTEM_PROMPT);
    }
  }
  check('matcher precedence: fable is first (never falls into the -5 arms)',
    VARIANT_FAMILIES[0]?.key === 'fable');
  const missing = missingVariantFamilies(CC_TEMPLATE);
  check('loaded template misses no family', missing.length === 0,
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

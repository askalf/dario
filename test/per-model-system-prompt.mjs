#!/usr/bin/env node
// Per-model system prompt (dario#lock-step): CC 2.1.198 ships Fable a larger,
// model-specific system prompt than the shared base. dario must inject Fable's
// prompt for Fable requests and the base for everything else.

import { buildCCRequest, systemPromptForModel, resolveSystemPrompt, CC_SYSTEM_PROMPT, CC_SYSTEM_PROMPT_FABLE, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_SONNET5, CC_TEMPLATE, withoutPasteOnlyExemption } from '../dist/cc-template.js';
import { VARIANT_FAMILIES, missingVariantFamilies, promptVariantsOf, variantFor } from '../dist/live-fingerprint.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

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
  check('sonnet request carries the base', !sonnetSys.includes(FABLE_MARKER));

  check('fable block is larger than opus block', fableSys.length > opusSys.length);
}


// ─────────────────────────────────────────────────────────────
header('opus-5 / sonnet-5 variants (CC 2.1.220, 2026-07-25)');
{
  check('opus-5 variant differs from base', CC_SYSTEM_PROMPT_OPUS5 !== CC_SYSTEM_PROMPT);
  check('sonnet-5 variant differs from base', CC_SYSTEM_PROMPT_SONNET5 !== CC_SYSTEM_PROMPT);
  // NB: the self-naming line ('powered by the model named Opus 5') is present in
  // the RAW capture but stripped by the scrubber, so assert on a section header
  // that survives scrubbing instead.
  check('opus-5 variant has its Delivering-work section',
    CC_SYSTEM_PROMPT_OPUS5.includes('# Delivering work'));
  check('base has NO Delivering-work section', !CC_SYSTEM_PROMPT.includes('# Delivering work'));
  // Sonnet 5 must carry substantial content that the base and the other
  // variants lack. Its headings are not pinned: they change independently of
  // the CC version.
  const sonnet5OnlyLines = CC_SYSTEM_PROMPT_SONNET5.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 40 &&
      ![CC_SYSTEM_PROMPT, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_FABLE].some((p) => p.includes(l)));
  check('sonnet-5 variant carries sonnet-5-only content', sonnet5OnlyLines.length >= 1,
    `sonnet-5-only lines: ${sonnet5OnlyLines.length}`);
  check('the three variants are mutually distinct',
    new Set([CC_SYSTEM_PROMPT_FABLE, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_SONNET5]).size === 3);

  check('opus-5 → opus-5 variant', systemPromptForModel('claude-opus-5') === CC_SYSTEM_PROMPT_OPUS5);
  check('opus-5[1m] → opus-5 variant', systemPromptForModel('claude-opus-5[1m]') === CC_SYSTEM_PROMPT_OPUS5);
  check('sonnet-5 → sonnet-5 variant', systemPromptForModel('claude-sonnet-5') === CC_SYSTEM_PROMPT_SONNET5);
  check('sonnet-5[1m] → sonnet-5 variant', systemPromptForModel('claude-sonnet-5[1m]') === CC_SYSTEM_PROMPT_SONNET5);
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
  const bundledVariants = promptVariantsOf(CC_TEMPLATE);
  for (const f of VARIANT_FAMILIES) {
    // A family that may share the base routes to the base until a bake stores
    // a variant for it.
    if (f.mayShareBase && !bundledVariants[f.key]) {
      check(`${f.key}: no variant held, so its capture model gets the base`,
        systemPromptForModel(f.captureModel) === CC_SYSTEM_PROMPT);
      continue;
    }
    check(`${f.key}: capture model routes to a non-base variant`,
      systemPromptForModel(f.captureModel) !== CC_SYSTEM_PROMPT);
  }
  for (const f of VARIANT_FAMILIES.filter((x) => x.mayShareBase)) {
    check(`${f.key}: a family that may share the base sits within none`, f.within === undefined);
  }
  const at = (key) => VARIANT_FAMILIES.findIndex((f) => f.key === key);
  check('matcher precedence: fable is ahead of the -5 arms (never falls into them)',
    at('fable') >= 0 && at('fable') < at('opus-5') && at('fable') < at('sonnet-5'));
  for (const f of VARIANT_FAMILIES.filter((x) => x.within !== undefined)) {
    check(`${f.key}: sits within a family of the table that has none above it`,
      at(f.within) >= 0 && VARIANT_FAMILIES[at(f.within)].within === undefined);
    check(`${f.key}: is matched ahead of ${f.within}, whose matcher accepts its models too`,
      at(f.key) < at(f.within) && VARIANT_FAMILIES[at(f.within)].matches(f.captureModel));
    check(`${f.key}: its matcher leaves ${f.within}'s own capture model alone`,
      !f.matches(VARIANT_FAMILIES[at(f.within)].captureModel));
  }
  const missing = missingVariantFamilies(CC_TEMPLATE);
  check('loaded template misses no family', missing.length === 0,
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined);
}

// ─────────────────────────────────────────────────────────────
header('a model version within a family: its own prompt, else the family\'s');
{
  const fam = (key) => VARIANT_FAMILIES.find((f) => f.key === key);
  const held = { fable: 'FABLE', 'opus-5': 'OPUS5' };
  check('own variant wins', variantFor({ ...held, 'fable-5-2': 'FABLE52' }, fam('fable-5-2')) === 'FABLE52');
  check('none of its own: the wider family\'s', variantFor(held, fam('fable-5-2')) === 'FABLE' && variantFor(held, fam('opus-5-5')) === 'OPUS5');
  check('neither held: undefined, which leaves the base', variantFor({}, fam('fable-5-2')) === undefined && variantFor(held, fam('sonnet-5-5')) === undefined);
  check('an empty string is not a variant', variantFor({ ...held, 'fable-5-2': '' }, fam('fable-5-2')) === 'FABLE');
  check('a family with none above it reads only its own', variantFor({ 'fable-5-2': 'FABLE52' }, fam('fable')) === undefined);

  // Which family a model id lands in, by the first matcher that accepts it.
  const familyOf = (model) => VARIANT_FAMILIES.find((f) => f.matches(model))?.key;
  check('claude-fable-5-2 and its [1m] form', familyOf('claude-fable-5-2') === 'fable-5-2' && familyOf('claude-fable-5-2[1m]') === 'fable-5-2');
  check('claude-fable-5-1', familyOf('claude-fable-5-1') === 'fable-5-1');
  check('claude-fable-5 stays Fable 5', familyOf('claude-fable-5') === 'fable' && familyOf('claude-fable-5[1m]') === 'fable');
  check('a dated Fable 5 id is not Fable 5.2', familyOf('claude-fable-5-20260601') === 'fable');
  check('a dated Fable 5.2 id is', familyOf('claude-fable-5-2-20261001') === 'fable-5-2');
  check('claude-opus-5-5 and claude-opus-5', familyOf('claude-opus-5-5') === 'opus-5-5' && familyOf('claude-opus-5') === 'opus-5' && familyOf('claude-opus-5-20260715') === 'opus-5');
  check('claude-sonnet-5-5 and claude-sonnet-5', familyOf('claude-sonnet-5-5[1m]') === 'sonnet-5-5' && familyOf('claude-sonnet-5') === 'sonnet-5');
  check('a two-digit minor is no family\'s', familyOf('claude-opus-5-50') === 'opus-5' && familyOf('claude-fable-5-25') === 'fable');
  check('claude-haiku-5-5 and a dated id of it', familyOf('claude-haiku-5-5') === 'haiku-5-5' && familyOf('claude-haiku-5-5-20261001') === 'haiku-5-5');
  check('Haiku 4.5 and a two-digit Haiku minor are no family\'s', familyOf('claude-haiku-4-5') === undefined && familyOf('claude-haiku-5-50') === undefined);

  // A family that may share the base: its own variant, else the base, and never reported missing.
  check('own variant wins for a family that may share the base', variantFor({ ...held, 'haiku-5-5': 'HAIKU55' }, fam('haiku-5-5')) === 'HAIKU55');
  check('none of its own: undefined, which leaves the base', variantFor(held, fam('haiku-5-5')) === undefined);
  const required = { fable: 'F', 'opus-5': 'O', 'sonnet-5': 'S' };
  check('a template with no variant for it misses no family',
    missingVariantFamilies({ system_prompt: 'BASE', system_prompt_variants: required }).length === 0);
  check('a template with no Sonnet 5 variant still misses Sonnet 5 and what sits within it',
    JSON.stringify(missingVariantFamilies({ system_prompt: 'BASE', system_prompt_variants: { fable: 'F', 'opus-5': 'O' } })) === JSON.stringify(['sonnet-5-5', 'sonnet-5']));

  // With the loaded template: the model version's own variant when it holds one, else the family's.
  const loaded = promptVariantsOf(CC_TEMPLATE);
  const plain = (key) => (typeof loaded[key] === 'string' && loaded[key].length > 0 ? withoutPasteOnlyExemption(loaded[key]) : undefined);
  for (const f of VARIANT_FAMILIES.filter((x) => x.within !== undefined)) {
    check(`${f.captureModel} gets ${plain(f.key) ? 'its own variant' : `the ${f.within} variant`}`,
      systemPromptForModel(f.captureModel) === (plain(f.key) ?? plain(f.within) ?? CC_SYSTEM_PROMPT));
  }
  // The identity paragraph names the model version, so a Fable 5.2 variant that says another one is the wrong capture.
  if (loaded['fable-5-2']) check('the Fable 5.2 variant names Fable 5.2', loaded['fable-5-2'].includes('Claude Fable 5.2'));
  if (loaded['fable-5-1']) check('the Fable 5.1 variant names Fable 5.1', loaded['fable-5-1'].includes('Claude Fable 5.1'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

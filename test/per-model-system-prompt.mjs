#!/usr/bin/env node
// Per-model system prompt (dario#lock-step): CC 2.1.198 ships Fable a larger,
// model-specific system prompt than the shared base. dario must inject Fable's
// prompt for Fable requests and the base for everything else.

import { buildCCRequest, systemPromptForModel, resolveSystemPrompt, CC_SYSTEM_PROMPT, CC_SYSTEM_PROMPT_FABLE, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_SONNET5, CC_TEMPLATE } from '../dist/cc-template.js';
import { VARIANT_FAMILIES, missingVariantFamilies } from '../dist/live-fingerprint.js';

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
// The invariant the suite actually cares about is structural: the Fable
// variant carries at least one top-level '# ' section heading that appears in
// NONE of base / opus-5 / sonnet-5. That is what makes Fable distinct and
// routable, it holds under both observed shapes, and it survives editorial
// drift. If it ever fails, Fable has genuinely stopped being distinct - a real
// regression, not rot. The request-level checks below then use one of those
// derived Fable-only headings as their marker, so they inherit the same
// robustness.
//
// FABLE_IDENTITY stays a literal: it is an identity string, not editorial
// prose, and has been byte-stable across every observed shape.
const headings = (body) => new Set(body.match(/^# .+$/gm) ?? []);
const fableOnlyHeadings = [...headings(CC_SYSTEM_PROMPT_FABLE)].filter((h) =>
  !headings(CC_SYSTEM_PROMPT).has(h) &&
  !headings(CC_SYSTEM_PROMPT_OPUS5).has(h) &&
  !headings(CC_SYSTEM_PROMPT_SONNET5).has(h));
const FABLE_MARKER = fableOnlyHeadings[0];
const FABLE_IDENTITY = 'This iteration of Claude is Claude Fable 5';

// ─────────────────────────────────────────────────────────────
header('template carries a distinct Fable variant');
{
  check('variant differs from base', CC_SYSTEM_PROMPT_FABLE !== CC_SYSTEM_PROMPT);
  check('variant is larger than base', CC_SYSTEM_PROMPT_FABLE.length > CC_SYSTEM_PROMPT.length);
  check('variant carries at least one Fable-only # heading (structural distinctness, #1087)',
    fableOnlyHeadings.length >= 1,
    `fable headings: ${[...headings(CC_SYSTEM_PROMPT_FABLE)].join(' | ')}`);
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
  // sonnet-5 gets the long-form prompt: it carries whole sections the base
  // omits. (The opening 'You are an interactive agent...' line is NOT a valid
  // marker -- base and every variant share it.)
  check('sonnet-5 variant has the long-form # System section',
    CC_SYSTEM_PROMPT_SONNET5.includes('# System'));
  check('sonnet-5 variant has the long-form # Doing tasks section',
    CC_SYSTEM_PROMPT_SONNET5.includes('# Doing tasks'));
  check('base has NEITHER long-form section',
    !CC_SYSTEM_PROMPT.includes('# System') && !CC_SYSTEM_PROMPT.includes('# Doing tasks'));
  check('the long-form sections are sonnet-5-only among the variants',
    !CC_SYSTEM_PROMPT_OPUS5.includes('# Doing tasks') && !CC_SYSTEM_PROMPT_FABLE.includes('# Doing tasks'));
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
  for (const f of VARIANT_FAMILIES) {
    check(`${f.key}: capture model routes to a non-base variant`,
      systemPromptForModel(f.captureModel) !== CC_SYSTEM_PROMPT);
  }
  check('matcher precedence: fable is first (never falls into the -5 arms)',
    VARIANT_FAMILIES[0]?.key === 'fable');
  const missing = missingVariantFamilies(CC_TEMPLATE);
  check('loaded template misses no family', missing.length === 0,
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

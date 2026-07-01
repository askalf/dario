#!/usr/bin/env node
// Per-model system prompt (dario#lock-step): CC 2.1.198 ships Fable a larger,
// model-specific system prompt than the shared base. dario must inject Fable's
// prompt for Fable requests and the base for everything else.

import { buildCCRequest, systemPromptForModel, resolveSystemPrompt, CC_SYSTEM_PROMPT, CC_SYSTEM_PROMPT_FABLE } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const FABLE_MARKER = 'Communicating with the user';
const FABLE_IDENTITY = 'This iteration of Claude is Claude Fable 5';

// ─────────────────────────────────────────────────────────────
header('template carries a distinct Fable variant');
{
  check('variant differs from base', CC_SYSTEM_PROMPT_FABLE !== CC_SYSTEM_PROMPT);
  check('variant is larger than base', CC_SYSTEM_PROMPT_FABLE.length > CC_SYSTEM_PROMPT.length);
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
  check('sonnet-5 → base', systemPromptForModel('claude-sonnet-5') === CC_SYSTEM_PROMPT);
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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

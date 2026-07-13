#!/usr/bin/env node
// Unit tests for --fast-model tier-aware routing. Under a forced --model,
// Claude Code's Haiku-tier sub-agent (Explore/Task) requests would be silently
// upgraded to the forced frontier model — quietly multiplying cost.
// --fast-model routes those Haiku-tier requests to a cheaper model instead,
// while the main conversation stays on --model. Covers the pure
// selectModelOverride() decision function, including the backward-compat
// no-op when --fast-model is unset.

import { selectModelOverride } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('forced --model with --fast-model set (the fix)');
{
  // Haiku sub-agent request → routes to the fast model, not the forced one.
  check('haiku-tier → fast model',
    selectModelOverride('claude-haiku-4-5', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-haiku-4-5');
  // Main-conversation model → stays on the forced --model.
  check('opus request → forced model',
    selectModelOverride('claude-opus-4-8', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-opus-4-8');
  check('sonnet request → forced model',
    selectModelOverride('claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-opus-4-8');
  check('fable request → forced model',
    selectModelOverride('claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-opus-4-8');
}

header('backward compatibility — --fast-model unset (inert)');
{
  // With no fast model, every request (incl. Haiku) resolves to the forced
  // model exactly as before — the change must be a no-op until opted in.
  check('haiku + no fast → forced model (unchanged behavior)',
    selectModelOverride('claude-haiku-4-5', 'claude-opus-4-8', null) === 'claude-opus-4-8');
  check('opus + no fast → forced model',
    selectModelOverride('claude-opus-4-8', 'claude-opus-4-8', null) === 'claude-opus-4-8');
  check('passthrough + no fast → null (passthrough preserved)',
    selectModelOverride('claude-haiku-4-5', null, null) === null);
}

header('passthrough with --fast-model (downgrade sub-agents only)');
{
  // No forced --model, but --fast-model set: Haiku-tier requests route to the
  // fast model; everything else passes through untouched (null).
  check('haiku + passthrough + fast → fast model',
    selectModelOverride('claude-haiku-4-5', null, 'claude-haiku-4-5') === 'claude-haiku-4-5');
  check('opus + passthrough + fast → passthrough (null)',
    selectModelOverride('claude-opus-4-8', null, 'claude-haiku-4-5') === null);
}

header('Haiku detection — matches the tier by name, case-insensitively');
{
  check('case-insensitive HAIKU',
    selectModelOverride('claude-HAIKU-4-5', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-haiku-4-5');
  check('dated 3.5 haiku id matches',
    selectModelOverride('claude-3-5-haiku-20241022', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-haiku-4-5');
  check('empty model → forced model (no false haiku match)',
    selectModelOverride('', 'claude-opus-4-8', 'claude-haiku-4-5') === 'claude-opus-4-8');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

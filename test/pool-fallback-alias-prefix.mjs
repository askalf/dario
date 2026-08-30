#!/usr/bin/env node
/**
 * test/pool-fallback-alias-prefix.mjs
 *
 * dario#1151 review finding (src/proxy.ts:3050) — pool-fallback chain entries
 * whose OPERATOR ALIAS TARGET carries a `claude:` / `anthropic:` prefix.
 *
 * The request path resolves an operator `--model-alias` FIRST and parses the
 * provider prefix AFTER, precisely so a target may carry one
 * (`my-fast` → `openai:gpt-4o-mini`) and retarget the backend. Chain
 * selection ran the same resolver but only prefix-parsed the entry AS
 * WRITTEN — so `--model-alias=backup=claude:opus --pool-fallback=gpt-5.6-sol,backup`
 * resolved `backup` to the literal `claude:opus`, matched no catalog base, and
 * pickClaudeFallback returned null. A perfectly valid reverse-failover target
 * was silently skipped and a rate-limited subscription stayed terminal.
 *
 * Covers resolveClaudeServable / isClaudeServableModel / pickClaudeFallback
 * with prefixed alias targets, using the proxy's REAL resolver shape
 * (`resolveClaudeAlias(applyModelAlias(m, aliases) ?? m)`) so classification
 * and forwarding cannot disagree — plus the fail-closed cases the prefix pass
 * must not weaken.
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { isClaudeServableModel, resolveClaudeServable } from '../dist/claude-model.js';
import { pickClaudeFallback } from '../dist/codex-backend.js';
import { resolveClaudeAlias, applyModelAlias } from '../dist/proxy.js';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const BASES = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
const SLUGS = ['gpt-5.6-sol', 'gpt-5.5'];

// Exactly the resolver proxy.ts hands pickClaudeFallback at the codex-decline
// site — operator aliases first, then the pinned + catalog pass.
const ALIASES = {
  backup: 'claude:opus',
  spare: 'anthropic:sonnet',
  fast: 'anthropic:haiku',
  elsewhere: 'openai:gpt-4o',
  ghost: 'claude:sonnet-6',
  unknown: 'ollama:llama3',
};
const resolver = (m) => resolveClaudeAlias(applyModelAlias(m, ALIASES) ?? m);

header('dario#1151 — an alias target carrying a claude:/anthropic: prefix');
{
  check('THE BUG: backup → claude:opus is servable (was null — target never prefix-parsed)',
    resolveClaudeServable('backup', BASES, resolver) === 'claude-opus-5');
  check('...and the picker selects it, returning the canonical id',
    pickClaudeFallback(['gpt-5.6-sol', 'backup'], SLUGS, BASES, resolver) === 'claude-opus-5');
  check('anthropic: on the target works the same way',
    resolveClaudeServable('spare', BASES, resolver) === 'claude-sonnet-5');
  check('...through the picker too',
    pickClaudeFallback(['gpt-5.6-sol', 'spare'], SLUGS, BASES, resolver) === 'claude-sonnet-5');
  check('a third family confirms it is the prefix rule, not one lucky name',
    pickClaudeFallback(['gpt-5.5', 'fast'], SLUGS, BASES, resolver) === 'claude-haiku-4-5');
  check('isClaudeServableModel agrees with the resolver',
    isClaudeServableModel('backup', BASES, resolver) === true);
}

header('the prefix pass must stay FAIL-CLOSED');
{
  check('an alias target on a non-Claude provider is still refused',
    resolveClaudeServable('elsewhere', BASES, resolver) === null);
  check('...and the picker skips it rather than 404ing Anthropic with gpt-4o',
    pickClaudeFallback(['gpt-5.6-sol', 'elsewhere'], SLUGS, BASES, resolver) === null);
  check('a prefix cannot make a nonexistent model servable',
    resolveClaudeServable('ghost', BASES, resolver) === null);
  check('an unrecognized prefix on the target is refused, not stripped',
    resolveClaudeServable('unknown', BASES, resolver) === null);
  check('an alias naming nothing real falls through to the base check',
    resolveClaudeServable('nonesuch', BASES, resolver) === null);
  check('a chain of only unservable entries selects nothing',
    pickClaudeFallback(['elsewhere', 'ghost', 'unknown'], SLUGS, BASES, resolver) === null);
}

header('pre-existing behaviour is unchanged by the second prefix pass');
{
  check('a prefixed ENTRY (no alias involved) still resolves',
    pickClaudeFallback(['gpt-5.6-sol', 'claude:opus'], SLUGS, BASES) === 'claude-opus-5');
  check('a bare canonical id is untouched',
    resolveClaudeServable('claude-sonnet-5', BASES, resolver) === 'claude-sonnet-5');
  check('a catalog shorthand still resolves',
    resolveClaudeServable('opus', BASES, resolver) === 'claude-opus-5');
  check('a [1m] variant survives the extra pass',
    resolveClaudeServable('claude-opus-5[1m]', BASES, resolver) === 'claude-opus-5[1m]');
  check('a codex slug is still handed to the codex end',
    pickClaudeFallback(['gpt-5.6-sol'], SLUGS, BASES, resolver) === null);
  check('an entry prefixed for the other provider is a definite no',
    resolveClaudeServable('openai:claude-opus-5', BASES, resolver) === null);
  check('empty selects nothing', pickClaudeFallback([], SLUGS, BASES, resolver) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

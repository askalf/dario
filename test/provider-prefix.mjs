// Regression test for provider prefix parsing in --model and request
// body model fields. `<provider>:<model>` with a recognized prefix
// forces routing; unrecognized prefixes and bare names pass through
// unchanged (crucial for ollama-style `llama3:8b` names).
//
// Also covers resolveClaudeAlias — request-time alias resolution on the
// claude/anthropic prefix path. Critical for the Cursor BYOK workaround
// in dario#190: users must pick `claude:opus` (or similar colon-prefixed
// names) to dodge Cursor's built-in `claude-*` name collision, and that
// shorthand has to map to the canonical Anthropic model id at request time.

import { parseProviderPrefix, resolveClaudeAlias } from '../dist/proxy.js';

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else      { console.log(`  ❌ ${label}`); fail++; }
}

console.log('\n======================================================================');
console.log('  provider prefix — parseProviderPrefix');
console.log('======================================================================');

const openai = parseProviderPrefix('openai:gpt-4o');
assert(openai?.provider === 'openai' && openai.model === 'gpt-4o', 'openai:gpt-4o → openai / gpt-4o');

const claude = parseProviderPrefix('claude:opus');
assert(claude?.provider === 'claude' && claude.model === 'opus', 'claude:opus → claude / opus');

const groq = parseProviderPrefix('groq:llama-3.3-70b-versatile');
assert(groq?.provider === 'openai' && groq.model === 'llama-3.3-70b-versatile', 'groq:llama → openai backend / stripped');

const local = parseProviderPrefix('local:qwen-coder-32b');
assert(local?.provider === 'openai' && local.model === 'qwen-coder-32b', 'local:qwen → openai backend / stripped');

const anth = parseProviderPrefix('anthropic:claude-opus-4-6');
assert(anth?.provider === 'claude' && anth.model === 'claude-opus-4-6', 'anthropic:claude-opus-4-6 → claude / full id');

const router = parseProviderPrefix('openrouter:meta-llama/llama-3.1-70b');
assert(router?.provider === 'openai' && router.model === 'meta-llama/llama-3.1-70b', 'openrouter:path/with-slash preserved');

// Bare names — no prefix, must return null
assert(parseProviderPrefix('gpt-4o') === null, 'bare gpt-4o → null');
assert(parseProviderPrefix('claude-opus-4-6') === null, 'bare claude-opus-4-6 → null');
assert(parseProviderPrefix('opus') === null, 'bare opus → null');

// Ollama-style — not a recognized prefix, pass through
assert(parseProviderPrefix('llama3:8b') === null, 'ollama llama3:8b → null (not a recognized prefix)');
assert(parseProviderPrefix('mistral:7b-instruct') === null, 'ollama mistral:7b → null');

// Edge cases
assert(parseProviderPrefix('openai:') === null, 'empty model after prefix → null');
assert(parseProviderPrefix(':gpt-4o') === null, 'empty prefix → null');
assert(parseProviderPrefix('') === null, 'empty string → null');
assert(parseProviderPrefix('unknown:something') === null, 'unknown provider → null');

// Case-insensitive prefix match
const upper = parseProviderPrefix('OPENAI:gpt-4o');
assert(upper?.provider === 'openai' && upper.model === 'gpt-4o', 'OPENAI: (uppercase) → openai');

console.log('\n======================================================================');
console.log('  resolveClaudeAlias — request-time alias resolution (dario#190)');
console.log('======================================================================');

assert(resolveClaudeAlias('opus') === 'claude-opus-4-6', 'opus → claude-opus-4-6');
assert(resolveClaudeAlias('sonnet') === 'claude-sonnet-4-6', 'sonnet → claude-sonnet-4-6');
assert(resolveClaudeAlias('haiku') === 'claude-haiku-4-5', 'haiku → claude-haiku-4-5');
assert(resolveClaudeAlias('opus1m') === 'claude-opus-4-6[1m]', 'opus1m → claude-opus-4-6[1m]');
assert(resolveClaudeAlias('sonnet1m') === 'claude-sonnet-4-6[1m]', 'sonnet1m → claude-sonnet-4-6[1m]');

// Already-canonical names pass through unchanged
assert(resolveClaudeAlias('claude-opus-4-7') === 'claude-opus-4-7', 'canonical claude-opus-4-7 → unchanged');
assert(resolveClaudeAlias('claude-sonnet-4-6') === 'claude-sonnet-4-6', 'canonical claude-sonnet-4-6 → unchanged');
assert(resolveClaudeAlias('claude-haiku-4-5') === 'claude-haiku-4-5', 'canonical claude-haiku-4-5 → unchanged');

// Unknown / non-aliased names pass through (caller decides what to do — Anthropic
// upstream will 400 if invalid, which is the right error for the user to see)
assert(resolveClaudeAlias('unknown-model') === 'unknown-model', 'unknown-model → unchanged');
assert(resolveClaudeAlias('') === '', 'empty string → unchanged');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

// betaForModel — full per-model golden matrix vs real CC 2.1.199.
//
// Live capture 2026-07-03 (this box, `claude --print --model <m> -p hi`,
// CC 2.1.199, sdk-cli entrypoint — the entrypoint dario claims). Each string
// below is the verbatim anthropic-beta header CC emitted for that model.
// betaForModel(GOLDEN_BASE, <model>) must reproduce it EXACTLY, order included.
//
// GOLDEN_BASE is the opus/sonnet-5 capture — the same set dario bakes into
// TEMPLATE.anthropic_beta. Every other family is a transform of it, so a single
// base drives the whole matrix (the live-capture auto-heal keeps the base
// current; these transforms hold regardless of afk-mode's remote-config state).

import { betaForModel } from '../dist/proxy.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}\n      got:  ${got}\n      want: ${want}`); fail++; }
}

// ── verbatim live captures (CC 2.1.199) ──
const OPUS   = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31';
const SONNET = OPUS; // sonnet-5 is byte-identical to opus on 2.1.199
const HAIKU  = 'interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01';
const FABLE  = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,fallback-credit-2026-06-01,afk-mode-2026-01-31';
// fable[1m]: context-1m at position 2, fallback-credit before afk-mode (the
// original default-model capture on this box).
const FABLE_1M = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,fallback-credit-2026-06-01,afk-mode-2026-01-31';

const GOLDEN_BASE = OPUS;

console.log('\n=== betaForModel — reproduces the live CC 2.1.199 matrix ===');
eq('opus-4-8',    betaForModel(GOLDEN_BASE, 'claude-opus-4-8'),  OPUS);
eq('sonnet-5',    betaForModel(GOLDEN_BASE, 'claude-sonnet-5'),  SONNET);
eq('haiku-4-5',   betaForModel(GOLDEN_BASE, 'claude-haiku-4-5'), HAIKU);
eq('fable-5',     betaForModel(GOLDEN_BASE, 'claude-fable-5'),   FABLE);
eq('fable-5[1m]', betaForModel(GOLDEN_BASE, 'claude-fable-5[1m]'), FABLE_1M);

console.log('\n=== membership invariants (the classifier-relevant deltas) ===');
eq('sonnet-5 keeps mid-conversation-system',
  String(betaForModel(GOLDEN_BASE, 'claude-sonnet-5').includes('mid-conversation-system-2026-04-07')), 'true');
eq('haiku drops afk-mode',
  String(betaForModel(GOLDEN_BASE, 'claude-haiku-4-5').includes('afk-mode-2026-01-31')), 'false');
eq('haiku drops effort',
  String(betaForModel(GOLDEN_BASE, 'claude-haiku-4-5').includes('effort-2025-11-24')), 'false');
eq('fable has fallback-credit',
  String(betaForModel(GOLDEN_BASE, 'claude-fable-5').includes('fallback-credit-2026-06-01')), 'true');

console.log('\n=== afk-mode-agnostic: transforms hold when the base lacks afk-mode ===');
// Remote config can flip afk-mode off within a version; when the bake captured
// it off, the base is 8 flags. The per-family shape must still be correct.
const BASE_NO_AFK = OPUS.split(',').filter(f => f !== 'afk-mode-2026-01-31').join(',');
eq('opus (no afk base) unchanged', betaForModel(BASE_NO_AFK, 'claude-opus-4-8'), BASE_NO_AFK);
eq('fable (no afk base) → fallback-credit at tail',
  betaForModel(BASE_NO_AFK, 'claude-fable-5'), `${BASE_NO_AFK},fallback-credit-2026-06-01`);
eq('haiku (no afk base) → same 6-flag reorder',
  betaForModel(BASE_NO_AFK, 'claude-haiku-4-5'), HAIKU);

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

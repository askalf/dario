// betaForModel — full per-model golden matrix vs Claude Code 2.1.201.
//
// These are the anthropic-beta headers the installed `claude` sends for each
// model on CC 2.1.201 (`claude --print --model <m> -p hi`), verbatim. Each
// string below is exactly what CC sent for that model.
// betaForModel(GOLDEN_BASE, <model>) must reproduce it EXACTLY, order included.
//
// GOLDEN_BASE is the opus/sonnet-5 header — the same set dario bakes into
// TEMPLATE.anthropic_beta. Every other family is a transform of it, so a single
// base drives the whole matrix (the periodic re-bake keeps the base
// current; these transforms hold regardless of afk-mode's remote-config state).

import { betaForModel } from '../dist/proxy.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}\n      got:  ${got}\n      want: ${want}`); fail++; }
}

// ── verbatim headers from CC 2.1.201 (sonnet-5 updated per CC 2.1.204) ──
const OPUS   = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31';
// CC 2.1.204 wire-drift capture: sonnet-5 == opus (mid-conversation-system included).
// The #667 drop is scoped to the sonnet-4 line (verified on sonnet 4.6, CC 2.1.201).
const SONNET46 = OPUS.split(',').filter((f) => f !== 'mid-conversation-system-2026-04-07').join(',');
const HAIKU  = 'interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01';
// CC 2.1.282 wire-drift capture (2026-09-25): fable-5 == opus. The
// fallback-credit-2026-06-01 flag that 2.1.220 to 2.1.281 inserted before
// afk-mode is gone.
const FABLE  = OPUS;

// The base[1m] shape: position-2 context-1m insert. Applies to every family
// that equals the base: sonnet-5[1m], the opus-4-x line, and (since CC
// 2.1.282) opus-5[1m] / fable-5[1m]. Written out rather than derived so a
// regression in the insert rule can't be masked by the test recomputing it the
// same wrong way.
const OPUS_1M = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31';

const GOLDEN_BASE = OPUS;

console.log('\n=== betaForModel — reproduces the live CC matrix ===');
// opus-5 takes the SAME transform as fable (live capture CC 2.1.220, and again
// on 2.1.282 when both dropped fallback-credit together), so its expected header
// is asserted against the fable constant on purpose: if upstream ever splits
// them, this line has to split too, which is the signal we want.
eq('opus-5 (== fable set)',     betaForModel(GOLDEN_BASE, 'claude-opus-5'),      FABLE);
eq('opus-5[1m] (== base 1m)',   betaForModel(GOLDEN_BASE, 'claude-opus-5[1m]'),  OPUS_1M);
eq('sonnet-5[1m]',              betaForModel(GOLDEN_BASE, 'claude-sonnet-5[1m]'), OPUS_1M);
eq('opus-4-8',    betaForModel(GOLDEN_BASE, 'claude-opus-4-8'),  OPUS);
eq('sonnet-5 == opus (CC 2.1.204)', betaForModel(GOLDEN_BASE, 'claude-sonnet-5'), OPUS);
eq('sonnet-4-6',  betaForModel(GOLDEN_BASE, 'claude-sonnet-4-6'), SONNET46);
eq('haiku-4-5',   betaForModel(GOLDEN_BASE, 'claude-haiku-4-5'), HAIKU);
eq('fable-5',     betaForModel(GOLDEN_BASE, 'claude-fable-5'),   FABLE);
eq('fable-5[1m]', betaForModel(GOLDEN_BASE, 'claude-fable-5[1m]'), OPUS_1M);

console.log('\n=== membership invariants (the per-model deltas) ===');
eq('sonnet-5 KEEPS mid-conversation-system (CC 2.1.204)',
  String(betaForModel(GOLDEN_BASE, 'claude-sonnet-5').includes('mid-conversation-system-2026-04-07')), 'true');
eq('sonnet-4-6 drops mid-conversation-system (#667, CC 2.1.201)',
  String(betaForModel(GOLDEN_BASE, 'claude-sonnet-4-6').includes('mid-conversation-system-2026-04-07')), 'false');
eq('haiku drops afk-mode',
  String(betaForModel(GOLDEN_BASE, 'claude-haiku-4-5').includes('afk-mode-2026-01-31')), 'false');
eq('haiku drops effort',
  String(betaForModel(GOLDEN_BASE, 'claude-haiku-4-5').includes('effort-2025-11-24')), 'false');
eq('fable has no fallback-credit (CC 2.1.282)',
  String(betaForModel(GOLDEN_BASE, 'claude-fable-5').includes('fallback-credit-2026-06-01')), 'false');
eq('opus-5 has no fallback-credit (CC 2.1.282)',
  String(betaForModel(GOLDEN_BASE, 'claude-opus-5').includes('fallback-credit-2026-06-01')), 'false');

console.log('\n=== CC 2.1.265 base: mid-conversation-tool-changes is opus/fable-only ===');
// The 2026-09-08 rebake (#1267) put mid-conversation-tool-changes-2026-07-01
// into TEMPLATE.anthropic_beta, after mid-conversation-system. That PR's own
// wire-drift capture against the installed CC 2.1.265 shows the flag on
// opus-4-8 / opus-5 / fable-5 and NOT on sonnet-5 or haiku-4-5 — so the
// transform has to strip it for the sonnet line and haiku, exactly like the
// #667 mid-conversation-system split.
const MCTC = 'mid-conversation-tool-changes-2026-07-01';
const BASE_265 = OPUS.split(',')
  .flatMap((f) => (f === 'mid-conversation-system-2026-04-07' ? [f, MCTC] : [f]))
  .join(',');
const has265 = (model) => String(betaForModel(BASE_265, model).includes(MCTC));
eq('opus-4-8 keeps mid-conversation-tool-changes', has265('claude-opus-4-8'), 'true');
eq('opus-5 keeps mid-conversation-tool-changes',   has265('claude-opus-5'),   'true');
eq('fable-5 keeps mid-conversation-tool-changes',  has265('claude-fable-5'),  'true');
eq('sonnet-5 drops mid-conversation-tool-changes (CC 2.1.265)', has265('claude-sonnet-5'), 'false');
eq('sonnet-4-6 drops mid-conversation-tool-changes',            has265('claude-sonnet-4-6'), 'false');
eq('haiku-4-5 drops mid-conversation-tool-changes',             has265('claude-haiku-4-5'),  'false');
// The strip must be surgical: with the new flag removed, every family's set is
// byte-identical to what the pre-2.1.265 base produced.
eq('sonnet-5 on 2.1.265 base == sonnet-5 on old base', betaForModel(BASE_265, 'claude-sonnet-5'), OPUS);
eq('sonnet-4-6 on 2.1.265 base == old', betaForModel(BASE_265, 'claude-sonnet-4-6'), SONNET46);
eq('haiku on 2.1.265 base == old',      betaForModel(BASE_265, 'claude-haiku-4-5'),  HAIKU);
// CC 2.1.282 live capture: opus-5 and fable-5 are the opus-4-8 base verbatim.
eq('opus-5 on 2.1.265 base == base (CC 2.1.282)',  betaForModel(BASE_265, 'claude-opus-5'),  BASE_265);
eq('fable-5 on 2.1.265 base == base (CC 2.1.282)', betaForModel(BASE_265, 'claude-fable-5'), BASE_265);

console.log('\n=== afk-mode-agnostic: transforms hold when the base lacks afk-mode ===');
// Remote config can flip afk-mode off within a version; when the bake ran with
// afk-mode off, the base is 8 flags. The per-family shape must still be correct.
const BASE_NO_AFK = OPUS.split(',').filter(f => f !== 'afk-mode-2026-01-31').join(',');
eq('opus (no afk base) unchanged', betaForModel(BASE_NO_AFK, 'claude-opus-4-8'), BASE_NO_AFK);
eq('fable (no afk base) unchanged', betaForModel(BASE_NO_AFK, 'claude-fable-5'), BASE_NO_AFK);
eq('haiku (no afk base) → same 6-flag reorder',
  betaForModel(BASE_NO_AFK, 'claude-haiku-4-5'), HAIKU);

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

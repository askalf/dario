#!/usr/bin/env node
// Effort-capability rejection parsing + clamp choice.
//
// The autodetected model catalog (v4.8.57) exposes models that predate the
// newer effort tiers; with a pinned DARIO_EFFORT (the prod box pins `max`)
// they hard-400: "This model does not support effort level 'max'.
// Supported levels: high, low, medium." (observed live 2026-06-10 on
// claude-opus-4-5-20251101). dario now parses that rejection, retries with
// the strongest supported level, and caches the supported set per model.
// NOTE: fable's effort intolerance is a SOFT refusal (200 + refusal stop)
// and stays handled by its measured resolveEffort clamp — different layer.

import assert from 'node:assert';
import { parseEffortRejection, bestSupportedEffort, EFFORT_PREFERENCE, isEffortParamUnsupported, parseMaxTokensRejection } from '../dist/proxy.js';

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

// --- parseEffortRejection — the live-observed wire shape ---
const live = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: "This model does not support effort level 'max'. Supported levels: high, low, medium.",
  },
  request_id: 'req_011CbvJwPBuypezxSTiFphUU',
});
const r = parseEffortRejection(live);
check('live shape parses', r !== null);
check('rejected level extracted', r.rejected === 'max');
check('supported set extracted', JSON.stringify(r.supported) === JSON.stringify(['high', 'low', 'medium']));

const xhigh = parseEffortRejection("does not support effort level 'xhigh'. Supported levels: high");
check('single supported level parses', xhigh.rejected === 'xhigh' && xhigh.supported.length === 1 && xhigh.supported[0] === 'high');

check('case-insensitive match', parseEffortRejection("DOES NOT SUPPORT EFFORT LEVEL 'MAX'. SUPPORTED LEVELS: HIGH, MEDIUM") !== null);
check('unrelated 400 → null', parseEffortRejection('{"error":{"message":"long context beta is not yet available"}}') === null);
check('empty body → null', parseEffortRejection('') === null);
check('beta rejection → null', parseEffortRejection('Unexpected value(s) `afk-mode-2026-01-31` for the `anthropic-beta` header') === null);

// --- bestSupportedEffort — degrade as little as possible ---
check('max rejected, high/low/medium supported → high', bestSupportedEffort(['high', 'low', 'medium']) === 'high');
check('xhigh preferred when present', bestSupportedEffort(['medium', 'xhigh', 'low']) === 'xhigh');
check('max preferred over high', bestSupportedEffort(['high', 'max']) === 'max');
check('single option', bestSupportedEffort(['low']) === 'low');
check('unknown-only set falls back to first entry', bestSupportedEffort(['turbo']) === 'turbo');
check('empty set falls back to high', bestSupportedEffort([]) === 'high');
check('preference order is descending capability',
  JSON.stringify(EFFORT_PREFERENCE) === JSON.stringify(['xhigh', 'max', 'high', 'medium', 'low']));

// --- isEffortParamUnsupported — the HARD rejection (no effort support at all) ---
// Distinct from the SOFT level rejection above: opus-4-1 / sonnet-4-5 predate
// output_config.effort entirely (observed live 2026-06-16). dario STRIPS the
// field rather than clamping. The two detectors must never collide.
const softMsg = "This model does not support effort level 'max'. Supported levels: high, low, medium.";
const hardMsg = 'This model does not support the effort parameter.';
check('hard rejection detected', isEffortParamUnsupported(hardMsg) === true);
check('hard rejection case-insensitive', isEffortParamUnsupported('DOES NOT SUPPORT THE EFFORT PARAMETER') === true);
check('soft rejection is NOT a hard rejection', isEffortParamUnsupported(softMsg) === false);
check('unrelated 400 → false', isEffortParamUnsupported('long context beta is not yet available') === false);
check('empty body → false', isEffortParamUnsupported('') === false);
check('soft parses soft, not hard', parseEffortRejection(softMsg) !== null && !isEffortParamUnsupported(softMsg));
check('hard detects hard, not soft', isEffortParamUnsupported(hardMsg) && parseEffortRejection(hardMsg) === null);

// --- parseMaxTokensRejection — per-model output cap ---
// dario pins DEFAULT_MAX_TOKENS=64000; older models cap lower (opus-4-1: 32000).
// Observed live 2026-06-16. Returns the cap (clamp target) or null.
const mtLive = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1-20250805.',
  },
});
check('max_tokens cap extracted', parseMaxTokensRejection(mtLive) === 32000);
check('cap parses without trailing comma', parseMaxTokensRejection('max_tokens: 100000 > 8192 which is the maximum allowed') === 8192);
check('case-insensitive', parseMaxTokensRejection('MAX_TOKENS: 64000 > 32000, WHICH IS THE MAXIMUM ALLOWED') === 32000);
check('effort rejection → null (no collision)', parseMaxTokensRejection(hardMsg) === null);
check('unrelated 400 → null', parseMaxTokensRejection('rate limit exceeded') === null);
check('empty body → null', parseMaxTokensRejection('') === null);

console.log(`✅ effort-capability: ${passed} assertions passed`);

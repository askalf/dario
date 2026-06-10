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
import { parseEffortRejection, bestSupportedEffort, EFFORT_PREFERENCE } from '../dist/proxy.js';

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

console.log(`✅ effort-capability: ${passed} assertions passed`);

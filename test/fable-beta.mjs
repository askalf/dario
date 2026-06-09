#!/usr/bin/env node
// betaForModel — fable-conditional `fallback-credit-2026-06-01` beta.
//
// Live captures (2026-06-09, CC v2.1.170): real CC appends
// `fallback-credit-2026-06-01` to the anthropic-beta set on FABLE requests
// only — the opus request from the same binary/account does not carry it.
// Subscription traffic on fable without the flag is soft-refused upstream:
// every request returns 200 with stop_reason "refusal" and empty content,
// while opus/sonnet answer normally (isolated on the live proxy 2026-06-09).
// dario therefore mirrors CC: append for the fable family, never for others.

import { betaForModel, FABLE_FALLBACK_CREDIT_BETA } from '../dist/proxy.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const BASE = 'claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24';

console.log('\n=== betaForModel — fable gets the fallback-credit beta ===');
check('fable full id → appended',
  betaForModel(BASE, 'claude-fable-5') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('fable [1m] id → appended',
  betaForModel(BASE, 'claude-fable-5[1m]') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('uppercase model → appended',
  betaForModel(BASE, 'CLAUDE-FABLE-5') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('already present → unchanged (no dup)',
  betaForModel(`${BASE},${FABLE_FALLBACK_CREDIT_BETA}`, 'claude-fable-5') === `${BASE},${FABLE_FALLBACK_CREDIT_BETA}`);
check('empty base + fable → just the flag',
  betaForModel('', 'claude-fable-5') === FABLE_FALLBACK_CREDIT_BETA);

console.log('\n=== betaForModel — every other family untouched ===');
check('opus → unchanged',   betaForModel(BASE, 'claude-opus-4-8') === BASE);
check('sonnet → unchanged', betaForModel(BASE, 'claude-sonnet-4-6') === BASE);
check('haiku → unchanged',  betaForModel(BASE, 'claude-haiku-4-5') === BASE);
check('empty model → unchanged', betaForModel(BASE, '') === BASE);
check('null model → unchanged',  betaForModel(BASE, null) === BASE);
check('undefined model → unchanged', betaForModel(BASE, undefined) === BASE);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

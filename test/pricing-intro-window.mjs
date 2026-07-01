#!/usr/bin/env node
// Tests for date-modeled intro pricing (analytics.ts pricingRateFor).
// Sonnet 5 launched with an intro rate ($2/$10) that reverts to standard
// ($3/$15) after 2026-08-31 UTC. Each request is priced at the rate effective
// at its OWN timestamp, so a window spanning the cutover estimates both sides
// correctly. Pure function, no I/O.

import { pricingRateFor } from '../dist/analytics.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }
const at = (iso) => Date.parse(iso);
const eq = (r, o) => r.input === o.input && r.output === o.output && r.cacheRead === o.cacheRead && r.cacheCreate === o.cacheCreate;

const INTRO = { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 };
const STANDARD = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

// ─────────────────────────────────────────────────────────────
header('Sonnet 5 — intro rate inside the window');
{
  check('mid-window (2026-07-15) -> intro', eq(pricingRateFor('claude-sonnet-5', at('2026-07-15T12:00:00Z')), INTRO));
  check('launch-ish (2026-06-30) -> intro', eq(pricingRateFor('claude-sonnet-5', at('2026-06-30T00:00:00Z')), INTRO));
}

// ─────────────────────────────────────────────────────────────
header('Sonnet 5 — cutover boundary is inclusive of 2026-08-31 UTC');
{
  check('last instant of 2026-08-31 -> intro', eq(pricingRateFor('claude-sonnet-5', at('2026-08-31T23:59:59.999Z')), INTRO));
  check('first instant of 2026-09-01 -> standard', eq(pricingRateFor('claude-sonnet-5', at('2026-09-01T00:00:00.000Z')), STANDARD));
  check('well after (2026-12-01) -> standard', eq(pricingRateFor('claude-sonnet-5', at('2026-12-01T00:00:00Z')), STANDARD));
}

// ─────────────────────────────────────────────────────────────
header('[1m] context variant follows the same window');
{
  check('sonnet-5[1m] mid-window -> intro', eq(pricingRateFor('claude-sonnet-5[1m]', at('2026-07-15T00:00:00Z')), INTRO));
  check('sonnet-5[1m] after cutover -> standard', eq(pricingRateFor('claude-sonnet-5[1m]', at('2026-10-01T00:00:00Z')), STANDARD));
}

// ─────────────────────────────────────────────────────────────
header('Models without an intro window are date-independent');
{
  const a = pricingRateFor('claude-sonnet-4-6', at('2026-07-15T00:00:00Z'));
  const b = pricingRateFor('claude-sonnet-4-6', at('2026-12-01T00:00:00Z'));
  check('sonnet-4-6 is standard mid-window', eq(a, STANDARD));
  check('sonnet-4-6 is unchanged after cutover', eq(a, b));

  const opus = pricingRateFor('claude-opus-4-8', at('2026-07-15T00:00:00Z'));
  check('opus-4-8 unaffected by any window', opus.input === 5 && opus.output === 25);

  // Opus 4.6 shares the current Opus rate ($5/$25), not the old $15/$75.
  const opus46 = pricingRateFor('claude-opus-4-6', at('2026-07-15T00:00:00Z'));
  check('opus-4-6 = $5/$25 (not the stale $15/$75)',
    opus46.input === 5 && opus46.output === 25 && opus46.cacheRead === 0.5 && opus46.cacheCreate === 6.25);
}

// ─────────────────────────────────────────────────────────────
header('Unknown model falls back to the sonnet-4-6 standard rate');
{
  check('unknown -> sonnet-4-6 standard', eq(pricingRateFor('claude-made-up-9', at('2026-07-15T00:00:00Z')), STANDARD));
}

// ─────────────────────────────────────────────────────────────
header('Fable 5 — official $10/$50 rate (platform docs, 2026-07-01 redeploy)');
{
  const FABLE = { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 };
  check('fable-5 = $10/$50/$1/$12.5', eq(pricingRateFor('claude-fable-5', at('2026-07-15T00:00:00Z')), FABLE));
  check('fable-5[1m] = same rate (tag stripped)', eq(pricingRateFor('claude-fable-5[1m]', at('2026-07-15T00:00:00Z')), FABLE));
  check('fable-5 is date-independent (no intro window)',
    eq(pricingRateFor('claude-fable-5', at('2026-12-01T00:00:00Z')), FABLE));
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

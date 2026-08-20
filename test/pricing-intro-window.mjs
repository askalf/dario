#!/usr/bin/env node
// Tests for date-modeled pricing (analytics.ts pricingRateFor).
//
// Sonnet 5 launched at $2/$10 described as introductory "through 2026-08-31,
// then $3/$15", and that cutover was modeled here. Anthropic has since
// CANCELLED the increase and made $2/$10 the standard price, so Sonnet 5 is a
// flat rate at every timestamp and the assertions below say so.
//
// The dated-intro MECHANISM is retained in pricingRateFor for the next model
// that genuinely has one, but no entry currently uses it — so that branch is
// unexercised today. If you add an `intro` window to PRICING, add coverage of
// its boundary here; the previous version of this file is the template.
//
// Each request is priced at the rate effective at its OWN timestamp, so a
// window spanning any future cutover still estimates both sides correctly.
// Pure function, no I/O.

import { pricingRateFor } from '../dist/analytics.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }
const at = (iso) => Date.parse(iso);
const eq = (r, o) => r.input === o.input && r.output === o.output && r.cacheRead === o.cacheRead && r.cacheCreate === o.cacheCreate;

// Sonnet 5's permanent rate. Named INTRO historically; it is simply the price.
const SONNET5 = { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 };
const INTRO = SONNET5;
const STANDARD = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

// ─────────────────────────────────────────────────────────────
header('Sonnet 5 — intro rate inside the window');
{
  check('mid-window (2026-07-15) -> intro', eq(pricingRateFor('claude-sonnet-5', at('2026-07-15T12:00:00Z')), INTRO));
  check('launch-ish (2026-06-30) -> intro', eq(pricingRateFor('claude-sonnet-5', at('2026-06-30T00:00:00Z')), INTRO));
}

// ─────────────────────────────────────────────────────────────
header('Sonnet 5 — $2/$10 is PERMANENT; the 2026-09-01 increase was cancelled');
{
  // The old cutover instant is the regression guard: before the fix this
  // flipped to $3/$15 here, silently over-stating every Sonnet 5 record by 50%
  // from 2026-09-01 with nothing in the output to show the number had moved.
  check('last instant of 2026-08-31 -> $2/$10', eq(pricingRateFor('claude-sonnet-5', at('2026-08-31T23:59:59.999Z')), SONNET5));
  check('first instant of 2026-09-01 -> STILL $2/$10', eq(pricingRateFor('claude-sonnet-5', at('2026-09-01T00:00:00.000Z')), SONNET5));
  check('well after (2026-12-01) -> STILL $2/$10', eq(pricingRateFor('claude-sonnet-5', at('2026-12-01T00:00:00Z')), SONNET5));
  check('far future (2028-01-01) -> STILL $2/$10', eq(pricingRateFor('claude-sonnet-5', at('2028-01-01T00:00:00Z')), SONNET5));
}

// ─────────────────────────────────────────────────────────────
header('[1m] context variant follows the same window');
{
  check('sonnet-5[1m] mid-window -> intro', eq(pricingRateFor('claude-sonnet-5[1m]', at('2026-07-15T00:00:00Z')), INTRO));
  check('sonnet-5[1m] after the old cutover -> STILL $2/$10', eq(pricingRateFor('claude-sonnet-5[1m]', at('2026-10-01T00:00:00Z')), SONNET5));
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

  // Opus 5 ships at the same $5/$25 as 4.8 — no long-context premium, and
  // the [1m] id must not fall through to the sonnet-4-6 default.
  const opus5 = pricingRateFor('claude-opus-5', at('2026-07-15T00:00:00Z'));
  check('opus-5 = $5/$25',
    opus5.input === 5 && opus5.output === 25 && opus5.cacheRead === 0.5 && opus5.cacheCreate === 6.25);
  const opus5_1m = pricingRateFor('claude-opus-5[1m]', at('2026-07-15T00:00:00Z'));
  check('opus-5[1m] strips the tag and bills at the opus rate',
    opus5_1m.input === 5 && opus5_1m.output === 25);

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

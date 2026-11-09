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

import { pricingRateFor, pricingModelForRequest, costOfRequest, costOfTokens, costOfTokensFailClosed, hasPublishedRate, LONG_PROMPT_TAG, PRICING } from '../dist/analytics.js';
import { BAKED_BASE_MODELS } from '../dist/model-catalog.js';

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

  // Opus 5.5 is $4/$20 with cache-read at 0.05x input ($0.20), the first model
  // off the 0.1x rule; a derived row would say $0.40. Its id also extends
  // 'claude-opus-5', so a prefix lookup would hand back the Opus 5 rate.
  const opus55 = pricingRateFor('claude-opus-5-5', at('2026-09-23T00:00:00Z'));
  check('opus-5-5 = $4/$20, cache-read $0.20, cache-write $5',
    opus55.input === 4 && opus55.output === 20 && opus55.cacheRead === 0.2 && opus55.cacheCreate === 5);

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

// ─────────────────────────────────────────────────────────────
header('The models that had no row: each priced at the sonnet-4-6 fallback until 2026-11-09');
{
  const T = at('2026-11-09T12:00:00Z');
  const rate = (id) => pricingRateFor(id, T);
  // Copied from the published table, not derived: the cache-read multiplier is
  // 0.025x on Fable 5.1/5.2, 0.05x on Sonnet 5.5, 0.1x on Fable 5 and Haiku 5.5.
  check('fable-5-2 = $8/$40, cache-read $0.20, cache-write $10', eq(rate('claude-fable-5-2'), { input: 8, output: 40, cacheRead: 0.2, cacheCreate: 10 }));
  check('fable-5-2[1m] and a dated echo price the same', eq(rate('claude-fable-5-2[1m]'), rate('claude-fable-5-2')) && eq(rate('claude-fable-5-2-20261101'), rate('claude-fable-5-2')));
  check('fable-5-1 = $10/$50, cache-read $0.25 (not Fable 5\'s $1)', eq(rate('claude-fable-5-1'), { input: 10, output: 50, cacheRead: 0.25, cacheCreate: 12.5 }));
  check('fable-5 is still its own row: cache-read $1', rate('claude-fable-5').cacheRead === 1 && rate('claude-fable-5').input === 10);
  check('mythos rows match the fable of the same version', ['', '-1', '-2'].every((v) => eq(rate(`claude-mythos-5${v}`), rate(`claude-fable-5${v}`))));
  check('sonnet-5-5 = $2/$10, cache-read $0.10 (Sonnet 5 is $0.20)', eq(rate('claude-sonnet-5-5'), { input: 2, output: 10, cacheRead: 0.1, cacheCreate: 2.5 }) && rate('claude-sonnet-5').cacheRead === 0.2);
  check('haiku-5-5 = $0.10/$0.50, cache-read $0.01, cache-write $0.125', eq(rate('claude-haiku-5-5'), { input: 0.1, output: 0.5, cacheRead: 0.01, cacheCreate: 0.125 }));
  check('haiku-4-5 is still $1/$5', rate('claude-haiku-4-5').input === 1 && rate('claude-haiku-4-5').output === 5);
  check('opus-4-5 = $5/$25 and sonnet-4-5 = $3/$15, dated forms included', eq(rate('claude-opus-4-5-20251101'), { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 }) && eq(rate('claude-sonnet-4-5-20250929'), STANDARD));
  check('every model in the baked catalog has a row of its own', BAKED_BASE_MODELS.every((id) => hasPublishedRate(id)), BAKED_BASE_MODELS.filter((id) => !hasPublishedRate(id)).join(','));
}

// ─────────────────────────────────────────────────────────────
header('Haiku 5.5 is priced by prompt length: over 100,000 prompt tokens, every bucket is 5x');
{
  const T = at('2026-11-09T12:00:00Z');
  const LONG = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheCreate: 0.625 };
  const req = (inputTokens, cacheReadTokens = 0, cacheCreateTokens = 0, outputTokens = 1_000) => ({ inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens });
  check('the tagged id reads the long-prompt row', eq(pricingRateFor(`claude-haiku-5-5${LONG_PROMPT_TAG}`, T), LONG));
  check('…on the dated id too', eq(pricingRateFor(`claude-haiku-5-5-20261015${LONG_PROMPT_TAG}`, T), LONG));
  check('the tag on a model with no long-prompt row changes nothing', eq(pricingRateFor(`claude-opus-5-5${LONG_PROMPT_TAG}`, T), pricingRateFor('claude-opus-5-5', T)));
  check('exactly 100,000 prompt tokens is the short row', pricingModelForRequest('claude-haiku-5-5', req(100_000)) === 'claude-haiku-5-5');
  check('100,001 is the long row', pricingModelForRequest('claude-haiku-5-5', req(100_001)) === 'claude-haiku-5-5[long]');
  check('cache reads and cache writes count toward the prompt', pricingModelForRequest('claude-haiku-5-5', req(1, 60_000, 40_000)) === 'claude-haiku-5-5[long]' && pricingModelForRequest('claude-haiku-5-5', req(0, 60_000, 40_000)) === 'claude-haiku-5-5');
  check('output tokens do not', pricingModelForRequest('claude-haiku-5-5', req(10, 0, 0, 500_000)) === 'claude-haiku-5-5');
  check('a context tag ahead of the long tag still finds the row', eq(pricingRateFor('claude-haiku-5-5[1m][long]', T), LONG) && pricingModelForRequest('claude-haiku-5-5[1m]', req(100_001)) === 'claude-haiku-5-5[1m][long]' && hasPublishedRate('claude-haiku-5-5[1m][long]'));
  check('an already tagged id is not tagged twice', pricingModelForRequest('claude-haiku-5-5[long]', req(200_000)) === 'claude-haiku-5-5[long]');
  check('no other model is priced by prompt length', Object.keys(PRICING).filter((id) => PRICING[id].longPrompt).join() === 'claude-haiku-5-5'
    && pricingModelForRequest('claude-fable-5-2', req(900_000)) === 'claude-fable-5-2' && pricingModelForRequest('gpt-6-astra', req(900_000)) === 'gpt-6-astra');
  // 200K in + 1K out: short rate would say $0.0205, the bill is $0.1025.
  const long = costOfRequest('claude-haiku-5-5', T, req(200_000));
  check('a 200K-token request bills at the long row: $0.1025', Math.abs(long - (200_000 * 0.5 + 1_000 * 2.5) / 1e6) < 1e-12, long);
  check('a 50K-token request bills at the short row: $0.0055', Math.abs(costOfRequest('claude-haiku-5-5', T, req(50_000)) - (50_000 * 0.1 + 1_000 * 0.5) / 1e6) < 1e-12);
  check('costOfTokens reads no prompt length: a day\'s 200K summed tokens stay at the row their key names', Math.abs(costOfTokens('claude-haiku-5-5', T, req(200_000)) - (200_000 * 0.1 + 1_000 * 0.5) / 1e6) < 1e-12);
  check('the fail-closed reservation prices one request, so it takes the long row too', costOfTokensFailClosed('Claude-Haiku-5-5', T, req(0, 0, 200_000)) === costOfTokens('claude-haiku-5-5[long]', T, req(0, 0, 200_000)));
}

// ─────────────────────────────────────────────────────────────
header('Hostile model ids price in linear time (CodeQL js/polynomial-redos)');
{
  // body.model reaches pricingRateFor before the request is forwarded (key
  // budget reservation). A run of '[' used to backtrack quadratically.
  for (const [name, id] of [
    ['200k "["', '['.repeat(200_000) + 'x'],
    ['200k "[a"', '[a'.repeat(100_000)],
    ['200k ":a"', ':a'.repeat(100_000) + '!'],
  ]) {
    const t0 = Date.now();
    const r = pricingRateFor(id, at('2026-07-15T00:00:00Z'));
    const ms = Date.now() - t0;
    check(`${name} -> fallback rate in ${ms}ms (< 250ms)`, ms < 250 && eq(r, STANDARD));
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

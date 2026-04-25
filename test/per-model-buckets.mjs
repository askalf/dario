#!/usr/bin/env node
// Tests for per-model 7d rate-limit buckets — the dario-side handling of
// the `anthropic-ratelimit-unified-7d_<family>-utilization` headers
// Anthropic started emitting on Sonnet responses around 2026-04-25
// (see CHANGELOG entry for context). Three contracts:
//
//   1. parseRateLimits captures any `7d_<family>-utilization` header
//      generically — `_sonnet` today, `_opus`/`_haiku` if/when they ship
//      tomorrow, no allowlist gate.
//   2. computeHeadroom takes a family hint and folds the per-model bucket
//      into the max(util5h, util7d, util_per_model) calculation when the
//      account has a snapshot for that family. Without the family arg or
//      a matching bucket key, behavior is identical to pre-PR (max of
//      the unified buckets only).
//   3. select(family) routes a Sonnet request to the account with the
//      most Sonnet headroom even when its unified util5h/util7d is
//      slightly worse than another account's — i.e. per-model headroom
//      can flip the routing decision.
//   4. modelFamily extracts the family token from a request model id
//      using a reasonable fuzzy match (`claude-opus-4-7` → `opus`).

import { AccountPool, EMPTY_SNAPSHOT, parseRateLimits, computeHeadroom, modelFamily } from '../dist/pool.js';

let pass = 0;
let fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// Build a Headers object the way the proxy receives them from upstream.
function buildHeaders(map) {
  const h = new Headers();
  for (const [k, v] of Object.entries(map)) h.set(k, v);
  return h;
}

// =====================================================================
//  parseRateLimits
// =====================================================================
header('parseRateLimits — captures unified buckets (regression)');
{
  const h = buildHeaders({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.20',
    'anthropic-ratelimit-unified-7d-utilization': '0.16',
    'anthropic-ratelimit-unified-overage-utilization': '0.0',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': '1777093800',
    'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  });
  const snap = parseRateLimits(h);
  check('util5h captured', snap.util5h === 0.2);
  check('util7d captured', snap.util7d === 0.16);
  check('claim captured', snap.claim === 'five_hour');
  check('perModel7d initialized empty when no per-model header present',
    snap.perModel7d && Object.keys(snap.perModel7d).length === 0);
}

header('parseRateLimits — captures _sonnet bucket (the live header today)');
{
  const h = buildHeaders({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.21',
    'anthropic-ratelimit-unified-7d-utilization': '0.16',
    'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.0',
    'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
    'anthropic-ratelimit-unified-7d_sonnet-reset': '1777154400',
  });
  const snap = parseRateLimits(h);
  check('perModel7d.sonnet captured', snap.perModel7d.sonnet === 0);
  check('only utilization is parsed (status/reset would be a separate column)',
    Object.keys(snap.perModel7d).length === 1);
}

header('parseRateLimits — captures hypothetical _opus bucket (forward-compat)');
{
  // Anthropic hasn't shipped this yet but the parser must not need a
  // schema bump when they do. Generic `7d_<family>-utilization` match.
  const h = buildHeaders({
    'anthropic-ratelimit-unified-7d_opus-utilization': '0.42',
    'anthropic-ratelimit-unified-7d_haiku-utilization': '0.05',
  });
  const snap = parseRateLimits(h);
  check('perModel7d.opus captured (no allowlist)', snap.perModel7d.opus === 0.42);
  check('perModel7d.haiku captured', snap.perModel7d.haiku === 0.05);
}

header('parseRateLimits — case-insensitive family match, lowercase keying');
{
  // Anthropic uses lowercase today but defensive check — if they ever ship
  // an upper/mixed case family token, our perModel7d keys stay lowercase
  // so callers don't need to second-guess.
  const h = buildHeaders({
    'anthropic-ratelimit-unified-7d_Sonnet-utilization': '0.10',
  });
  const snap = parseRateLimits(h);
  check('mixed-case family normalized to lowercase', snap.perModel7d.sonnet === 0.1);
}

// =====================================================================
//  computeHeadroom
// =====================================================================
header('computeHeadroom — unified-only fallback when family not supplied');
{
  const snap = { ...EMPTY_SNAPSHOT, util5h: 0.3, util7d: 0.5, perModel7d: { sonnet: 0.95 } };
  const headroom = computeHeadroom(snap);
  check('ignores per-model bucket when no family arg', Math.abs(headroom - 0.5) < 1e-9);
}

header('computeHeadroom — folds in per-model bucket when family matches');
{
  const snap = { ...EMPTY_SNAPSHOT, util5h: 0.3, util7d: 0.5, perModel7d: { sonnet: 0.95 } };
  const headroom = computeHeadroom(snap, 'sonnet');
  // max(0.3, 0.5, 0.95) = 0.95 → headroom = 0.05
  check('headroom for sonnet uses the saturated bucket', Math.abs(headroom - 0.05) < 1e-9);
}

header('computeHeadroom — family without matching bucket falls back to unified');
{
  const snap = { ...EMPTY_SNAPSHOT, util5h: 0.3, util7d: 0.5, perModel7d: { sonnet: 0.95 } };
  const headroom = computeHeadroom(snap, 'opus');
  check('opus request without _opus bucket uses unified buckets only',
    Math.abs(headroom - 0.5) < 1e-9);
}

// =====================================================================
//  select(family)
// =====================================================================
header('select(family) — flips routing when one account is sonnet-saturated');
{
  const pool = new AccountPool();
  pool.add('account-A', { accessToken: 'a', refreshToken: 'a', expiresAt: Date.now() + 3600_000, deviceId: 'a', accountUuid: 'a' });
  pool.add('account-B', { accessToken: 'b', refreshToken: 'b', expiresAt: Date.now() + 3600_000, deviceId: 'b', accountUuid: 'b' });

  // A: better unified headroom but Sonnet-saturated
  pool.updateRateLimits('account-A', {
    ...EMPTY_SNAPSHOT, util5h: 0.10, util7d: 0.10, perModel7d: { sonnet: 0.99 }, status: 'allowed', updatedAt: Date.now(),
  });
  // B: worse unified, but no Sonnet pressure
  pool.updateRateLimits('account-B', {
    ...EMPTY_SNAPSHOT, util5h: 0.40, util7d: 0.40, perModel7d: { sonnet: 0.05 }, status: 'allowed', updatedAt: Date.now(),
  });

  const noFamily = pool.select();
  check('without family hint, picks A (best unified headroom)', noFamily?.alias === 'account-A');

  const sonnet = pool.select('sonnet');
  check('with family=sonnet, flips to B (A is sonnet-saturated)', sonnet?.alias === 'account-B');

  const opus = pool.select('opus');
  check('with family=opus, picks A again (no _opus bucket recorded)', opus?.alias === 'account-A');
}

header('select(family) — sonnet bucket on one account only, partial signal');
{
  // Real-world shape: account A has made a Sonnet request recently
  // (snapshot has perModel7d.sonnet), account B hasn't (perModel7d empty).
  // A's per-model bucket is at 50%; B has no per-model data. Routing
  // should still pick the one with better effective headroom.
  const pool = new AccountPool();
  pool.add('A', { accessToken: 'a', refreshToken: 'a', expiresAt: Date.now() + 3600_000, deviceId: 'a', accountUuid: 'a' });
  pool.add('B', { accessToken: 'b', refreshToken: 'b', expiresAt: Date.now() + 3600_000, deviceId: 'b', accountUuid: 'b' });

  pool.updateRateLimits('A', {
    ...EMPTY_SNAPSHOT, util5h: 0.10, util7d: 0.10, perModel7d: { sonnet: 0.50 }, status: 'allowed', updatedAt: Date.now(),
  });
  pool.updateRateLimits('B', {
    ...EMPTY_SNAPSHOT, util5h: 0.30, util7d: 0.30, perModel7d: {}, status: 'allowed', updatedAt: Date.now(),
  });

  // A: max(0.10, 0.10, 0.50) = 0.50 → headroom 0.50
  // B: max(0.30, 0.30) = 0.30 → headroom 0.70
  const picked = pool.select('sonnet');
  check('B wins despite missing per-model snapshot — better effective headroom',
    picked?.alias === 'B');
}

// =====================================================================
//  modelFamily
// =====================================================================
header('modelFamily — extracts family token from common model ids');
{
  check('opus 4.7 → opus',         modelFamily('claude-opus-4-7') === 'opus');
  check('sonnet 4.6 → sonnet',     modelFamily('claude-sonnet-4-6') === 'sonnet');
  check('haiku 4.5 → haiku',       modelFamily('claude-haiku-4-5') === 'haiku');
  check('alias "opus" → opus',     modelFamily('opus') === 'opus');
  check('uppercase OK',            modelFamily('CLAUDE-SONNET-4-6') === 'sonnet');
  check('legacy 3-7-sonnet → sonnet', modelFamily('claude-3-7-sonnet-20250219') === 'sonnet');
  check('null → null',             modelFamily(null) === null);
  check('undefined → null',        modelFamily(undefined) === null);
  check('empty → null',            modelFamily('') === null);
  check('non-claude id → null',    modelFamily('gpt-4o') === null);
}

// =====================================================================
//  Result
// =====================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`${'='.repeat(70)}\n`);
if (fail > 0) process.exit(1);

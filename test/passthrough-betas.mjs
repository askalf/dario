#!/usr/bin/env node
/**
 * --passthrough-betas plumbing.
 *
 * Two behaviors to lock in:
 *   1. CLI parser: --passthrough-betas=csv beats DARIO_PASSTHROUGH_BETAS,
 *      trims, dedupes, drops empties.
 *   2. Beta-header build (manually replayed in-test, not by booting the
 *      proxy): operator-pinned flags get appended, bypass the billable
 *      filter, but still get stripped by the per-account rejection cache.
 *
 * In-process. No proxy boot, no upstream.
 */

import { parsePassthroughBetasFlag } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// ────────────────────────────────────────────────────────────────────
header('1. parsePassthroughBetasFlag — basic shapes');

check('no flag, no env → empty array',
  JSON.stringify(parsePassthroughBetasFlag([], undefined)) === '[]');

check('env-only csv → trimmed list',
  JSON.stringify(parsePassthroughBetasFlag([], 'a, b ,c')) === '["a","b","c"]');

check('flag-only csv → trimmed list',
  JSON.stringify(parsePassthroughBetasFlag(['--passthrough-betas=x,y'], undefined)) === '["x","y"]');

check('flag wins over env',
  JSON.stringify(parsePassthroughBetasFlag(['--passthrough-betas=cli'], 'env')) === '["cli"]');

check('empty entries dropped',
  JSON.stringify(parsePassthroughBetasFlag(['--passthrough-betas=,a,,b,'], undefined)) === '["a","b"]');

check('duplicates collapsed',
  JSON.stringify(parsePassthroughBetasFlag(['--passthrough-betas=a,b,a'], undefined)) === '["a","b"]');

check('whitespace-only entry dropped',
  JSON.stringify(parsePassthroughBetasFlag(['--passthrough-betas=a,   ,b'], undefined)) === '["a","b"]');

check('empty flag value clears env (operator override to "none")',
  JSON.stringify(parsePassthroughBetasFlag(['--passthrough-betas='], 'envonly')) === '[]');

// ────────────────────────────────────────────────────────────────────
header('2. Beta-build replay — pinned flags survive substitution');

// Replay the proxy's beta-build logic in isolation. The proxy reads
// `passthroughBetas` (a Set) and the per-account `unavailableBetas`
// map, then computes the outbound `anthropic-beta` string. This test
// exercises the same logic shape so the contract is visible without
// having to boot the full proxy. If proxy.ts moves the order of
// operations (pin BEFORE rejected-strip), this stays in sync.

function buildBeta(args) {
  let beta = args.base;
  // Step 1: client beta merge with billable filter.
  if (args.clientBeta) {
    const baseSet = new Set(beta.split(','));
    const filtered = args.clientBeta.split(',')
      .map(b => b.trim())
      .filter(b => b.length > 0 && !args.billable.has(b))
      .filter(b => !baseSet.has(b))
      .join(',');
    if (filtered) beta += ',' + filtered;
  }
  // Step 2: pinned passthrough betas (bypass billable filter).
  if (args.pinned.size > 0) {
    const baseSet = new Set(beta.split(','));
    const toAdd = [...args.pinned].filter(b => !baseSet.has(b));
    if (toAdd.length > 0) beta += ',' + toAdd.join(',');
  }
  // Step 3: per-account rejection cache strips known-bad flags.
  if (args.rejected.size > 0) {
    beta = beta.split(',').filter(t => t.length > 0 && !args.rejected.has(t)).join(',');
  }
  return beta;
}

// Baseline: no pinned, no client → just the captured base.
{
  const out = buildBeta({
    base: 'oauth-2025-04-20,context-1m-2025-08-07',
    clientBeta: undefined,
    pinned: new Set(),
    rejected: new Set(),
    billable: new Set(['extended-cache-ttl-2026-01-01']),
  });
  check('no pin, no client → base unchanged', out === 'oauth-2025-04-20,context-1m-2025-08-07');
}

// Pinned flag bypasses billable filter.
{
  const out = buildBeta({
    base: 'oauth-2025-04-20',
    clientBeta: undefined,
    pinned: new Set(['extended-cache-ttl-2026-01-01']),
    rejected: new Set(),
    billable: new Set(['extended-cache-ttl-2026-01-01']),
  });
  check('pinned billable beta is ALLOWED through', out.includes('extended-cache-ttl-2026-01-01'));
}

// Client tries to set a billable beta — gets filtered. But operator pin
// for the SAME flag wins.
{
  const out = buildBeta({
    base: 'oauth-2025-04-20',
    clientBeta: 'extended-cache-ttl-2026-01-01',
    pinned: new Set(),
    rejected: new Set(),
    billable: new Set(['extended-cache-ttl-2026-01-01']),
  });
  check('unpinned billable beta from client is FILTERED', !out.includes('extended-cache-ttl-2026-01-01'));
}
{
  const out = buildBeta({
    base: 'oauth-2025-04-20',
    clientBeta: 'extended-cache-ttl-2026-01-01',
    pinned: new Set(['extended-cache-ttl-2026-01-01']),
    rejected: new Set(),
    billable: new Set(['extended-cache-ttl-2026-01-01']),
  });
  check('pinned billable beta SURVIVES even when client also requests it', out.includes('extended-cache-ttl-2026-01-01'));
}

// Pinned flag still gets dropped if upstream rejected it.
{
  const out = buildBeta({
    base: 'oauth-2025-04-20',
    clientBeta: undefined,
    pinned: new Set(['afk-mode-2026-01-31']),
    rejected: new Set(['afk-mode-2026-01-31']),
    billable: new Set(),
  });
  check('rejected pinned beta is dropped on retry path', !out.includes('afk-mode-2026-01-31'));
}

// Pinned flag already in base set → not duplicated.
{
  const out = buildBeta({
    base: 'oauth-2025-04-20,context-1m-2025-08-07',
    clientBeta: undefined,
    pinned: new Set(['oauth-2025-04-20']),
    rejected: new Set(),
    billable: new Set(),
  });
  const occurrences = out.split(',').filter(t => t === 'oauth-2025-04-20').length;
  check('pin already in base does not duplicate', occurrences === 1);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

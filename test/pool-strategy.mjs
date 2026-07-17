#!/usr/bin/env node
/**
 * test/pool-strategy.mjs
 *
 * Pool routing strategy. `headroom` (the default, and the only behaviour
 * before this feature) spreads new conversations to the seat with the most
 * slack; `fill-first` concentrates them on the alphabetically-first
 * eligible seat until it drains to the 2% floor, then spills to the next —
 * primary/backup semantics where alias naming picks the fill order.
 *
 * Covers:
 *   - resolvePoolStrategy: explicit wins, env fallback, invalid values
 *     fall through to the default, case/whitespace tolerance
 *   - default construction preserves headroom behaviour exactly
 *   - fill-first: picks the alphabetically-first seat even when a later
 *     seat has more headroom
 *   - fill-first: spills to the next alias at/below the 2% floor and
 *     returns when headroom recovers
 *   - fill-first: skips rejected / expired / auth-cooldown seats
 *   - fill-first: all seats at/below the floor falls back to max-headroom
 *   - fill-first: per-model 7d bucket joins the floor check
 *   - selectExcluding keeps fill order on failover
 *   - selectSticky: existing bindings win over fill order in both modes
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { AccountPool, computeStickyKey, resolvePoolStrategy, EMPTY_SNAPSHOT } from '../dist/pool.js';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// Helper — add an account with an initial snapshot
function addAccount(pool, alias, { util5h = 0, util7d = 0, perModel7d = {}, rejected = false, expiresInMs = 3600_000 } = {}) {
  pool.add(alias, {
    accessToken: `tok-${alias}`,
    refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + expiresInMs,
    deviceId: `dev-${alias}`,
    accountUuid: `uuid-${alias}`,
  });
  pool.updateRateLimits(alias, {
    ...EMPTY_SNAPSHOT,
    util5h,
    util7d,
    perModel7d,
    status: rejected ? 'rejected' : 'ok',
    updatedAt: Date.now(),
  });
  if (rejected) {
    pool.markRejected(alias, {
      ...EMPTY_SNAPSHOT,
      util5h, util7d, perModel7d,
      status: 'rejected',
      updatedAt: Date.now(),
    });
  }
}

header('resolvePoolStrategy');
{
  check('default is headroom', resolvePoolStrategy(undefined, {}) === 'headroom');
  check('explicit fill-first wins', resolvePoolStrategy('fill-first', {}) === 'fill-first');
  check('explicit headroom wins over env', resolvePoolStrategy('headroom', { DARIO_POOL_STRATEGY: 'fill-first' }) === 'headroom');
  check('env fallback applies', resolvePoolStrategy(undefined, { DARIO_POOL_STRATEGY: 'fill-first' }) === 'fill-first');
  check('invalid explicit falls through to env', resolvePoolStrategy('round-robin', { DARIO_POOL_STRATEGY: 'fill-first' }) === 'fill-first');
  check('invalid everywhere falls back to headroom', resolvePoolStrategy('nope', { DARIO_POOL_STRATEGY: 'also-nope' }) === 'headroom');
  check('case and whitespace tolerated', resolvePoolStrategy('  Fill-First ', {}) === 'fill-first');
}

header('default construction preserves headroom behaviour');
{
  const pool = new AccountPool();
  addAccount(pool, 'a-main', { util5h: 0.6 });
  addAccount(pool, 'b-spill', { util5h: 0.1 });
  check('picks the max-headroom seat', pool.select()?.alias === 'b-spill');
}

header('fill-first concentrates on the first alias');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'b-spill', { util5h: 0.1 });
  addAccount(pool, 'a-main', { util5h: 0.6 });
  check('first alias wins despite worse headroom', pool.select()?.alias === 'a-main');
  check('insertion order is irrelevant', pool.select()?.alias === 'a-main');
}

header('fill-first spills at the floor and returns on recovery');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.99 });   // headroom 1% <= 2% floor
  addAccount(pool, 'b-spill', { util5h: 0.5 });
  check('spills to next alias at/below the floor', pool.select()?.alias === 'b-spill');

  pool.updateRateLimits('a-main', { ...EMPTY_SNAPSHOT, util5h: 0.3, status: 'ok', updatedAt: Date.now() });
  check('returns to first alias when headroom recovers', pool.select()?.alias === 'a-main');
}

header('fill-first skips ineligible seats');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-rejected', { util5h: 0.1, rejected: true });
  addAccount(pool, 'b-expired', { util5h: 0.1, expiresInMs: 5_000 });
  addAccount(pool, 'c-cooldown', { util5h: 0.1 });
  addAccount(pool, 'd-healthy', { util5h: 0.4 });
  pool.markAuthFailure('c-cooldown');
  check('rejected/expired/cooldown seats are skipped', pool.select()?.alias === 'd-healthy');
}

header('fill-first with every seat at/below the floor');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.99 });
  addAccount(pool, 'b-spill', { util5h: 0.985 });
  check('falls back to max-headroom (least-drained)', pool.select()?.alias === 'b-spill');
}

header('fill-first honours per-model 7d buckets');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.2, perModel7d: { sonnet: 0.99 } });
  addAccount(pool, 'b-spill', { util5h: 0.5 });
  check('sonnet request spills off the sonnet-drained seat', pool.select('sonnet')?.alias === 'b-spill');
  check('opus request stays on the first seat', pool.select('opus')?.alias === 'a-main');
}

header('selectExcluding keeps fill order on failover');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.3 });
  addAccount(pool, 'b-next', { util5h: 0.6 });
  addAccount(pool, 'c-best-headroom', { util5h: 0.1 });
  const next = pool.selectExcluding(new Set(['a-main']));
  check('failover tries the next alias, not max-headroom', next?.alias === 'b-next');

  const headroomPool = new AccountPool();
  addAccount(headroomPool, 'a-main', { util5h: 0.3 });
  addAccount(headroomPool, 'b-next', { util5h: 0.6 });
  addAccount(headroomPool, 'c-best-headroom', { util5h: 0.1 });
  const hNext = headroomPool.selectExcluding(new Set(['a-main']));
  check('headroom mode failover unchanged (max-headroom)', hNext?.alias === 'c-best-headroom');
}

header('sticky bindings win over fill order in both modes');
{
  const key = computeStickyKey('same first user message');
  for (const strategy of ['headroom', 'fill-first']) {
    const pool = new AccountPool(strategy);
    addAccount(pool, 'a-main', { util5h: 0.3 });
    addAccount(pool, 'b-other', { util5h: 0.3 });
    pool.rebindSticky(key, 'b-other');
    check(`${strategy}: existing binding returned as-is`, pool.selectSticky(key)?.alias === 'b-other');
  }
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);

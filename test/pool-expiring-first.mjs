#!/usr/bin/env node
/**
 * `--pool-strategy=expiring-first`: fill-first, ordered by when each seat's
 * capacity expires instead of by alias.
 *
 * Why: subscription capacity is use-it-or-lose-it. Fleet box, 2026-09-22: the
 * operator used a limit reset on seat `pro1` (its 7-day window then reset on
 * Fri 02:00Z, ~50h out) while `login` had 44% of a window that reset Sat
 * 22:00Z (~70h out). `fill-first` orders by alias, so every new conversation
 * went to `login` and pro1's fresh capacity sat idle; `headroom` spreads, so
 * both drain together and part of pro1's expires unused. `expiring-first`
 * fills the seat whose 7-day window resets soonest until it drains to the
 * floor, then spills.
 *
 * Covers:
 *   - resolvePoolStrategy accepts it (flag, env, case/whitespace)
 *   - parseRateLimits reads `7d-reset` into reset7d, separate from `reset`
 *   - the soonest 7-day reset wins over alias order and over headroom
 *   - it spills to the next-soonest at the floor and returns on recovery
 *   - a seat with no 7d reading, or whose window already rolled, goes last
 *   - ties break by alias
 *   - ineligible seats are skipped; all-at-floor falls back to max headroom
 *   - a reading without the 7d-reset header keeps the learned reset
 *   - the failover path (selectExcluding) keeps the same order
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { AccountPool, resolvePoolStrategy, parseRateLimits, seatExpiry, EMPTY_SNAPSHOT } from '../dist/pool.js';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const NOW = Date.now();
const SECS = Math.floor(NOW / 1000);
const H = 3600;

function addAccount(pool, alias, { util5h = 0, util7d = 0, reset7d = 0, rejected = false, expiresInMs = 3600_000 } = {}) {
  pool.add(alias, {
    accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + expiresInMs, deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
  });
  pool.updateRateLimits(alias, { ...EMPTY_SNAPSHOT, util5h, util7d, reset7d, status: 'ok', updatedAt: Date.now() });
  if (rejected) {
    pool.markRejected(alias, { ...EMPTY_SNAPSHOT, util5h: 1.02, util7d, reset7d, reset: SECS + H, status: 'rejected', updatedAt: Date.now() });
  }
}

header('resolvePoolStrategy');
{
  check('explicit expiring-first', resolvePoolStrategy('expiring-first', {}) === 'expiring-first');
  check('env expiring-first', resolvePoolStrategy(undefined, { DARIO_POOL_STRATEGY: 'expiring-first' }) === 'expiring-first');
  check('case and whitespace tolerated', resolvePoolStrategy('  Expiring-First ', {}) === 'expiring-first');
  check('the others still resolve', resolvePoolStrategy('fill-first', {}) === 'fill-first' && resolvePoolStrategy(undefined, {}) === 'headroom');
}

header('parseRateLimits reads the 7-day reset');
{
  const snap = parseRateLimits(new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.02',
    'anthropic-ratelimit-unified-7d-utilization': '0.44',
    'anthropic-ratelimit-unified-7d-reset': String(SECS + 70 * H),
    'anthropic-ratelimit-unified-reset': String(SECS + 1 * H),
    'anthropic-ratelimit-unified-status': 'allowed',
  }), 'opus');
  check('reset7d is the 7d-reset header', snap.reset7d === SECS + 70 * H, snap.reset7d);
  check('reset is still the representative one', snap.reset === SECS + 1 * H, snap.reset);
  const none = parseRateLimits(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }));
  check('absent header -> 0', none.reset7d === 0, none.reset7d);
}

header('the soonest 7-day reset fills first (the 2026-09-22 shape)');
{
  const pool = new AccountPool('expiring-first');
  addAccount(pool, 'login', { util5h: 0.02, util7d: 0.44, reset7d: SECS + 70 * H });
  addAccount(pool, 'pro1', { util5h: 0.06, util7d: 0.01, reset7d: SECS + 50 * H });
  check('pro1 (resets in 50h) over login (70h)', pool.select()?.alias === 'pro1', pool.select()?.alias);
  const busy = new AccountPool('expiring-first');
  addAccount(busy, 'a-late', { util5h: 0.0, util7d: 0.0, reset7d: SECS + 100 * H });
  addAccount(busy, 'z-soon', { util5h: 0.7, util7d: 0.9, reset7d: SECS + 5 * H });
  check('soonest wins over alias AND over headroom', busy.select()?.alias === 'z-soon', busy.select()?.alias);
  const fill = new AccountPool('fill-first');
  addAccount(fill, 'login', { util7d: 0.44, reset7d: SECS + 70 * H });
  addAccount(fill, 'pro1', { util7d: 0.01, reset7d: SECS + 50 * H });
  check('(fill-first on the same pool still picks login, by alias)', fill.select()?.alias === 'login');
}

header('spills at the floor, returns on recovery');
{
  const pool = new AccountPool('expiring-first');
  addAccount(pool, 'login', { util7d: 0.44, reset7d: SECS + 70 * H });
  addAccount(pool, 'pro1', { util7d: 0.99, reset7d: SECS + 50 * H });
  check('pro1 at the floor -> login', pool.select()?.alias === 'login', pool.select()?.alias);
  pool.updateRateLimits('pro1', { ...EMPTY_SNAPSHOT, util7d: 0.3, reset7d: SECS + 50 * H, status: 'ok', updatedAt: Date.now() });
  check('back to pro1 when it has room', pool.select()?.alias === 'pro1');
  const floored = new AccountPool('expiring-first', 0.1);
  addAccount(floored, 'login', { util7d: 0.44, reset7d: SECS + 70 * H });
  addAccount(floored, 'pro1', { util7d: 0.92, reset7d: SECS + 50 * H });
  check('honours a configured floor (10%)', floored.select()?.alias === 'login');
}

header('unknown or rolled windows go last; ties break by alias');
{
  const pool = new AccountPool('expiring-first');
  addAccount(pool, 'a-unread', { util7d: 0.0 });
  addAccount(pool, 'b-rolled', { util7d: 0.0, reset7d: SECS - 60 });
  addAccount(pool, 'c-known', { util7d: 0.6, reset7d: SECS + 90 * H });
  check('a seat with a known future reset beats unread and rolled seats', pool.select()?.alias === 'c-known', pool.select()?.alias);
  check('seatExpiry of an unread seat is +Infinity', seatExpiry(pool.get('a-unread'), NOW) === Infinity);
  check('seatExpiry of a rolled window is +Infinity', seatExpiry(pool.get('b-rolled'), NOW) === Infinity);
  const ties = new AccountPool('expiring-first');
  addAccount(ties, 'b', { reset7d: SECS + 10 * H });
  addAccount(ties, 'a', { reset7d: SECS + 10 * H });
  check('equal resets -> alias order', ties.select()?.alias === 'a');
  const blind = new AccountPool('expiring-first');
  addAccount(blind, 'b', {});
  addAccount(blind, 'a', {});
  check('no readings at all -> alias order (fill-first behaviour)', blind.select()?.alias === 'a');
}

header('ineligible seats are skipped; all at the floor falls back to max headroom');
{
  const pool = new AccountPool('expiring-first');
  addAccount(pool, 'soon-rejected', { reset7d: SECS + 1 * H, rejected: true });
  addAccount(pool, 'later', { util7d: 0.5, reset7d: SECS + 60 * H });
  check('a rejected soonest seat is skipped', pool.select()?.alias === 'later', pool.select()?.alias);
  const drained = new AccountPool('expiring-first');
  addAccount(drained, 'soon', { util5h: 0.99, reset7d: SECS + 1 * H });
  addAccount(drained, 'late', { util5h: 0.985, reset7d: SECS + 60 * H });
  check('all at/below the floor -> least drained', drained.select()?.alias === 'late');
}

header('a reading without 7d-reset keeps the learned one');
{
  const pool = new AccountPool('expiring-first');
  addAccount(pool, 'login', { util7d: 0.44, reset7d: SECS + 70 * H });
  addAccount(pool, 'pro1', { util7d: 0.01, reset7d: SECS + 50 * H });
  pool.updateRateLimits('pro1', { ...EMPTY_SNAPSHOT, util7d: 0.02, status: 'ok', updatedAt: Date.now() });
  check('pro1 keeps reset7d across a header-less reading', pool.get('pro1').rateLimit.reset7d === SECS + 50 * H, pool.get('pro1').rateLimit.reset7d);
  check('and still fills first', pool.select()?.alias === 'pro1');
}

header('failover keeps the expiring order');
{
  const pool = new AccountPool('expiring-first');
  addAccount(pool, 'a', { util7d: 0.1, reset7d: SECS + 90 * H });
  addAccount(pool, 'b', { util7d: 0.1, reset7d: SECS + 20 * H });
  addAccount(pool, 'c', { util7d: 0.1, reset7d: SECS + 40 * H });
  check('first pick is the soonest (b)', pool.select()?.alias === 'b');
  check('failover from b goes to the next-soonest (c), not by alias (a)', pool.selectExcluding(new Set(['b']))?.alias === 'c', pool.selectExcluding(new Set(['b']))?.alias);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('PASS pool expiring-first');

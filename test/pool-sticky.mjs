#!/usr/bin/env node
/**
 * test/pool-sticky.mjs
 *
 * Session stickiness for AccountPool. Multi-turn agent sessions carry the
 * same first user message on every turn; the pool hashes it into a sticky
 * key and pins the conversation to one account so the Anthropic prompt
 * cache isn't destroyed on every turn by account rotation.
 *
 * Covers:
 *   - computeStickyKey: stable hash, empty/whitespace null-return, collision shape
 *   - selectSticky: first call binds to headroom winner, second call returns
 *     the same account even when a different one has better headroom now
 *   - selectSticky: rebinds on rejected account
 *   - selectSticky: rebinds on expired token
 *   - selectSticky: rebinds on collapsed headroom
 *   - rebindSticky: explicit rebind from 429 failover path
 *   - cleanupSticky: TTL expiry, size cap, stale alias cleanup
 *   - stickyCount / stickyAliasFor observability helpers
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { AccountPool, computeStickyKey, EMPTY_SNAPSHOT } from '../dist/pool.js';

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
function addAccount(pool, alias, { util5h = 0, util7d = 0, rejected = false, expiresInMs = 3600_000 } = {}) {
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
    status: rejected ? 'rejected' : 'ok',
    updatedAt: Date.now(),
  });
  if (rejected) {
    pool.markRejected(alias, {
      ...EMPTY_SNAPSHOT,
      util5h, util7d,
      status: 'rejected',
      updatedAt: Date.now(),
    });
  }
}

// ======================================================================
//  computeStickyKey
// ======================================================================
header('computeStickyKey — stable hash');
{
  const a = computeStickyKey('Hello world');
  const b = computeStickyKey('Hello world');
  const c = computeStickyKey('Hello world ');
  const d = computeStickyKey('Hello worldX');
  check('deterministic: same input → same key', a === b);
  check('trimmed: trailing whitespace does NOT change the key', a === c);
  check('sensitive: different input → different key', a !== d);
  check('key is 16 hex chars', typeof a === 'string' && a.length === 16 && /^[0-9a-f]+$/.test(a));
}

header('computeStickyKey — null cases');
{
  check('empty string → null', computeStickyKey('') === null);
  check('whitespace-only → null', computeStickyKey('   \n\t ') === null);
  check('null → null', computeStickyKey(null) === null);
  check('undefined → null', computeStickyKey(undefined) === null);
}

// ======================================================================
//  selectSticky — basic bind and re-select
// ======================================================================
header('selectSticky — first call binds, second call returns same account');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 }); // highest headroom
  addAccount(pool, 'beta', { util5h: 0.5 });
  addAccount(pool, 'gamma', { util5h: 0.8 });
  const key = computeStickyKey('help me refactor this module');
  const first = pool.selectSticky(key);
  check('first call picks highest-headroom account (alpha)', first?.alias === 'alpha');
  check('binding count is 1', pool.stickyCount() === 1);
  check('stickyAliasFor returns alpha', pool.stickyAliasFor(key) === 'alpha');

  // Now alpha burns through a lot of headroom — beta is now the better
  // pick on plain select(). But sticky should hold alpha because the
  // prompt cache for this conversation already lives on alpha.
  pool.updateRateLimits('alpha', { ...EMPTY_SNAPSHOT, util5h: 0.6, status: 'ok', updatedAt: Date.now() });
  const plainBest = pool.select();
  check('plain select would now pick beta (0.5 < 0.6)', plainBest?.alias === 'beta');
  const second = pool.selectSticky(key);
  check('sticky select still returns alpha', second?.alias === 'alpha');
}

// ======================================================================
//  selectSticky — null key bypasses stickiness
// ======================================================================
header('selectSticky — null key delegates to plain select');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.5 });
  const picked = pool.selectSticky(null);
  check('null key returns best headroom', picked?.alias === 'alpha');
  check('null key creates NO sticky binding', pool.stickyCount() === 0);
}

// ======================================================================
//  selectSticky — rebinds on rejected bound account
// ======================================================================
header('selectSticky — rebinds on rejected bound account');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.5 });
  const key = computeStickyKey('long agent session query one');
  const first = pool.selectSticky(key);
  check('initially bound to alpha', first?.alias === 'alpha');
  pool.markRejected('alpha', { ...EMPTY_SNAPSHOT, status: 'rejected', updatedAt: Date.now() });
  const second = pool.selectSticky(key);
  check('after alpha rejected, sticky rebinds to beta', second?.alias === 'beta');
  check('binding count still 1 (same key, new alias)', pool.stickyCount() === 1);
  check('stickyAliasFor now returns beta', pool.stickyAliasFor(key) === 'beta');
}

// ======================================================================
//  selectSticky — rebinds when bound account's headroom collapses
// ======================================================================
header('selectSticky — rebinds on headroom collapse below 2%');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.5 });
  const key = computeStickyKey('another long session');
  check('first select binds to alpha', pool.selectSticky(key)?.alias === 'alpha');
  // Push alpha to 99% utilization — headroom = 0.01, below the 2% floor.
  pool.updateRateLimits('alpha', { ...EMPTY_SNAPSHOT, util5h: 0.99, status: 'ok', updatedAt: Date.now() });
  const second = pool.selectSticky(key);
  check('after alpha hits 99%, sticky rebinds to beta', second?.alias === 'beta');
}

// ======================================================================
//  selectSticky — rebinds on expired token
// ======================================================================
header('selectSticky — rebinds when bound account token expires');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1, expiresInMs: 3600_000 });
  addAccount(pool, 'beta', { util5h: 0.5, expiresInMs: 3600_000 });
  const key = computeStickyKey('expiring token session');
  check('first select binds to alpha', pool.selectSticky(key)?.alias === 'alpha');
  // Alpha's token is about to expire (under the 30s grace window).
  pool.updateTokens('alpha', 'tok-alpha', 'ref-alpha', Date.now() + 10_000);
  const second = pool.selectSticky(key);
  check('expiring alpha: sticky rebinds to beta', second?.alias === 'beta');
}

// ======================================================================
//  rebindSticky — explicit rebind from proxy 429 failover path
// ======================================================================
header('rebindSticky — explicit alias swap');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.5 });
  addAccount(pool, 'gamma', { util5h: 0.7 });
  const key = computeStickyKey('failover session');
  check('sticky starts at alpha', pool.selectSticky(key)?.alias === 'alpha');
  pool.rebindSticky(key, 'gamma');
  check('stickyAliasFor reflects rebind to gamma', pool.stickyAliasFor(key) === 'gamma');
  // Next sticky select should return gamma (headroom check still passes
  // because gamma has 0.3 headroom).
  check('next sticky select returns gamma', pool.selectSticky(key)?.alias === 'gamma');
}

header('rebindSticky — null key is a no-op, unknown alias is a no-op');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  pool.rebindSticky(null, 'alpha');
  check('null key adds no binding', pool.stickyCount() === 0);
  const key = computeStickyKey('key-a');
  pool.selectSticky(key); // bind alpha
  pool.rebindSticky(key, 'nonexistent');
  check('unknown alias leaves the existing binding intact', pool.stickyAliasFor(key) === 'alpha');
}

// ======================================================================
//  cleanupSticky — stale alias cleanup (account removed)
// ======================================================================
header('cleanupSticky — binding for removed account is dropped');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.5 });
  const key = computeStickyKey('removed account session');
  pool.selectSticky(key); // binds to alpha
  check('bound to alpha', pool.stickyAliasFor(key) === 'alpha');
  pool.remove('alpha');
  // Next sticky select triggers cleanup then re-selects
  const reselected = pool.selectSticky(key);
  check('after alpha removed, next sticky select returns beta', reselected?.alias === 'beta');
  check('stale binding for alpha was cleaned up (now bound to beta)', pool.stickyAliasFor(key) === 'beta');
}

// ======================================================================
//  Multi-conversation — different keys don't interfere
// ======================================================================
header('multi-conversation — distinct keys bind to distinct accounts');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.5 });

  const key1 = computeStickyKey('conversation one about databases');
  const key2 = computeStickyKey('conversation two about react hooks');

  const pick1 = pool.selectSticky(key1);
  check('key1 → alpha (highest headroom)', pick1?.alias === 'alpha');

  // Burn alpha down so beta is now the best headroom for a new conversation
  pool.updateRateLimits('alpha', { ...EMPTY_SNAPSHOT, util5h: 0.7, status: 'ok', updatedAt: Date.now() });

  const pick2 = pool.selectSticky(key2);
  check('key2 → beta (now highest headroom at pick time)', pick2?.alias === 'beta');

  // key1's follow-up still goes to alpha even though beta is now better,
  // because alpha's headroom (0.3) is still above the 2% floor and the
  // conversation's cache lives there.
  const pick1followup = pool.selectSticky(key1);
  check('key1 follow-up still returns alpha (cache preservation)', pick1followup?.alias === 'alpha');

  check('pool has 2 distinct sticky bindings', pool.stickyCount() === 2);
}

// ======================================================================
//  idle-based TTL — the binding timer measures time since LAST use, not
//  creation, so a long-running active session is never rebound out from
//  under its warm prompt cache. `now` is injected (same convention as the
//  auth-cooldown tests tampering lastAuthFailureAt) since we can't sleep 6h.
//  Tokens are given a far-future expiry so the synthetic clock doesn't trip
//  the 30s token-expiry guard inside selectSticky.
// ======================================================================
const HOUR = 3600_000;
const FAR = 72 * HOUR; // token expiry well past the synthetic timeline

header('idle TTL — an actively-used binding survives past the 6h AGE mark');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1, expiresInMs: FAR });
  addAccount(pool, 'beta', { util5h: 0.5, expiresInMs: FAR });
  const key = computeStickyKey('a very long agent session');
  const t0 = Date.now();

  check('binds to alpha at t0', pool.selectSticky(key, null, t0)?.alias === 'alpha');
  // Keep taking turns across many hours — each hit refreshes the idle timer,
  // so the binding never crosses 6h of *idleness* even though its age does.
  check('turn at t0+5h still alpha', pool.selectSticky(key, null, t0 + 5 * HOUR)?.alias === 'alpha');
  check('turn at t0+9h still alpha (age > 6h, idle never > 6h)', pool.selectSticky(key, null, t0 + 9 * HOUR)?.alias === 'alpha');
  check('turn at t0+14h still alpha', pool.selectSticky(key, null, t0 + 14 * HOUR)?.alias === 'alpha');
  check('exactly one binding throughout (never rebound)', pool.stickyCount() === 1);
}

header('idle TTL — a binding idle past 6h is reaped and re-picks the current best');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1, expiresInMs: FAR }); // best at t0
  addAccount(pool, 'beta', { util5h: 0.5, expiresInMs: FAR });
  const key = computeStickyKey('a session that goes quiet');
  const t0 = Date.now();

  check('binds to alpha at t0', pool.selectSticky(key, null, t0)?.alias === 'alpha');
  // alpha drains so a FRESH selection would now prefer beta — but alpha still
  // has 0.4 headroom, above the 2% floor, so stickiness holds it within the TTL.
  pool.updateRateLimits('alpha', { ...EMPTY_SNAPSHOT, util5h: 0.6, status: 'ok', updatedAt: Date.now() });
  check('return at t0+3h stays on alpha (within idle TTL)', pool.selectSticky(key, null, t0 + 3 * HOUR)?.alias === 'alpha');
  // That t0+3h hit re-based the timer; 7h later (idle > 6h) the binding is reaped
  // and the returning conversation re-picks the current best, which is now beta.
  check('return at t0+10h reaped → re-picks beta', pool.selectSticky(key, null, t0 + 10 * HOUR)?.alias === 'beta');
  check('still one binding after reap+rebind', pool.stickyCount() === 1);
  check('binding now points at beta', pool.stickyAliasFor(key) === 'beta');
}

// ======================================================================
//  size cap — evicts least-recently-USED, not least-recently-created
// ======================================================================
header('size cap — LRU eviction keeps recently-used bindings over old-but-idle');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha', { util5h: 0.1, expiresInMs: FAR });
  const t0 = Date.now();
  const keys = [];
  // Fill to the 2000 cap, each binding stamped 1ms apart so lastUsedAt is a
  // strict total order (created-order == used-order at this point).
  for (let i = 0; i < 2000; i++) {
    const k = computeStickyKey(`conversation number ${i}`);
    keys.push(k);
    pool.selectSticky(k, null, t0 + i);
  }
  check('at the cap (2000 bindings)', pool.stickyCount() === 2000);

  // Re-touch the OLDEST-created binding so it becomes the newest-USED one.
  pool.selectSticky(keys[0], null, t0 + 100_000);
  // Overflow the cap, then trigger the cleanup pass that evicts down to 80%.
  const overflow = computeStickyKey('conversation number 2000');
  pool.selectSticky(overflow, null, t0 + 100_001);
  pool.selectSticky(overflow, null, t0 + 100_002);

  check('evicted down to 80% of cap (1600)', pool.stickyCount() === 1600);
  check('key 0 SURVIVED — recently used despite being created first', pool.stickyAliasFor(keys[0]) === 'alpha');
  check('key 1 EVICTED — oldest lastUsedAt', pool.stickyAliasFor(keys[1]) === null);
  check('overflow key survived (just inserted)', pool.stickyAliasFor(overflow) === 'alpha');
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`${'='.repeat(70)}`);
if (fail > 0) process.exit(1);

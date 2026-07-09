#!/usr/bin/env node
/**
 * Pool mode — end-to-end routing validation.
 *
 * The existing pool tests are unit-level: pool-sticky drives selectSticky with
 * hand-built RateLimitSnapshots, pool-auth-cooldown / pool-reconcile / pool-
 * activation each cover one method. None exercise the path the PROXY actually
 * runs: real Anthropic-shaped response headers → parseRateLimits → a snapshot
 * fed back via updateRateLimits/markRejected → the next select/selectExcluding
 * decision — and in particular NOTHING covers per-model-family headroom routing
 * (`select('opus')` vs `select('fable')` landing on different accounts because
 * their per-model 7d buckets differ), which is the mechanism that makes pool
 * mode worth running.
 *
 * This harness stands up N synthetic accounts and drives them through the exact
 * pool API sequence proxy.ts uses (select → updateRateLimits(parseRateLimits(
 * upstreamHeaders)) → on 429 markRejected + selectExcluding(tried, family) +
 * rebindSticky), asserting routing correctness end to end. In-process; no proxy,
 * OAuth, or upstream.
 */

import { AccountPool, parseRateLimits, modelFamily, computeStickyKey } from '../dist/pool.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const HOUR = 3600_000;

// Mint a synthetic account with a far-future token so expiry never gates it.
function addAccount(pool, alias) {
  pool.add(alias, {
    accessToken: `tok-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 8 * HOUR,
    deviceId: `dev-${alias}`,
    accountUuid: `uuid-${alias}`,
  });
}

// Build a real `Headers` instance shaped exactly like an Anthropic unified
// rate-limit response, so the snapshot comes through the production parser.
// `perModel` maps family → 7d utilization, emitting the `7d_<family>` headers
// the parser scans for.
function upstreamHeaders({ status = 'allowed', util5h = 0, util7d = 0, perModel = {}, claim = 'seven_day', reset = Math.floor(Date.now() / 1000) + 7 * 24 * 3600, overage = 0 } = {}) {
  const h = new Headers();
  h.set('anthropic-ratelimit-unified-status', status);
  h.set('anthropic-ratelimit-unified-5h-utilization', String(util5h));
  h.set('anthropic-ratelimit-unified-7d-utilization', String(util7d));
  h.set('anthropic-ratelimit-unified-overage-utilization', String(overage));
  h.set('anthropic-ratelimit-unified-representative-claim', claim);
  h.set('anthropic-ratelimit-unified-reset', String(reset));
  for (const [family, util] of Object.entries(perModel)) {
    h.set(`anthropic-ratelimit-unified-7d_${family}-utilization`, String(util));
  }
  return h;
}

// Apply an upstream response to the pool the way proxy.ts does: 429 → markRejected,
// otherwise updateRateLimits, both from a parsed real-headers snapshot.
function applyResponse(pool, alias, status, headerOpts) {
  const snapshot = parseRateLimits(upstreamHeaders(headerOpts));
  if (status === 429) pool.markRejected(alias, snapshot);
  else pool.updateRateLimits(alias, snapshot);
  return snapshot;
}

// ── parseRateLimits round-trip: real headers → snapshot the router reads ──
header('parseRateLimits — real Anthropic headers → snapshot');
{
  const snap = parseRateLimits(upstreamHeaders({
    util5h: 0.4, util7d: 0.6, perModel: { opus: 0.9, fable: 0.1 }, claim: 'seven_day',
  }));
  check('util5h parsed', snap.util5h === 0.4);
  check('util7d parsed', snap.util7d === 0.6);
  check('per-model opus bucket parsed', snap.perModel7d.opus === 0.9);
  check('per-model fable bucket parsed', snap.perModel7d.fable === 0.1);
  check('claim parsed', snap.claim === 'seven_day');
  check('unknown family absent (not zero-filled)', snap.perModel7d.sonnet === undefined);
}

// ── Per-model-family routing: the core pool-mode value prop ──
// Two accounts. A is nearly out of Opus but flush on Fable; B is the mirror.
// A request's family must route to whichever account has slack in THAT family's
// bucket — not by the unified 7d number, which is identical here.
header('per-model routing — opus vs fable land on different accounts');
{
  const pool = new AccountPool();
  addAccount(pool, 'A');
  addAccount(pool, 'B');
  // Identical unified 7d (0.5) so ONLY the per-model bucket can differentiate.
  applyResponse(pool, 'A', 200, { util7d: 0.5, perModel: { opus: 0.95, fable: 0.10 } });
  applyResponse(pool, 'B', 200, { util7d: 0.5, perModel: { opus: 0.10, fable: 0.95 } });

  check('opus request routes to B (A is opus-saturated)', pool.select(modelFamily('claude-opus-4-8'))?.alias === 'B');
  check('fable request routes to A (B is fable-saturated)', pool.select(modelFamily('claude-fable-5'))?.alias === 'A');
  // A family with no per-model bucket on either account falls back to unified
  // headroom (a tie here) — must still return a usable account, not null.
  check('haiku request (no per-model bucket) still selects', pool.select(modelFamily('claude-haiku-4-5')) !== null);
  // Family-less select uses unified buckets only (tie → first eligible).
  check('family-less select returns an account', pool.select() !== null);
}

// ── Headroom picks the max-slack account, and tracks live updates ──
header('headroom routing — most-slack account wins, updates live');
{
  const pool = new AccountPool();
  addAccount(pool, 'alpha');
  addAccount(pool, 'beta');
  applyResponse(pool, 'alpha', 200, { util7d: 0.2 });   // 80% headroom
  applyResponse(pool, 'beta', 200, { util7d: 0.7 });    // 30% headroom
  check('picks alpha (most headroom)', pool.select()?.alias === 'alpha');

  // alpha burns down below beta — routing must follow the live snapshot.
  applyResponse(pool, 'alpha', 200, { util7d: 0.85 });  // 15% headroom
  check('after alpha burns down, picks beta', pool.select()?.alias === 'beta');
}

// ── Full in-request 429 failover loop, exactly as proxy dispatchLoop drives it ──
// select → 429 → markRejected + selectExcluding(tried) → … until an account
// answers or the pool is exhausted.
header('429 failover loop — selectExcluding cascades then exhausts');
{
  const pool = new AccountPool();
  for (const a of ['a1', 'a2', 'a3']) addAccount(pool, a);
  applyResponse(pool, 'a1', 200, { util7d: 0.1 });   // best
  applyResponse(pool, 'a2', 200, { util7d: 0.3 });
  applyResponse(pool, 'a3', 200, { util7d: 0.5 });

  const family = modelFamily('claude-sonnet-5');
  const tried = new Set();

  // Turn 1: initial select is the best account.
  let acct = pool.select(family);
  check('initial select is a1 (best headroom)', acct?.alias === 'a1');
  tried.add(acct.alias);
  // a1 returns 429 (rejected) → mark + failover.
  applyResponse(pool, 'a1', 429, { status: 'rejected', util7d: 1.0 });
  acct = pool.selectExcluding(tried, family);
  check('failover #1 → a2 (next-best, a1 excluded+rejected)', acct?.alias === 'a2');
  tried.add(acct.alias);
  applyResponse(pool, 'a2', 429, { status: 'rejected', util7d: 1.0 });
  acct = pool.selectExcluding(tried, family);
  check('failover #2 → a3 (last standing)', acct?.alias === 'a3');
  tried.add(acct.alias);
  applyResponse(pool, 'a3', 429, { status: 'rejected', util7d: 1.0 });
  acct = pool.selectExcluding(tried, family);
  check('failover #3 → null (pool exhausted)', acct === null);

  // With every account rejected, a fresh select() falls back to earliest-reset,
  // never returns a still-usable illusion.
  const fallback = pool.select(family);
  check('all-rejected select falls back to an earliest-reset account (not null)', fallback !== null);
}

// ── Sticky session survives a mid-conversation failover ──
// A multi-turn conversation binds to one account; that account gets rejected on
// a later turn; the proxy rebinds via rebindSticky and the binding must follow.
header('sticky + failover — conversation rebinds and stays on new account');
{
  const pool = new AccountPool();
  addAccount(pool, 'home');
  addAccount(pool, 'backup');
  applyResponse(pool, 'home', 200, { util7d: 0.1 });    // best → sticky lands here
  applyResponse(pool, 'backup', 200, { util7d: 0.4 });

  const key = computeStickyKey('read the repo and summarize the architecture');
  const family = modelFamily('claude-opus-4-8');

  check('turn 1 binds conversation to home', pool.selectSticky(key, family)?.alias === 'home');
  check('turn 2 stays on home (cache locality)', pool.selectSticky(key, family)?.alias === 'home');

  // Turn 3: home 429s mid-request. Proxy: markRejected + selectExcluding + rebindSticky.
  const tried = new Set(['home']);
  applyResponse(pool, 'home', 429, { status: 'rejected', util7d: 1.0 });
  const next = pool.selectExcluding(tried, family);
  check('failover selects backup', next?.alias === 'backup');
  pool.rebindSticky(key, next.alias);

  check('turn 4 of same conversation now sticks to backup', pool.selectSticky(key, family)?.alias === 'backup');
  check('binding did not leak (still one sticky entry)', pool.stickyCount() === 1);
}

// ── Interleaved multi-family workload routes each family independently ──
// One busy account for opus, a different busy account for fable; a stream of
// interleaved opus/fable requests must each go to the family-appropriate seat.
header('interleaved workload — each family routed by its own bucket');
{
  const pool = new AccountPool();
  addAccount(pool, 'X');
  addAccount(pool, 'Y');
  applyResponse(pool, 'X', 200, { util7d: 0.5, perModel: { opus: 0.05, fable: 0.98 } });
  applyResponse(pool, 'Y', 200, { util7d: 0.5, perModel: { opus: 0.98, fable: 0.05 } });

  const models = ['claude-opus-4-8', 'claude-fable-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-fable-5'];
  const routed = models.map((m) => pool.select(modelFamily(m))?.alias);
  const expected = ['X', 'Y', 'X', 'Y', 'Y']; // opus→X (Y opus-saturated), fable→Y (X fable-saturated)
  check(`routing sequence ${JSON.stringify(routed)} matches ${JSON.stringify(expected)}`,
    JSON.stringify(routed) === JSON.stringify(expected));
}

// ── Auth cooldown removes an account from routing, then failover covers it ──
header('auth failure — cooled-down account skipped, healthy one still routes');
{
  const pool = new AccountPool();
  addAccount(pool, 'good');
  addAccount(pool, 'bad');
  applyResponse(pool, 'good', 200, { util7d: 0.6 });    // less headroom
  applyResponse(pool, 'bad', 200, { util7d: 0.1 });     // more headroom, but about to fail auth

  check('normally picks bad (most headroom)', pool.select()?.alias === 'bad');
  pool.markAuthFailure('bad');                          // 401/invalid_grant → cooldown
  check('after auth failure, routing skips bad → good', pool.select()?.alias === 'good');
  pool.clearAuthFailure('bad');
  check('after clear, bad is routable again', pool.select()?.alias === 'bad');
}

// ── Single-account degenerate case: selectExcluding refuses to loop forever ──
header('single account — selectExcluding returns null (no phantom failover)');
{
  const pool = new AccountPool();
  addAccount(pool, 'solo');
  applyResponse(pool, 'solo', 200, { util7d: 0.3 });
  check('select returns solo', pool.select()?.alias === 'solo');
  check('selectExcluding(solo) → null (nothing to fail over to)', pool.selectExcluding(new Set(['solo'])) === null);
}

console.log(`\npool-e2e: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

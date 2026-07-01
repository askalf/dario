#!/usr/bin/env node
// Tests for reconcilePoolAccounts (#599) — the hot-reload primitive behind the
// headless admin API. Exercises the live AccountPool directly with synthetic
// accounts: no disk, no network, no proxy, so it never touches a real ~/.dario.
//
// Covers the two behaviours the admin/headless flow depends on:
//   1. An empty pool selects nothing -> the request path returns a clean 503
//      ("No account configured") instead of the single-account upstream error.
//   2. Reconciling the pool against the on-disk set adds new accounts, drops
//      removed ones, refreshes an existing account's tokens, and preserves its
//      rate-limit / auth-cooldown state — so an account added over HTTP becomes
//      routable immediately, with no proxy restart.

import { AccountPool, reconcilePoolAccounts, isInAuthCooldown } from '../dist/pool.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const HOUR = 3600_000;
function mkAcc(alias, accessToken = `tok-${alias}`) {
  return {
    alias,
    accessToken,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 2 * HOUR,
    deviceId: `dev-${alias}`,
    accountUuid: `uuid-${alias}`,
  };
}
const aliasesOf = (pool) => pool.all().map(a => a.alias).sort();
const tokenOf = (pool, alias) => pool.all().find(a => a.alias === alias)?.accessToken;

// ─────────────────────────────────────────────────────────────
header('Empty pool -> select() is null (the clean-503 trigger, #599)');
{
  const pool = new AccountPool();
  check('fresh pool size is 0', pool.size === 0);
  check('select() on empty pool returns null', pool.select() === null);
}

// ─────────────────────────────────────────────────────────────
header('Reconcile: bootstrap from empty, then add');
{
  const pool = new AccountPool();

  const n0 = reconcilePoolAccounts(pool, []);
  check('reconcile([]) keeps size 0', n0 === 0 && pool.size === 0);
  check('still selects nothing while empty', pool.select() === null);

  const n1 = reconcilePoolAccounts(pool, [mkAcc('acct1')]);
  check('first account added -> size 1', n1 === 1 && pool.size === 1);
  check('the lone account is now selectable', pool.select()?.alias === 'acct1');

  const n2 = reconcilePoolAccounts(pool, [mkAcc('acct1'), mkAcc('acct2')]);
  check('second account added -> size 2', n2 === 2);
  check('both aliases present', JSON.stringify(aliasesOf(pool)) === JSON.stringify(['acct1', 'acct2']));
}

// ─────────────────────────────────────────────────────────────
header('Reconcile: removals drop accounts no longer on disk');
{
  const pool = new AccountPool();
  reconcilePoolAccounts(pool, [mkAcc('a'), mkAcc('b'), mkAcc('c')]);
  check('seeded 3', pool.size === 3);

  const n = reconcilePoolAccounts(pool, [mkAcc('b')]);
  check('reconcile to just [b] -> size 1', n === 1);
  check('only b remains', JSON.stringify(aliasesOf(pool)) === JSON.stringify(['b']));

  const nEmpty = reconcilePoolAccounts(pool, []);
  check('reconcile to [] -> size 0 (all removed)', nEmpty === 0 && pool.size === 0);
  check('empty again selects nothing', pool.select() === null);
}

// ─────────────────────────────────────────────────────────────
header('Reconcile: existing account gets fresh tokens, keeps its state');
{
  const pool = new AccountPool();
  reconcilePoolAccounts(pool, [mkAcc('keep', 'old-token')]);
  check('seeded token is old-token', tokenOf(pool, 'keep') === 'old-token');

  // Put the account into auth cool-down (mirrors a 401 during use).
  pool.markAuthFailure('keep');
  const before = pool.all().find(a => a.alias === 'keep');
  check('account is in auth cool-down after a failure', isInAuthCooldown(before));
  check('cool-down makes it unselectable', pool.select() === null);

  // A reconcile (e.g. background refresh wrote a new token to disk) must update
  // the token WITHOUT clearing the cool-down / resetting failure state.
  reconcilePoolAccounts(pool, [mkAcc('keep', 'new-token')]);
  check('token refreshed to new-token', tokenOf(pool, 'keep') === 'new-token');
  const after = pool.all().find(a => a.alias === 'keep');
  check('auth cool-down preserved across reconcile', isInAuthCooldown(after));
  check('failure counter preserved (not reset by re-add)', after.consecutiveAuthFailures >= 1);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

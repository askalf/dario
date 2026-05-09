// dario#234 — pool selector skips accounts in auth-failure cool-down.
//
// Without this, a 401/403 on one account never moves the selector off it:
// rate-limit-driven routing only sees `util5h` / `util7d` headers, which
// 401 responses don't include. Headroom math sees a healthy idle account
// → selector keeps picking the dead one. The cool-down adds an explicit
// "this account just failed auth, skip for N seconds" filter.
//
// The actual proxy-side hook (mark on 401/403, clear on 2xx) is exercised
// by the live e2e — these tests cover the pool-internal contract.

import {
  AccountPool,
  authCooldownMs,
  isInAuthCooldown,
} from '../dist/pool.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`, ...rest); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

function makePool(aliases) {
  const pool = new AccountPool();
  for (const alias of aliases) {
    pool.add(alias, {
      accessToken: `tok-${alias}`,
      refreshToken: `ref-${alias}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
      deviceId: `dev-${alias}`,
      accountUuid: `uuid-${alias}`,
    });
  }
  return pool;
}

// ----------------------------------------------------------------------
header('authCooldownMs — exponential backoff with cap');
// ----------------------------------------------------------------------
{
  check('0 failures → 0ms', authCooldownMs(0) === 0);
  check('1 failure → 60s', authCooldownMs(1) === 60_000);
  check('2 failures → 120s (doubles)', authCooldownMs(2) === 120_000);
  check('3 failures → 240s', authCooldownMs(3) === 240_000);
  check('large N caps at 30 min', authCooldownMs(20) === 30 * 60 * 1000);
}

// ----------------------------------------------------------------------
header('isInAuthCooldown — fresh account is not in cooldown');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha']);
  const acc = pool.all().find(a => a.alias === 'alpha');
  check('no failure → not in cooldown', !isInAuthCooldown(acc));
  check('lastAuthFailureAt is undefined initially', acc.lastAuthFailureAt === undefined);
  check('consecutiveAuthFailures starts at 0', acc.consecutiveAuthFailures === 0);
}

// ----------------------------------------------------------------------
header('markAuthFailure — puts account in cooldown');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha']);
  pool.markAuthFailure('alpha');
  const acc = pool.all().find(a => a.alias === 'alpha');
  check('lastAuthFailureAt populated', typeof acc.lastAuthFailureAt === 'number');
  check('consecutiveAuthFailures = 1', acc.consecutiveAuthFailures === 1);
  check('isInAuthCooldown returns true', isInAuthCooldown(acc));
}

// ----------------------------------------------------------------------
header('markAuthFailure — increments counter on consecutive failures');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha']);
  pool.markAuthFailure('alpha');
  pool.markAuthFailure('alpha');
  pool.markAuthFailure('alpha');
  const acc = pool.all().find(a => a.alias === 'alpha');
  check('counter reaches 3', acc.consecutiveAuthFailures === 3);
}

// ----------------------------------------------------------------------
header('markAuthFailure — no-op for unknown alias');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha']);
  pool.markAuthFailure('nonexistent');
  const acc = pool.all().find(a => a.alias === 'alpha');
  check('alpha untouched', acc.consecutiveAuthFailures === 0);
}

// ----------------------------------------------------------------------
header('clearAuthFailure — resets counter and timestamp');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha']);
  pool.markAuthFailure('alpha');
  pool.markAuthFailure('alpha');
  pool.clearAuthFailure('alpha');
  const acc = pool.all().find(a => a.alias === 'alpha');
  check('lastAuthFailureAt cleared', acc.lastAuthFailureAt === undefined);
  check('counter reset to 0', acc.consecutiveAuthFailures === 0);
  check('isInAuthCooldown returns false', !isInAuthCooldown(acc));
}

// ----------------------------------------------------------------------
header('clearAuthFailure on alias A does not affect alias B');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha', 'beta']);
  pool.markAuthFailure('alpha');
  pool.markAuthFailure('beta');
  pool.clearAuthFailure('alpha');
  const beta = pool.all().find(a => a.alias === 'beta');
  check('beta still in cooldown', isInAuthCooldown(beta));
}

// ----------------------------------------------------------------------
header('select() skips cooldown\'d accounts');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha', 'beta']);
  pool.markAuthFailure('alpha');
  const picked = pool.select();
  check('skipped alpha (in cooldown)', picked && picked.alias === 'beta');
}

// ----------------------------------------------------------------------
header('select() returns null when ALL accounts are in cooldown');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha', 'beta']);
  pool.markAuthFailure('alpha');
  pool.markAuthFailure('beta');
  const picked = pool.select();
  check('returns null (no eligible account)', picked === null);
}

// ----------------------------------------------------------------------
header('selectExcluding() skips cooldown\'d accounts on 429 failover');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha', 'beta', 'gamma']);
  // Simulate 429 on alpha → tried alpha, then auth-failure on beta
  // → now selectExcluding({alpha}) should return gamma, not beta
  pool.markAuthFailure('beta');
  const picked = pool.selectExcluding(new Set(['alpha']));
  check('skipped both alpha (excluded) and beta (cooldown)', picked && picked.alias === 'gamma');
}

// ----------------------------------------------------------------------
header('selectSticky() breaks binding when bound account is in cooldown');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha', 'beta']);
  // First call binds key to whichever is bestAccount (alphabetical tied).
  const first = pool.selectSticky('conv-key-1');
  check('first call binds and picks an account', first !== null);
  const firstAlias = first.alias;

  // Mark the bound account in cooldown — next selectSticky should rebind
  // to the other account.
  pool.markAuthFailure(firstAlias);
  const second = pool.selectSticky('conv-key-1');
  check('second call rebinds to peer (not the cooldown\'d account)', second && second.alias !== firstAlias);
  check('peer received the binding', pool.stickyAliasFor('conv-key-1') === second.alias);
}

// ----------------------------------------------------------------------
header('cooldown expires after the configured window');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha']);
  pool.markAuthFailure('alpha');
  const acc = pool.all().find(a => a.alias === 'alpha');

  // Tamper with the timestamp to simulate the cooldown having passed.
  // Real code wouldn't do this — wallclock advances naturally — but
  // we can't sleep 60s in a unit test. The contract we're pinning is
  // "isInAuthCooldown returns false once now > lastAuthFailureAt + cooldownMs".
  acc.lastAuthFailureAt = Date.now() - 61_000; // 61s ago, past 60s cooldown
  check('past the cooldown window → no longer in cooldown', !isInAuthCooldown(acc));

  // And select() can pick it again.
  const picked = pool.select();
  check('select() returns the now-eligible account', picked && picked.alias === 'alpha');
}

// ----------------------------------------------------------------------
header('status() counts cooldown\'d accounts as unhealthy');
// ----------------------------------------------------------------------
{
  const pool = makePool(['alpha', 'beta']);
  pool.markAuthFailure('alpha');
  const status = pool.status();
  check('healthy count excludes cooldown\'d alpha', status.healthy === 1);
  check('exhausted count includes alpha', status.exhausted === 1);
}

// ----------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

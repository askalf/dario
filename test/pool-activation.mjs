// dario#618 — pool activation threshold is a documented contract.
//
// `shouldUsePool` decides whether `dario proxy` routes through the account
// pool or the classic single-account credentials.json path. The contract:
//
//   - ANY entry in ~/.dario/accounts/ activates the pool, so a cold
//     `dario accounts add <alias>` (no prior `dario login`) yields a
//     servable proxy. Before #618 the threshold was 2+ and a lone
//     accounts/ entry exited with "Not authenticated. Run `dario login`".
//   - Zero accounts + non-admin keeps the login-only path — existing
//     `dario login` setups never see the pool.
//   - Admin mode (#599) always pools, even at zero accounts, so the
//     empty pool can be populated over HTTP.
//
// Pure function, no disk. Pins the threshold so a refactor can't quietly
// regress the cold-start lifecycle.

import { shouldUsePool } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

header('non-admin thresholds');
{
  check('0 accounts → login-only path (no pool)', shouldUsePool(0, false) === false);
  check('1 account → pool (#618: cold `accounts add` serves)', shouldUsePool(1, false) === true);
  check('2 accounts → pool (pre-#618 behavior unchanged)', shouldUsePool(2, false) === true);
}

header('admin mode always pools (#599)');
{
  check('0 accounts + admin → pool (empty start, populated over HTTP)', shouldUsePool(0, true) === true);
  check('1 account + admin → pool', shouldUsePool(1, true) === true);
}

console.log(`\npool-activation: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

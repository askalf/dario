#!/usr/bin/env node
/**
 * test/pool-headroom-floor.mjs
 *
 * The pool headroom floor is configurable (dario#1333). Default 2%: a seat
 * whose headroom is at or below the floor counts as drained — a sticky
 * session rebinds off it and new conversations skip it. An operator whose
 * seats answer with API errors in the last percent of a window moves the
 * floor to 5% and the seat is left alone before the 429, not at it.
 *
 * Covers:
 *   - parsePoolHeadroomFloor: ratio, percent, bare number > 1 as percent,
 *     whitespace, out-of-bounds and garbage → null
 *   - resolvePoolHeadroomFloor: explicit wins, env fallback, invalid falls
 *     through, default 0.02
 *   - default construction is byte-for-byte the old behaviour (2%)
 *   - selectSticky: a binding rides a seat at 96% used under the default
 *     floor and rebinds off it under a 5% floor
 *   - select (headroom strategy): a seat at the floor is still returned when
 *     it is the only one (max-headroom fallback), not null
 *   - fill-first: the first alias spills at the configured floor, not at 2%
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */
import {
  AccountPool, computeStickyKey, EMPTY_SNAPSHOT,
  parsePoolHeadroomFloor, resolvePoolHeadroomFloor, DEFAULT_POOL_HEADROOM_FLOOR,
} from '../dist/pool.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

function addAccount(pool, alias, { util5h = 0, util7d = 0 } = {}) {
  pool.add(alias, {
    accessToken: `tok-${alias}`,
    refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + 3600_000,
    deviceId: `dev-${alias}`,
    accountUuid: `uuid-${alias}`,
  });
  pool.updateRateLimits(alias, { ...EMPTY_SNAPSHOT, util5h, util7d, status: 'ok', updatedAt: Date.now() });
}

header('parsePoolHeadroomFloor');
{
  check('ratio', parsePoolHeadroomFloor('0.05') === 0.05);
  check('percent with sign', parsePoolHeadroomFloor('5%') === 0.05);
  check('bare number above 1 is a percent', parsePoolHeadroomFloor('5') === 0.05);
  check('number input', parsePoolHeadroomFloor(0.1) === 0.1);
  check('whitespace tolerated', parsePoolHeadroomFloor('  10 % ') === 0.1);
  check('below the 2% minimum is rejected', parsePoolHeadroomFloor('0.01') === null);
  check('above the 50% maximum is rejected', parsePoolHeadroomFloor('0.6') === null);
  check('garbage is rejected', parsePoolHeadroomFloor('lots') === null);
  check('empty is rejected', parsePoolHeadroomFloor('') === null);
  check('undefined is rejected', parsePoolHeadroomFloor(undefined) === null);
}

header('resolvePoolHeadroomFloor');
{
  check('default is 2%', resolvePoolHeadroomFloor(undefined, {}) === DEFAULT_POOL_HEADROOM_FLOOR && DEFAULT_POOL_HEADROOM_FLOOR === 0.02);
  check('explicit wins over env', resolvePoolHeadroomFloor('0.1', { DARIO_POOL_HEADROOM_FLOOR: '0.2' }) === 0.1);
  check('env fallback applies', resolvePoolHeadroomFloor(undefined, { DARIO_POOL_HEADROOM_FLOOR: '5%' }) === 0.05);
  check('invalid explicit falls through to env', resolvePoolHeadroomFloor('nope', { DARIO_POOL_HEADROOM_FLOOR: '0.05' }) === 0.05);
  check('invalid everywhere falls back to the default', resolvePoolHeadroomFloor('99', { DARIO_POOL_HEADROOM_FLOOR: '0' }) === 0.02);
  check('a bare 9 means 9%', resolvePoolHeadroomFloor('9', {}) === 0.09);
}

header('default construction keeps the 2% behaviour');
{
  const pool = new AccountPool();
  check('pool reports the default floor', pool.headroomFloor === 0.02);
  addAccount(pool, 'a', { util5h: 0.96 });   // headroom 4% > 2%: still fine
  addAccount(pool, 'b', { util5h: 0.1 });
  const key = computeStickyKey('hello');
  pool.rebindSticky(key, 'a');
  check('a session bound to a 96%-used seat keeps riding it at the default floor', pool.selectSticky(key)?.alias === 'a');
}

header('a 5% floor rebinds a sticky session off a 96%-used seat');
{
  const pool = new AccountPool('headroom', 0.05);
  check('pool reports the configured floor', pool.headroomFloor === 0.05);
  addAccount(pool, 'a', { util5h: 0.96 });   // headroom 4% <= 5%: drained
  addAccount(pool, 'b', { util5h: 0.1 });
  const key = computeStickyKey('hello again');
  pool.rebindSticky(key, 'a');
  check('the session moves to the seat with headroom', pool.selectSticky(key)?.alias === 'b');
  check('and stays there', pool.selectSticky(key)?.alias === 'b');
  pool.updateRateLimits('a', { ...EMPTY_SNAPSHOT, util5h: 0.5, status: 'ok', updatedAt: Date.now() });
  check('a recovered seat does not steal a bound session back', pool.selectSticky(key)?.alias === 'b');
}

header('a lone seat at the floor is still served, never null');
{
  const pool = new AccountPool('headroom', 0.05);
  addAccount(pool, 'only', { util5h: 0.97 });
  check('max-headroom fallback returns the only seat', pool.select()?.alias === 'only');
}

header('fill-first spills at the configured floor');
{
  const pool = new AccountPool('fill-first', 0.1);
  addAccount(pool, 'a-main', { util5h: 0.92 });   // headroom 8% <= 10%: spill
  addAccount(pool, 'b-spill', { util5h: 0.5 });
  check('spills at 10% where the default would not', pool.select()?.alias === 'b-spill');
  const strict = new AccountPool('fill-first');
  addAccount(strict, 'a-main', { util5h: 0.92 });
  addAccount(strict, 'b-spill', { util5h: 0.5 });
  check('the default floor keeps filling the first seat at 92% used', strict.select()?.alias === 'a-main');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

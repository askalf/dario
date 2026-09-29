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
 *   - the implicit default stays soft; an explicit floor hard-parks
 *   - selectExcluding: failover never picks another seat at the floor
 *   - hard parking reports a reset; stale/reset-less readings stay probeable
 *   - fill-first: the first alias spills at the configured floor, not at 2%
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */
import {
  AccountPool, computeStickyKey, EMPTY_SNAPSHOT,
  parsePoolHeadroomFloor, resolvePoolHeadroomFloor, DEFAULT_POOL_HEADROOM_FLOOR, headroomFloorProblem, headroomFloorFlagProblem,
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
  pool.updateRateLimits('a', { ...EMPTY_SNAPSHOT, util5h: 0.99, status: 'ok', updatedAt: Date.now() });
  pool.updateRateLimits('b', { ...EMPTY_SNAPSHOT, util5h: 0.98, status: 'ok', updatedAt: Date.now() });
  check('the implicit 2% floor remains a preference', pool.select()?.alias === 'b');
}

header('an explicitly configured 2% floor is hard');
{
  const pool = new AccountPool('headroom', 0.02);
  addAccount(pool, 'only', { util5h: 0.98 });
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.98,
    claim: 'five_hour',
    reset: Math.floor(Date.now() / 1000) + 300,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('the explicit floor returns no seat', pool.select() === null);
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

header('the floor hard-parks every routing strategy');
{
  for (const strategy of ['headroom', 'fill-first', 'expiring-first']) {
    const pool = new AccountPool(strategy, 0.05);
    addAccount(pool, 'only', { util5h: 0.96 });
    pool.updateRateLimits('only', {
      ...EMPTY_SNAPSHOT,
      util5h: 0.96,
      claim: 'five_hour',
      reset: Math.floor(Date.now() / 1000) + 300,
      status: 'ok',
      updatedAt: Date.now(),
    });
    check(`${strategy} returns no seat at the floor`, pool.select() === null);
  }
}

header('failover does not cross the floor');
{
  const pool = new AccountPool('headroom', 0.05);
  addAccount(pool, 'failed', { util5h: 0.1 });
  addAccount(pool, 'drained', { util5h: 0.96 });
  pool.updateRateLimits('drained', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    claim: 'five_hour',
    reset: Math.floor(Date.now() / 1000) + 300,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('the drained peer is not a failover target', pool.selectExcluding(new Set(['failed'])) === null);
}

header('hard parking reports the earliest known reset');
{
  const pool = new AccountPool('headroom', 0.05);
  const reset = Math.floor(Date.now() / 1000) + 300;
  const laterReset = reset + 300;
  addAccount(pool, 'only', { util5h: 0.96 });
  addAccount(pool, 'later', { util5h: 0.96 });
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    claim: 'five_hour',
    reset,
    status: 'ok',
    updatedAt: Date.now(),
  });
  pool.updateRateLimits('later', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    claim: 'five_hour',
    reset: laterReset,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('selection is parked', pool.select() === null);
  check('parkedUntil names the earliest reset', pool.parkedUntil() === reset * 1000, pool.parkedUntil());
}

header('preferred seats obey an explicit hard floor');
{
  const reset = Math.floor(Date.now() / 1000) + 300;
  const pool = new AccountPool('headroom', 0.05);
  addAccount(pool, 'preferred', { util5h: 0.96 });
  pool.updateRateLimits('preferred', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    claim: 'five_hour',
    reset,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('a known-reset preferred seat cannot bypass hard parking', pool.canPrefer(pool.get('preferred')) === false);
  pool.updateRateLimits('preferred', {
    ...pool.get('preferred').rateLimit,
    claim: 'unknown',
    reset: 0,
  });
  check('a stale preferred seat remains probeable', pool.canPrefer(pool.get('preferred')) === true);
}

header('readings that cannot retire themselves stay probeable');
{
  const pool = new AccountPool('headroom', 0.05);
  addAccount(pool, 'only', { util5h: 0.96 });
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    claim: 'unknown',
    reset: 0,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('a reset-less reading is probed', pool.select()?.alias === 'only');

  const reset7d = Math.floor(Date.now() / 1000) + 600;
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.1,
    util7d: 0.96,
    claim: 'five_hour',
    reset: Math.floor(Date.now() / 1000) + 300,
    reset7d,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('a 7d-limited seat parks until its known 7d reset', pool.select() === null && pool.parkedUntil() === reset7d * 1000);
  pool.updateRateLimits('only', { ...pool.get('only').rateLimit, reset7d: Math.floor(Date.now() / 1000) - 1 });
  check('an elapsed 7d reset makes a mismatched claim probeable', pool.select()?.alias === 'only');

  const perModelReset = Math.floor(Date.now() / 1000) + 900;
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.1,
    util7d: 0.1,
    perModel7d: { sonnet: 0.96 },
    reset7d: perModelReset,
    claim: 'five_hour',
    reset: Math.floor(Date.now() / 1000) + 300,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('a per-model-limited seat parks until its known 7d reset', pool.select('sonnet') === null && pool.parkedUntil(Date.now(), 'sonnet') === perModelReset * 1000);
  pool.updateRateLimits('only', { ...pool.get('only').rateLimit, reset7d: Math.floor(Date.now() / 1000) - 1 });
  check('an elapsed per-model reset makes that family probeable', pool.select('sonnet')?.alias === 'only');
}

header('a seat below the floor on two windows parks until the later reset');
{
  // The representative claim names the 7d window, so the reading carries no 5h
  // reset. The 7d bucket alone holds the seat below the floor until its reset.
  const pool = new AccountPool('headroom', 0.05);
  const reset7d = Math.floor(Date.now() / 1000) + 3 * 86400;
  addAccount(pool, 'only', { util5h: 0.96 });
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    util7d: 0.97,
    claim: 'seven_day',
    reset: reset7d,
    reset7d,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('both windows high with a 7d claim: no seat', pool.select() === null);
  check('parked until the 7d reset', pool.parkedUntil() === reset7d * 1000, pool.parkedUntil());
  check('a preferred seat cannot bypass it', pool.canPrefer(pool.get('only')) === false);
  addAccount(pool, 'failed', { util5h: 0.1 });
  check('failover off a healthy seat cannot pick it', pool.selectExcluding(new Set(['failed'])) === null);
  pool.remove('failed');

  const reset5h = Math.floor(Date.now() / 1000) + 3600;
  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    util7d: 0.97,
    claim: 'five_hour',
    reset: reset5h,
    reset7d,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('both resets known: parked until the later one, not the first', pool.parkedUntil() === reset7d * 1000, pool.parkedUntil());

  pool.updateRateLimits('only', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.96,
    util7d: 0.97,
    claim: 'seven_day',
    reset: Math.floor(Date.now() / 1000) - 1,
    reset7d: Math.floor(Date.now() / 1000) - 1,
    status: 'ok',
    updatedAt: Date.now(),
  });
  check('after the 7d reset, a 5h reading with no reset is probed', pool.select()?.alias === 'only');
}

header('headroomFloorProblem');
{
  check('unset and empty are not problems', headroomFloorProblem(undefined) === null && headroomFloorProblem(null) === null && headroomFloorProblem('  ') === null);
  check('usable values are not problems', ['5%', '0.05', '5', 0.1, 5].every((v) => headroomFloorProblem(v) === null));
  const p95 = headroomFloorProblem('95');
  check('dario#1333: "95" names the bounds', typeof p95 === 'string' && p95.includes('"95" is not a usable headroom floor') && p95.includes('between 2% and 50%'));
  check('dario#1333: "95" suggests 5%, the headroom left at 95% used', typeof p95 === 'string' && p95.includes('to leave a seat at 95% used, set 5%.'), p95);
  check('"95%" and the config number 95 read the same', headroomFloorProblem('95%') === headroomFloorProblem('95').replace('"95"', '"95%"') && headroomFloorProblem(95) === p95);
  check('0.9 as a ratio suggests 10%', headroomFloorProblem('0.9')?.includes('at 90% used, set 10%.'));
  check('the suggestion never goes below the 2% minimum', headroomFloorProblem('99')?.includes('at 99% used, set 2%.'));
  check('below the minimum: bounds only, no usage hint', headroomFloorProblem('0.01')?.endsWith('(e.g. 0.05 or 5%).') === true);
  check('garbage: bounds only', headroomFloorProblem('lots')?.endsWith('(e.g. 0.05 or 5%).') === true);
  check('no em dash in the message', !/\u2014/.test(p95 ?? ''));
}

header('headroomFloorFlagProblem');
{
  const bounds = '"" is not a usable headroom floor. Use a ratio or percent between 2% and 50% (e.g. 0.05 or 5%).';
  check('an empty flag value names the bounds, not null', headroomFloorFlagProblem('') === bounds, headroomFloorFlagProblem(''));
  check('a whitespace-only flag value names the bounds', headroomFloorFlagProblem('   ') === bounds, headroomFloorFlagProblem('   '));
  check('a non-empty flag value reads like the env/config message', headroomFloorFlagProblem('95') === headroomFloorProblem('95'));
  check('garbage flag value: bounds only', headroomFloorFlagProblem('lots') === '"lots" is not a usable headroom floor. Use a ratio or percent between 2% and 50% (e.g. 0.05 or 5%).');
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

#!/usr/bin/env node
/**
 * `--pool-strategy=headroom-by-plan`: headroom routing with each seat's
 * headroom counted by its plan size. Opt-in only; `headroom` stays the
 * default and is unchanged.
 *
 * Covers:
 *   - planWeight reads Max Nx from rate_limit_tier; Pro and unknown are 1
 *   - resolvePoolStrategy accepts it; the default is still headroom
 *   - under headroom-by-plan a 20x seat at 30% headroom beats a Pro at 90%
 *   - plain headroom still picks the Pro in that same pool
 *   - a big seat with less weighted room still loses
 *   - over-limit seats are not ranked by weight
 *   - the failover path (selectExcluding) uses the same weighting
 *   - describePoolStrategy names it
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { AccountPool, resolvePoolStrategy, describePoolStrategy, planWeight, EMPTY_SNAPSHOT } from '../dist/pool.js';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

function addAccount(pool, alias, { tier, util5h = 0, util7d = 0 } = {}) {
  pool.add(alias, {
    accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + 3600_000, deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
    ...(tier ? { rateLimitTier: tier } : {}),
  });
  pool.updateRateLimits(alias, { ...EMPTY_SNAPSHOT, util5h, util7d, status: 'ok', updatedAt: Date.now() });
}

function mixedPool(strategy) {
  const pool = new AccountPool(strategy);
  addAccount(pool, 'max20', { tier: 'default_claude_max_20x', util7d: 0.7 });
  addAccount(pool, 'pro', { tier: 'default_claude_ai', util7d: 0.1 });
  return pool;
}

header('planWeight');
{
  check('Max 20x counts 20', planWeight('default_claude_max_20x') === 20);
  check('Max 5x counts 5', planWeight('default_claude_max_5x') === 5);
  check('Pro counts 1', planWeight('default_claude_ai') === 1);
  check('unknown and missing count 1', planWeight('some_team_tier') === 1 && planWeight(undefined) === 1 && planWeight('') === 1);
  check('a zero multiplier is not trusted', planWeight('default_claude_max_0x') === 1);
  check('a tier that only contains max_Nx counts 1',
    planWeight('unknown_max_20x') === 1 && planWeight('default_claude_max_20x_trial') === 1 && planWeight('max_20x') === 1);
}

header('resolvePoolStrategy');
{
  check('explicit headroom-by-plan', resolvePoolStrategy('headroom-by-plan', {}) === 'headroom-by-plan');
  check('env headroom-by-plan', resolvePoolStrategy(undefined, { DARIO_POOL_STRATEGY: 'headroom-by-plan' }) === 'headroom-by-plan');
  check('case and whitespace tolerated', resolvePoolStrategy('  Headroom-By-Plan ', {}) === 'headroom-by-plan');
  check('the default is still headroom', resolvePoolStrategy(undefined, {}) === 'headroom');
}

header('selection');
{
  check('headroom-by-plan: 20x at 30% beats Pro at 90% (6.0 vs 0.9)', mixedPool('headroom-by-plan').select()?.alias === 'max20');
  check('plain headroom: the same pool picks the Pro', mixedPool('headroom').select()?.alias === 'pro');
  check('default constructor: the same pool picks the Pro', mixedPool(undefined).select()?.alias === 'pro');

  const tight = new AccountPool('headroom-by-plan');
  addAccount(tight, 'max5', { tier: 'default_claude_max_5x', util7d: 0.9 });
  addAccount(tight, 'pro', { tier: 'default_claude_ai', util7d: 0.3 });
  check('a big seat with less weighted room still loses (0.5 vs 0.7)', tight.select()?.alias === 'pro');

  const unknown = new AccountPool('headroom-by-plan');
  addAccount(unknown, 'a', { util7d: 0.5 });
  addAccount(unknown, 'b', { tier: 'default_claude_ai', util7d: 0.2 });
  check('a seat with no plan is not favoured', unknown.select()?.alias === 'b');

  const lookalike = new AccountPool('headroom-by-plan');
  addAccount(lookalike, 'odd', { tier: 'unknown_max_20x', util7d: 0.7 });
  addAccount(lookalike, 'pro', { tier: 'default_claude_ai', util7d: 0.1 });
  check('an unrecognised tier containing max_20x is not favoured', lookalike.select()?.alias === 'pro');

  // Unweighted, the 20x is less over (-0.05 vs -0.10); weighting the negative
  // score would make it -1.0 and hand the pick to the Pro.
  const over = new AccountPool('headroom-by-plan');
  addAccount(over, 'max20', { tier: 'default_claude_max_20x', util7d: 1.05 });
  addAccount(over, 'pro', { tier: 'default_claude_ai', util7d: 1.1 });
  const overPick = over.select()?.alias;
  check('over-limit seats rank by unweighted headroom (-0.05 beats -0.10)', overPick === 'max20', overPick);

  const failover = mixedPool('headroom-by-plan');
  addAccount(failover, 'max5', { tier: 'default_claude_max_5x', util7d: 0.5 });
  const next = failover.selectExcluding(new Set(['max20']));
  check('failover keeps the weighting (5x at 50% = 2.5 beats Pro 0.9)', next?.alias === 'max5', next?.alias);
}

header('describePoolStrategy');
{
  const line = describePoolStrategy('headroom-by-plan', 0.02);
  check('names the strategy, the weighting and the floor', line.startsWith('headroom-by-plan') && line.includes('plan size') && line.includes('2% floor'), line);
  check('headroom still says default', describePoolStrategy('headroom').includes('(default)'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

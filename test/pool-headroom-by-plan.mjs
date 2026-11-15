#!/usr/bin/env node
/**
 * `--pool-strategy=headroom-by-plan`: headroom routing with each seat's
 * headroom counted by its plan's weekly size. Opt-in only; `headroom` stays the
 * default and is unchanged.
 *
 * Covers:
 *   - planWeight reads the plan from rate_limit_tier: Ultra 10, Max 5, Pro and unknown 1
 *   - resolvePoolStrategy accepts it; the default is still headroom
 *   - under headroom-by-plan an Ultra seat at 30% headroom beats a Pro at 90%
 *   - a Max and an Ultra seat share work by their weeks, and Max's five-hour window still counts
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
  check('Ultra (tier default_claude_max_20x) counts 10, its week in Pro weeks', planWeight('default_claude_max_20x') === 10, planWeight('default_claude_max_20x'));
  check('Max (tier default_claude_max_5x) counts 5', planWeight('default_claude_max_5x') === 5);
  check('any other Max multiple counts as written', planWeight('default_claude_max_3x') === 3 && planWeight('default_claude_max_40x') === 40);
  check('the tier name is read whatever its case', planWeight('DEFAULT_CLAUDE_MAX_20X') === 10);
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
  check('headroom-by-plan: Ultra at 30% beats Pro at 90% (3.0 vs 0.9)', mixedPool('headroom-by-plan').select()?.alias === 'max20');
  check('plain headroom: the same pool picks the Pro', mixedPool('headroom').select()?.alias === 'pro');
  check('default constructor: the same pool picks the Pro', mixedPool(undefined).select()?.alias === 'pro');

  const tight = new AccountPool('headroom-by-plan');
  addAccount(tight, 'max5', { tier: 'default_claude_max_5x', util7d: 0.9 });
  addAccount(tight, 'pro', { tier: 'default_claude_ai', util7d: 0.3 });
  check('a big seat with less weighted room still loses (0.5 vs 0.7)', tight.select()?.alias === 'pro');

  // The pair from dario#1893. Ultra's week is twice Max's, not four times: at
  // 30% left against Max's 70% it has less room (3.0 vs 3.5), which the old
  // weight of 20 read as more (6.0).
  const pair = (max, ultra) => {
    const pool = new AccountPool('headroom-by-plan');
    addAccount(pool, 'max', { tier: 'default_claude_max_5x', ...max });
    addAccount(pool, 'ultra', { tier: 'default_claude_max_20x', ...ultra });
    return pool.select()?.alias;
  };
  check('Max with 70% of its week left beats Ultra with 30% (3.5 vs 3.0)', pair({ util7d: 0.3 }, { util7d: 0.7 }) === 'max', pair({ util7d: 0.3 }, { util7d: 0.7 }));
  check('Ultra with 40% left beats Max with 70% (4.0 vs 3.5)', pair({ util7d: 0.3 }, { util7d: 0.6 }) === 'ultra', pair({ util7d: 0.3 }, { util7d: 0.6 }));
  check('both fresh: Ultra first (10 vs 5)', pair({}, {}) === 'ultra', pair({}, {}));
  check('Max held by its five-hour window gives way to an Ultra seat with no such reading (0.5 vs 1.0)',
    pair({ util5h: 0.9, util7d: 0.1 }, { util7d: 0.9 }) === 'ultra', pair({ util5h: 0.9, util7d: 0.1 }, { util7d: 0.9 }));

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
  check('names the strategy, the weighting and the floor', line.startsWith('headroom-by-plan') && line.includes('weekly size (Ultra counts 10, Max 5, Pro 1)') && line.includes('2% floor'), line);
  check('headroom still says default', describePoolStrategy('headroom').includes('(default)'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * The active pool strategy is visible, and `dario doctor` previews with it.
 *
 * Fleet box, 2026-09-22: the deployment's compose file set
 * `DARIO_POOL_STRATEGY=fill-first`, overriding dario's `headroom` default, and
 * nothing said so: the startup banner printed a strategy only when it was NOT
 * headroom (so the one place it appeared was easy to miss in a long log),
 * `/status` and `/accounts` did not carry it, and `dario doctor` built a
 * default pool for its "Pool routing" preview, so it predicted a max-headroom
 * pick on a fill-first pool: the wrong next seat.
 *
 * Covers:
 *   - pool.status() carries strategy + headroomFloor (GET /accounts spreads it)
 *   - pool.strategy is readable (GET /status reports it)
 *   - describePoolStrategy names every strategy, the default, and the floor
 *   - configuredPoolRouting: env beats the config file, the file beats the
 *     default, invalid values fall back like the proxy's resolver
 *   - a pool built from configuredPoolRouting previews the seat the proxy
 *     picks (fill-first -> the alias-first seat, not the max-headroom one)
 *   - the proxy banner, /status, doctor and `accounts list` use the helpers
 *     (source checks, so the surfaces cannot drift back silently)
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { readFileSync } from 'node:fs';
import { AccountPool, describePoolStrategy, configuredPoolRouting, EMPTY_SNAPSHOT } from '../dist/pool.js';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}
function addAccount(pool, alias, { util5h = 0, util7d = 0 } = {}) {
  pool.add(alias, {
    accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + 3600_000, deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
  });
  pool.updateRateLimits(alias, { ...EMPTY_SNAPSHOT, util5h, util7d, status: 'ok', updatedAt: Date.now() });
}

header('pool.status() and pool.strategy carry the routing');
{
  const def = new AccountPool();
  check('default strategy is headroom', def.strategy === 'headroom' && def.status().strategy === 'headroom');
  check('default floor is 2%', def.status().headroomFloor === 0.02);
  const ff = new AccountPool('fill-first', 0.05);
  check('status().strategy reflects the pool', ff.status().strategy === 'fill-first', ff.status());
  check('status().headroomFloor reflects the pool', ff.status().headroomFloor === 0.05);
  check('existing fields are still there', typeof ff.status().accounts === 'number' && 'bestAccount' in ff.status());
}

header('describePoolStrategy names the strategy, the default, and the floor');
{
  const h = describePoolStrategy('headroom');
  check('headroom is marked as the default', /^headroom \(default\)/.test(h), h);
  check('the floor is named', /2% floor/.test(h), h);
  check('fill-first explains alias order', /alphabetically-first/.test(describePoolStrategy('fill-first', 0.05)) && /5% floor/.test(describePoolStrategy('fill-first', 0.05)));
  check('expiring-first explains reset order', /resets soonest/.test(describePoolStrategy('expiring-first')));
}

header('configuredPoolRouting follows the proxy precedence (env > file > default)');
{
  check('nothing set -> headroom, 2%', JSON.stringify(configuredPoolRouting(undefined, {})) === '{"strategy":"headroom","headroomFloor":0.02}');
  check('file only -> file', configuredPoolRouting({ strategy: 'fill-first', headroomFloor: 0.1 }, {}).strategy === 'fill-first'
    && configuredPoolRouting({ strategy: 'fill-first', headroomFloor: 0.1 }, {}).headroomFloor === 0.1);
  check('env beats the file', configuredPoolRouting({ strategy: 'fill-first' }, { DARIO_POOL_STRATEGY: 'expiring-first' }).strategy === 'expiring-first');
  check('env floor beats the file floor', configuredPoolRouting({ headroomFloor: 0.1 }, { DARIO_POOL_HEADROOM_FLOOR: '5%' }).headroomFloor === 0.05);
  check('an invalid value falls back to headroom, like the proxy', configuredPoolRouting({ strategy: 'round-robin' }, {}).strategy === 'headroom');
}

header('a pool built from the configured routing previews the right seat');
{
  const routing = configuredPoolRouting(undefined, { DARIO_POOL_STRATEGY: 'fill-first' });
  const doctorPool = new AccountPool(routing.strategy, routing.headroomFloor);
  addAccount(doctorPool, 'login', { util7d: 0.44 });
  addAccount(doctorPool, 'pro1', { util7d: 0.01 });
  check('fill-first preview names the alias-first seat (login)', doctorPool.select()?.alias === 'login', doctorPool.select()?.alias);
  const oldDoctorPool = new AccountPool();
  addAccount(oldDoctorPool, 'login', { util7d: 0.44 });
  addAccount(oldDoctorPool, 'pro1', { util7d: 0.01 });
  check('(the old default-built preview named pro1: the wrong seat)', oldDoctorPool.select()?.alias === 'pro1');
}

header('every surface uses the helpers');
{
  const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
  const doctor = readFileSync(new URL('../src/doctor-core.ts', import.meta.url), 'utf8');
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  check('banner prints describePoolStrategy unconditionally', /console\.log\(`  Pool strategy: \$\{describePoolStrategy\(poolStrategy, pool\.headroomFloor\)\}`\)/.test(proxy)
    && !/if \(poolStrategy !== 'headroom'\)/.test(proxy));
  check('/status carries pool.strategy', /pool: pool\.size > 0 \? \{ strategy: pool\.strategy, headroomFloor: pool\.headroomFloor/.test(proxy));
  check('doctor builds its preview from configuredPoolRouting', /new AccountPool\(routing\.strategy, routing\.headroomFloor\)/.test(doctor)
    && !/const pool = new AccountPool\(\);/.test(doctor));
  check('doctor names the strategy it used', /describePoolStrategy\(routing\.strategy, routing\.headroomFloor\)/.test(doctor));
  check('accounts list prints a Routing line', /Routing: \$\{describePoolStrategy\(routing\.strategy, routing\.headroomFloor\)\}/.test(cli));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('PASS pool routing visible');

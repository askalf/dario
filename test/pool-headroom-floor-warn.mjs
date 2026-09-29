#!/usr/bin/env node
/**
 * test/pool-headroom-floor-warn.mjs
 *
 * The wiring of the headroom-floor warnings (dario#1333): which source
 * `dario proxy` names at startup, which value the flag shadows, and the
 * `Pool headroom floor` row in `dario doctor`. The message text itself is
 * covered in pool-headroom-floor.mjs.
 *
 * Startup runs are spawned with --host=0.0.0.0 and no DARIO_API_KEY, so the
 * CLI refuses at the non-loopback guard, which comes after the floor check:
 * every run reaches the warning and none starts a listener.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-floor-warn-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_HOST;
delete process.env.DARIO_POOL_HEADROOM_FLOOR;
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const configPath = join(tmpHome, '.dario', 'config.json');
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });

const writeConfig = (headroomFloor) => writeFile(configPath,
  JSON.stringify(headroomFloor === undefined ? {} : { pool: { headroomFloor } }));
const UNUSABLE = 'is not a usable headroom floor';

/** Run `dario proxy` with the given env and extra args; it exits at the host guard. */
function runProxy(env, extra = []) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, DARIO_NO_BUN: '1', ...env };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const p = spawn(process.execPath, [CLI, 'proxy', '--host=0.0.0.0', ...extra], { env: childEnv, cwd: tmpHome });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill(); resolve({ code: null, out, err, lingered: true }); }, 20_000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, lingered: false }); });
  });
}
const floorWarnings = (r) => (r.out + r.err).split('\n').filter((l) => l.includes(UNUSABLE));
const reachedHostGuard = (r) => r.code === 1 && r.err.includes('Refusing to start proxy') && !r.lingered;

header('startup: an invalid env value warns and names the env var');
{
  await writeConfig(undefined);
  const r = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: '95' });
  const w = floorWarnings(r);
  check('startup ran past the floor check', reachedHostGuard(r), `code=${r.code} err=${r.err.slice(0, 200)}`);
  check('one floor warning', w.length === 1, JSON.stringify(w));
  check('names DARIO_POOL_HEADROOM_FLOOR and the value', w[0]?.includes('[dario] DARIO_POOL_HEADROOM_FLOOR: "95"'), w[0]);
  check('says the default is used', w[0]?.includes('Using the default 2%.'), w[0]);
}

header('startup: an invalid config value warns and names the config file when the env is unset');
{
  await writeConfig(95);
  const r = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: undefined });
  const w = floorWarnings(r);
  check('startup ran past the floor check', reachedHostGuard(r), `code=${r.code} err=${r.err.slice(0, 200)}`);
  check('one floor warning', w.length === 1, JSON.stringify(w));
  check('names pool.headroomFloor in the config file', w[0]?.includes('[dario] pool.headroomFloor in the config file: "95"'), w[0]);
  check('does not name the env var', !w[0]?.includes('DARIO_POOL_HEADROOM_FLOOR'), w[0]);
}

header('startup: a valid env value shadows an invalid config value');
{
  await writeConfig(95);
  const r = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: '5%' });
  check('startup ran past the floor check', reachedHostGuard(r), `code=${r.code} err=${r.err.slice(0, 200)}`);
  check('no floor warning', floorWarnings(r).length === 0, JSON.stringify(floorWarnings(r)));
}

header('startup: a valid flag shadows an invalid env value');
{
  await writeConfig(undefined);
  const r = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: '95' }, ['--pool-headroom-floor=5%']);
  check('startup ran past the floor check', reachedHostGuard(r), `code=${r.code} err=${r.err.slice(0, 200)}`);
  check('no floor warning', floorWarnings(r).length === 0, JSON.stringify(floorWarnings(r)));
}

header('startup: valid and unset values do not warn');
{
  await writeConfig(undefined);
  const unset = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: undefined });
  check('unset: startup ran past the floor check', reachedHostGuard(unset), `code=${unset.code} err=${unset.err.slice(0, 200)}`);
  check('unset: no floor warning', floorWarnings(unset).length === 0, JSON.stringify(floorWarnings(unset)));
  const valid = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: '0.05' });
  check('valid env: startup ran past the floor check', reachedHostGuard(valid), `code=${valid.code} err=${valid.err.slice(0, 200)}`);
  check('valid env: no floor warning', floorWarnings(valid).length === 0, JSON.stringify(floorWarnings(valid)));
  await writeConfig(0.1);
  const validCfg = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: undefined });
  check('valid config: startup ran past the floor check', reachedHostGuard(validCfg), `code=${validCfg.code} err=${validCfg.err.slice(0, 200)}`);
  check('valid config: no floor warning', floorWarnings(validCfg).length === 0, JSON.stringify(floorWarnings(validCfg)));
}

header('startup: an invalid or empty flag refuses to start');
{
  await writeConfig(undefined);
  const bad = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: undefined }, ['--pool-headroom-floor=95']);
  check('invalid flag exits 1', bad.code === 1 && !bad.lingered, `code=${bad.code}`);
  check('invalid flag names the flag and the value', bad.err.includes('[dario] Invalid --pool-headroom-floor: "95"'), bad.err.slice(0, 200));
  check('invalid flag stops before the host guard', !bad.err.includes('Refusing to start proxy'));
  const empty = await runProxy({ DARIO_POOL_HEADROOM_FLOOR: undefined }, ['--pool-headroom-floor=']);
  check('empty flag exits 1', empty.code === 1 && !empty.lingered, `code=${empty.code}`);
  check('empty flag names the bounds', empty.err.includes('[dario] Invalid --pool-headroom-floor: "" ' + UNUSABLE), empty.err.slice(0, 200));
  check('empty flag never prints null', !empty.err.includes('null'), empty.err.slice(0, 200));
  check('empty flag stops before the host guard', !empty.err.includes('Refusing to start proxy'));
}

// doctor: a configured account puts runChecks on the Pool routing path.
await writeFile(join(tmpHome, '.dario', 'accounts', 'only.json'), JSON.stringify({
  alias: 'only',
  accessToken: 'only-token',
  refreshToken: 'only-refresh',
  expiresAt: Date.now() + 6 * 3_600_000,
  scopes: ['user:inference'],
  deviceId: 'dev-only',
  accountUuid: 'uuid-only',
}));
const { runChecks } = await import('../dist/doctor-core.js');
const floorRow = async () => {
  const checks = await runChecks();
  return { routing: checks.find((c) => c.label === 'Pool routing'), floor: checks.filter((c) => c.label === 'Pool headroom floor') };
};

header('doctor: an invalid env value is a warning naming the env var');
{
  await writeConfig(undefined);
  process.env.DARIO_POOL_HEADROOM_FLOOR = '95';
  const { routing, floor } = await floorRow();
  check('the Pool routing row ran', routing?.status === 'info', JSON.stringify(routing));
  check('one Pool headroom floor row', floor.length === 1, JSON.stringify(floor));
  check('it is a warning', floor[0]?.status === 'warn', JSON.stringify(floor[0]));
  check('names DARIO_POOL_HEADROOM_FLOOR and the value', floor[0]?.detail.startsWith('DARIO_POOL_HEADROOM_FLOOR: "95" ' + UNUSABLE), floor[0]?.detail);
  check('says the default is in effect', floor[0]?.detail.endsWith('The default 2% is in effect.'), floor[0]?.detail);
}

header('doctor: an invalid config value is a warning naming pool.headroomFloor when the env is unset');
{
  await writeConfig(95);
  delete process.env.DARIO_POOL_HEADROOM_FLOOR;
  const { routing, floor } = await floorRow();
  check('the Pool routing row ran', routing?.status === 'info', JSON.stringify(routing));
  check('one Pool headroom floor row', floor.length === 1, JSON.stringify(floor));
  check('it is a warning', floor[0]?.status === 'warn', JSON.stringify(floor[0]));
  check('names pool.headroomFloor and the value', floor[0]?.detail.startsWith('pool.headroomFloor: "95" ' + UNUSABLE), floor[0]?.detail);
}

header('doctor: a valid env value shadows an invalid config value');
{
  await writeConfig(95);
  process.env.DARIO_POOL_HEADROOM_FLOOR = '5%';
  const { routing, floor } = await floorRow();
  check('the Pool routing row ran', routing?.status === 'info', JSON.stringify(routing));
  check('no Pool headroom floor row', floor.length === 0, JSON.stringify(floor));
}

header('doctor: valid and unset values produce no row');
{
  await writeConfig(undefined);
  delete process.env.DARIO_POOL_HEADROOM_FLOOR;
  const unset = await floorRow();
  check('unset: the Pool routing row ran', unset.routing?.status === 'info', JSON.stringify(unset.routing));
  check('unset: no Pool headroom floor row', unset.floor.length === 0, JSON.stringify(unset.floor));
  await writeConfig(0.1);
  const valid = await floorRow();
  check('valid config: the Pool routing row ran', valid.routing?.status === 'info', JSON.stringify(valid.routing));
  check('valid config: no Pool headroom floor row', valid.floor.length === 0, JSON.stringify(valid.floor));
}

delete process.env.DARIO_POOL_HEADROOM_FLOOR;
await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

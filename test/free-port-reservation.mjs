#!/usr/bin/env node
// helpers/free-port.mjs reserves every port it hands out in DARIO_TEST_PORT_DIR,
// so two test files running at once never get the same number. The kernel
// decides which port a real draw returns, so the suite only sees a repeat by
// chance; here net.createServer is replaced with one that returns a scripted
// sequence, and two module instances (each with its own `issued`, as two
// test-file processes have) draw from it against one reservation directory.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);

// Every draw takes the next number from `script`, the way the kernel would
// hand out a released port again.
let script = [];
const realCreateServer = net.createServer;
net.createServer = () => {
  let port;
  return {
    unref() {},
    on() { return this; },
    listen(_port, _host, cb) { port = script.shift(); setImmediate(cb); },
    address() { return { port }; },
    close(cb) { setImmediate(cb); },
  };
};
syncBuiltinESMExports();

const suiteDir = process.env.DARIO_TEST_PORT_DIR;
let n = 0;
const instance = async () => (await import(`./helpers/free-port.mjs?instance=${++n}`)).freePort;

header('two instances sharing one reservation directory');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-free-port-'));
  process.env.DARIO_TEST_PORT_DIR = dir;
  writeFileSync(join(dir, '40001'), 'another file');
  const a = await instance();
  const b = await instance();
  script = [40001, 40002, 40002, 40003, 40003, 40004];
  const [pa, pb] = await Promise.all([a(), b()]);
  check('the two get different ports', pa !== pb, `${pa} ${pb}`);
  check('neither gets the preclaimed port', pa !== 40001 && pb !== 40001, `${pa} ${pb}`);
  check('both are from the script', [40002, 40003].includes(pa) && [40002, 40003].includes(pb), `${pa} ${pb}`);
  const files = readdirSync(dir).sort();
  check('one reservation file per port claimed', JSON.stringify(files) === JSON.stringify(['40001', '40002', '40003']), files.join(','));
  check('the preclaimed file is left as it was', readFileSync(join(dir, '40001'), 'utf8') === 'another file');
  check('each claimed file names this process', readFileSync(join(dir, String(pa)), 'utf8') === String(process.pid) && readFileSync(join(dir, String(pb)), 'utf8') === String(process.pid));

  const c = await instance();
  script = [40002, 40003, 40005];
  check('a third instance skips every port already reserved', (await c()) === 40005);
}

header('without DARIO_TEST_PORT_DIR only `issued` applies');
{
  delete process.env.DARIO_TEST_PORT_DIR;
  const d = await instance();
  script = [40001, 40001, 40006];
  const first = await d();
  const second = await d();
  check('the first draw is returned as it is', first === 40001, first);
  check('the same instance never reissues it', second === 40006, second);
}

net.createServer = realCreateServer;
syncBuiltinESMExports();
if (suiteDir === undefined) delete process.env.DARIO_TEST_PORT_DIR;
else process.env.DARIO_TEST_PORT_DIR = suiteDir;

// all.test.mjs sets DARIO_LIVE_TEMPLATE_CACHE for every child, and must set
// DARIO_TEST_PORT_DIR beside it, or the reservation above never runs there.
if (process.env.DARIO_LIVE_TEMPLATE_CACHE) {
  header('all.test.mjs hands every file the shared directory');
  let isDir = false;
  try { isDir = statSync(suiteDir).isDirectory(); } catch { /* reported below */ }
  check('DARIO_TEST_PORT_DIR names a directory', isDir, suiteDir);
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

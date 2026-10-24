// The Bun relaunch wrapper passes SIGTERM and SIGINT on to its child, and exits the
// way the child did. Unit checks run everywhere; the end-to-end checks start
// dist/cli.js with a stand-in `bun` on PATH (it never starts a proxy, and HOME is a
// temp dir) and need POSIX signals, so they skip on win32.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORWARDED_SIGNALS, forwardSignals, relaunchExitCode } from '../dist/relaunch-signals.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

header('forwardSignals');
{
  const source = new EventEmitter();
  const sent = [];
  const child = { exitCode: null, signalCode: null, kill: (s) => { sent.push(s); return true; } };
  forwardSignals(child, source);
  check('handlers for SIGTERM and SIGINT only', FORWARDED_SIGNALS.join() === 'SIGTERM,SIGINT'
    && source.listenerCount('SIGTERM') === 1 && source.listenerCount('SIGINT') === 1 && source.listenerCount('SIGHUP') === 0);
  source.emit('SIGTERM');
  source.emit('SIGINT');
  check('each signal reaches the running child', sent.join() === 'SIGTERM,SIGINT', sent.join());
  child.exitCode = 0;
  source.emit('SIGTERM');
  check('nothing is sent once the child has exited', sent.length === 2, sent.join());
  const killed = { exitCode: null, signalCode: 'SIGKILL', kill: () => { throw new Error('sent to a dead child'); } };
  const s2 = new EventEmitter();
  forwardSignals(killed, s2);
  let threw = false;
  try { s2.emit('SIGTERM'); } catch { threw = true; }
  check('nothing is sent to a child a signal already ended', !threw);
}

header('relaunchExitCode');
check('the child\'s own code passes through', relaunchExitCode(0, null) === 0 && relaunchExitCode(3, null) === 3);
check('a signal maps to 128 plus its number', relaunchExitCode(null, 'SIGTERM') === 143 && relaunchExitCode(null, 'SIGKILL') === 137);
check('no code and no signal is 0', relaunchExitCode(null, null) === 0);

if (process.platform === 'win32') {
  console.log('\nend to end: skipped on win32');
} else {
  header('end to end: dist/cli.js under a stand-in bun');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const tmp = mkdtempSync(join(tmpdir(), 'relaunch-signals-'));
  const marker = join(tmp, 'child-got');
  // `bun --version` succeeds; `bun run ...` waits. On SIGTERM it records the
  // signal and exits 0, the way the proxy's drain does; with STUB_DIE it
  // removes its handler and dies by the signal instead.
  const stub = join(tmp, 'bun');
  writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('1.0.0'); process.exit(0); }
const onSig = (s) => {
  fs.writeFileSync(${JSON.stringify(marker)}, s);
  if (process.env.STUB_DIE) { process.removeAllListeners(s); process.kill(process.pid, s); return; }
  process.exit(0);
};
process.on('SIGTERM', onSig);
process.on('SIGINT', onSig);
fs.writeFileSync(${JSON.stringify(marker)} + '.ready', '1');
setInterval(() => {}, 1000);
`);
  chmodSync(stub, 0o755);

  const run = (extraEnv) => new Promise((resolve) => {
    rmSync(marker, { force: true });
    rmSync(marker + '.ready', { force: true });
    const env = { ...process.env, PATH: tmp + delimiter + process.env.PATH, HOME: tmp, USERPROFILE: tmp, ...extraEnv };
    delete env.DARIO_NO_BUN;
    const p = spawn(process.execPath, [cli, 'proxy', '--port=1'], { env, stdio: 'ignore' });
    const started = Date.now();
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ timedOut: true }); }, 20_000);
    const poll = setInterval(() => {
      if (existsSync(marker + '.ready')) { clearInterval(poll); p.kill('SIGTERM'); }
    }, 50);
    p.on('exit', (code, signal) => {
      clearTimeout(timer); clearInterval(poll);
      resolve({ code, signal, ms: Date.now() - started, got: existsSync(marker) ? readFileSync(marker, 'utf8') : '' });
    });
  });

  const graceful = await run({});
  check('SIGTERM to the wrapper reaches the child', graceful.got === 'SIGTERM', JSON.stringify(graceful));
  check('the wrapper exits with the child\'s code, not by the signal', graceful.code === 0 && graceful.signal === null, JSON.stringify(graceful));
  const died = await run({ STUB_DIE: '1' });
  check('a child killed by the signal makes the wrapper exit 143', died.got === 'SIGTERM' && died.code === 143, JSON.stringify(died));
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

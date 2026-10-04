// scripts/_tracked-process.mjs stops ALL of what it starts. The server here is a
// stand-in for dist/cli.js: unless DARIO_NO_BUN is set it relaunches itself as a
// child and waits, the way the CLI does under Bun, and that wrapper does not
// forward signals.

import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTracked } from '../scripts/_tracked-process.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

if (process.platform === 'win32') {
  // No process groups to signal on Windows; the runner this guards is Linux.
  console.log('skipped on win32');
  console.log('\n0 pass, 0 fail');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'tracked-process-'));
const fake = join(tmp, 'fake-cli.mjs');
writeFileSync(fake, `
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const [port, pidFile] = process.argv.slice(2);
if (!process.env.DARIO_NO_BUN) {
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, DARIO_NO_BUN: '1' } });
  child.on('exit', (code) => process.exit(code ?? 0));
  await new Promise(() => {});
}
createServer((req, res) => { res.writeHead(200); res.end('{}'); }).listen(Number(port), '127.0.0.1', () => writeFileSync(pidFile, String(process.pid)));
`);

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const answering = (port) => async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).status === 200;
  } catch {
    return false;
  }
};
const waitUp = async (listening) => {
  for (let i = 0; i < 100; i += 1) {
    if (await listening()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
const envWithout = (name) => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== name));

header('a server that relaunches itself behind a wrapper');
{
  const port = await freePort();
  const pidFile = join(tmp, 'relaunched.pid');
  const listening = answering(port);
  const first = startTracked(process.execPath, [fake, String(port), pidFile], { stdio: 'ignore', env: envWithout('DARIO_NO_BUN') });
  check('comes up', await waitUp(listening));
  check('the listener is the relaunched child, not the tracked wrapper', Number(readFileSync(pidFile, 'utf8')) !== first.child.pid);
  check('stop reports the server gone', await first.stop(listening) === true);
  check('the listener is gone', await listening() === false);

  const second = startTracked(process.execPath, [fake, String(port), pidFile], { stdio: 'ignore', env: envWithout('DARIO_NO_BUN') });
  check('a second run can start on the same port', await waitUp(listening));
  check('and is stopped too', await second.stop(listening) === true && await listening() === false);
}

header('a server started as itself');
{
  const port = await freePort();
  const pidFile = join(tmp, 'direct.pid');
  const listening = answering(port);
  const run = startTracked(process.execPath, [fake, String(port), pidFile], { stdio: 'ignore', env: { ...process.env, DARIO_NO_BUN: '1' } });
  check('comes up', await waitUp(listening));
  check('the tracked process is the listener', Number(readFileSync(pidFile, 'utf8')) === run.child.pid);
  check('stop reports the server gone', await run.stop(listening) === true);
  // The listener closes before the exit event is delivered: give the event a moment.
  for (let i = 0; i < 50 && !run.hasExited(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  check('hasExited follows the process', run.hasExited() === true);
}

header('a server that ignores SIGTERM');
{
  const port = await freePort();
  const stubborn = join(tmp, 'stubborn.mjs');
  writeFileSync(stubborn, `
import { createServer } from 'node:http';
process.on('SIGTERM', () => {});
createServer((req, res) => { res.writeHead(200); res.end('{}'); }).listen(${port}, '127.0.0.1');
`);
  const listening = answering(port);
  const run = startTracked(process.execPath, [stubborn], { stdio: 'ignore' });
  check('comes up', await waitUp(listening));
  check('is killed after the grace period', await run.stop(listening, { graceMs: 500, killMs: 3000 }) === true && await listening() === false);
}

header('a server that closes its listener on SIGTERM and keeps running');
{
  const port = await freePort();
  const lingering = join(tmp, 'lingering.mjs');
  writeFileSync(lingering, `
import { createServer } from 'node:http';
const server = createServer((req, res) => { res.writeHead(200); res.end('{}'); }).listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => { server.close(); setInterval(() => {}, 1000); });
`);
  const listening = answering(port);
  const run = startTracked(process.execPath, [lingering], { stdio: 'ignore' });
  check('comes up', await waitUp(listening));
  check('stop reports it gone', await run.stop(listening, { graceMs: 500, killMs: 3000 }) === true);
  // Give the exit event a moment to be delivered, as above.
  for (let i = 0; i < 50 && !run.hasExited(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  check('the process itself has exited', run.hasExited() === true);
  let groupLeft = true;
  try { process.kill(-run.child.pid, 0); } catch { groupLeft = false; }
  check('no process of its group is left', groupLeft === false);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

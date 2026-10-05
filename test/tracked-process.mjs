// scripts/_tracked-process.mjs stops ALL of what it starts. The server here is a
// stand-in for dist/cli.js: unless DARIO_NO_BUN is set it relaunches itself as a
// child and waits, the way the CLI does under Bun, and that wrapper does not
// forward signals.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processGroupAlive, startTracked } from '../scripts/_tracked-process.mjs';

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
const within = async (ms, done) => {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (await done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return done();
};
const watching = () => ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((event) => process.listenerCount(event)).join(',');

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
  const before = watching();
  const run = startTracked(process.execPath, [fake, String(port), pidFile], { stdio: 'ignore', env: { ...process.env, DARIO_NO_BUN: '1' } });
  check('comes up', await waitUp(listening));
  check('the tracked process is the listener', Number(readFileSync(pidFile, 'utf8')) === run.child.pid);
  check('the end of this process is watched for while the server runs', watching() !== before, watching());
  check('stop reports the server gone', await run.stop(listening) === true);
  check('and nothing is watched for once it is gone', watching() === before, watching());
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

// A signal that ends the starting process by default runs no exit handler in it,
// and the server is in another process group, so the signal does not reach the
// server either.
header('the process that started the server is ended by a signal');
{
  const helper = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', '_tracked-process.mjs')).href;
  const starter = join(tmp, 'starter.mjs');
  writeFileSync(starter, `
import { writeFileSync } from 'node:fs';
import { startTracked } from ${JSON.stringify(helper)};
const [cli, port, pidFile, groupFile] = process.argv.slice(2);
const run = startTracked(process.execPath, [cli, port, pidFile], { stdio: 'ignore' });
writeFileSync(groupFile, String(run.child.pid));
setInterval(() => {}, 1000);
`);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const port = await freePort();
    const groupFile = join(tmp, `${sig}.group`);
    const listening = answering(port);
    // Without DARIO_NO_BUN the server relaunches behind a wrapper, so the group holds two processes.
    const parent = spawn(process.execPath, [starter, fake, String(port), join(tmp, `${sig}.pid`), groupFile], { stdio: 'ignore', env: envWithout('DARIO_NO_BUN') });
    const ended = new Promise((resolve) => parent.on('exit', (code, signal) => resolve(signal ?? code)));
    check(`${sig}: the server comes up`, await waitUp(listening));
    const group = Number(readFileSync(groupFile, 'utf8'));
    check(`${sig}: its group is there`, processGroupAlive(group) === true);
    parent.kill(sig);
    const how = await ended;
    check(`${sig}: the starter still ends by that signal`, how === sig, String(how));
    check(`${sig}: the listener is gone`, await within(5000, async () => !(await listening())));
    check(`${sig}: no process of the server's group is left`, await within(5000, () => !processGroupAlive(group)));
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

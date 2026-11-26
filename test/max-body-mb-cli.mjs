#!/usr/bin/env node
// `dario proxy` hands a valid --max-body-mb / DARIO_MAX_BODY_MB through to the
// proxy.
//
// test/max-body-mb.mjs covers the parsing, the refusal of bad values by the
// real CLI, and the live 413 / success through startProxy. None of that notices
// a CLI that validates a good value and then stops passing it on. Here the real
// `dist/cli.js proxy` runs as a child, three times:
//   - no flag, no env: an 11 MiB body gets 413 naming 10MB;
//   - --max-body-mb=16: an 11 MiB body gets the stubbed inference answer and a
//     17 MiB body gets 413 naming 16MB, with no inference call for it;
//   - DARIO_MAX_BODY_MB=16: the same as the flag.
//
// Hermetic: the child's environment is built from a short allowlist of OS
// variables plus this test's own settings, so nothing the operator exported
// reaches it. HOME is a mkdtemp'd dir with one Claude account and the ledger is
// off (DARIO_LEDGER=0). The child preloads test/helpers/fetch-stub-preload.cjs
// through NODE_OPTIONS, which stubs the network; DARIO_NO_BUN=1 keeps the CLI on
// Node, because a Bun relaunch would drop the preload. The test's own requests
// go to 127.0.0.1 through node:http with a plain agent, so no proxy setting in
// the parent's environment applies to them.
//
// A child counts as ready when it prints its own post-bind banner. Each case
// stops its child in an awaited finally, and reads the child's stderr only after
// the child's `close` event. If the child has not closed within 10 s of SIGTERM
// and again within 10 s of SIGKILL, the case fails explicitly, its stderr is not
// inspected, and the child stays tracked so the final cleanup kills it again. A
// request that fails or runs past its 60 s deadline fails the case, and the child
// is still stopped and closed before its stderr is read.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const PRELOAD = join(here, 'helpers', 'fetch-stub-preload.cjs').replace(/\\/g, '/');
const MIB = 1024 * 1024;
const READY_DEADLINE_MS = 30_000;
const REQUEST_DEADLINE_MS = 60_000;
const CLOSE_DEADLINE_MS = 10_000;
// The banner the proxy prints from its listen callback, so it appears only once
// this child itself has bound its port.
const READY_LINE = 'Your Claude subscription is now an API.';

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-max-body-cli-'));
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(
  join(tmpHome, '.dario', 'accounts', 'main.json'),
  JSON.stringify({
    alias: 'main',
    accessToken: 'claude-access-token',
    refreshToken: 'claude-refresh-token',
    expiresAt: Date.now() + 6 * 3_600_000,
    scopes: ['user:inference'],
    deviceId: 'dev-1',
    accountUuid: 'uuid-1',
  }),
);

// The OS variables a Node child needs, matched case-insensitively (Windows
// spells PATH as Path). Nothing else is inherited.
const OS_VARS = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']);
const baseEnv = {};
for (const [k, v] of Object.entries(process.env)) if (OS_VARS.has(k.toUpperCase())) baseEnv[k] = v;
Object.assign(baseEnv, {
  HOME: tmpHome,
  USERPROFILE: tmpHome,
  DARIO_LEDGER: '0',
  DARIO_NO_BUN: '1',
  NODE_OPTIONS: `--require "${PRELOAD}"`,
});

// Children that have not yet closed. A child leaves this set only after its
// `close` event, so the final cleanup reaches any that never did.
const children = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true once `run.closed` is set, false after `ms`. */
async function waitClosed(run, ms) {
  const end = Date.now() + ms;
  while (!run.closed && Date.now() < end) await sleep(50);
  return run.closed;
}

/** Start the CLI on a free port; ready once it prints its own banner. Retries once on a port collision. */
async function startCli(extraArgs, extraEnv = {}) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [CLI, 'proxy', '--host=127.0.0.1', `--port=${port}`, '--no-live-capture', ...extraArgs], {
      env: { ...baseEnv, ...extraEnv },
      cwd: tmpHome,
    });
    children.add(child);
    // `closed` is set only by the close event; `died` also covers a spawn error.
    const run = { port, child, out: '', err: '', ready: false, died: false, closed: false, spawnError: null, stopped: false };
    child.on('close', () => { run.closed = true; run.died = true; });
    child.on('error', (e) => { run.spawnError = e; run.died = true; });
    child.stdout.on('data', (d) => { run.out += d; });
    child.stderr.on('data', (d) => { run.err += d; });
    const deadline = Date.now() + READY_DEADLINE_MS;
    while (!run.died && Date.now() < deadline) {
      if (run.out.includes(READY_LINE)) { run.ready = true; break; }
      await sleep(50);
    }
    if (run.ready) return run;
    run.stopped = await stopCli(run);
    last = run;
    if (!run.stopped || !/already in use/.test(run.err + run.out)) break;
  }
  return last;
}

/**
 * Stop a child and wait for its close event. True once it closed (and only then
 * is it dropped from `children`); false if SIGTERM and then SIGKILL each waited
 * out CLOSE_DEADLINE_MS, in which case the child stays tracked. Only children
 * this test spawned.
 */
async function stopCli(run) {
  if (run.child.pid === undefined) run.closed = true; // never started: no close event will come
  if (!run.closed) {
    run.child.kill();
    if (!(await waitClosed(run, CLOSE_DEADLINE_MS))) {
      run.child.kill('SIGKILL');
      await waitClosed(run, CLOSE_DEADLINE_MS);
    }
  }
  if (run.closed) children.delete(run.child);
  return run.closed;
}

/**
 * POST a body of about `bytes` bytes straight to 127.0.0.1 over node:http with a
 * plain agent (no proxy), so the parent's proxy settings cannot redirect it. One
 * deadline covers the upload and reading the whole response; a failure rejects.
 */
function post(port, bytes) {
  const payload = Buffer.from(JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'x'.repeat(bytes) }] }));
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false });
    let status = null;
    const finish = (fn, v) => { agent.destroy(); fn(v); };
    const req = request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', agent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    }, (res) => {
      status = res.statusCode;
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => finish(resolve, { status, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, new Error('response aborted')));
    });
    // The proxy may answer 413 before it has read the whole upload; a write error after that is expected.
    req.on('error', (e) => { if (status === null) finish(reject, e); });
    req.end(payload);
  });
}
const readJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const stubLines = (run, kind) => [...run.err.matchAll(new RegExp(`\\[fetch-stub\\] ${kind}(?: (.*))?$`, 'gm'))].map((m) => m[1] ?? '');

/** The checks every case shares, on the child's complete stderr after it closed. */
function checkStub(run, inferenceCalls) {
  check('the startup catalog fetch went to the stub', stubLines(run, 'models').length >= 1, run.err.slice(0, 300));
  check('nothing was refused', stubLines(run, 'refused').length === 0, stubLines(run, 'refused').join(' | '));
  const calls = stubLines(run, 'messages').map((l) => Number(l.replace('bytes=', '')));
  check(`the stub saw ${inferenceCalls} inference call(s)`, calls.length === inferenceCalls, JSON.stringify(calls));
  return calls;
}

/** One CLI run: the 11 MiB body, then (for a raised limit) a 17 MiB one. */
async function runCase(label, extraArgs, extraEnv, raised) {
  header(label);
  const run = await startCli(extraArgs, extraEnv);
  check('the CLI printed its banner', run.ready === true, `${run.spawnError ?? ''} ${run.err.slice(0, 300)} ${run.out.slice(0, 300)}`);
  if (!run.ready) {
    check('the child that did not start closed', run.stopped === true, 'no close event: stderr not inspected, child stays tracked');
    return;
  }
  let stopped = false;
  try {
    const mid = await post(run.port, 11 * MIB);
    if (raised) {
      check('11 MiB: 200', mid.status === 200, `${mid.status} ${mid.text.slice(0, 160)}`);
      check('11 MiB: the stubbed inference answer comes back', mid.text.includes('served through the CLI'), mid.text.slice(0, 160));
      const big = await post(run.port, 17 * MIB);
      check('17 MiB: 413', big.status === 413, `${big.status} ${big.text.slice(0, 120)}`);
      check('17 MiB: the body names 16MB', readJson(big.text)?.max === '16MB', big.text.slice(0, 120));
    } else {
      check('11 MiB: 413', mid.status === 413, `${mid.status} ${mid.text.slice(0, 120)}`);
      check('11 MiB: the body names 10MB', readJson(mid.text)?.max === '10MB', mid.text.slice(0, 120));
    }
  } catch (e) {
    check('the requests completed within their deadline', false, String(e && e.message));
  } finally {
    stopped = await stopCli(run);
  }
  check('the child closed', stopped === true, 'no close event: stderr not inspected, child stays tracked');
  if (!stopped) return;
  const calls = checkStub(run, raised ? 1 : 0);
  if (raised) check('the one inference call carried the 11 MiB body', calls[0] > 10 * MIB && calls[0] < 16 * MIB, JSON.stringify(calls));
}

try {
  await runCase('no flag, no env: the default limit', [], {}, false);
  await runCase('--max-body-mb=16: the CLI passes it through', ['--max-body-mb=16'], {}, true);
  await runCase('DARIO_MAX_BODY_MB=16: the CLI passes it through', [], { DARIO_MAX_BODY_MB: '16' }, true);
} finally {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

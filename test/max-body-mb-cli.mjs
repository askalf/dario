#!/usr/bin/env node
// `dario proxy` hands a valid --max-body-mb / DARIO_MAX_BODY_MB through to the
// proxy.
//
// test/max-body-mb.mjs covers the parsing, the refusal of bad values by the
// real CLI, and the live 413 / success through startProxy. None of that notices
// a CLI that validates a good value and then stops passing it on. Here the real
// `dist/cli.js proxy` runs as a child, three times, and each one gets the same
// 11 MiB body:
//   - no flag, no env: 413 naming 10MB;
//   - --max-body-mb=16: the stubbed inference answer;
//   - DARIO_MAX_BODY_MB=16: the stubbed inference answer.
//
// Hermetic: HOME is a mkdtemp'd dir with one Claude account; upstream, log,
// ledger and refresh-lock settings are cleared and the ledger is off
// (DARIO_LEDGER=0). The child preloads test/helpers/fetch-stub-preload.mjs
// through NODE_OPTIONS, which stubs the network, so DARIO_NO_BUN=1 keeps the CLI
// on Node (a Bun relaunch would drop the preload). Only the children this test
// spawned are killed.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const PRELOAD = pathToFileURL(join(here, 'helpers', 'fetch-stub-preload.mjs')).href;
const MIB = 1024 * 1024;

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

const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
for (const k of [
  'ANTHROPIC_UPSTREAM_API_KEY', 'ANTHROPIC_API_KEY', 'DARIO_API_KEY', 'DARIO_MAX_BODY_MB', 'DARIO_CREDITS_API_KEY',
  'DARIO_REFRESH_LOCK_URL', 'DARIO_REFRESH_LOCK_TOKEN', 'DARIO_LOG_FILE', 'DARIO_LOG_BODIES', 'DARIO_LEDGER_PATH',
]) delete env[k];
env.DARIO_LEDGER = '0';
env.DARIO_NO_BUN = '1';
env.NODE_OPTIONS = `--import ${PRELOAD}`;

const children = [];
/** Start `dario proxy` on a free port; resolves once /health answers or the child dies. */
async function startCli(extraArgs, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'proxy', `--port=${port}`, '--no-live-capture', ...extraArgs], {
    env: { ...env, ...extraEnv },
    cwd: tmpHome,
  });
  children.push(child);
  const run = { port, child, out: '', err: '', exited: false };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  child.on('exit', () => { run.exited = true; });
  for (let i = 0; i < 150 && !run.exited; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); await r.text(); run.ready = true; break; } catch { await sleep(100); }
  }
  return run;
}

const post = (port, bytes) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'x'.repeat(bytes) }] }),
});
const readJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const messageCalls = (run) => [...run.err.matchAll(/\[fetch-stub\] messages bytes=(\d+)/g)].map((m) => Number(m[1]));
const catalogCalls = (run) => [...run.err.matchAll(/\[fetch-stub\] models/g)].length;
const refusedCalls = (run) => [...run.err.matchAll(/\[fetch-stub\] refused (\S+)/g)].map((m) => m[1]);

try {
  header('no flag, no env: the default limit refuses 11 MiB');
  {
    const run = await startCli([]);
    check('the CLI came up', run.ready === true, run.err.slice(0, 300));
    const res = await post(run.port, 11 * MIB);
    const text = await res.text();
    check('413', res.status === 413, `${res.status} ${text.slice(0, 120)}`);
    check('the body says 10MB', readJson(text)?.max === '10MB', text.slice(0, 120));
    check('nothing was sent upstream', messageCalls(run).length === 0);
    check('the preload was active: the startup catalog fetch went to the stub, and nothing was refused', catalogCalls(run) >= 1 && refusedCalls(run).length === 0, `${catalogCalls(run)} ${refusedCalls(run).join(',')}`);
  }

  header('--max-body-mb=16: the CLI passes it through');
  {
    const run = await startCli(['--max-body-mb=16']);
    check('the CLI came up', run.ready === true, run.err.slice(0, 300));
    const res = await post(run.port, 11 * MIB);
    const text = await res.text();
    check('200', res.status === 200, `${res.status} ${text.slice(0, 160)}`);
    check('the stubbed inference answer comes back', text.includes('served through the CLI'), text.slice(0, 160));
    check('the inference call carried the big body', messageCalls(run).length === 1 && messageCalls(run)[0] > 10 * MIB, JSON.stringify(messageCalls(run)));
    check('nothing else was requested', refusedCalls(run).length === 0, refusedCalls(run).join(','));
  }

  header('DARIO_MAX_BODY_MB=16: the CLI passes it through');
  {
    const run = await startCli([], { DARIO_MAX_BODY_MB: '16' });
    check('the CLI came up', run.ready === true, run.err.slice(0, 300));
    const res = await post(run.port, 11 * MIB);
    const text = await res.text();
    check('200', res.status === 200, `${res.status} ${text.slice(0, 160)}`);
    check('the stubbed inference answer comes back', text.includes('served through the CLI'), text.slice(0, 160));
    check('the inference call carried the big body', messageCalls(run).length === 1 && messageCalls(run)[0] > 10 * MIB, JSON.stringify(messageCalls(run)));
    check('nothing else was requested', refusedCalls(run).length === 0, refusedCalls(run).join(','));
  }
} finally {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

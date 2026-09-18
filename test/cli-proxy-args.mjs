#!/usr/bin/env node
/**
 * test/cli-proxy-args.mjs
 *
 * `dario proxy <word>` must never start a proxy (dario#1353). It read its flags
 * by prefix and ignored every other argument, so `dario proxy status` started a
 * real server and kept the OAuth refresh timer running for five days.
 *
 * Covers the pure classifier and two spawned runs against a scratch HOME:
 * a stray word exits 1 with nothing started; `proxy status` prints the report.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-proxy-args-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const { strayProxyArgs } = await import('../dist/cli.js');

header('strayProxyArgs — flags pass, bare words are stray, the leading command word is not');
{
  check("['proxy','status'] → ['status']", JSON.stringify(strayProxyArgs(['proxy', 'status'])) === '["status"]');
  check("['proxy','stop','-v'] → ['stop']", JSON.stringify(strayProxyArgs(['proxy', 'stop', '-v'])) === '["stop"]');
  check("['proxy','--port=1','--no-tui'] → []", strayProxyArgs(['proxy', '--port=1', '--no-tui']).length === 0);
  check("['--port=1'] (implied proxy) → []", strayProxyArgs(['--port=1']).length === 0);
  check("['proxy'] → []", strayProxyArgs(['proxy']).length === 0);
  check("['proxy','3456'] → ['3456'] (a space-separated value was never accepted; now it is said)", JSON.stringify(strayProxyArgs(['proxy', '3456'])) === '["3456"]');
  check("['--no-tui','proxy','status'] → ['status'] (a global flag may precede the command)", JSON.stringify(strayProxyArgs(['--no-tui', 'proxy', 'status'])) === '["status"]');
  check("['--no-tui','proxy','--port=1'] → []", strayProxyArgs(['--no-tui', 'proxy', '--port=1']).length === 0);
  check("['proxy','proxy'] → ['proxy'] (a second bare proxy is stray)", JSON.stringify(strayProxyArgs(['proxy', 'proxy'])) === '["proxy"]');
}

/** Run the CLI, kill it if it lingers (a started proxy would), return the outcome. */
function run(args, ms = 15_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DARIO_PORT: '1' }, cwd: tmpHome });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill(); resolve({ code: null, out, err, lingered: true }); }, ms);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, lingered: false }); });
  });
}

header('dario proxy stop — refused, nothing started');
{
  const r = await run(['proxy', 'stop']);
  check('exits 1', r.code === 1, `code=${r.code} lingered=${r.lingered}`);
  check('names the stray word', r.err.includes('Unknown proxy argument "stop"'), r.err.slice(0, 200));
  check('says nothing was started and points at dario status', r.err.includes('nothing was started') && r.err.includes('dario status'));
  check('no listener came up', !r.out.includes('Listening on') && !r.lingered);
}

header('dario --no-tui proxy status — the alias survives a leading global flag');
{
  const r = await run(['--no-tui', 'proxy', 'status']);
  check('exits 0', r.code === 0, `code=${r.code} lingered=${r.lingered} err=${r.err.slice(0, 120)}`);
  check('prints the status report', r.out.includes('dario — Status'), r.out.slice(0, 200));
  check('no listener came up', !r.out.includes('Listening on') && !r.lingered);
}

header('dario proxy status — the report, not a server');
{
  const r = await run(['proxy', 'status']);
  check('exits 0', r.code === 0, `code=${r.code} lingered=${r.lingered} err=${r.err.slice(0, 120)}`);
  check('prints the status report', r.out.includes('dario — Status'), r.out.slice(0, 200));
  check('no listener came up', !r.out.includes('Listening on') && !r.lingered);
}

await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

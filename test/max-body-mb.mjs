#!/usr/bin/env node
// The request body limit (ProxyOptions.maxBodyMb, --max-body-mb, DARIO_MAX_BODY_MB).
//
// The limit resolves to bytes with a 10 MiB default, and a body past it is
// answered 413 with the configured limit in `max`. Hermetic: HOME is a
// mkdtemp'd dir with one Claude account, and nothing reaches the network
// because every request here is refused or never leaves the body read.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-max-body-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
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

const { startProxy, resolveMaxBodyBytes, DEFAULT_MAX_BODY_MB } = await import('../dist/proxy.js');
const MIB = 1024 * 1024;

header('resolveMaxBodyBytes: default and configured');
{
  check('the default is 10 MiB', DEFAULT_MAX_BODY_MB === 10 && resolveMaxBodyBytes(undefined) === 10 * MIB);
  check('a set value is taken in MiB', resolveMaxBodyBytes(64) === 64 * MIB);
  check('0 keeps the default', resolveMaxBodyBytes(0) === 10 * MIB);
  check('a negative value keeps the default', resolveMaxBodyBytes(-3) === 10 * MIB);
  check('NaN keeps the default', resolveMaxBodyBytes(Number.NaN) === 10 * MIB);
}

const upstreamCalls = [];
const fetchImpl = async (url) => {
  upstreamCalls.push(String(url));
  return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const SMALL_PORT = await freePort();
const DEFAULT_PORT = await freePort();
const common = { host: '127.0.0.1', passthrough: false, verbose: false, noLiveCapture: true, fetchImpl };
await startProxy({ ...common, port: SMALL_PORT, maxBodyMb: 1 });
await startProxy({ ...common, port: DEFAULT_PORT });
for (const port of [SMALL_PORT, DEFAULT_PORT]) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
}

const post = (port, bytes) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'x'.repeat(bytes) }] }),
});

header('413 reports the configured limit');
{
  const res = await post(SMALL_PORT, 2 * MIB);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  check('a 2 MiB body against a 1 MiB limit is 413', res.status === 413, `${res.status} ${text.slice(0, 120)}`);
  check('the body names the configured limit', json?.error === 'Request body too large' && json?.max === '1MB', text.slice(0, 120));
}

header('a body past 1 MiB but under the default limit is not refused with 413');
{
  const res = await post(DEFAULT_PORT, 2 * MIB);
  await res.text();
  check('no 413 on the default 10 MiB limit', res.status !== 413, String(res.status));
}

header('the default limit still refuses past 10 MiB and says so');
{
  const res = await post(DEFAULT_PORT, 11 * MIB);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  check('11 MiB against the default is 413', res.status === 413, `${res.status} ${text.slice(0, 120)}`);
  check('the body says 10MB', json?.max === '10MB', text.slice(0, 120));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

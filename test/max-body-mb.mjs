#!/usr/bin/env node
// The request body limit (--max-body-mb, DARIO_MAX_BODY_MB, ProxyOptions.maxBodyMb).
//
// Three parts. The parsing: a whole number of MiB written as digits, the flag
// over the env var, a bad env value ignored, a bad flag value refused (also
// through the real CLI, which must exit before it binds a port). The byte
// limit stays finite for any input. And a live proxy: a body past 10 MiB gets
// 413 naming the limit on a default proxy and is served on one with a higher
// limit.
//
// Hermetic: HOME is a mkdtemp'd dir with one Claude account, and the upstream
// and credential env vars are cleared. The account makes the proxy fetch the
// model catalog at startup, so globalThis.fetch is replaced before the proxy
// loads: it answers /v1/models and the stubbed inference call, refuses any
// other non-loopback URL, and passes loopback URLs (the test's own requests to
// the proxy) to the real fetch. The same stub is the proxy's fetchImpl.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));

for (const k of ['ANTHROPIC_UPSTREAM_API_KEY', 'ANTHROPIC_API_KEY', 'DARIO_API_KEY', 'DARIO_MAX_BODY_MB', 'DARIO_CREDITS_API_KEY', 'DARIO_REFRESH_LOCK_URL', 'DARIO_REFRESH_LOCK_TOKEN']) {
  delete process.env[k];
}
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-max-body-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const MIB = 1024 * 1024;
const { resolveMaxBodyMb, parseMaxBodyMb, resolveMaxBodyBytes, DEFAULT_MAX_BODY_MB, MAX_BODY_MB_CEILING } = await import('../dist/body-limit.js');

header('parsing: digits only, whole MiB');
{
  check('64 -> 64', parseMaxBodyMb('64') === 64);
  check('surrounding whitespace is refused', parseMaxBodyMb(' 64 ') === undefined && parseMaxBodyMb('64 ') === undefined && parseMaxBodyMb(' 64') === undefined);
  check('64MiB is refused (parseInt would read 64)', parseMaxBodyMb('64MiB') === undefined);
  check('64oops is refused', parseMaxBodyMb('64oops') === undefined);
  check('6.4 is refused', parseMaxBodyMb('6.4') === undefined);
  check('1e3 is refused', parseMaxBodyMb('1e3') === undefined);
  check('-5 is refused', parseMaxBodyMb('-5') === undefined);
  check('+5 is refused', parseMaxBodyMb('+5') === undefined);
  check('empty is refused', parseMaxBodyMb('') === undefined);
  check('0 is not a limit', parseMaxBodyMb('0') === undefined);
  check('a leading zero is still digits', parseMaxBodyMb('064') === 64);
  check('the ceiling is 256 and is accepted', MAX_BODY_MB_CEILING === 256 && parseMaxBodyMb('256') === 256);
  check('one past the ceiling is refused', parseMaxBodyMb('257') === undefined);
  check('a 400-digit value is refused', parseMaxBodyMb('9'.repeat(400)) === undefined);
}

header('resolution: argv and env');
{
  check('nothing set: default', resolveMaxBodyMb([], undefined) === undefined);
  check('env 64 -> 64', resolveMaxBodyMb([], '64') === 64);
  check('flag 32 -> 32', resolveMaxBodyMb(['proxy', '--max-body-mb=32'], undefined) === 32);
  check('the flag wins over the env var', resolveMaxBodyMb(['--max-body-mb=32'], '64') === 32);
  check('an explicit flag 0 keeps the default even with a valid env', resolveMaxBodyMb(['--max-body-mb=0'], '64') === undefined);
  check('a flag with whitespace around 0 is not the zero sentinel', (() => { try { resolveMaxBodyMb(['--max-body-mb= 0'], '64'); return false; } catch { return true; } })());
  for (const bad of ['64MiB', '64oops', '6.4', '-1', 'abc', '0', '', ' 64', '64 ', '257', '99999999999999']) {
    check(`env ${JSON.stringify(bad)} is ignored (default)`, resolveMaxBodyMb([], bad) === undefined);
  }
  for (const bad of ['64MiB', '64oops', '6.4', '-1', 'abc', '', ' 64', '64 ', '257', '99999999999999']) {
    let msg = null;
    try { resolveMaxBodyMb([`--max-body-mb=${bad}`], '64'); } catch (e) { msg = e.message; }
    check(`flag ${JSON.stringify(bad)} throws and names MiB`, msg !== null && msg.includes('MiB') && !/\bms\b/.test(msg), String(msg));
  }
}

header('a bare --max-body-mb is a missing value');
{
  let msg = null;
  try { resolveMaxBodyMb(['proxy', '--max-body-mb'], '64'); } catch (e) { msg = e.message; }
  check('a bare flag throws the MiB diagnostic even with a valid env', msg !== null && msg.includes('MiB') && /Invalid --max-body-mb value/.test(msg), String(msg));
}

header('the CLI refuses a bad flag value before it binds a port');
{
  for (const bad of ['64MiB', '64oops', '6.4', ' 64', '257']) {
    const r = spawnSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), 'proxy', `--port=${await freePort()}`, `--max-body-mb=${bad}`], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf8',
      timeout: 30_000,
    });
    check(`--max-body-mb=${bad} exits 1`, r.status === 1, `status ${r.status}`);
    check('...with a MiB error on stderr', /Invalid --max-body-mb value/.test(r.stderr) && r.stderr.includes('MiB'), r.stderr.slice(0, 200));
  }
  const bare = spawnSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), 'proxy', `--port=${await freePort()}`, '--max-body-mb'], {
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, DARIO_MAX_BODY_MB: '64' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  check('a bare --max-body-mb exits 1', bare.status === 1, `status ${bare.status}`);
  check('...with a MiB error on stderr', /Invalid --max-body-mb value/.test(bare.stderr) && bare.stderr.includes('MiB'), bare.stderr.slice(0, 200));
}

header('the byte limit stays within the ceiling');
{
  check('the default is 10 MiB', DEFAULT_MAX_BODY_MB === 10 && resolveMaxBodyBytes(undefined) === 10 * MIB);
  check('a set value is taken in MiB', resolveMaxBodyBytes(64) === 64 * MIB);
  check('0 keeps the default', resolveMaxBodyBytes(0) === 10 * MIB);
  check('a negative value keeps the default', resolveMaxBodyBytes(-3) === 10 * MIB);
  check('NaN keeps the default', resolveMaxBodyBytes(Number.NaN) === 10 * MIB);
  check('Infinity keeps the default', resolveMaxBodyBytes(Infinity) === 10 * MIB);
  check('Number.MAX_VALUE keeps the default, not an infinite limit', resolveMaxBodyBytes(Number.MAX_VALUE) === 10 * MIB);
  check('the ceiling itself is taken', resolveMaxBodyBytes(MAX_BODY_MB_CEILING) === 256 * MIB);
  check('one past the ceiling keeps the default', resolveMaxBodyBytes(MAX_BODY_MB_CEILING + 1) === 10 * MIB);
  check('1024 keeps the default', resolveMaxBodyBytes(1024) === 10 * MIB);
  check('a fraction of a MiB keeps the default', resolveMaxBodyBytes(2.5) === 10 * MIB);
}

// The account makes startProxy fetch the model catalog, so the stub goes in
// before the proxy module is loaded and is also the proxy's fetchImpl.
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

const realFetch = globalThis.fetch;
const stubbedCalls = [];
const refused = [];
const stubFetch = async (url, init) => {
  const target = String(url instanceof Request ? url.url : url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(target)) return realFetch(url, init);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (target.includes('/v1/messages')) {
    const body = init?.body;
    stubbedCalls.push({ url: target, bytes: body == null ? 0 : (typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) });
    return new Response(JSON.stringify({
      id: 'msg_big_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'served the big body' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_big_1' } });
  }
  refused.push(target);
  throw new Error(`unexpected network call in test: ${target}`);
};
globalThis.fetch = stubFetch;

const { startProxy } = await import('../dist/proxy.js');
const DEFAULT_PORT = await freePort();
const RAISED_PORT = await freePort();
const SMALL_PORT = await freePort();
const common = { host: '127.0.0.1', passthrough: false, verbose: false, noLiveCapture: true, fetchImpl: stubFetch };
await startProxy({ ...common, port: DEFAULT_PORT });
await startProxy({ ...common, port: RAISED_PORT, maxBodyMb: 16 });
await startProxy({ ...common, port: SMALL_PORT, maxBodyMb: 1 });
for (const port of [DEFAULT_PORT, RAISED_PORT, SMALL_PORT]) {
  for (let i = 0; i < 50; i++) {
    try { await realFetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
}

const post = (port, bytes) => realFetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'x'.repeat(bytes) }] }),
});
const readJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

header('the same 11 MiB body: refused by the default limit, served by a raised one');
{
  const before = stubbedCalls.length;
  const res = await post(DEFAULT_PORT, 11 * MIB);
  const text = await res.text();
  check('default proxy: 413', res.status === 413, `${res.status} ${text.slice(0, 120)}`);
  check('default proxy: the body says 10MB', readJson(text)?.error === 'Request body too large' && readJson(text)?.max === '10MB', text.slice(0, 120));
  check('default proxy: nothing was sent upstream', stubbedCalls.length === before);
}
{
  const before = stubbedCalls.length;
  const res = await post(RAISED_PORT, 11 * MIB);
  const text = await res.text();
  check('16 MiB limit: 200', res.status === 200, `${res.status} ${text.slice(0, 160)}`);
  check('16 MiB limit: the stubbed inference answer comes back', text.includes('served the big body'), text.slice(0, 160));
  check('16 MiB limit: the inference call carried the big body', stubbedCalls.length === before + 1 && stubbedCalls[stubbedCalls.length - 1].bytes > 10 * MIB,
    JSON.stringify(stubbedCalls.slice(before)));
}

header('413 reports the configured limit');
{
  const res = await post(SMALL_PORT, 2 * MIB);
  const text = await res.text();
  check('a 2 MiB body against a 1 MiB limit is 413', res.status === 413, `${res.status} ${text.slice(0, 120)}`);
  check('the body names the configured limit', readJson(text)?.max === '1MB', text.slice(0, 120));
}

header('nothing reached the network but the stubs');
check('no unexpected non-loopback URL was requested', refused.length === 0, refused.join(','));

globalThis.fetch = realFetch;
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

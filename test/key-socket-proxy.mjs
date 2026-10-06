#!/usr/bin/env node
// Key sockets through the real proxy: `--key-socket=<path>=<key>` listens on
// a unix socket whose every request is that named key's, with no secret on
// the wire. A header on the socket cannot name another key or the root key;
// the key's model allowlist, revoke and expiry still apply; the socket is
// born 0660; a stale socket file is replaced and any other file at the path
// stops the start; TCP is unchanged. POSIX only.

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

if (process.platform === 'win32') {
  console.log('key sockets are POSIX only; skipped on Windows');
  process.exit(0);
}

let pass = 0, fail = 0;
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT_KEY = 'root-secret-for-the-test';
const ANALYTICS_TOKEN = 'analytics-token-for-the-test';

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-key-socket-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH; delete process.env.DARIO_KEY_SOCKETS;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const started = [];
const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }, { id: 'claude-opus-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  started.push(String(url));
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
    },
  });
};

const runCli = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: tmpHome });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
  p.on('close', (code) => resolve({ code, out: o }));
});
const secretIn = (s) => (s.match(/dk_[0-9a-f]{48}/) ?? [null])[0];

// Keys first, so the proxy's startup line can say the key exists.
const ci = await runCli(['keys', 'create', 'ci']);
const ciSecret = secretIn(ci.out);
const other = await runCli(['keys', 'create', 'other']);
const otherSecret = secretIn(other.out);
await runCli(['keys', 'create', 'narrow', '--models=claude-sonnet-5']);

const sockDir = join(tmpHome, 'run');
await mkdir(sockDir, { mode: 0o750 });
const SOCK = join(sockDir, 'ci.sock');
const SOCK_NARROW = join(sockDir, 'narrow.sock');
const SOCK_GONE = join(sockDir, 'gone.sock');
// A stale socket from a crashed run at `path`: whatever is there is removed first, then a
// listener binds and is SIGKILLed before it can unlink. A child that exits before it is
// listening fails the fixture instead of hanging it.
const staleSocketAt = async (path) => {
  await rm(path, { force: true });
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`]);
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  await new Promise((resolveUp, rejectUp) => {
    child.stdout.once('data', resolveUp);
    child.once('error', rejectUp);
    child.once('exit', (code) => rejectUp(new Error(`stale-socket fixture exited (${code}) before listening: ${err.slice(-300)}`)));
  });
  child.removeAllListeners('exit');
  const closed = new Promise((r) => child.once('close', r));
  child.kill('SIGKILL');
  await closed;
};
await staleSocketAt(SOCK);
const staleLeft = existsSync(SOCK) && statSync(SOCK).isSocket();

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

const { startProxy } = await import('../dist/proxy.js');
const { parseKeySocketSpec } = await import('../dist/keys.js');
await startProxy({
  host: '127.0.0.1', port: PORT, verbose: true, noLiveCapture: true, fetchImpl,
  pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false, analyticsToken: ANALYTICS_TOKEN,
  keySockets: [{ path: SOCK, key: 'ci' }, { path: SOCK_NARROW, key: 'narrow' }, { path: SOCK_GONE, key: 'nobody' }],
});
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }
for (let i = 0; i < 50 && !existsSync(SOCK_GONE); i++) await sleep(50);

const viaSocket = (socketPath, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ socketPath, path, method, headers: body ? { 'content-type': 'application/json', ...headers } : headers }, (res) => {
    let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const msg = (content, model = 'claude-sonnet-5') => JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content }] });
const analytics = async () => (await (await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } })).json());

header('the spec');
check('path=key parses', JSON.stringify(parseKeySocketSpec('/run/dario/ci.sock=ci')) === JSON.stringify({ path: '/run/dario/ci.sock', key: 'ci' }));
check('the last = splits, so a path may hold one', parseKeySocketSpec('/run/a=b/ci.sock=ci')?.path === '/run/a=b/ci.sock');
check('a relative path is refused', parseKeySocketSpec('run/ci.sock=ci') === null);
check('a missing key is refused', parseKeySocketSpec('/run/ci.sock=') === null && parseKeySocketSpec('/run/ci.sock') === null);
check('a bad key name is refused', parseKeySocketSpec('/run/ci.sock=../x') === null);

header('the socket file');
{
  const st = statSync(SOCK);
  check('a stale socket file was replaced and the proxy listens there', staleLeft && st.isSocket(), `stale left: ${staleLeft}`);
  check('the socket is 0660: owner and group only', (st.mode & 0o777) === 0o660, (st.mode & 0o777).toString(8));
  check('the startup log names the bound key', log.some((l) => l.includes(`key socket: ${SOCK} → named key "ci"`)), log.join(' | '));
  check('a socket bound to a missing key says so at start', log.some((l) => l.includes(SOCK_GONE) && l.includes('no usable key of that name yet')), log.join(' | '));
}

header('requests on the socket are the bound key\'s, with no secret');
{
  started.length = 0;
  let r = await viaSocket(SOCK, '/v1/messages', { method: 'POST', body: msg('no header at all') });
  check('no credential on the socket → served', r.status === 200, `${r.status} ${r.body}`);
  r = await viaSocket(SOCK, '/v1/messages', { method: 'POST', headers: { 'x-api-key': otherSecret }, body: msg('names other') });
  check('a header naming another key → still served', r.status === 200, `${r.status} ${r.body}`);
  r = await viaSocket(SOCK, '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'dk_' + 'f'.repeat(48), 'x-dario-consumer': 'mallory' }, body: msg('garbage header') });
  check('an unknown credential and a consumer header → still served', r.status === 200, `${r.status} ${r.body}`);
  check('all three went upstream', started.length === 3, started.length);
  const a = await analytics();
  check('/analytics: all three are ci\'s; other and mallory have none', a.perConsumer?.ci?.requests === 3 && !('other' in (a.perConsumer ?? {})) && !('mallory' in (a.perConsumer ?? {})), JSON.stringify(a.perConsumer));
}

header('the key\'s own limits ride the socket');
{
  started.length = 0;
  let r = await viaSocket(SOCK_NARROW, '/v1/messages', { method: 'POST', body: msg('opus please', 'claude-opus-5') });
  check('the model allowlist refuses on the socket, nothing upstream', r.status === 403 && JSON.parse(r.body).error.message.includes('"narrow"') && started.length === 0, `${r.status} ${r.body}`);
  r = await viaSocket(SOCK_GONE, '/v1/messages', { method: 'POST', headers: { 'x-api-key': ROOT_KEY }, body: msg('no such key') });
  check('a socket whose key does not exist → 401, even with the root key in a header', r.status === 401, `${r.status} ${r.body}`);
  check('-v names the key socket in the reject', log.some((l) => l.includes('401 rejected (key socket: named key "nobody"')), log.filter((l) => l.includes('401')).join(' | '));
  const rv = await runCli(['keys', 'revoke', 'ci']);
  check('dario keys revoke ci', rv.code === 0, rv.out);
  r = await viaSocket(SOCK, '/v1/messages', { method: 'POST', headers: { 'x-api-key': otherSecret }, body: msg('after revoke') });
  check('a revoked key\'s socket → 401 at once, and another key in a header does not rescue it', r.status === 401 && started.length === 0, `${r.status} ${r.body}`);
  r = await viaSocket(SOCK, '/analytics', { headers: { 'x-api-key': ANALYTICS_TOKEN } });
  check('a revoked key\'s socket → 401 on /analytics, even with the analytics token', r.status === 401, `${r.status} ${r.body}`);
  r = await viaSocket(SOCK_GONE, '/metrics', { headers: { authorization: `Bearer ${ANALYTICS_TOKEN}` } });
  check('a socket whose key does not exist → 401 on /metrics, even with the analytics token', r.status === 401, `${r.status} ${r.body}`);
  const t = await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ANALYTICS_TOKEN } }); await t.text();
  check('the analytics token still reads /analytics over TCP', t.status === 200, t.status);
}

header('TCP is unchanged');
{
  let r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: msg('tcp no key') }); await r.text();
  check('no credential over TCP → 401', r.status === 401);
  r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': otherSecret }, body: msg('tcp other') }); await r.text();
  check('another key over TCP → served as that key', r.status === 200 && (await analytics()).perConsumer?.other?.requests === 1);
  r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ciSecret }, body: msg('tcp revoked') }); await r.text();
  check('the revoked key over TCP → 401', r.status === 401);
}

header('starting refuses what it cannot honor');
{
  const bad = await runCli(['proxy', '--key-socket=relative.sock=ci']);
  check('a malformed --key-socket stops the start', bad.code === 1 && bad.out.includes('is not <absolute socket path>=<key name>'), bad.out);
  const twice = await runCli(['proxy', `--key-socket=${SOCK}=ci`, `--key-socket=${SOCK}=other`]);
  check('the same path twice stops the start', twice.code === 1 && twice.out.includes('is given twice'), twice.out);
  const off = await runCli(['proxy', `--key-socket=${join(sockDir, 'x.sock')}=ci`, '--no-keys']);
  check('--key-socket with --no-keys stops the start', off.code === 1 && off.out.includes('named keys are off'), off.out);
  const envBad = await runCli(['proxy'], { DARIO_KEY_SOCKETS: 'nope' });
  check('DARIO_KEY_SOCKETS is checked the same way', envBad.code === 1 && envBad.out.includes('"nope" is not'), envBad.out);

  // Start a second proxy in a child with one key socket at `path`; its exit and output.
  const startInChild = async (path, lifeMs = 3000) => {
    const script = `
      const { startProxy } = await import(${JSON.stringify(join(here, '..', 'dist', 'proxy.js'))});
      const { connect } = await import('node:net');
      await startProxy({ host: '127.0.0.1', port: ${await freePort()}, noLiveCapture: true, fetchImpl: async () => new Response('{}'),
        keySockets: [{ path: ${JSON.stringify(path)}, key: 'other' }] });
      // Before exiting, check this start's own socket still answers: a racing start must not have removed it.
      setTimeout(() => {
        const c = connect(${JSON.stringify(path)});
        c.on('connect', () => { console.log('probe ok'); c.destroy(); process.exit(0); });
        c.on('error', (e) => { console.log('probe ' + e.code); process.exit(3); });
      }, ${lifeMs});
    `;
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, cwd: tmpHome });
      let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
      p.on('close', (code) => resolve({ code, out: o }));
    });
  };

  // A regular file at the socket path is not ours to remove: the start fails and the file stays.
  const plain = join(sockDir, 'plain');
  await writeFile(plain, 'keep me');
  const res = await startInChild(plain);
  check('a regular file at the path stops the start', res.code === 1 && res.out.includes(`--key-socket ${plain}: listen EADDRINUSE`), `${res.code} ${res.out.slice(-600)}`);
  check('and the file is left alone', statSync(plain).isFile());

  check('a failed start leaves no lock behind', !existsSync(`${plain}.lock`));

  // A start holding the lock (probing, removing, binding) keeps a second start off the path.
  const locked = join(sockDir, 'locked.sock');
  await writeFile(`${locked}.lock`, '1\n');
  const lockRes = await startInChild(locked);
  check('a start lock held by another start stops this one, and the lock is not taken', lockRes.code !== 0 && lockRes.out.includes(`${locked}.lock exists`) && existsSync(`${locked}.lock`), `${lockRes.code} ${lockRes.out.slice(-600)}`);
  // An old lock is not taken over either: removing one would race a concurrent start's removal.
  const old = new Date(Date.now() - 3_600_000);
  await utimes(`${locked}.lock`, old, old);
  const oldLock = await startInChild(locked);
  check('an hour-old lock still stops the start and is left for the operator', oldLock.code !== 0 && oldLock.out.includes('if no dario is starting, remove it') && existsSync(`${locked}.lock`), `${oldLock.code} ${oldLock.out.slice(-600)}`);
  await rm(`${locked}.lock`);
  const freed = await startInChild(locked);
  check('once removed, the start binds and releases the lock', freed.code === 0 && freed.out.includes(`key socket: ${locked}`) && !existsSync(`${locked}.lock`), `${freed.code} ${freed.out.slice(-600)}`);

  // Two starts at once against one stale socket: one binds and keeps its endpoint, the other stops.
  const raced = join(sockDir, 'raced.sock');
  await staleSocketAt(raced);
  const [a, b] = await Promise.all([startInChild(raced, 6000), startInChild(raced, 6000)]);
  const winners = [a, b].filter((x) => x.code === 0 && x.out.includes(`key socket: ${raced}`));
  check('two concurrent starts on one stale socket: exactly one binds', winners.length === 1, `${a.code} ${a.out.slice(-300)} || ${b.code} ${b.out.slice(-300)}`);
  check('and the other stops on the lock or the live listener', [a, b].some((x) => x.code !== 0 && /\.lock exists|in use by a running listener/.test(x.out)));
  check('and the winner\'s endpoint was not removed under it', [a, b].every((x) => !x.out.includes('ENOENT')) && winners[0]?.out.includes('probe ok'), winners[0]?.out.slice(-300));

  // Two starts at once against an old lock and a stale socket: neither removes the lock, so
  // neither can remove a socket the other bound; both stop and leave both files alone.
  {
    await staleSocketAt(raced);
    await writeFile(`${raced}.lock`, '1\n');
    await utimes(`${raced}.lock`, old, old);
    const [c, d] = await Promise.all([startInChild(raced, 6000), startInChild(raced, 6000)]);
    check('two concurrent starts against an old lock and a stale socket: both stop, lock and socket untouched',
      c.code !== 0 && d.code !== 0 && existsSync(`${raced}.lock`) && statSync(raced).isSocket(), `${c.code} ${d.code}`);
  }

  // A live listener's socket is not stale: a second start must not unlink it.
  const liveRes = await startInChild(SOCK);
  check('a socket a running listener answers on stops the start', liveRes.code !== 0 && liveRes.out.includes(`--key-socket ${SOCK}: ${SOCK} is in use by a running listener`), `${liveRes.code} ${liveRes.out.slice(-600)}`);
  // ci was revoked above: a 401 means the original proxy answered.
  const r = await viaSocket(SOCK, '/v1/messages', { method: 'POST', headers: { 'x-api-key': otherSecret }, body: msg('still mine') }).catch((e) => ({ status: e.code, body: '' }));
  check('and the running listener keeps its endpoint', statSync(SOCK).isSocket() && r.status === 401, `${r.status} ${r.body}`);
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

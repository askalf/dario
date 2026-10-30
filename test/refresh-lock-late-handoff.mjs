// Regression test for dario#1733: two replicas refreshing the same account
// OUT OF PHASE. test/integration/dual-instance-race.mjs fires both refreshes
// at the same instant, so the loser always found the winner's credentials in
// the lock service's 5-minute handoff cache. In production each replica's
// 15-minute tick runs on its own phase, and a replica whose tick landed more
// than 5 minutes after its peer's refresh found the cache empty, took the
// lock, and refreshed with a token the peer had already rotated away.
//
// Runs the real client (dist/accounts.js) against both bundled backends:
// the Cloudflare Worker's RefreshLock in process, and redis-lock/server.mjs
// as a child process over a fake Redis that keeps PX expiries on a clock
// this test moves. A mock token endpoint rotates the refresh token on every
// refresh and rejects any token it has already rotated away, the way
// Anthropic does.

import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Account files land in a throwaway home, never the operator's ~/.dario.
const home = mkdtempSync(join(tmpdir(), 'dario-late-handoff-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { refreshAccountToken, adoptSharedCredentials, removeAccount } = await import('../dist/accounts.js');
const { RefreshLock } = await import('../cloudflare/refresh-lock/worker.mjs');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ----- one clock for the client, the Worker and the fake Redis ----------
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms) => { offset += ms; };
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ----- mock token endpoint ---------------------------------------------
// Each family has one live refresh token; refreshing rotates it, and the
// previous one is rejected from then on.
const live = new Map();       // family -> live refresh token
const tokenFamily = new Map(); // refresh token -> family
const oauthLog = [];
function seedFamily(family, token) { live.set(family, token); tokenFamily.set(token, family); }
function oauthRefresh(form) {
  const presented = new URLSearchParams(form).get('refresh_token');
  const family = tokenFamily.get(presented);
  if (!family || live.get(family) !== presented) {
    oauthLog.push({ presented, ok: false });
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  }
  const next = `${family}-${oauthLog.filter((e) => e.ok && e.family === family).length + 1}`;
  seedFamily(family, next);
  oauthLog.push({ presented, ok: true, family });
  return new Response(JSON.stringify({ access_token: `access-${next}`, refresh_token: next, expires_in: 8 * 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}
const rejections = () => oauthLog.filter((e) => !e.ok).length;
const refreshes = () => oauthLog.filter((e) => e.ok).length;

process.env.DARIO_OAUTH_TOKEN_URL = 'http://oauth.test/v1/oauth/token';
process.env.DARIO_OAUTH_CLIENT_ID = 'test-client-id';
process.env.DARIO_REFRESH_LOCK_TOKEN = 'lock-secret';

// ----- fake Redis: the five commands redis-lock/server.mjs sends ----------
function startFakeRedis() {
  const store = new Map(); // key -> { value, expiresAt }
  const get = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { store.delete(k); return null; }
    return e;
  };
  const bulk = (v) => (v === null ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  const run = (args) => {
    const [cmd, ...rest] = args;
    switch (cmd.toUpperCase()) {
      case 'GET': return bulk(get(rest[0])?.value ?? null);
      case 'SET': {
        const [k, v, ...opts] = rest;
        const up = opts.map((o) => o.toUpperCase());
        if (up.includes('NX') && get(k)) return '$-1\r\n';
        const px = up.indexOf('PX');
        store.set(k, { value: v, expiresAt: px >= 0 ? Date.now() + Number(opts[px + 1]) : null });
        return '+OK\r\n';
      }
      case 'PTTL': {
        const e = get(rest[0]);
        return `:${e ? (e.expiresAt === null ? -1 : e.expiresAt - Date.now()) : -2}\r\n`;
      }
      case 'EVAL': {
        // Only the release compare-and-delete is reachable from these tests.
        const [, , key, lockId] = rest;
        if (get(key)?.value === lockId) { store.delete(key); return ':1\r\n'; }
        return ':0\r\n';
      }
      default: return `-ERR unknown command ${cmd}\r\n`;
    }
  };
  const server = createTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    // The server child is killed at teardown, which resets its connection.
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        // RESP array of bulk strings; wait for more data when incomplete.
        const text = buf.toString('latin1');
        if (!text.startsWith('*')) return;
        let pos = text.indexOf('\r\n');
        if (pos < 0) return;
        const n = Number(text.slice(1, pos));
        pos += 2;
        const args = [];
        for (let i = 0; i < n; i++) {
          const end = text.indexOf('\r\n', pos);
          if (end < 0) return;
          const len = Number(text.slice(pos + 1, end));
          if (text.length < end + 2 + len + 2) return;
          args.push(buf.subarray(end + 2, end + 2 + len).toString('utf8'));
          pos = end + 2 + len + 2;
        }
        buf = buf.subarray(pos);
        sock.write(run(args));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function freePort() {
  const s = createTcpServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// ----- backends ----------------------------------------------------------
function workerBackend() {
  const storage = new Map();
  const state = {
    storage: {
      get: async (k) => storage.get(k),
      put: async (k, v) => { storage.set(k, v); },
      delete: async (k) => storage.delete(k),
      list: async ({ prefix }) => new Map([...storage].filter(([k]) => k.startsWith(prefix))),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new RefreshLock(state, { LOCK_TOKEN: 'lock-secret' });
  return { url: 'http://lock.test', handle: (req) => obj.fetch(req), stop: async () => {} };
}

async function redisBackend() {
  const redis = await startFakeRedis();
  const port = await freePort();
  const child = spawn(process.execPath, [join(__dirname, '..', 'redis-lock', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), LOCK_TOKEN: 'lock-secret', REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redis.address().port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await realFetch(`${url}/`, { method: 'POST' }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return {
    url,
    handle: null,
    stop: async () => { child.kill(); await new Promise((r) => redis.close(r)); },
  };
}

const realFetch = globalThis.fetch;
let backend = null;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('http://oauth.test/')) return oauthRefresh(init.body);
  if (backend?.handle && url.startsWith(backend.url)) return backend.handle(new Request(url, init));
  return realFetch(input, init);
};

// ----- the scenario, once per backend -------------------------------------
async function scenario(name, make) {
  backend = await make();
  process.env.DARIO_REFRESH_LOCK_URL = backend.url;
  const alias = `late-handoff-${name}`;
  const G1 = Date.now() - DAY;
  live.clear(); tokenFamily.clear(); oauthLog.length = 0;
  seedFamily('fam', 'fam-0');

  // Both replicas loaded the same copied file: one refresh token, expiring
  // in 30 minutes, so both are inside the 45-minute refresh window.
  const copied = { alias, accessToken: 'access-fam-0', refreshToken: 'fam-0', expiresAt: Date.now() + 30 * MIN, scopes: [], deviceId: 'd', accountUuid: 'u', grantedAt: G1 };

  header(`${name}: replica B's tick lands 10 minutes after replica A's refresh`);
  const a1 = await refreshAccountToken(copied);
  check('replica A refreshed for real', a1.refreshToken === 'fam-1' && refreshes() === 1);

  advance(10 * MIN); // past the old 5-minute handoff window
  const peeked = await adoptSharedCredentials(copied);
  check('B\'s peek returns A\'s rotation', peeked?.refreshToken === 'fam-1');
  const b1 = await refreshAccountToken(copied);
  check('B adopts A\'s credentials instead of refreshing', b1.refreshToken === 'fam-1');
  check('still exactly one real refresh', refreshes() === 1);
  check('no rotated token was presented', rejections() === 0);

  header(`${name}: the next cycle, hours apart`);
  advance(7 * HOUR + 20 * MIN); // A's own window for its fam-1 token
  const a2 = await refreshAccountToken(a1);
  check('A refreshes its own token (equal is not newer)', a2.refreshToken === 'fam-2' && refreshes() === 2);
  advance(25 * MIN);
  const b2 = await refreshAccountToken(b1);
  check('B, 25 minutes behind, adopts fam-2', b2.refreshToken === 'fam-2' && refreshes() === 2);
  check('no rotated token was presented', rejections() === 0);

  header(`${name}: a re-login on A is not overwritten by B's old grant`);
  const G2 = Date.now();
  seedFamily('new', 'new-0');
  const relogin = { ...copied, accessToken: 'access-new-0', refreshToken: 'new-0', expiresAt: Date.now() + 2 * HOUR, grantedAt: G2 };
  // B keeps refreshing the old grant; its tokens expire LATER than A's.
  advance(7 * HOUR);
  const b3 = await refreshAccountToken(b2);
  check('B refreshes the old grant', b3.refreshToken === 'fam-3');
  check('A\'s peek ignores the old grant despite its later expiry', (await adoptSharedCredentials(relogin)) === null);
  const a3 = await refreshAccountToken({ ...relogin, expiresAt: Date.now() + 30 * MIN });
  check('A refreshes its new grant', a3.refreshToken === 'new-1');
  const bPeek = await adoptSharedCredentials(b3);
  check('B then moves to the newer grant', bPeek?.refreshToken === 'new-1' && bPeek?.grantedAt === G2);
  check('no rotated token was presented', rejections() === 0);

  header(`${name}: the cache only expires after the grant could still be live`);
  advance(31 * DAY);
  check('31 days on, nothing is handed out', (await adoptSharedCredentials(copied)) === null);

  await removeAccount(alias);
  await backend.stop();
  backend = null;
}

try {
  await scenario('worker', async () => workerBackend());
  await scenario('redis', redisBackend);
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (backend) await backend.stop();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

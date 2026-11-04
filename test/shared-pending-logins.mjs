// Pending admin API logins on the shared service (dario#1733). With
// --pool-shared-accounts a login started on one replica is also published on
// the refresh-lock service, so a replica behind the same load balancer can
// complete it. Off, the pending map is in-process only, as it always was.
//
// Two "instances" are two copies of dist/admin-api.js (a query string gives
// each its own pending maps) with their own AccountSync client, against one
// backend: the Cloudflare Worker's RefreshLock in process, then
// redis-lock/server.mjs as a child process over a fake Redis (or a real one:
// DARIO_TEST_REDIS_PORT, DARIO_TEST_REDIS_HOST; use a throwaway Redis). The
// OAuth token endpoints are stubbed, and record what each exchange was sent.

import { EventEmitter } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Account files land in a throwaway home, never the operator's ~/.dario.
const home = mkdtempSync(join(tmpdir(), 'dario-shared-logins-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_CODEX_TOKEN_URL = 'http://codex-token.test/token';

const { AccountSync } = await import('../dist/account-sync.js');
const { RefreshLock } = await import('../cloudflare/refresh-lock/worker.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const MIN = 60_000;
const LOCK_TOKEN = 'lock-secret';
const ADMIN_TOKEN = 'admin-secret';

// One clock, moved by the test.
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms) => { offset += ms; };

// ----- everything that is printed or audited, to prove no secret is in it ---
const printed = [];
for (const m of ['log', 'error', 'warn']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { printed.push(a.map(String).join(' ')); orig(...a); };
}

// ----- fake Redis: the commands redis-lock/server.mjs sends for logins -------
function startFakeRedis() {
  const hashes = new Map();
  const hash = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  const bulk = (v) => (v === null || v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  // The hash expiry (PEXPIREAT) each put set, by key.
  const expires = new Map();
  // The login put script, in JS, step for step with the Lua.
  const loginPut = ([key, alias, record, now, cap, create]) => {
    const h = hash(key);
    let others = 0, has = false, last = 0;
    for (const [f, v] of [...h]) {
      const r = JSON.parse(v);
      if (Number(r.lapse) <= Number(now)) h.delete(f);
      else if (f === alias) has = true;
      else { others++; last = Math.max(last, Number(r.lapse)); }
    }
    if (has && create === '1') return ':2\r\n';
    if (!has && others >= Number(cap)) return ':0\r\n';
    last = Math.max(last, Number(JSON.parse(record).lapse));
    h.set(alias, record);
    expires.set(key, last);
    return ':1\r\n';
  };
  const loginRemove = ([key, alias, state, now]) => {
    const h = hash(key);
    const cur = h.get(alias);
    if (cur === undefined) return ':0\r\n';
    const r = JSON.parse(cur);
    if (r.state !== state) return ':0\r\n';
    h.delete(alias);
    return Number(r.lapse) <= Number(now) ? ':0\r\n' : ':1\r\n';
  };
  const run = (args) => {
    const [cmd, ...rest] = args;
    switch (cmd.toUpperCase()) {
      case 'HGET': return bulk(hash(rest[0]).get(rest[1]) ?? null);
      case 'HDEL': return hash(rest[0]).delete(rest[1]) ? ':1\r\n' : ':0\r\n';
      case 'HGETALL': {
        const h = hash(rest[0]);
        return `*${h.size * 2}\r\n` + [...h].map(([k, v]) => bulk(k) + bulk(v)).join('');
      }
      case 'EVAL': {
        const [script, , ...keysAndArgs] = rest;
        if (script.includes('PEXPIREAT')) return loginPut(keysAndArgs);
        if (script.includes('r.state ~= ARGV[2]')) return loginRemove(keysAndArgs);
        return '-ERR unexpected script\r\n';
      }
      default: return `-ERR unknown command ${cmd}\r\n`;
    }
  };
  const server = createTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
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
  server.fake = { hashes, expires };
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
  let alarm = null;
  const state = {
    storage: {
      get: async (k) => storage.get(k),
      put: async (k, v) => { storage.set(k, structuredClone(v)); },
      delete: async (k) => storage.delete(k),
      list: async ({ prefix }) => new Map([...storage].filter(([k]) => k.startsWith(prefix))),
      getAlarm: async () => alarm,
      setAlarm: async (at) => { alarm = at; },
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new RefreshLock(state, { LOCK_TOKEN });
  return {
    url: 'http://lock.test', handle: (req) => obj.fetch(req), stop: async () => {},
    holds: (engine, alias) => storage.has(`login:${engine}:${alias}`),
    alarmAt: () => alarm,
    // What the platform does when the alarm time arrives: clear it, then run the handler.
    runAlarm: async () => { alarm = null; if (typeof obj.alarm === 'function') await obj.alarm(); },
  };
}

const realFetch = globalThis.fetch;

async function redisBackend() {
  const external = process.env.DARIO_TEST_REDIS_PORT;
  const redis = external ? null : await startFakeRedis();
  const port = await freePort();
  const child = spawn(process.execPath, [join(__dirname, '..', 'redis-lock', 'server.mjs')], {
    env: {
      ...process.env, PORT: String(port), LOCK_TOKEN,
      REDIS_HOST: external ? (process.env.DARIO_TEST_REDIS_HOST || '127.0.0.1') : '127.0.0.1',
      REDIS_PORT: external ? external : String(redis.address().port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await realFetch(`${url}/`, { method: 'POST' }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return {
    url, handle: null, stop: async () => { child.kill(); if (redis) await new Promise((r) => redis.close(r)); },
    // Only the fake Redis can be looked into; a real one is checked through the service alone.
    holds: redis ? (engine, alias) => redis.fake.hashes.get(`logins:${engine}`)?.has(alias) === true : undefined,
    expireAt: redis ? (engine) => redis.fake.expires.get(`logins:${engine}`) : undefined,
  };
}

// ----- the network: the backend, and the stubbed OAuth endpoints -----------
let backend = null;
let serviceDown = false;
let serviceCalls = 0;
// The list endpoint answering as if no login were pending, to make two instances pick the same alias.
let staleList = false;
// The remove endpoint not answering while the rest of the service does.
let failRemove = false;
// One call held at the service until the test opens it, to land a change between a lookup and a claim.
let held = null;
function holdCall(path) {
  let reached, open;
  const atCall = new Promise((r) => { reached = r; });
  const opened = new Promise((r) => { open = r; });
  held = { path, reached, opened };
  return { atCall, open };
}
const sameOrigin = (url, base) => new URL(url).origin === new URL(base).origin;
// Every token exchange: { engine, code, verifier, state }.
const exchanges = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (backend && sameOrigin(url, backend.url)) {
    serviceCalls++;
    if (held && url.endsWith(held.path)) {
      const h = held;
      held = null;
      h.reached();
      await h.opened;
    }
    if (failRemove && url.endsWith('/remove')) throw new TypeError('fetch failed');
    if (staleList && url.endsWith('/logins/claude/list')) return Response.json({ aliases: [] });
    if (serviceDown) throw new TypeError('fetch failed');
    if (backend.handle) return backend.handle(new Request(url, init));
    return realFetch(input, init);
  }
  if (new URL(url).hostname === 'codex-token.test') {
    const form = new URLSearchParams(String(init.body));
    exchanges.push({ engine: 'codex', code: form.get('code'), verifier: form.get('code_verifier'), state: null });
    return Response.json({ access_token: `cx-at-${exchanges.length}`, refresh_token: 'cx-rt', expires_in: 3600, id_token: 'cx-id' });
  }
  if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('"authorization_code"')) {
    const b = JSON.parse(init.body);
    exchanges.push({ engine: 'claude', code: b.code, verifier: b.code_verifier, state: b.state });
    return Response.json({ access_token: 'cl-at', refresh_token: 'cl-rt', expires_in: 28_800, scope: 'user:inference' });
  }
  if (url.includes('/profile')) return new Response('{}', { status: 404 });
  return realFetch(input, init);
};

// ----- an instance: its own admin-api module, its own sync client ----------
let instanceSeq = 0;
async function loadIsolated() {
  const dir = mkdtempSync(join(tmpdir(), 'dario-instance-'));
  const own = join(dir, 'home');
  mkdirSync(own);
  cpSync(join(__dirname, '..', 'dist'), join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = own;
  process.env.USERPROFILE = own;
  try {
    return { mod: await import(pathToFileURL(join(dir, 'dist', 'admin-api.js')).href), home: own };
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}
async function instance({ shared = true, isolated = false } = {}) {
  const lines = [];
  const audits = [];
  const loaded = isolated ? await loadIsolated() : null;
  const mod = loaded ? loaded.mod : await import(`../dist/admin-api.js?instance=${++instanceSeq}`);
  const sync = shared ? new AccountSync({ baseUrl: backend.url, token: LOCK_TOKEN, log: (l) => lines.push(l) }) : null;
  const deps = { adminTokenBuf: Buffer.from(ADMIN_TOKEN), sharedLogins: sync, audit: (e) => { audits.push(e); printed.push(JSON.stringify(e)); } };
  async function call(url, body) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = url;
    req.headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
    req.destroy = () => {};
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body ?? {}))); req.emit('end'); });
    const res = { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; return this; }, end(b) { this.body = b || ''; return this; } };
    await mod.handleAdminRequest(req, res, url, deps);
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* leave null */ }
    return { status: res.statusCode, json };
  }
  return {
    sync, lines, audits,
    seatFile: (alias) => (loaded ? join(loaded.home, '.dario', 'codex-accounts', `${alias}.json`) : null),
    reset: () => mod._resetAdminStateForTest(),
    start: (alias) => call('/admin/login/start', alias === undefined ? {} : { alias }),
    complete: (alias, code) => call('/admin/login/complete', { alias, code }),
    startCodex: (alias) => call('/admin/codex/login/start', alias === undefined ? {} : { alias }),
    completeCodex: (alias, code) => call('/admin/codex/login/complete', { alias, code }),
  };
}

async function raw(path, body) {
  const res = await fetch(`${backend.url}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${LOCK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');
const authParam = (r, name) => new URL(r.json.authorize_url).searchParams.get(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- the scenarios, once per backend --------------------------------------
async function scenario(name, make) {
  backend = await make();
  serviceDown = false;
  exchanges.length = 0;
  const secrets = new Set();
  const note = (r) => { if (r.json?.authorize_url) secrets.add(authParam(r, 'state')); };

  header(`${name}: a login started on A completes on B`);
  {
    const A = await instance(), B = await instance();
    const s = await A.start('work');
    note(s);
    check('A starts the login', s.status === 200 && s.json.alias === 'work');
    const held = await raw('/logins/claude/work/get');
    check('the service holds it', held.body.login && typeof held.body.login.codeVerifier === 'string' && held.body.login.state === authParam(s, 'state'));
    check('the service lists its alias', (await raw('/logins/claude/list')).body.aliases.includes('work'));
    const c = await B.complete('work', 'code-1');
    check('B completes it', c.status === 200 && c.json.alias === 'work' && c.json.status === 'added', JSON.stringify(c.json));
    const ex = exchanges.at(-1);
    check('B exchanged the code with A\'s verifier', ex && ex.code === 'code-1' && challengeOf(ex.verifier) === authParam(s, 'code_challenge'));
    check('and A\'s state', ex && ex.state === authParam(s, 'state'));
    secrets.add(ex.verifier);
    check('the service no longer holds it', (await raw('/logins/claude/work/get')).body.login === null);
    check('nor lists it', !(await raw('/logins/claude/list')).body.aliases.includes('work'));

    header(`${name}: a completed login cannot be completed again`);
    const before = exchanges.length;
    const again = await A.complete('work', 'code-1');
    check('A, which started it, finds nothing: 410', again.status === 410);
    const againB = await B.complete('work', 'code-1');
    check('B finds nothing either: 410', againB.status === 410);
    check('no second exchange', exchanges.length === before);
  }

  header(`${name}: a mismatched state does not burn the login`);
  {
    const A = await instance(), B = await instance();
    const s = await A.start('mismatch');
    note(s);
    const bad = await B.complete('mismatch', 'code-x#not-the-state');
    check('a code from another attempt: 400', bad.status === 400);
    check('the login is still on the service', (await raw('/logins/claude/mismatch/get')).body.login !== null);
    const good = await B.complete('mismatch', `code-2#${authParam(s, 'state')}`);
    check('the right paste completes it', good.status === 200);
    secrets.add(exchanges.at(-1).verifier);
  }

  header(`${name}: a restart replaces the pending login`);
  {
    const A = await instance(), B = await instance();
    const first = await A.start('dup');
    const second = await B.start('dup');
    note(first); note(second);
    check('the two logins differ', authParam(first, 'state') !== authParam(second, 'state'));
    const c = await A.complete('dup', 'code-3');
    check('A completes with the replacement\'s verifier', c.status === 200 && challengeOf(exchanges.at(-1).verifier) === authParam(second, 'code_challenge'));
    secrets.add(exchanges.at(-1).verifier);
    check('one entry, now gone', (await raw('/logins/claude/dup/get')).body.login === null);
  }

  header(`${name}: two instances completing at once, one wins`);
  {
    const A = await instance(), B = await instance();
    const s = await A.start('race');
    note(s);
    const before = exchanges.length;
    const [x, y] = await Promise.all([A.complete('race', 'code-4'), B.complete('race', 'code-4')]);
    const statuses = [x.status, y.status].sort();
    check('one 200 and one 410', statuses[0] === 200 && statuses[1] === 410, statuses.join());
    check('one exchange', exchanges.length === before + 1);
    secrets.add(exchanges.at(-1).verifier);
  }

  header(`${name}: expiry`);
  {
    const A = await instance(), B = await instance();
    const s = await A.start('late');
    note(s);
    advance(11 * MIN);
    const before = exchanges.length;
    const c = await B.complete('late', 'code-5');
    check('past the TTL, B gets today\'s 410', c.status === 410 && /no pending login/.test(c.json.error));
    check('no exchange', exchanges.length === before);
    check('the expired login is gone from the service', (await raw('/logins/claude/late/get')).body.login === null);
    advance(-11 * MIN);
    // The test clock ran backwards, which a real one does not: take the entry out by hand.
    await raw('/logins/claude/late/remove', { state: authParam(s, 'state') });

    // The service's own TTL, on its own clock.
    const p = await raw('/logins/claude/short/put', { login: { codeVerifier: 'v-short', state: 's-short', expiresAt: Date.now() + MIN }, ttlMs: 1000 });
    check('a put with a TTL is stored', p.body.stored === true);
    await sleep(1200);
    check('after its TTL the service returns none', (await raw('/logins/claude/short/get')).body.login === null);
    check('and no longer lists it', !(await raw('/logins/claude/list')).body.aliases.includes('short'));
    if (backend.holds) check('a get does not delete: the lapsed record waits for a put or the expiry', backend.holds('claude', 'short'));
    const reput = await raw('/logins/claude/short/put', { login: { codeVerifier: 'v-short', state: 's-short', expiresAt: Date.now() + MIN }, ttlMs: 60_000, create: true });
    check('a lapsed record does not count as taken', reput.body.stored === true);
    await raw('/logins/claude/short/remove', { state: 's-short' });
    await raw('/logins/claude/short2/put', { login: { codeVerifier: 'v2', state: 's2', expiresAt: Date.now() + MIN }, ttlMs: 1000 });
    await sleep(1200);
    await raw('/logins/claude/short3/put', { login: { codeVerifier: 'v3', state: 's3', expiresAt: Date.now() + MIN }, ttlMs: 60_000 });
    check('a later put prunes the lapsed ones', !(await raw('/logins/claude/list')).body.aliases.includes('short2'));
    await raw('/logins/claude/short3/remove', { state: 's3' });
  }

  header(`${name}: the cap`);
  {
    const A = await instance(), B = await instance();
    for (let i = 0; i < 64; i++) {
      const out = await A.sync.put('claude', `cap-${i}`, { codeVerifier: `v${i}`, state: `s${i}`, expiresAt: Date.now() + 10 * MIN }, 10 * MIN);
      if (out !== 'stored') { check(`cap fill ${i}`, false, out); break; }
    }
    const over = await B.start('one-too-many');
    check('a 65th alias on another instance: 429', over.status === 429 && /too many pending logins/.test(over.json.error));
    check('it is not left on B', (await B.complete('one-too-many', 'c')).status === 410);
    const replace = await B.start('cap-3');
    check('replacing an alias already held still works', replace.status === 200);
    const codex = await B.startCodex('cap-codex');
    check('the ChatGPT logins have their own cap', codex.status === 200);
    for (let i = 0; i < 64; i++) await A.sync.remove('claude', `cap-${i}`, `s${i}`);
    await A.sync.remove('codex', 'cap-codex', authParam(codex, 'state'));
    await A.sync.remove('claude', 'cap-3', authParam(replace, 'state'));
  }

  header(`${name}: a generated alias skips one pending on another instance`);
  {
    const A = await instance(), B = await instance();
    const a = await A.start();
    const b = await B.start();
    note(a); note(b);
    check('A gets account-1', a.json.alias === 'account-1');
    check('B does not take it', b.json.alias === 'account-2', b.json.alias);
    await A.sync.remove('claude', 'account-1', authParam(a, 'state'));
    await A.sync.remove('claude', 'account-2', authParam(b, 'state'));
  }

  header(`${name}: ChatGPT logins`);
  {
    const A = await instance(), B = await instance();
    const seat = `seat-${name}`;
    const s = await A.startCodex(seat);
    note(s);
    check('A starts a codex login', s.status === 200 && s.json.alias === seat);
    check('it is under the codex namespace only', (await raw(`/logins/codex/${seat}/get`)).body.login !== null && (await raw(`/logins/claude/${seat}/get`)).body.login === null);
    const c = await B.completeCodex(seat, `http://localhost:1455/auth/callback?code=cx-code&state=${authParam(s, 'state')}`);
    check('B completes it', c.status === 200 && c.json.alias === seat, JSON.stringify(c.json));
    const ex = exchanges.at(-1);
    check('with A\'s verifier', ex.engine === 'codex' && ex.code === 'cx-code' && challengeOf(ex.verifier) === authParam(s, 'code_challenge'));
    secrets.add(ex.verifier);
    check('gone from the service', (await raw(`/logins/codex/${seat}/get`)).body.login === null);
    check('a second completion: 410', (await A.completeCodex(seat, 'cx-code')).status === 410);
    const expired = await A.startCodex(`${seat}-b`);
    note(expired);
    advance(11 * MIN);
    check('an expired codex login: 410', (await B.completeCodex(`${seat}-b`, 'cx-code')).status === 410);
    advance(-11 * MIN);
    await raw(`/logins/codex/${seat}-b/remove`, { state: authParam(expired, 'state') });
  }

  header(`${name}: the service is down`);
  {
    const A = await instance(), B = await instance();
    serviceDown = true;
    const s = await A.start('offline');
    note(s);
    check('a start still succeeds on A', s.status === 200 && typeof s.json.authorize_url === 'string');
    check('the failure is logged', A.lines.some((l) => /could not publish the pending login for "offline"/.test(l)));
    const c = await A.complete('offline', 'code-6');
    check('and completes on A from its own copy', c.status === 200, JSON.stringify(c.json));
    secrets.add(exchanges.at(-1).verifier);
    serviceDown = false;

    const t = await A.start('flaky');
    note(t);
    serviceDown = true;
    const c2 = await A.complete('flaky', 'code-7');
    check('a published login completes on A while the service is down', c2.status === 200, JSON.stringify(c2.json));
    secrets.add(exchanges.at(-1).verifier);
    serviceDown = false;
    await raw('/logins/claude/flaky/remove', { state: authParam(t, 'state') });

    serviceDown = true;
    const u = await A.start('local-only');
    note(u);
    serviceDown = false;
    const before = exchanges.length;
    const cb = await B.complete('local-only', 'code-8');
    check('a login never published is not found on B: today\'s 410', cb.status === 410 && /no pending login/.test(cb.json.error));
    check('no exchange', exchanges.length === before);
    const ca = await A.complete('local-only', 'code-8');
    check('A still holds it, and completes it', ca.status === 200, JSON.stringify(ca.json));
    secrets.add(exchanges.at(-1).verifier);
  }

  header(`${name}: an older service without the endpoints`);
  {
    const A = await instance();
    const realBackend = backend;
    backend = { ...realBackend, handle: async (req) => (new URL(req.url).pathname.startsWith('/logins/') ? Response.json({ error: 'not found' }, { status: 404 }) : realBackend.handle ? realBackend.handle(req) : realFetch(req)) };
    // For the Redis child the 404 is faked in front of it, so the call never reaches it.
    const s = await A.start('old-service');
    note(s);
    check('a start works', s.status === 200);
    check('a completion on the same instance works', (await A.complete('old-service', 'code-9')).status === 200);
    secrets.add(exchanges.at(-1).verifier);
    backend = realBackend;
  }

  header(`${name}: the service rejects what it does not understand`);
  {
    const noAuth = await fetch(`${backend.url}/logins/claude/x/get`, { method: 'POST', body: '{}' });
    check('no bearer: 401', noAuth.status === 401);
    const bad = await raw('/logins/claude/x/put', { login: { codeVerifier: '', state: 's', expiresAt: 1 } });
    check('an incomplete login: 400', bad.status === 400);
    const other = await raw('/logins/gemini/x/get');
    check('an unknown engine: 404', other.status === 404);
    await raw('/logins/claude/x/put', { login: { codeVerifier: 'v-x', state: 's-x', expiresAt: Date.now() + MIN }, ttlMs: 60_000 });
    check('a remove with no state: 400', (await raw('/logins/claude/x/remove', {})).status === 400);
    check('a remove naming another login removes nothing', (await raw('/logins/claude/x/remove', { state: 'other' })).body.removed === false
      && (await raw('/logins/claude/x/get')).body.login !== null);
    check('a remove naming the login removes it', (await raw('/logins/claude/x/remove', { state: 's-x' })).body.removed === true
      && (await raw('/logins/claude/x/get')).body.login === null);
    check('a second remove of it is false', (await raw('/logins/claude/x/remove', { state: 's-x' })).body.removed === false);
    await raw('/logins/claude/y/put', { login: { codeVerifier: 'v-y', state: 's-y', expiresAt: Date.now() + MIN }, ttlMs: 60_000 });
    const second = await raw('/logins/claude/y/put', { login: { codeVerifier: 'v-y2', state: 's-y2', expiresAt: Date.now() + MIN }, ttlMs: 60_000, create: true });
    check('create leaves a live login alone: taken', second.body.stored === false && second.body.taken === true);
    check('and it is still the first', (await raw('/logins/claude/y/get')).body.login.state === 's-y');
    const plain = await raw('/logins/claude/y/put', { login: { codeVerifier: 'v-y3', state: 's-y3', expiresAt: Date.now() + MIN }, ttlMs: 60_000 });
    check('without create a put replaces', plain.body.stored === true && (await raw('/logins/claude/y/get')).body.login.state === 's-y3');
    await raw('/logins/claude/y/remove', { state: 's-y3' });
  }

  header(`${name}: a login is completed once, even by overlapping calls on one instance`);
  for (const engine of ['claude', 'codex']) {
    const begin = (I, alias) => (engine === 'claude' ? I.start(alias) : I.startCodex(alias));
    const finish = (I, alias, code) => (engine === 'claude' ? I.complete(alias, code) : I.completeCodex(alias, code));
    const A = await instance();
    const alias = `once-${engine}-${name}`;
    serviceDown = true;
    const s1 = await begin(A, alias);
    note(s1);
    serviceDown = false;
    let before = exchanges.length;
    let [x, y] = await Promise.all([finish(A, alias, 'code-a'), finish(A, alias, 'code-a')]);
    check(`${engine}: a login kept on this instance alone: one 200, one 410`, [x.status, y.status].sort().join() === '200,410', [x.status, y.status].join());
    check(`${engine}: one exchange`, exchanges.length === before + 1);
    secrets.add(exchanges.at(-1)?.verifier);

    const s2 = await begin(A, `${alias}-b`);
    note(s2);
    serviceDown = true;
    before = exchanges.length;
    [x, y] = await Promise.all([finish(A, `${alias}-b`, 'code-b'), finish(A, `${alias}-b`, 'code-b')]);
    serviceDown = false;
    check(`${engine}: on the local copy while the service is down: one 200, one 410`, [x.status, y.status].sort().join() === '200,410', [x.status, y.status].join());
    check(`${engine}: one exchange`, exchanges.length === before + 1);
    secrets.add(exchanges.at(-1)?.verifier);
    await raw(`/logins/${engine}/${alias}-b/remove`, { state: authParam(s2, 'state') });
  }

  header(`${name}: a completion cannot delete or spend a login that replaced the one it read`);
  for (const engine of ['claude', 'codex']) {
    const begin = (I, alias) => (engine === 'claude' ? I.start(alias) : I.startCodex(alias));
    const finish = (I, alias, code) => (engine === 'claude' ? I.complete(alias, code) : I.completeCodex(alias, code));
    const A = await instance(), B = await instance();
    const alias = `swap-${engine}-${name}`;
    const first = await begin(A, alias);
    note(first);
    const hold = holdCall(`/logins/${engine}/${alias}/remove`);
    const before = exchanges.length;
    const pending = finish(B, alias, 'code-old');
    await hold.atCall;
    const second = await begin(A, alias);
    note(second);
    hold.open();
    const lost = await pending;
    check(`${engine}: the completion that read the first login gets 410`, lost.status === 410, JSON.stringify(lost.json));
    check(`${engine}: it exchanged nothing`, exchanges.length === before);
    const kept = await raw(`/logins/${engine}/${alias}/get`);
    check(`${engine}: the replacement is still on the service`, kept.body.login?.state === authParam(second, 'state'));
    const ok = await finish(B, alias, 'code-new');
    check(`${engine}: and still completes`, ok.status === 200, JSON.stringify(ok.json));
    check(`${engine}: with its own verifier`, challengeOf(exchanges.at(-1).verifier) === authParam(second, 'code_challenge'));
    secrets.add(exchanges.at(-1).verifier);
  }

  header(`${name}: simultaneous generated aliases on two instances`);
  for (const engine of ['claude', 'codex']) {
    const begin = (I) => (engine === 'claude' ? I.start() : I.startCodex());
    const A = await instance(), B = await instance();
    const [x, y] = await Promise.all([begin(A), begin(B)]);
    note(x); note(y);
    check(`${engine}: both start`, x.status === 200 && y.status === 200, `${x.status} ${y.status}`);
    check(`${engine}: under different aliases`, x.json.alias !== y.json.alias, `${x.json.alias} ${y.json.alias}`);
    const gx = (await raw(`/logins/${engine}/${x.json.alias}/get`)).body.login;
    const gy = (await raw(`/logins/${engine}/${y.json.alias}/get`)).body.login;
    check(`${engine}: each login is still its own`, gx?.state === authParam(x, 'state') && gy?.state === authParam(y, 'state'));
    await raw(`/logins/${engine}/${x.json.alias}/remove`, { state: authParam(x, 'state') });
    await raw(`/logins/${engine}/${y.json.alias}/remove`, { state: authParam(y, 'state') });
  }

  header(`${name}: a generated alias tries at most 8 times`);
  {
    const A = await instance(), B = await instance(), C = await instance();
    for (let i = 1; i <= 7; i++) await A.sync.put('claude', `account-${i}`, { codeVerifier: `vv${i}`, state: `ss${i}`, expiresAt: Date.now() + 10 * MIN }, 10 * MIN);
    staleList = true;
    const last = await B.start();
    note(last);
    check('seven taken: the eighth candidate is used', last.status === 200 && last.json.alias === 'account-8', last.json.alias ?? JSON.stringify(last.json));
    const none = await C.start();
    check('eight taken: gives up with 409', none.status === 409, JSON.stringify(none.json));
    staleList = false;
    for (let i = 1; i <= 7; i++) await A.sync.remove('claude', `account-${i}`, `ss${i}`);
    await A.sync.remove('claude', 'account-8', authParam(last, 'state'));
  }

  if (backend.alarmAt) {
    header(`${name}: the alarm deletes lapsed logins when no request follows`);
    const put = (alias, ttl) => raw(`/logins/claude/${alias}/put`, { login: { codeVerifier: `v-${alias}`, state: `s-${alias}`, expiresAt: Date.now() + ttl }, ttlMs: ttl });
    await backend.runAlarm();
    await put('al-1', 5000);
    await put('al-2', 20_000);
    const t0 = Date.now();
    check('the alarm is armed at the earliest lapse', backend.alarmAt() !== null && Math.abs(backend.alarmAt() - (t0 + 5000)) < 1000, String(backend.alarmAt() - t0));
    advance(6000);
    await backend.runAlarm();
    check('the lapsed login is gone with no later request', !backend.holds('claude', 'al-1'));
    check('the live one is kept', backend.holds('claude', 'al-2'));
    check('and the alarm is armed for it', backend.alarmAt() !== null && Math.abs(backend.alarmAt() - (t0 + 20_000)) < 1000);
    advance(15_000);
    await backend.runAlarm();
    check('it goes at its own lapse', !backend.holds('claude', 'al-2'));
    check('and no alarm is left armed', backend.alarmAt() === null);
    advance(-21_000);
    await put('al-3', 1000);
    advance(-0);
    const first = backend.alarmAt();
    await put('al-4', 30_000);
    check('a later, longer login does not push the alarm back', backend.alarmAt() === first);
    await raw('/logins/claude/al-3/remove', { state: 's-al-3' });
    await raw('/logins/claude/al-4/remove', { state: 's-al-4' });
    await backend.runAlarm();
  }

  if (backend.expireAt) {
    header(`${name}: Redis drops the hash at the newest lapse`);
    const put = (alias, ttl) => raw(`/logins/claude/${alias}/put`, { login: { codeVerifier: `v-${alias}`, state: `s-${alias}`, expiresAt: Date.now() + ttl }, ttlMs: ttl });
    const real = realNow();
    await put('ex-1', 60_000);
    const at1 = backend.expireAt('claude');
    check('the expiry is the lapse of the login put', at1 >= real + 59_000 && at1 <= real + 62_000, String(at1 - real));
    await put('ex-2', 2000);
    check('a shorter login put later does not shorten it', backend.expireAt('claude') === at1);
    await raw('/logins/claude/ex-1/remove', { state: 's-ex-1' });
    await raw('/logins/claude/ex-2/remove', { state: 's-ex-2' });
  }

  header(`${name}: a Codex login does not overwrite a seat held on the completing instance`);
  {
    // Three instances, each with its own account stores.
    const A = await instance({ isolated: true }), B = await instance({ isolated: true }), C = await instance({ isolated: true });
    const alias = `held-${name}`;
    await B.startCodex(alias);
    const seeded = await B.completeCodex(alias, 'seat-code');
    check('B holds a seat under the alias', seeded.status === 200 && existsSync(B.seatFile(alias)), JSON.stringify(seeded.json));
    secrets.add(exchanges.at(-1)?.verifier);
    const seatBefore = readFileSync(B.seatFile(alias), 'utf8');
    check('A, which lacks it, starts a login under the alias', !existsSync(A.seatFile(alias)));
    const s = await A.startCodex(alias);
    note(s);
    check('A starts it', s.status === 200, JSON.stringify(s.json));
    const before = exchanges.length;
    const refused = await B.completeCodex(alias, `http://localhost:1455/auth/callback?code=other-seat&state=${authParam(s, 'state')}`);
    check('B refuses: 409', refused.status === 409 && /already exists on this instance/.test(refused.json.error), JSON.stringify(refused.json));
    check('no token exchange', exchanges.length === before);
    check('B\'s seat file is unchanged', readFileSync(B.seatFile(alias), 'utf8') === seatBefore);
    check('the login is still on the service', (await raw(`/logins/codex/${alias}/get`)).body.login?.state === authParam(s, 'state'));
    const ok = await C.completeCodex(alias, `http://localhost:1455/auth/callback?code=other-seat&state=${authParam(s, 'state')}`);
    check('an instance without the seat completes it', ok.status === 200, JSON.stringify(ok.json));
    check('with the starting instance\'s verifier', challengeOf(exchanges.at(-1).verifier) === authParam(s, 'code_challenge'));
    secrets.add(exchanges.at(-1).verifier);
    check('the seat lands on C', existsSync(C.seatFile(alias)));
    check('and B\'s is still unchanged', readFileSync(B.seatFile(alias), 'utf8') === seatBefore);
  }

  header(`${name}: partial outages never let two completions both exchange`);
  for (const engine of ['claude', 'codex']) {
    const begin = (I, alias) => (engine === 'claude' ? I.start(alias) : I.startCodex(alias));
    const finish = (I, alias, code) => (engine === 'claude' ? I.complete(alias, code) : I.completeCodex(alias, code));

    // The lookup fails on A, B claims the login, the service recovers: A's remove answers a definite no.
    {
      const A = await instance(), B = await instance();
      const alias = `lost-${engine}-${name}`;
      note(await begin(A, alias));
      const hold = holdCall(`/logins/${engine}/${alias}/remove`);
      serviceDown = true;
      const pendingA = finish(A, alias, 'code-lost');
      await hold.atCall;
      serviceDown = false;
      const before = exchanges.length;
      const viaB = await finish(B, alias, 'code-lost');
      secrets.add(exchanges.at(-1)?.verifier);
      hold.open();
      const viaA = await pendingA;
      check(`${engine}: B claims it on the service`, viaB.status === 200, JSON.stringify(viaB.json));
      check(`${engine}: A, whose lookup failed, is told the claim is lost: 410`, viaA.status === 410, JSON.stringify(viaA.json));
      check(`${engine}: one exchange`, exchanges.length === before + 1);
    }

    // Both lookups succeed and both removes fail: the copy held here is claimed once.
    {
      const A = await instance();
      const alias = `failrm-${engine}-${name}`;
      const st = await begin(A, alias);
      note(st);
      const before = exchanges.length;
      failRemove = true;
      const [x, y] = await Promise.all([finish(A, alias, 'code-f'), finish(A, alias, 'code-f')]);
      failRemove = false;
      check(`${engine}: removes failing: one 200, one 410`, [x.status, y.status].sort().join() === '200,410', [x.status, y.status].join());
      check(`${engine}: one exchange`, exchanges.length === before + 1);
      secrets.add(exchanges.at(-1)?.verifier);
      await raw(`/logins/${engine}/${alias}/remove`, { state: authParam(st, 'state') });
    }

    // Found on the service with no copy here, and the remove fails: nothing can be claimed.
    {
      const A = await instance(), B = await instance();
      const alias = `nocopy-${engine}-${name}`;
      const st = await begin(A, alias);
      note(st);
      const before = exchanges.length;
      failRemove = true;
      const out = await finish(B, alias, 'code-n');
      failRemove = false;
      check(`${engine}: no copy here and the claim unconfirmed: 410`, out.status === 410, JSON.stringify(out.json));
      check(`${engine}: no exchange`, exchanges.length === before);
      const later = await finish(B, alias, 'code-n');
      check(`${engine}: the login is intact and completes once the service answers`, later.status === 200, JSON.stringify(later.json));
      secrets.add(exchanges.at(-1)?.verifier);
    }
  }

  header(`${name}: copies of logins completed elsewhere do not fill this instance`);
  for (const engine of ['claude', 'codex']) {
    const begin = (I, alias) => (engine === 'claude' ? I.start(alias) : I.startCodex(alias));
    const finish = (I, alias, code) => (engine === 'claude' ? I.complete(alias, code) : I.completeCodex(alias, code));
    const A = await instance();
    const fill = (i) => `fill-${engine}-${name}-${i}`;
    const started = [];
    for (let i = 0; i < 64; i++) started.push(await begin(A, fill(i)));
    check(`${engine}: 64 started on A`, started.every((r) => r.status === 200));
    started.forEach(note);
    // Completed elsewhere: the service no longer holds 63 of them, and A's copies are stale.
    for (let i = 1; i < 64; i++) await raw(`/logins/${engine}/${fill(i)}/remove`, { state: authParam(started[i], 'state') });
    const fresh = await begin(A, `fresh-${engine}-${name}`);
    note(fresh);
    check(`${engine}: a new start on A is not refused: 200`, fresh.status === 200, JSON.stringify(fresh.json));
    const done = await finish(A, `fresh-${engine}-${name}`, 'code-fresh');
    check(`${engine}: and completes`, done.status === 200, JSON.stringify(done.json));
    secrets.add(exchanges.at(-1)?.verifier);
    const evicted = await finish(A, fill(0), 'code-evicted');
    check(`${engine}: a live login whose copy here gave way completes through the service`, evicted.status === 200, JSON.stringify(evicted.json));
    check(`${engine}: with its own verifier`, challengeOf(exchanges.at(-1).verifier) === authParam(started[0], 'code_challenge'));
    secrets.add(exchanges.at(-1).verifier);
  }

  header(`${name}: logins kept on this instance alone still hit the cap`);
  for (const engine of ['claude', 'codex']) {
    const begin = (I, alias) => (engine === 'claude' ? I.start(alias) : I.startCodex(alias));
    const A = await instance();
    serviceDown = true;
    const solo = (i) => `solo-${engine}-${name}-${i}`;
    let ok = true;
    for (let i = 0; i < 64; i++) ok = (await begin(A, solo(i))).status === 200 && ok;
    check(`${engine}: 64 local-only logins start`, ok);
    const over = await begin(A, `solo-${engine}-${name}-over`);
    check(`${engine}: a new alias past the cap: 429`, over.status === 429, String(over.status));
    const again = await begin(A, solo(5));
    check(`${engine}: replacing one of them still works`, again.status === 200);
    serviceDown = false;
  }

  header(`${name}: no secret in any log`);
  {
    const text = [...printed].join('\n');
    const all = [...secrets].filter((x) => typeof x === 'string' && x.length >= 8);
    check('there were secrets to look for', all.length >= 10, String(all.length));
    check('none appears in anything printed', all.every((x) => !text.includes(x)));
  }

  await backend.stop();
  backend = null;
}

// ----- shared accounts off: nothing changes ---------------------------------
async function offScenario() {
  header('shared off: pending logins stay in the process');
  backend = workerBackend();
  serviceCalls = 0;
  const A = await instance({ shared: false }), B = await instance({ shared: false });
  const s = await A.start('solo');
  check('A starts', s.status === 200);
  const wrong = await B.complete('solo', 'code-10');
  check('B cannot complete it: 410', wrong.status === 410 && /no pending login/.test(wrong.json.error));
  const right = await A.complete('solo', 'code-10');
  check('A can', right.status === 200);
  const cx = await A.startCodex('solo-cx');
  check('codex starts', cx.status === 200);
  check('codex does not cross instances', (await B.completeCodex('solo-cx', 'c')).status === 410);
  for (const engine of ['claude', 'codex']) {
    const begin = (I, alias) => (engine === 'claude' ? I.start(alias) : I.startCodex(alias));
    const finish = (I, alias, code) => (engine === 'claude' ? I.complete(alias, code) : I.completeCodex(alias, code));
    const alias = `off-${engine}`;
    await begin(A, alias);
    const before = exchanges.length;
    const [x, y] = await Promise.all([finish(A, alias, 'code-d'), finish(A, alias, 'code-d')]);
    check(`${engine}: overlapping completions: one 200, one 410`, [x.status, y.status].sort().join() === '200,410', [x.status, y.status].join());
    check(`${engine}: one exchange`, exchanges.length === before + 1);
  }
  check('the service was never called', serviceCalls === 0);
  const t = await A.start('timed');
  advance(11 * MIN);
  check('expiry is unchanged', t.status === 200 && (await A.complete('timed', 'c')).status === 410);
  advance(-11 * MIN);
  await backend.stop();
  backend = null;
}

await scenario('worker', async () => workerBackend());
await scenario('redis', redisBackend);
await offScenario();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

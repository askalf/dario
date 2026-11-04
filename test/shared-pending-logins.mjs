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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // The login put script, in JS, step for step with the Lua.
  const loginPut = ([key, alias, record, now, , cap]) => {
    const h = hash(key);
    let others = 0;
    for (const [f, v] of [...h]) {
      if (Number(JSON.parse(v).lapse) <= Number(now)) h.delete(f);
      else if (f !== alias) others++;
    }
    if (others >= Number(cap)) return ':0\r\n';
    h.set(alias, record);
    return ':1\r\n';
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
        if (script.includes('ARGV[5]') && script.includes('cjson.decode(all[i + 1])')) return loginPut(keysAndArgs);
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
      put: async (k, v) => { storage.set(k, structuredClone(v)); },
      delete: async (k) => storage.delete(k),
      list: async ({ prefix }) => new Map([...storage].filter(([k]) => k.startsWith(prefix))),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new RefreshLock(state, { LOCK_TOKEN });
  return { url: 'http://lock.test', handle: (req) => obj.fetch(req), stop: async () => {} };
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
  return { url, handle: null, stop: async () => { child.kill(); if (redis) await new Promise((r) => redis.close(r)); } };
}

// ----- the network: the backend, and the stubbed OAuth endpoints -----------
let backend = null;
let serviceDown = false;
let serviceCalls = 0;
// Every token exchange: { engine, code, verifier, state }.
const exchanges = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (backend && url.startsWith(backend.url)) {
    serviceCalls++;
    if (serviceDown) throw new TypeError('fetch failed');
    if (backend.handle) return backend.handle(new Request(url, init));
    return realFetch(input, init);
  }
  if (url.startsWith('http://codex-token.test')) {
    const form = new URLSearchParams(String(init.body));
    exchanges.push({ engine: 'codex', code: form.get('code'), verifier: form.get('code_verifier'), state: null });
    return Response.json({ access_token: 'cx-at', refresh_token: 'cx-rt', expires_in: 3600, id_token: 'cx-id' });
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
async function instance({ shared = true } = {}) {
  const lines = [];
  const audits = [];
  const mod = await import(`../dist/admin-api.js?instance=${++instanceSeq}`);
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

    // The service's own TTL, on its own clock.
    const p = await raw('/logins/claude/short/put', { login: { codeVerifier: 'v-short', state: 's-short', expiresAt: Date.now() + MIN }, ttlMs: 1000 });
    check('a put with a TTL is stored', p.body.stored === true);
    await sleep(1200);
    check('after its TTL the service returns none', (await raw('/logins/claude/short/get')).body.login === null);
    check('and no longer lists it', !(await raw('/logins/claude/list')).body.aliases.includes('short'));
    await raw('/logins/claude/short2/put', { login: { codeVerifier: 'v2', state: 's2', expiresAt: Date.now() + MIN }, ttlMs: 1000 });
    await sleep(1200);
    await raw('/logins/claude/short3/put', { login: { codeVerifier: 'v3', state: 's3', expiresAt: Date.now() + MIN }, ttlMs: 60_000 });
    check('a later put prunes the lapsed ones', !(await raw('/logins/claude/list')).body.aliases.includes('short2'));
    await raw('/logins/claude/short3/remove');
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
    for (let i = 0; i < 64; i++) await A.sync.remove('claude', `cap-${i}`);
    await A.sync.remove('codex', 'cap-codex');
  }

  header(`${name}: a generated alias skips one pending on another instance`);
  {
    const A = await instance(), B = await instance();
    const a = await A.start();
    const b = await B.start();
    note(a); note(b);
    check('A gets account-1', a.json.alias === 'account-1');
    check('B does not take it', b.json.alias === 'account-2', b.json.alias);
    await A.sync.remove('claude', 'account-1');
    await A.sync.remove('claude', 'account-2');
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
    await raw('/logins/claude/flaky/remove');

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

// Shared account registry (src/account-sync.ts, dario#1733): replicas merge
// their Claude accounts and ChatGPT seats (src/codex-account-sync.ts, each in
// a registry of its own) through the refresh-lock service, so a second pod
// that boots with an empty accounts directory starts with its peer's
// accounts, an add on one replica reaches the others, and a removal is not
// undone by a replica that still holds the file.
//
// Runs the real client against both bundled backends: the Cloudflare
// Worker's RefreshLock in process, and redis-lock/server.mjs as a child
// process over a fake Redis (or a real one: DARIO_TEST_REDIS_PORT, with
// DARIO_TEST_REDIS_HOST, points the server at it; use a throwaway Redis,
// the test writes the registry keys). Replicas are in-memory stores with
// the same rules as accounts.ts; the real file helpers run last, against
// a throwaway home.

import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Account files land in a throwaway home, never the operator's ~/.dario.
const home = mkdtempSync(join(tmpdir(), 'dario-account-sync-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

// Read when codex-oauth.ts loads, so it has to be set before the import below.
const TOKEN_URL = 'http://codex-token.test/oauth/token';
process.env.DARIO_CODEX_TOKEN_URL = TOKEN_URL;

const accounts = await import('../dist/accounts.js');
const { credentialsAreNewer, grantedAfter } = accounts;
const { AccountSync, planAccountSync, removeAccountEverywhere } = await import('../dist/account-sync.js');
const codex = await import('../dist/codex-accounts.js');
const { CODEX_REGISTRY, isCodexRegistryRecord, removeCodexAccountEverywhere } = await import('../dist/codex-account-sync.js');
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

// One clock, moved by the test, so removal and grant times never tie.
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms) => { offset += ms; };
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const LOCK_TOKEN = 'lock-secret';

function seat(alias, extra = {}) {
  return {
    alias, accessToken: `access-${alias}`, refreshToken: `refresh-${alias}`, expiresAt: Date.now() + 8 * HOUR,
    scopes: ['user:inference'], deviceId: `device-${alias}`, accountUuid: `uuid-${alias}`, grantedAt: Date.now() - DAY,
    ...extra,
  };
}

function codexSeat(alias, extra = {}) {
  return {
    alias, accessToken: `access-${alias}`, refreshToken: `refresh-${alias}`, expiresAt: Date.now() + 8 * HOUR,
    idToken: `id-${alias}`, grantedAt: Date.now() - DAY,
    ...extra,
  };
}

// ----- one replica's accounts directory, with the rules of accounts.ts ----
function memoryStore() {
  const files = new Map();
  const removals = new Map();
  return {
    files,
    loadAll: async () => [...files.values()].map((c) => ({ ...c })),
    save: async (creds, { fetchedAt, removedAt }) => {
      const removedHere = removals.get(creds.alias);
      if (removedHere !== undefined && removedHere >= fetchedAt) return { saved: false };
      const current = files.get(creds.alias);
      if (current && grantedAfter(current, removedAt) && !credentialsAreNewer(creds, current)) return { saved: false };
      files.set(creds.alias, { ...creds });
      return { saved: true, replaced: current };
    },
    remove: async (alias, removedAt) => {
      const current = files.get(alias);
      if (!current || grantedAfter(current, removedAt)) return false;
      files.delete(alias);
      return true;
    },
    localRemovals: () => new Map(removals),
    // What `dario accounts add` / an admin login and removeAccount do here.
    put: (c) => { files.set(c.alias, { ...c }); },
    removeHere: (alias) => { if (files.delete(alias)) removals.set(alias, Date.now()); },
  };
}

function codexReplica(url, store = memoryStore()) {
  const lines = [];
  const sync = new AccountSync({ baseUrl: url, token: LOCK_TOKEN, store, log: (l) => lines.push(l), registry: CODEX_REGISTRY });
  return { sync, store, lines };
}

function replica(url, store = memoryStore()) {
  const lines = [];
  const sync = new AccountSync({ baseUrl: url, token: LOCK_TOKEN, store, log: (l) => lines.push(l) });
  return { sync, store, lines };
}

// ----- fake Redis: the commands redis-lock/server.mjs sends --------------
function startFakeRedis() {
  const kv = new Map();
  const hashes = new Map();
  const hash = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  const bulk = (v) => (v === null || v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  // The two account scripts, in JS, step for step with the Lua.
  const accountPut = ([recKey, rmKey, alias, record, grantedRaw, expiresRaw]) => {
    const g = grantedRaw === '' ? null : Number(grantedRaw), e = Number(expiresRaw);
    const rm = hash(rmKey).get(alias);
    if (rm !== undefined && (g === null || g <= Number(rm))) return ':0\r\n';
    const cur = hash(recKey).get(alias);
    if (cur !== undefined) {
      const c = JSON.parse(cur);
      const cg = typeof c.grantedAt === 'number' ? c.grantedAt : null;
      if (g !== null && cg !== null && g !== cg) { if (g < cg) return ':0\r\n'; }
      else if (typeof c.expiresAt === 'number' && e <= c.expiresAt) return ':0\r\n';
    }
    hash(recKey).set(alias, record);
    if (rm !== undefined) hash(rmKey).delete(alias);
    return ':1\r\n';
  };
  const accountRemove = ([recKey, rmKey, alias, atRaw]) => {
    const at = Number(atRaw);
    const cur = hash(recKey).get(alias);
    if (cur !== undefined) {
      const c = JSON.parse(cur);
      if (typeof c.grantedAt === 'number' && c.grantedAt > at) return ':0\r\n';
      hash(recKey).delete(alias);
    }
    const rm = hash(rmKey).get(alias);
    if (rm === undefined || at > Number(rm)) hash(rmKey).set(alias, atRaw);
    return ':1\r\n';
  };
  const run = (args) => {
    const [cmd, ...rest] = args;
    switch (cmd.toUpperCase()) {
      case 'GET': return bulk(kv.get(rest[0]) ?? null);
      case 'HGETALL': {
        const h = hashes.get(rest[0]) ?? new Map();
        return `*${h.size * 2}\r\n` + [...h].map(([k, v]) => bulk(k) + bulk(v)).join('');
      }
      case 'EVAL': {
        const [script, , ...keysAndArgs] = rest;
        if (script.includes('ARGV[4]')) return accountPut(keysAndArgs);
        if (script.includes('local at')) return accountRemove(keysAndArgs);
        return `-ERR unexpected script\r\n`;
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
    url,
    handle: null,
    stop: async () => { child.kill(); if (redis) await new Promise((r) => redis.close(r)); },
  };
}

const realFetch = globalThis.fetch;
let backend = null;
let serviceDown = false;
// One call held at the service until the test opens it, to land a change
// while a sync waits.
let held = null;
function holdCall(path) {
  let reached, open;
  const atCall = new Promise((r) => { reached = r; });
  const opened = new Promise((r) => { open = r; });
  held = { path, reached, opened };
  return { atCall, open };
}
// What the fake ChatGPT token endpoint answers next.
let tokenAnswer = { status: 400, body: { error: 'invalid_grant' } };
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === TOKEN_URL) return jsonResponse(tokenAnswer.status, tokenAnswer.body);
  // A lock service from before the ChatGPT registry: the Claude one answers, the new paths do not.
  if (url.startsWith('http://older-lock.test/')) {
    return url.endsWith('/accounts/list') && !url.includes('/codex-accounts/') ? jsonResponse(200, { accounts: {}, removed: {} }) : jsonResponse(404, { error: 'not found' });
  }
  if (backend && url.startsWith(backend.url)) {
    if (held && url.endsWith(held.path)) {
      const h = held;
      held = null;
      h.reached();
      await h.opened;
    }
    if (serviceDown) throw new TypeError('fetch failed');
    if (backend.handle) return backend.handle(new Request(url, init));
  }
  return realFetch(input, init);
};

async function registry() {
  const res = await fetch(`${backend.url}/accounts/list`, {
    method: 'POST', headers: { authorization: `Bearer ${LOCK_TOKEN}`, 'content-type': 'application/json' }, body: '{}',
  });
  return res.json();
}
async function rawCall(path, body) {
  const res = await fetch(`${backend.url}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${LOCK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ----- the plan, by itself ----------------------------------------------
header('planAccountSync: per alias, the newer record that outlives its removal');
{
  const none = new Map();
  const g = Date.now() - DAY;
  const a = seat('a', { grantedAt: g });
  const plan = (local, reg, markers = none, removals = none) => planAccountSync(local, new Map(reg.map((r) => [r.alias, r])), markers, removals);

  let p = plan([], []);
  check('nothing on either side: nothing to do', p.save.length + p.remove.length + p.push.length === 0);
  p = plan([a], []);
  check('only here: pushed', p.push.length === 1 && p.push[0].alias === 'a' && p.save.length === 0);
  p = plan([], [a]);
  check('only in the registry: saved here', p.save.length === 1 && p.save[0].creds.alias === 'a' && p.save[0].removedAt === undefined);
  p = plan([a], [{ ...a }]);
  check('the same record on both: nothing to do', p.save.length + p.remove.length + p.push.length === 0);
  p = plan([{ ...a, expiresAt: a.expiresAt + HOUR }], [a]);
  check('same grant, later expiry here: pushed', p.push.length === 1 && p.save.length === 0);
  p = plan([a], [{ ...a, expiresAt: a.expiresAt + HOUR }]);
  check('same grant, later expiry in the registry: saved', p.save.length === 1 && p.push.length === 0);
  p = plan([{ ...a, grantedAt: g + HOUR, expiresAt: a.expiresAt - 2 * HOUR }], [a]);
  check('a newer grant beats a later expiry', p.push.length === 1 && p.save.length === 0);

  const removedAt = g + HOUR;
  const markers = new Map([['a', removedAt]]);
  p = plan([a], [], markers);
  check('a marker after the grant here: the file is removed', p.remove.length === 1 && p.remove[0].removedAt === removedAt && p.push.length === 0);
  p = plan([{ ...a, grantedAt: undefined }], [], markers);
  check('a record with no grant time predates the marker: removed', p.remove.length === 1);
  p = plan([{ ...a, grantedAt: removedAt + 1 }], [], markers);
  check('a login after the marker: pushed, not removed', p.push.length === 1 && p.remove.length === 0);
  p = plan([a], [{ ...a, grantedAt: removedAt + 1 }], markers);
  check('a peer\'s login after the marker replaces the removed file', p.save.length === 1 && p.save[0].removedAt === removedAt && p.remove.length === 0);
  p = plan([], [a], none, new Map([['a', removedAt]]));
  check('removed here, still in the registry: not saved back', p.save.length === 0 && p.push.length === 0);
  p = plan([], [{ ...a, grantedAt: removedAt + 1 }], none, new Map([['a', removedAt]]));
  check('removed here, then a peer logged in again: saved', p.save.length === 1);
  p = plan([], [], new Map([['a', removedAt]]), new Map([['a', removedAt - 5]]));
  check('only markers: nothing to do', p.save.length + p.remove.length + p.push.length === 0);
}

// ----- replicas against one service, once per backend ---------------------
async function scenario(name, make) {
  backend = await make();
  serviceDown = false;

  header(`${name}: a second replica boots with an empty accounts directory`);
  const A = replica(backend.url), B = replica(backend.url);
  const work = seat('work'), home2 = seat('home');
  A.store.put(work);
  A.store.put(home2);
  await A.sync.syncOnce();
  let reg = await registry();
  check('A published both accounts', Object.keys(reg.accounts).sort().join() === 'home,work');
  check('A logged each one it published', A.lines.filter((l) => l.includes('published account')).length === 2);
  const bootChange = await B.sync.syncOnce();
  check('B starts with both of A\'s accounts', [...B.store.files.keys()].sort().join() === 'home,work');
  check('B wrote A\'s credentials as they are', B.store.files.get('work').refreshToken === work.refreshToken && B.store.files.get('work').grantedAt === work.grantedAt);
  check('with no pool attached, nothing is reported as a change', bootChange && bootChange.records.length === 0 && bootChange.removed.length === 0);
  check('status counts the two saves', B.sync.status().saved === 2 && B.sync.status().registryAccounts === 2);

  header(`${name}: boot merge, both directions`);
  const side = seat('side');
  B.store.put(side);
  await B.sync.syncOnce();
  await A.sync.syncOnce();
  check('B\'s own account reached the registry and A', A.store.files.has('side'));
  reg = await registry();
  check('the registry holds the merged set', Object.keys(reg.accounts).sort().join() === 'home,side,work');
  const quiet = await A.sync.syncOnce();
  check('a sync with nothing new writes and pushes nothing', quiet.records.length === 0 && A.sync.status().pushed === 2 && A.sync.status().saved === 1);

  header(`${name}: a refresh on one replica reaches the other`);
  advance(MIN);
  const rotated = { ...A.store.files.get('work'), accessToken: 'access-work-2', refreshToken: 'refresh-work-2', expiresAt: Date.now() + 8 * HOUR };
  A.store.put(rotated);
  await A.sync.syncOnce();
  await B.sync.syncOnce();
  check('B holds the rotated refresh token', B.store.files.get('work').refreshToken === 'refresh-work-2');
  // An older record pushed by a replica that missed the rotation is refused.
  const stale = await rawCall('/accounts/work/put', { credentials: work });
  check('the registry refuses an older record', stale.status === 200 && stale.body.stored === false);
  check('and still holds the rotation', (await registry()).accounts.work.refreshToken === 'refresh-work-2');

  header(`${name}: the running pool hears about adds, rotations and removals`);
  const pool = new Map([...B.store.files].map(([k, v]) => [k, { ...v }]));
  const changes = [];
  B.sync.attach((alias) => pool.get(alias), (change) => { changes.push(change); });
  const extra = seat('extra');
  A.store.put(extra);
  await A.sync.syncOnce();
  await B.sync.syncOnce();
  check('an account added on A is handed to B\'s pool', changes.length === 1 && changes[0].records.map((r) => r.alias).join() === 'extra');
  pool.set('extra', { ...extra });
  changes.length = 0;
  await B.sync.syncOnce();
  check('a pool already holding it is not told again', changes.length === 0);

  header(`${name}: a removal here while a sync waits on the service`);
  // An admin removal on B lands while B's sync pushes the file it read
  // before the removal: the pool must not get the account back.
  advance(MIN);
  B.store.put(seat('race'));
  changes.length = 0;
  const hold = holdCall('/accounts/race/put');
  const racing = B.sync.syncOnce();
  await hold.atCall;
  B.store.removeHere('race');
  pool.delete('race');
  hold.open();
  const raced = await racing;
  check('the sync does not hand the removed account to the pool', raced && !raced.records.some((r) => r.alias === 'race') && !changes.some((c) => c.records.some((r) => r.alias === 'race')));
  await B.sync.syncOnce();
  reg = await registry();
  check('the next sync publishes the removal over the pushed record', reg.accounts.race === undefined && typeof reg.removed.race === 'number');
  check('and the pool is not told about it again', !changes.some((c) => c.records.some((r) => r.alias === 'race')));

  header(`${name}: a removal on A reaches B`);
  advance(MIN);
  A.store.removeHere('side');
  await A.sync.syncOnce();
  reg = await registry();
  check('A published the removal', reg.accounts.side === undefined && typeof reg.removed.side === 'number');
  check('status counts it', A.sync.status().removalsPublished === 1);
  await B.sync.syncOnce();
  check('B removed its copy', !B.store.files.has('side'));
  check('and told its pool', changes.some((c) => c.removed.some((r) => r.alias === 'side')));
  check('B said so', B.lines.some((l) => l.includes('removed account "side"')));
  pool.delete('side');
  await A.sync.syncOnce();
  check('A publishes each removal once', A.sync.status().removalsPublished === 1);

  header(`${name}: a replica that was offline does not bring a removed account back`);
  const C = replica(backend.url);
  C.store.put(side); // the file it had before A removed the account
  await C.sync.syncOnce();
  check('C removed its stale copy', !C.store.files.has('side'));
  check('the registry still holds no record for it', (await registry()).accounts.side === undefined);
  const pushBack = await rawCall('/accounts/side/put', { credentials: side });
  check('the registry refuses a push of the removed grant', pushBack.body.stored === false);

  header(`${name}: a login after the removal wins`);
  advance(MIN);
  const relogin = seat('side', { accessToken: 'access-side-new', refreshToken: 'refresh-side-new', grantedAt: Date.now() });
  C.store.put(relogin);
  await C.sync.syncOnce();
  reg = await registry();
  check('the registry stored the new login and dropped the marker', reg.accounts.side?.refreshToken === 'refresh-side-new' && reg.removed.side === undefined);
  changes.length = 0;
  await A.sync.syncOnce();
  await B.sync.syncOnce();
  check('A, which removed it, takes the new login', A.store.files.get('side')?.refreshToken === 'refresh-side-new');
  check('B takes it and hands it to its pool', B.store.files.get('side')?.refreshToken === 'refresh-side-new' && changes.some((c) => c.records.some((r) => r.alias === 'side')));
  pool.set('side', { ...relogin });

  header(`${name}: a removal made on the shared disk by another process`);
  // `dario accounts remove` in the pod: it publishes the marker, then
  // deletes the file the running proxy also reads. This replica never
  // removed anything itself, and its pool still holds the seat.
  advance(MIN);
  check('the command removes the file and publishes the marker', (await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'extra', { store: B.store })) === 'removed' && !B.store.files.has('extra'));
  changes.length = 0;
  await B.sync.syncOnce();
  check('the pool is told to drop the seat', changes.some((c) => c.removed.some((r) => r.alias === 'extra')));
  pool.delete('extra');
  check('a removal publish with no time is refused', (await rawCall('/accounts/extra/remove', {})).status === 400);

  header(`${name}: dario accounts remove against a later login`);
  advance(MIN);
  const D = replica(backend.url);
  D.store.put(seat('cli'));
  // A login on another instance whose clock runs ahead of this one's, or
  // that landed while the removal was on its way.
  await rawCall('/accounts/cli/put', { credentials: seat('cli', { refreshToken: 'refresh-cli-later', grantedAt: Date.now() + MIN }) });
  const refused = await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'cli', { store: D.store });
  check('a removal the registry refuses changes nothing', refused === 'registry-newer' && D.store.files.has('cli') && (await registry()).accounts.cli?.refreshToken === 'refresh-cli-later');
  advance(2 * MIN);
  const again = await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'cli', { store: D.store });
  check('run again after that login, it removes both', again === 'removed' && !D.store.files.has('cli') && (await registry()).accounts.cli === undefined);
  advance(MIN);
  D.store.put(seat('cli', { refreshToken: 'refresh-cli-here', grantedAt: Date.now() }));
  const keptHere = await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'cli', { store: D.store, removedAt: Date.now() - 1000 });
  check('a login here made after the removal keeps its file', keptHere === 'local-newer' && D.store.files.get('cli')?.refreshToken === 'refresh-cli-here');
  advance(MIN);
  // The registry takes the removal, but the file the removal covers cannot
  // be deleted (a read-only accounts directory, say).
  const unwritable = { ...D.store, remove: async () => false };
  const failedHere = await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'cli', { store: unwritable });
  check('a file the removal covers that cannot be deleted is reported, not called removed', failedHere === 'local-failed' && D.store.files.has('cli'));
  serviceDown = true;
  let threw = false;
  try { await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'cli', { store: D.store }); } catch { threw = true; }
  serviceDown = false;
  check('with the service down it throws and keeps the file', threw && D.store.files.has('cli'));

  header(`${name}: the service is down`);
  serviceDown = true;
  advance(MIN);
  A.store.removeHere('home');
  const downResult = await A.sync.syncOnce();
  await A.sync.syncOnce();
  check('the sync fails open', downResult === null && A.store.files.has('work'));
  check('the outage is logged once', A.lines.filter((l) => l.includes('unreachable')).length === 1);
  check('the removal is still pending', A.sync.status().removalsPublished === 1);
  serviceDown = false;
  await A.sync.syncOnce();
  check('back up: said once', A.lines.filter((l) => l.includes('reachable again')).length === 1);
  check('the pending removal went out', A.sync.status().removalsPublished === 2 && (await registry()).accounts.home === undefined);
  await B.sync.syncOnce();
  check('and reached B', !B.store.files.has('home'));

  header(`${name}: a different subscription under the same alias`);
  advance(MIN);
  B.store.put(seat('login', { accountId: 'acct-b', accountEmail: 'b@example.com', grantedAt: Date.now() - HOUR }));
  await B.sync.syncOnce();
  A.store.put(seat('login', { accountId: 'acct-a', accountEmail: 'a@example.com', grantedAt: Date.now() }));
  await A.sync.syncOnce();
  await B.sync.syncOnce();
  check('the newer login wins on B', B.store.files.get('login')?.accountId === 'acct-a');
  check('B says loudly that the alias now holds another account', B.lines.some((l) => l.includes('account "login" here was') && l.includes('give each subscription its own alias')));
  check('and does not print either email whole', !B.lines.some((l) => l.includes('a@example.com') || l.includes('b@example.com')));

  header(`${name}: what the service accepts`);
  check('a record under another alias is refused', (await rawCall('/accounts/work/put', { credentials: { ...work, alias: 'other' } })).status === 400);
  check('a record with no refresh token is refused', (await rawCall('/accounts/work/put', { credentials: { ...work, refreshToken: undefined } })).status === 400);
  const named = await rawCall('/accounts/peek/put', { credentials: seat('peek') });
  check('an alias named like a lock action is an account', named.status === 200 && named.body.stored === true && (await registry()).accounts.peek?.alias === 'peek');

  {
  const seats = async () => (await rawCall('/codex-accounts/list', {})).body;

  header(`${name}: a ChatGPT seat reaches the replica that did not complete its login`);
  const C1 = codexReplica(backend.url), C2 = codexReplica(backend.url);
  const rama = codexSeat('rama');
  C1.store.put(rama);
  await C1.sync.syncOnce();
  check('the seat is published to its own registry', (await seats()).accounts.rama?.refreshToken === rama.refreshToken);
  check('the log calls it a codex account', C1.lines.some((l) => l.includes('shared codex accounts: published codex account "rama"')));
  check('it is not among the Claude accounts', (await registry()).accounts.rama === undefined);
  await C2.sync.syncOnce();
  check('the other replica has it, as it was written', C2.store.files.get('rama')?.refreshToken === rama.refreshToken && C2.store.files.get('rama')?.idToken === rama.idToken);
  check('a record needs none of a Claude seat\'s fields', C2.store.files.get('rama')?.deviceId === undefined);

  header(`${name}: one alias, a Claude account and a ChatGPT seat`);
  const claudeRama = seat('rama');
  await rawCall('/accounts/rama/put', { credentials: claudeRama });
  check('the Claude registry holds its own record', (await registry()).accounts.rama?.refreshToken === claudeRama.refreshToken);
  check('the seat is untouched', (await seats()).accounts.rama?.refreshToken === rama.refreshToken);

  header(`${name}: a refresh on one replica reaches the other`);
  const seatRefreshed = { ...rama, accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: rama.expiresAt + HOUR };
  C2.store.put(seatRefreshed);
  await C2.sync.syncOnce();
  await C1.sync.syncOnce();
  check('the later expiry wins on the same login', C1.store.files.get('rama')?.refreshToken === 'refresh-2');
  check('an older record is refused', (await rawCall('/codex-accounts/rama/put', { credentials: rama })).body.stored === false);

  header(`${name}: a removal reaches every replica, and only that registry`);
  advance(MIN);
  C1.store.removeHere('rama');
  await C1.sync.syncOnce();
  let onService = await seats();
  check('the record goes and a marker stays', onService.accounts.rama === undefined && typeof onService.removed.rama === 'number');
  check('the Claude account of that name is left alone', (await registry()).accounts.rama?.refreshToken === claudeRama.refreshToken);
  check('and takes no marker from it', (await registry()).removed.rama === undefined);
  await C2.sync.syncOnce();
  check('the seat leaves the other replica', !C2.store.files.has('rama'));
  const wasOffline = codexReplica(backend.url);
  wasOffline.store.put(seatRefreshed);
  await wasOffline.sync.syncOnce();
  check('a replica that was wasOffline does not bring it back', !wasOffline.store.files.has('rama') && (await seats()).accounts.rama === undefined);
  const noGrant = codexReplica(backend.url);
  const { grantedAt: _unset, ...beforeGrantTimes } = seatRefreshed;
  noGrant.store.put(beforeGrantTimes);
  await noGrant.sync.syncOnce();
  check('a seat from before grant times counts as older than the removal', !noGrant.store.files.has('rama'));

  header(`${name}: a login after the removal wins`);
  advance(MIN);
  const relogin = codexSeat('rama', { refreshToken: 'refresh-3', grantedAt: Date.now() });
  C2.store.put(relogin);
  await C2.sync.syncOnce();
  onService = await seats();
  check('it is published and clears the marker', onService.accounts.rama?.refreshToken === 'refresh-3' && onService.removed.rama === undefined);
  await C1.sync.syncOnce();
  check('it reaches the replica that removed the seat before', C1.store.files.get('rama')?.refreshToken === 'refresh-3');
  const newerGrant = codexSeat('rama', { refreshToken: 'refresh-4', grantedAt: Date.now() + 1000, expiresAt: Date.now() + HOUR });
  await rawCall('/codex-accounts/rama/put', { credentials: newerGrant });
  await C2.sync.syncOnce();
  check('a newer login beats a later expiry', C2.store.files.get('rama')?.refreshToken === 'refresh-4');

  header(`${name}: a different ChatGPT subscription under the same alias`);
  const idFor = (id) => `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.y`;
  const X = codexReplica(backend.url), Y = codexReplica(backend.url);
  Y.store.put(codexSeat('altman-1', { idToken: idFor('workspace-aaaaaa'), grantedAt: Date.now() - HOUR }));
  await Y.sync.syncOnce();
  X.store.put(codexSeat('altman-1', { idToken: idFor('workspace-bbbbbb'), grantedAt: Date.now() }));
  await X.sync.syncOnce();
  await Y.sync.syncOnce();
  check('the newer login wins', Y.store.files.get('altman-1')?.idToken === idFor('workspace-bbbbbb'));
  check('and the replica says the alias now holds another subscription', Y.lines.some((l) => l.includes('codex account "altman-1" here was ChatGPT account ending aaaaaa and is now ChatGPT account ending bbbbbb')));
  check('without printing either id whole', !Y.lines.some((l) => l.includes('workspace-')));
  const quiet = codexReplica(backend.url);
  quiet.store.put(codexSeat('altman-1', { idToken: idFor('workspace-bbbbbb'), grantedAt: Date.now() - DAY }));
  await quiet.sync.syncOnce();
  check('a newer login of the same subscription says nothing of the kind', !quiet.lines.some((l) => l.includes('here was')));

  header(`${name}: what the ChatGPT registry accepts`);
  check('a record under another alias is refused', (await rawCall('/codex-accounts/rama/put', { credentials: { ...relogin, alias: 'other' } })).status === 400);
  check('a record with no refresh token is refused', (await rawCall('/codex-accounts/rama/put', { credentials: { ...relogin, refreshToken: undefined } })).status === 400);
  await rawCall(`/codex-accounts/${encodeURIComponent('../escape')}/put`, { credentials: codexSeat('../escape') });
  const wary = codexReplica(backend.url);
  await wary.sync.syncOnce();
  check('an alias that is no file name never reaches the disk', !wary.store.files.has('../escape') && wary.store.files.has('rama'));
  }

  await backend.stop();
  backend = null;
}

// ----- the real account files -------------------------------------------
async function fileHelpers() {
  header('accounts.ts: the helpers the sync writes through');
  const { saveAccount, loadAccount, removeAccount, saveSharedAccount, removeSharedAccount, localAccountRemovals } = accounts;
  const base = seat('files-a');
  await saveAccount(base);

  let out = await saveSharedAccount({ ...base, expiresAt: base.expiresAt - HOUR }, { fetchedAt: Date.now() });
  check('an older record is not written', out.saved === false && (await loadAccount('files-a')).expiresAt === base.expiresAt);
  out = await saveSharedAccount({ ...base, refreshToken: 'newer', expiresAt: base.expiresAt + HOUR }, { fetchedAt: Date.now() });
  check('a newer record is written, and says what it replaced', out.saved === true && out.replaced?.expiresAt === base.expiresAt && (await loadAccount('files-a')).refreshToken === 'newer');

  const fetchedAt = Date.now();
  advance(1000);
  const before = Date.now();
  check('removeAccount removes the file', await removeAccount('files-a'));
  const at = localAccountRemovals().get('files-a');
  check('and records when', typeof at === 'number' && at >= before && at <= Date.now());
  out = await saveSharedAccount({ ...base, expiresAt: base.expiresAt + 2 * HOUR }, { fetchedAt });
  check('a registry read from before the removal does not bring it back', out.saved === false && (await loadAccount('files-a')) === null);
  advance(1000);
  out = await saveSharedAccount({ ...base, grantedAt: Date.now() }, { fetchedAt: Date.now(), removedAt: Date.now() - 1000 });
  check('a read after it, carrying a later login, is written', out.saved === true && (await loadAccount('files-a')) !== null);

  const kept = seat('files-b', { grantedAt: Date.now() });
  await saveAccount(kept);
  check('a removal older than the file\'s grant keeps it', (await removeSharedAccount('files-b', Date.now() - MIN)) === false && (await loadAccount('files-b')) !== null);
  advance(1000);
  check('a removal after the grant removes it', (await removeSharedAccount('files-b', Date.now())) === true && (await loadAccount('files-b')) === null);
  check('that removal is not republished as this instance\'s own', !localAccountRemovals().has('files-b'));
  check('an alias that cannot be a file name is refused', (await saveSharedAccount(seat('../escape'), { fetchedAt: Date.now() })).saved === false);

  header('the default store end to end: files here, the Worker as the service');
  backend = workerBackend();
  const lines = [];
  const sync = new AccountSync({ baseUrl: backend.url, token: LOCK_TOKEN, log: (l) => lines.push(l) });
  await saveAccount(seat('files-c'));
  await sync.syncOnce();
  check('a file here is published', (await registry()).accounts['files-c']?.alias === 'files-c');
  advance(1000);
  await removeAccount('files-c');
  await sync.syncOnce();
  const reg = await registry();
  check('removing it publishes the removal', reg.accounts['files-c'] === undefined && typeof reg.removed['files-c'] === 'number');
  await rawCall('/accounts/files-d/put', { credentials: seat('files-d') });
  await sync.syncOnce();
  check('a peer\'s account is written to this instance\'s accounts directory', (await loadAccount('files-d'))?.alias === 'files-d');
  advance(1000);
  const removedD = await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'files-d');
  check('dario accounts remove deletes the file and publishes the marker', removedD === 'removed' && (await loadAccount('files-d')) === null && typeof (await registry()).removed['files-d'] === 'number');
  await saveAccount(seat('files-e', { grantedAt: Date.now() }));
  const removedE = await removeAccountEverywhere(backend.url, LOCK_TOKEN, 'files-e', { removedAt: Date.now() - 1000 });
  check('and keeps a file holding a login made after the removal', removedE === 'local-newer' && (await loadAccount('files-e')) !== null);
  backend = null;
}

// ----- the real ChatGPT seat files ---------------------------------------
async function codexFileHelpers() {
  const { saveCodexAccount, loadCodexAccount, removeCodexAccount, saveSharedCodexAccount, removeSharedCodexAccount, localCodexAccountRemovals } = codex;

  header('codex-accounts.ts: the helpers the sync writes through');
  const base = codexSeat('seat-a');
  await saveCodexAccount(base);
  let out = await saveSharedCodexAccount({ ...base, expiresAt: base.expiresAt - HOUR }, { fetchedAt: Date.now() });
  check('an older record is not written', out.saved === false && (await loadCodexAccount('seat-a')).expiresAt === base.expiresAt);
  out = await saveSharedCodexAccount({ ...base, refreshToken: 'newer', expiresAt: base.expiresAt + HOUR }, { fetchedAt: Date.now() });
  check('a newer record is written, and says what it replaced', out.saved === true && out.replaced?.expiresAt === base.expiresAt && (await loadCodexAccount('seat-a')).refreshToken === 'newer');
  out = await saveSharedCodexAccount({ ...base, grantedAt: base.grantedAt + 1000, expiresAt: base.expiresAt - HOUR, refreshToken: 'relogin' }, { fetchedAt: Date.now() });
  check('a newer login is written over a later expiry', out.saved === true && (await loadCodexAccount('seat-a')).refreshToken === 'relogin');
  check('an alias that is no file name is not written', (await saveSharedCodexAccount({ ...base, alias: '../escape' }, { fetchedAt: Date.now() })).saved === false);

  const fetchedAt = Date.now();
  advance(1000);
  check('removeCodexAccount removes the file', await removeCodexAccount('seat-a'));
  const at = localCodexAccountRemovals().get('seat-a');
  check('and records when', typeof at === 'number' && at > fetchedAt);
  out = await saveSharedCodexAccount({ ...base, expiresAt: base.expiresAt + DAY }, { fetchedAt });
  check('a registry read from before the removal does not bring it back', out.saved === false && (await loadCodexAccount('seat-a')) === null);
  advance(1000);
  out = await saveSharedCodexAccount({ ...base, grantedAt: Date.now() }, { fetchedAt: Date.now() });
  check('a read from after it does', out.saved === true && (await loadCodexAccount('seat-a')) !== null);

  const granted = Date.now();
  await saveCodexAccount(codexSeat('seat-b', { grantedAt: granted }));
  check('a registry removal keeps a login granted after it', (await removeSharedCodexAccount('seat-b', granted - 1000)) === false && (await loadCodexAccount('seat-b')) !== null);
  check('and removes one granted before it', (await removeSharedCodexAccount('seat-b', granted + 1000)) === true && (await loadCodexAccount('seat-b')) === null);
  check('which is not published again as this instance\'s own', !localCodexAccountRemovals().has('seat-b'));

  header('a seat the proxy had given up on');
  codex._resetCodexPresenceCacheForTest();
  await removeCodexAccount('seat-a');
  check('no seat is remembered as none', (await codex.hasAnyCodexAccount()) === false);
  await saveSharedCodexAccount(codexSeat('seat-c', { grantedAt: Date.now() + 1000 }), { fetchedAt: Date.now() + 1000 });
  check('a seat from the registry routes at once', (await codex.hasAnyCodexAccount()) === true);
  const dead = codexSeat('seat-d', { expiresAt: Date.now() - HOUR });
  await saveCodexAccount(dead);
  tokenAnswer = { status: 400, body: { error: 'invalid_grant' } };
  let failed = false;
  try { await codex.getFreshCodexAccount(dead); } catch { failed = true; }
  check('a dead token is remembered', failed && codex.getCodexRefreshFailure('seat-d') !== null);
  await saveSharedCodexAccount({ ...dead, refreshToken: 'from-a-peer', expiresAt: Date.now() + HOUR }, { fetchedAt: Date.now() });
  check('credentials from the registry clear it', codex.getCodexRefreshFailure('seat-d') === null);

  header('a login and a refresh keep the grant time');
  tokenAnswer = { status: 200, body: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, id_token: 'i1' } };
  const before = Date.now();
  const made = await codex.completeAddCodexAccount('seat-e', 'code', 'verifier');
  check('a login stamps it', typeof made.grantedAt === 'number' && made.grantedAt >= before);
  advance(1000);
  tokenAnswer = { status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 7200, id_token: 'i2' } };
  const fresh = await codex.refreshCodexAccount(made);
  check('a refresh keeps it, on the file too', fresh.grantedAt === made.grantedAt && (await loadCodexAccount('seat-e')).grantedAt === made.grantedAt && fresh.refreshToken === 'r2');

  header('isCodexRegistryRecord');
  const ok = codexSeat('good');
  check('a whole record passes', isCodexRegistryRecord('good', ok));
  check('it needs no id token or grant time', isCodexRegistryRecord('good', { alias: 'good', accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  check('a record under another alias does not', !isCodexRegistryRecord('other', ok));
  check('an alias that is no file name does not', !isCodexRegistryRecord('../good', { ...ok, alias: '../good' }));
  check('an empty refresh token does not', !isCodexRegistryRecord('good', { ...ok, refreshToken: '' }));
  check('a non-numeric expiry does not', !isCodexRegistryRecord('good', { ...ok, expiresAt: 'soon' }));

  header('an older lock service');
  const lines = [];
  const older = new AccountSync({ baseUrl: 'http://older-lock.test', token: LOCK_TOKEN, log: (l) => lines.push(l), registry: CODEX_REGISTRY });
  check('a sync reports no registry', (await older.syncOnce()) === null);
  await older.syncOnce();
  check('and says so once', lines.filter((l) => l.includes('unreachable')).length === 1 && lines[0].includes('shared codex accounts:') && lines[0].includes('HTTP 404'));
  check('the seats on this disk stay', (await loadCodexAccount('seat-e')) !== null);
  const claude = new AccountSync({ baseUrl: 'http://older-lock.test', token: LOCK_TOKEN, store: memoryStore(), log: () => {} });
  check('the Claude registry on that service still syncs', (await claude.syncOnce()) !== null);

  header('the default store end to end: seat files here, the Worker as the service');
  backend = workerBackend();
  const seats = async () => (await rawCall('/codex-accounts/list', {})).body;
  const sync = new AccountSync({ baseUrl: backend.url, token: LOCK_TOKEN, log: () => {}, registry: CODEX_REGISTRY });
  await saveCodexAccount(codexSeat('seat-f'));
  await sync.syncOnce();
  check('a file here is published', (await seats()).accounts['seat-f']?.alias === 'seat-f');
  advance(1000);
  await removeCodexAccount('seat-f');
  await sync.syncOnce();
  let held = await seats();
  check('removing it publishes the removal', held.accounts['seat-f'] === undefined && typeof held.removed['seat-f'] === 'number');
  await rawCall('/codex-accounts/seat-g/put', { credentials: codexSeat('seat-g') });
  await sync.syncOnce();
  check('a peer\'s seat is written to this instance\'s directory', (await loadCodexAccount('seat-g'))?.alias === 'seat-g');
  await rawCall('/codex-accounts/seat-g/remove', { removedAt: Date.now() });
  await sync.syncOnce();
  check('and a peer\'s removal deletes it', (await loadCodexAccount('seat-g')) === null);

  header('dario codex remove');
  await saveCodexAccount(codexSeat('seat-h'));
  await sync.syncOnce();
  advance(1000);
  check('it deletes the file and publishes the marker', (await removeCodexAccountEverywhere(backend.url, LOCK_TOKEN, 'seat-h')) === 'removed' && (await loadCodexAccount('seat-h')) === null);
  held = await seats();
  check('so no replica pushes it back', held.accounts['seat-h'] === undefined && typeof held.removed['seat-h'] === 'number');
  await saveCodexAccount(codexSeat('seat-i', { grantedAt: Date.now() }));
  check('it keeps a file holding a login made after the removal', (await removeCodexAccountEverywhere(backend.url, LOCK_TOKEN, 'seat-i', { removedAt: Date.now() - 1000 })) === 'local-newer' && (await loadCodexAccount('seat-i')) !== null);
  await rawCall('/codex-accounts/seat-j/put', { credentials: codexSeat('seat-j', { grantedAt: Date.now() }) });
  check('it changes nothing when the registry holds a later login', (await removeCodexAccountEverywhere(backend.url, LOCK_TOKEN, 'seat-j', { removedAt: Date.now() - 1000 })) === 'registry-newer');
  backend = null;
}

try {
  await scenario('worker', async () => workerBackend());
  await scenario('redis', redisBackend);
  await fileHelpers();
  await codexFileHelpers();
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (backend) await backend.stop();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

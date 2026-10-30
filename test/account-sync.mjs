// Shared account registry (src/account-sync.ts, dario#1733): replicas merge
// their Claude accounts through the refresh-lock service, so a second pod
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

const accounts = await import('../dist/accounts.js');
const { credentialsAreNewer, grantedAfter } = accounts;
const { AccountSync, planAccountSync, removeAccountEverywhere } = await import('../dist/account-sync.js');
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
globalThis.fetch = async (input, init) => {
  const url = String(input);
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

try {
  await scenario('worker', async () => workerBackend());
  await scenario('redis', redisBackend);
  await fileHelpers();
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (backend) await backend.stop();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

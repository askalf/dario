// Startup with the shared account registry on (dario#1733): a replica whose
// only seat is the `login` account, removed from the registry after that
// login, must not serve it. The startup sync deletes accounts/login.json;
// the empty-pool recovery that follows must not restore it from
// credentials.json, or the removed account is served until the next sync
// deletes it again, on every restart.
//
// Drives a real startProxy() in a throwaway home, admin mode off, against
// the Cloudflare Worker's RefreshLock in process. Hermetic: the lock service
// runs in this process, and every other host gets a 404.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

// Account files land in a throwaway home, never the operator's ~/.dario.
const home = mkdtempSync(join(tmpdir(), 'dario-account-sync-startup-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.DARIO_ADMIN;
const LOCK_URL = 'http://lock.test';
const LOCK_TOKEN = 'lock-secret';
process.env.DARIO_REFRESH_LOCK_URL = LOCK_URL;
process.env.DARIO_REFRESH_LOCK_TOKEN = LOCK_TOKEN;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
const grantedAt = Date.now() - DAY;
const removedAt = Date.now() - HOUR;
const dario = join(home, '.dario');
mkdirSync(dario, { recursive: true });
writeFileSync(join(dario, 'credentials.json'), JSON.stringify({
  claudeAiOauth: {
    accessToken: 'access-login', refreshToken: 'refresh-login', expiresAt: Date.now() + 8 * HOUR,
    scopes: ['user:inference', 'user:profile'], grantedAt,
  },
}), { mode: 0o600 });

const { RefreshLock } = await import('../cloudflare/refresh-lock/worker.mjs');
const storage = new Map();
const lock = new RefreshLock({
  storage: {
    get: async (k) => storage.get(k),
    put: async (k, v) => { storage.set(k, structuredClone(v)); },
    delete: async (k) => storage.delete(k),
    list: async ({ prefix }) => new Map([...storage].filter(([k]) => k.startsWith(prefix))),
  },
  blockConcurrencyWhile: (fn) => fn(),
}, { LOCK_TOKEN });

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(LOCK_URL)) return lock.fetch(new Request(url, init));
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};
async function lockCall(path, body) {
  const res = await fetch(`${LOCK_URL}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${LOCK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

// The account was removed on another instance, an hour after this login.
const marked = await lockCall('/accounts/login/remove', { removedAt });
check('the registry takes the removal', marked.removed === true);

const logs = [];
const consoleError = console.error;
console.error = (...args) => { logs.push(args.join(' ')); consoleError(...args); };

const { startProxy } = await import('../dist/proxy.js');
const port = await freePort();
await startProxy({ port, host: '127.0.0.1', noLiveCapture: true, poolSharedAccounts: true, fetchImpl: (u, i) => globalThis.fetch(u, i) });
let listing = null;
for (let i = 0; i < 100; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/accounts`);
    if (res.ok) { listing = await res.json(); break; }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 50));
}

check('the proxy answers /accounts', listing !== null);
check('the removed login is not in the live pool', Array.isArray(listing?.accounts) && !listing.accounts.some((a) => a.alias === 'login'));
check('the pool starts empty', listing?.accounts?.length === 0);
check('its file is not restored', !existsSync(join(dario, 'accounts', 'login.json')));
check('the startup sync read the removal', listing?.sharedAccounts?.registryRemoved === 1);
check('the log says why the login is not served', logs.some((l) => l.includes('not restoring the `login` account')));
const reg = await lockCall('/accounts/list', {});
check('the registry still holds no login record', reg.accounts?.login === undefined);
check('and keeps the removal', reg.removed?.login === removedAt);

console.error = consoleError;
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

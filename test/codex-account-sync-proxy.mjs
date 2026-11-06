// ChatGPT seats and the shared registry through a real startProxy() and the
// real CLI (dario#1733). A replica whose only seat is a peer's has to boot, so
// the first sync runs before the proxy decides whether it needs a Claude login.
// `dario codex remove` has to publish the removal, or a replica's next sync
// pushes the seat back.
//
// Hermetic: a throwaway home, and the Cloudflare Worker's RefreshLock served
// from this process over loopback, so the CLI can reach it too.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Seat files land in a throwaway home, never the operator's ~/.dario.
const home = mkdtempSync(join(tmpdir(), 'dario-codex-sync-proxy-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.DARIO_ADMIN;
const LOCK_TOKEN = 'lock-secret';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}

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

const lockServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const out = await lock.fetch(new Request(`http://lock.test${req.url}`, { method: req.method, headers: req.headers, body: Buffer.concat(chunks) }));
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(await out.text());
  });
});
await new Promise((r) => lockServer.listen(0, '127.0.0.1', r));
const LOCK_URL = `http://127.0.0.1:${lockServer.address().port}`;
process.env.DARIO_REFRESH_LOCK_URL = LOCK_URL;
process.env.DARIO_REFRESH_LOCK_TOKEN = LOCK_TOKEN;

async function lockCall(path, body) {
  const res = await fetch(`${LOCK_URL}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${LOCK_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

const HOUR = 3_600_000;
const seat = (alias) => ({ alias, accessToken: `access-${alias}`, refreshToken: `refresh-${alias}`, expiresAt: Date.now() + 8 * HOUR, grantedAt: Date.now() - HOUR });

// A peer holds the only seat. This home has no Claude login and no seat file.
await lockCall('/codex-accounts/peer-seat/put', { credentials: seat('peer-seat') });

const { startProxy } = await import('../dist/proxy.js');
const port = await freePort();
await startProxy({ port, host: '127.0.0.1', noLiveCapture: true, poolSharedAccounts: true });
let listing = null;
for (let i = 0; i < 100; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/accounts`);
    if (res.ok) { listing = await res.json(); break; }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 50));
}

const seatFile = (alias) => join(home, '.dario', 'codex-accounts', `${alias}.json`);
check('a replica whose only seat is a peer\'s boots with no Claude login', listing !== null);
check('the startup sync wrote the seat', existsSync(seatFile('peer-seat')));
check('as the peer published it', JSON.parse(readFileSync(seatFile('peer-seat'), 'utf8')).refreshToken === 'refresh-peer-seat');
check('/accounts reports the sync', listing?.sharedCodexAccounts?.saved === 1 && listing?.sharedCodexAccounts?.registryAccounts === 1);

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, '..', 'dist', 'cli.js'), ...args], {
      env: { ...process.env, DARIO_POOL_SHARED_ACCOUNTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const missing = await cli('codex', 'remove', 'no-such-seat');
check('dario codex remove says when there is no such seat', missing.code === 1 && missing.out.includes('No Codex account "no-such-seat" found'));
const removed = await cli('codex', 'remove', 'peer-seat');
check('dario codex remove says it went everywhere', removed.code === 0 && removed.out.includes('Codex account "peer-seat" removed, here and from the shared account registry'));
check('the file is gone', !existsSync(seatFile('peer-seat')));
const held = await lockCall('/codex-accounts/list', {});
check('and the registry holds a marker in its place', held.accounts['peer-seat'] === undefined && typeof held.removed['peer-seat'] === 'number');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

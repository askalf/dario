// dario#790 — refreshed OAuth tokens must be *durably* persisted to disk so a
// container recreate after >8h uptime loads a live credential family instead of
// a rotated-away refresh token.
//
// Root cause of the 2026-07-17 fleet outage: the pool refresh loop already
// wrote rotated tokens back to accounts/<alias>.json + credentials.json, but
// via a plain writeFile(tmp)+rename with NO fsync. An abrupt container recreate
// (`docker rm -f` → SIGKILL, the autodeploy path) discarded the page cache
// before the kernel flushed, so a bind-mounted ~/.dario reverted to the last
// durable (mint-time) content. Every recreate after >8h then 401'd until a
// manual re-login.
//
// These tests exercise, with NO real network and NO live model loop:
//   1. durableWriteFile — atomic round-trip, no tmp stragglers, overwrite,
//      foreign-tmp isolation.
//   2. refreshAccountToken (injected fetch) persists the rotated token to disk
//      so a fresh loadAccount() reads the NEW tokens (persist-on-refresh).
//   3. resyncLoginFromCredentialsIfStale overwrites a stale `login` pool
//      snapshot from a fresh credentials.json (the login→pool sync gap).

import { mkdtemp, writeFile, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Temp home + env override must happen BEFORE importing the modules that read
// homedir() at import time.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-durable-persist-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const dariDir = join(tmpHome, '.dario');
const accountsDir = join(dariDir, 'accounts');
const credentialsPath = join(dariDir, 'credentials.json');
await mkdir(accountsDir, { recursive: true });

const { durableWriteFile } = await import('../dist/durable-write.js');
const {
  saveAccount,
  loadAccount,
  removeAccount,
  refreshAccountToken,
  resyncLoginFromCredentialsIfStale,
  MIGRATED_LOGIN_ALIAS,
} = await import('../dist/accounts.js');
const { _clearCredentialsCacheForTest } = await import('../dist/oauth.js');

const NOW = Date.now();
const HOUR = 3_600_000;

async function resetAccounts() {
  try {
    for (const f of await readdir(accountsDir)) {
      await removeAccount(f.replace(/\.json$/, ''));
    }
  } catch { /* dir may not exist yet */ }
  _clearCredentialsCacheForTest();
}

// ----------------------------------------------------------------------
header('durableWriteFile — atomic round-trip + no tmp stragglers');
// ----------------------------------------------------------------------
{
  const target = join(dariDir, 'durable-roundtrip.json');
  await durableWriteFile(target, JSON.stringify({ hello: 'world' }), 0o600);
  check('target file exists', existsSync(target));
  check('content round-trips', JSON.parse(readFileSync(target, 'utf8')).hello === 'world');
  const stragglers = (await readdir(dariDir)).filter(f => f.startsWith('durable-roundtrip.json.tmp'));
  check('no *.tmp stragglers after success', stragglers.length === 0);
}

// ----------------------------------------------------------------------
header('durableWriteFile — overwrites existing target');
// ----------------------------------------------------------------------
{
  const target = join(dariDir, 'durable-overwrite.json');
  writeFileSync(target, JSON.stringify({ v: 'old' }));
  await durableWriteFile(target, JSON.stringify({ v: 'new' }), 0o600);
  check('old content replaced', JSON.parse(readFileSync(target, 'utf8')).v === 'new');
}

// ----------------------------------------------------------------------
header('durableWriteFile — leaves a foreign-pid tmp file alone');
// ----------------------------------------------------------------------
{
  const target = join(dariDir, 'durable-foreign.json');
  const foreignTmp = `${target}.tmp.999999.123`;
  writeFileSync(foreignTmp, '{"partial": true');
  await durableWriteFile(target, JSON.stringify({ done: true }), 0o600);
  check('target written', JSON.parse(readFileSync(target, 'utf8')).done === true);
  check('foreign tmp left untouched', existsSync(foreignTmp) &&
    readFileSync(foreignTmp, 'utf8') === '{"partial": true');
  await rm(foreignTmp, { force: true });
}

// ----------------------------------------------------------------------
header('refreshAccountToken persists the rotated token to disk (persist-on-refresh)');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  // Seed a pool account with the MINT tokens (what a >8h-old container loaded).
  await saveAccount({
    alias: 'login',
    accessToken: 'ak-mint',
    refreshToken: 'rt-mint',
    expiresAt: NOW - HOUR, // already expired
    scopes: ['user:inference'],
    deviceId: 'dev-1',
    accountUuid: 'acct-1',
  });

  // Inject a fetch that mints ROTATED tokens (no real network).
  const originalFetch = globalThis.fetch;
  let seenRefreshToken = null;
  globalThis.fetch = async (_url, init) => {
    const body = String(init?.body ?? '');
    const m = /refresh_token=([^&]+)/.exec(body);
    seenRefreshToken = m ? decodeURIComponent(m[1]) : null;
    return new Response(JSON.stringify({
      access_token: 'ak-rotated',
      refresh_token: 'rt-rotated',
      expires_in: 8 * 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const seed = await loadAccount('login');
    const refreshed = await refreshAccountToken(seed);
    check('refresh used the on-disk (mint) refresh token', seenRefreshToken === 'rt-mint');
    check('returned tokens are rotated', refreshed.accessToken === 'ak-rotated' && refreshed.refreshToken === 'rt-rotated');

    // The crux: a FRESH read from disk must see the rotated tokens — this is
    // what a container recreate does. Pre-fix the disk stayed at the mint token.
    const fromDisk = await loadAccount('login');
    check('disk now holds the ROTATED access token', fromDisk.accessToken === 'ak-rotated');
    check('disk now holds the ROTATED refresh token', fromDisk.refreshToken === 'rt-rotated');
    check('disk expiresAt advanced (~8h out)', fromDisk.expiresAt > NOW + 7 * HOUR);
    check('identity fields preserved across refresh', fromDisk.deviceId === 'dev-1' && fromDisk.accountUuid === 'acct-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ----------------------------------------------------------------------
header('resyncLoginFromCredentialsIfStale — login updates a stale pool snapshot');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  // Stale `login` pool snapshot (rotated-away tokens).
  await saveAccount({
    alias: MIGRATED_LOGIN_ALIAS,
    accessToken: 'ak-stale',
    refreshToken: 'rt-stale',
    expiresAt: NOW - HOUR,
    scopes: ['user:inference'],
    deviceId: 'dev-9',
    accountUuid: 'acct-9',
  });
  // A fresh `login --force-reauth` wrote NEW credentials.json only.
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'ak-fresh',
      refreshToken: 'rt-fresh',
      expiresAt: NOW + 8 * HOUR,
      scopes: ['user:inference'],
    },
  }, null, 2));
  _clearCredentialsCacheForTest();

  const result = await resyncLoginFromCredentialsIfStale();
  check('resync reported "resynced"', result === 'resynced');
  const synced = await loadAccount(MIGRATED_LOGIN_ALIAS);
  check('login snapshot now holds the FRESH access token', synced.accessToken === 'ak-fresh');
  check('login snapshot now holds the FRESH refresh token', synced.refreshToken === 'rt-fresh');
  check('pool identity preserved (deviceId/accountUuid not rotated)', synced.deviceId === 'dev-9' && synced.accountUuid === 'acct-9');
}

// ----------------------------------------------------------------------
await rm(tmpHome, { recursive: true, force: true });
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

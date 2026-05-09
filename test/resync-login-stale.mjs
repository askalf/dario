// dario#235 — pool's back-filled `login` snapshot goes stale on
// credentials.json refresh-token rotation.
//
// Setup: the back-fill (ensureLoginCredentialsInPool) copies credentials.json
// into accounts/login.json on the user's first `dario accounts add`. After
// that, the single-account path keeps refreshing credentials.json
// independently. Each refresh issues new tokens and Anthropic invalidates
// the snapshot's refresh_token. login.json now has tokens that 401 on
// every request and 400 invalid_grant on every refresh.
//
// resyncLoginFromCredentialsIfStale fixes this at proxy startup by
// detecting divergence and overwriting the snapshot with the current
// canonical credentials.json content. These tests cover the contract.

import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
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

// Temp home + env override must happen BEFORE importing accounts.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-resync-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const dariDir = join(tmpHome, '.dario');
const accountsDir = join(dariDir, 'accounts');
const credentialsPath = join(dariDir, 'credentials.json');
await mkdir(dariDir, { recursive: true });

const {
  resyncLoginFromCredentialsIfStale,
  saveAccount,
  loadAccount,
  removeAccount,
  listAccountAliases,
  MIGRATED_LOGIN_ALIAS,
} = await import('../dist/accounts.js');

const { _clearCredentialsCacheForTest } = await import('../dist/oauth.js');

async function resetAccounts() {
  try {
    const entries = await readdir(accountsDir);
    for (const f of entries) {
      await removeAccount(f.replace(/\.json$/, ''));
    }
  } catch { /* dir may not exist yet */ }
  // Invalidate the in-memory credentials cache between tests — the cache
  // TTL is 10s and the tests run in ms, so without this invalidation each
  // scenario sees the previous scenario's cached creds and misses the
  // updated credentials.json content on disk.
  _clearCredentialsCacheForTest();
}

async function writeCredentials(tokens) {
  await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: tokens }, null, 2));
}

async function deleteCredentials() {
  try { await rm(credentialsPath); } catch { /* not there */ }
}

// ----------------------------------------------------------------------
header('returns no-pool when fewer than 2 accounts');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  const result = await resyncLoginFromCredentialsIfStale();
  check('empty accounts/ → no-pool', result === 'no-pool');

  await saveAccount({
    alias: 'login',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3600_000,
    scopes: ['user:inference'],
    deviceId: 'dev', accountUuid: 'uuid',
  });
  const result2 = await resyncLoginFromCredentialsIfStale();
  check('1 account → no-pool', result2 === 'no-pool');
}

// ----------------------------------------------------------------------
header('returns no-login when pool has 2+ but no login alias');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  await saveAccount({
    alias: 'work', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd', accountUuid: 'u',
  });
  await saveAccount({
    alias: 'personal', accessToken: 'at2', refreshToken: 'rt2',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd2', accountUuid: 'u2',
  });
  const result = await resyncLoginFromCredentialsIfStale();
  check('no `login` alias → no-login', result === 'no-login');
}

// ----------------------------------------------------------------------
header('returns no-creds when login.json present but credentials.json missing');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  await deleteCredentials();
  await saveAccount({
    alias: 'login', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd', accountUuid: 'u',
  });
  await saveAccount({
    alias: 'personal', accessToken: 'at2', refreshToken: 'rt2',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd2', accountUuid: 'u2',
  });
  const result = await resyncLoginFromCredentialsIfStale();
  check('no credentials reachable → no-creds (leave login alone)', result === 'no-creds');
  // Confirm we didn't touch login.json
  const after = await loadAccount('login');
  check('login.json unmodified', after.accessToken === 'at' && after.refreshToken === 'rt');
}

// ----------------------------------------------------------------------
header('returns in-sync when tokens match');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  const matchingAccess = 'access-token-shared-AAAA';
  const matchingRefresh = 'refresh-token-shared-BBBB';
  // Far-future expiresAt so the synthetic test creds beat any real keychain
  // entry on the freshest-wins ordering inside loadCredentials.
  const expiresAt = Date.now() + 365 * 24 * 3600_000;

  await writeCredentials({
    accessToken: matchingAccess,
    refreshToken: matchingRefresh,
    expiresAt,
    scopes: ['user:inference'],
  });
  await saveAccount({
    alias: 'login',
    accessToken: matchingAccess,
    refreshToken: matchingRefresh,
    expiresAt,
    scopes: ['user:inference'],
    deviceId: 'preserved-device-id',
    accountUuid: 'preserved-uuid',
  });
  await saveAccount({
    alias: 'personal', accessToken: 'at2', refreshToken: 'rt2',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd2', accountUuid: 'u2',
  });

  const result = await resyncLoginFromCredentialsIfStale();
  check('matching tokens → in-sync', result === 'in-sync');
  const after = await loadAccount('login');
  check('login.json unchanged', after.accessToken === matchingAccess);
}

// ----------------------------------------------------------------------
header('returns resynced + overwrites when tokens differ');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  const staleAccess = 'old-access-CCCC';
  const staleRefresh = 'old-refresh-DDDD';
  const freshAccess = 'new-access-EEEE';
  const freshRefresh = 'new-refresh-FFFF';
  // 1 year ahead — must beat any real keychain entry's expiresAt because
  // loadCredentials picks the freshest across (dario file, CC file, keychain).
  const newExpires = Date.now() + 365 * 24 * 3600_000;

  await writeCredentials({
    accessToken: freshAccess,
    refreshToken: freshRefresh,
    expiresAt: newExpires,
    scopes: ['user:inference', 'org:create_api_key'],
  });
  await saveAccount({
    alias: 'login',
    accessToken: staleAccess,
    refreshToken: staleRefresh,
    expiresAt: Date.now() + 3600_000,
    scopes: ['user:inference'],
    deviceId: 'preserved-device-id',
    accountUuid: 'preserved-uuid',
  });
  await saveAccount({
    alias: 'personal', accessToken: 'at2', refreshToken: 'rt2',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd2', accountUuid: 'u2',
  });

  const result = await resyncLoginFromCredentialsIfStale();
  check('mismatched tokens → resynced', result === 'resynced');

  const after = await loadAccount('login');
  check('accessToken overwritten with fresh value', after.accessToken === freshAccess);
  check('refreshToken overwritten with fresh value', after.refreshToken === freshRefresh);
  check('expiresAt updated', after.expiresAt === newExpires);
  check('scopes updated from credentials.json', after.scopes.length === 2 && after.scopes.includes('org:create_api_key'));
  check('deviceId preserved (pool-internal identity)', after.deviceId === 'preserved-device-id');
  check('accountUuid preserved (pool-internal identity)', after.accountUuid === 'preserved-uuid');
}

// ----------------------------------------------------------------------
header('idempotent — second call after resync returns in-sync');
// ----------------------------------------------------------------------
{
  // State from previous test: login.json now matches credentials.json.
  const result = await resyncLoginFromCredentialsIfStale();
  check('immediately after resync → in-sync', result === 'in-sync');
}

// ----------------------------------------------------------------------
header('only access-token diverges → still resyncs');
// ----------------------------------------------------------------------
{
  await resetAccounts();
  const sharedRefresh = 'shared-refresh-token';
  const oldAccess = 'access-old';
  const newAccess = 'access-new-after-refresh';
  // 1 year ahead so keychain doesn't outrank our synthetic credentials.
  const expiresAt = Date.now() + 365 * 24 * 3600_000;

  await writeCredentials({
    accessToken: newAccess,
    refreshToken: sharedRefresh,
    expiresAt,
    scopes: [],
  });
  await saveAccount({
    alias: 'login',
    accessToken: oldAccess,
    refreshToken: sharedRefresh,
    expiresAt,
    scopes: [],
    deviceId: 'd', accountUuid: 'u',
  });
  await saveAccount({
    alias: 'personal', accessToken: 'at2', refreshToken: 'rt2',
    expiresAt: Date.now() + 3600_000, scopes: [],
    deviceId: 'd2', accountUuid: 'u2',
  });

  const result = await resyncLoginFromCredentialsIfStale();
  check('access-only divergence triggers resync', result === 'resynced');
  const after = await loadAccount('login');
  check('access-token updated', after.accessToken === newAccess);
}

// ----------------------------------------------------------------------
//  Cleanup
// ----------------------------------------------------------------------
await rm(tmpHome, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

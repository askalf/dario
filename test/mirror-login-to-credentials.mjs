// dario#808 — mirror the pool-refreshed `login` token back into the legacy
// credentials.json store.
//
// After #805 stopped the pool→credentials clobber, the two files stayed
// diverged: the pool's refresh loop advances accounts/login.json while nothing
// writes credentials.json, so the legacy file stays frozen at the last
// `dario login`. `dario doctor` reads credentials.json and prints
// 'expired'/'expiring' even when the live pool token is fresh (false alarm),
// and any other reader of credentials.json sees a stale token indefinitely.
//
// mirrorLoginToCredentials(refreshed) writes a strictly-newer `login` token
// back to credentials.json, freshness-guarded so it never clobbers a
// newer-or-equal legacy family (symmetric with #805). These tests cover the
// contract without any network.

import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
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

// Temp home + env override must happen BEFORE importing accounts/oauth.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-mirror-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const dariDir = join(tmpHome, '.dario');
const credentialsPath = join(dariDir, 'credentials.json');
await mkdir(dariDir, { recursive: true });

const { mirrorLoginToCredentials, MIGRATED_LOGIN_ALIAS } = await import('../dist/accounts.js');
const { _clearCredentialsCacheForTest } = await import('../dist/oauth.js');

async function writeCredentials(tokens) {
  await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: tokens }, null, 2));
  _clearCredentialsCacheForTest();
}
async function readCredentials() {
  try { return JSON.parse(await readFile(credentialsPath, 'utf-8')).claudeAiOauth; }
  catch { return null; }
}
async function deleteCredentials() {
  try { await rm(credentialsPath); } catch { /* not there */ }
  _clearCredentialsCacheForTest();
}
function acct(overrides = {}) {
  return {
    alias: MIGRATED_LOGIN_ALIAS,
    accessToken: 'at-fresh',
    refreshToken: 'rt-fresh',
    expiresAt: Date.now() + 3600_000,
    scopes: ['user:inference'],
    deviceId: 'dev', accountUuid: 'uuid',
    ...overrides,
  };
}

// ----------------------------------------------------------------------
header('non-login alias is never mirrored');
// ----------------------------------------------------------------------
{
  await deleteCredentials();
  const result = await mirrorLoginToCredentials(acct({ alias: 'work' }));
  check('alias "work" → skip-not-login', result === 'skip-not-login');
  check('credentials.json not created', (await readCredentials()) === null);
}

// ----------------------------------------------------------------------
header('mirrors a strictly-newer login token into credentials.json');
// ----------------------------------------------------------------------
{
  // Legacy file frozen at the last login (older expiry).
  const oldExpiry = Date.now() + 600_000;
  await writeCredentials({
    accessToken: 'at-stale', refreshToken: 'rt-stale',
    expiresAt: oldExpiry, scopes: ['user:inference'],
  });
  // Pool refreshed the login account — strictly newer expiry.
  const newExpiry = Date.now() + 8 * 3600_000;
  const result = await mirrorLoginToCredentials(acct({
    accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: newExpiry,
    scopes: ['user:inference', 'org:create_api_key'],
  }));
  check('newer pool token → mirrored', result === 'mirrored');
  const after = await readCredentials();
  check('accessToken written', after.accessToken === 'at-new');
  check('refreshToken written', after.refreshToken === 'rt-new');
  check('expiresAt written', after.expiresAt === newExpiry);
  check('scopes written from pool token', after.scopes.length === 2 && after.scopes.includes('org:create_api_key'));
}

// ----------------------------------------------------------------------
header('does NOT clobber a newer-or-equal credentials.json (#805 direction)');
// ----------------------------------------------------------------------
{
  const credExpiry = Date.now() + 8 * 3600_000;
  await writeCredentials({
    accessToken: 'at-cred-fresh', refreshToken: 'rt-cred-fresh',
    expiresAt: credExpiry, scopes: ['user:inference'],
  });
  // Pool token is OLDER — another process (e.g. `dario login --force-reauth`)
  // just wrote a fresher family; must not overwrite it.
  const older = await mirrorLoginToCredentials(acct({
    accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 600_000,
  }));
  check('older pool token → creds-newer', older === 'creds-newer');
  const afterOlder = await readCredentials();
  check('credentials.json untouched (older case)', afterOlder.accessToken === 'at-cred-fresh');

  // Equal expiry is also a no-op — files already agree / same-second race.
  const equal = await mirrorLoginToCredentials(acct({
    accessToken: 'at-equal', refreshToken: 'rt-equal', expiresAt: credExpiry,
  }));
  check('equal-expiry pool token → creds-newer', equal === 'creds-newer');
  const afterEqual = await readCredentials();
  check('credentials.json untouched (equal case)', afterEqual.accessToken === 'at-cred-fresh');
}

// ----------------------------------------------------------------------
header('mirrors when no credentials.json exists yet (missing = expiry 0)');
// ----------------------------------------------------------------------
{
  await deleteCredentials();
  const result = await mirrorLoginToCredentials(acct({
    accessToken: 'at-boot', refreshToken: 'rt-boot', expiresAt: Date.now() + 3600_000,
  }));
  check('no credentials.json → mirrored (creates it)', result === 'mirrored');
  const after = await readCredentials();
  check('credentials.json created with pool token', after && after.accessToken === 'at-boot');
}

// ----------------------------------------------------------------------
//  Cleanup
// ----------------------------------------------------------------------
await rm(tmpHome, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

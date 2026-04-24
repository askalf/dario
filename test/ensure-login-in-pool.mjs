// Tests for ensureLoginCredentialsInPool — the back-fill that promotes a
// user's `dario login` credentials into the pool on their first
// `dario accounts add`. Covers:
//
//   1. No credentials anywhere + empty accounts/ → null (nothing to do)
//   2. Valid credentials.json + empty accounts/ → migrates, writes
//      accounts/<alias>.json with tokens + scopes from the creds file and
//      identity populated from detectClaudeIdentity (or random fallback)
//   3. Idempotency — second call after a successful migration returns null
//      (accounts/ is no longer empty, guard short-circuits)
//   4. Skip when accounts/ already has an entry — even if credentials.json
//      is present and valid, migration doesn't happen
//   5. Invalid alias input (traversal / unsafe chars) returns null without
//      writing anything
//
// Isolation strategy: point HOME + USERPROFILE at a mkdtemp'd directory
// BEFORE dynamically importing the accounts module. Because accounts.ts
// computes `DARIO_DIR = join(homedir(), '.dario')` at module evaluation
// time, the override only takes effect if env is set before import.
// `all.test.mjs` spawns each test as its own subprocess, so this override
// is fully isolated from other test files and from the user's real dir.

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

// Temp home + env override must happen BEFORE importing the module under
// test, because DARIO_DIR is evaluated at import time.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-migrate-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const dariDir = join(tmpHome, '.dario');
const accountsDir = join(dariDir, 'accounts');
const credentialsPath = join(dariDir, 'credentials.json');
await mkdir(dariDir, { recursive: true });

const { ensureLoginCredentialsInPool, listAccountAliases, loadAccount, saveAccount, removeAccount, MIGRATED_LOGIN_ALIAS } =
  await import('../dist/accounts.js');

// Helper — clear accounts/ between tests without nuking the dir itself.
async function resetAccounts() {
  try {
    const entries = await readdir(accountsDir);
    for (const f of entries) {
      const alias = f.replace(/\.json$/, '');
      await removeAccount(alias);
    }
  } catch { /* dir may not exist yet */ }
}

async function writeFakeCreds() {
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-access-token-abc',
      refreshToken: 'test-refresh-token-xyz',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    },
  }, null, 2), { mode: 0o600 });
}

async function clearCreds() {
  try { await rm(credentialsPath); } catch { /* already gone */ }
}

// ======================================================================
//  1. No creds + empty accounts → null
// ======================================================================
header('no creds + empty accounts → returns null, writes nothing');
{
  await resetAccounts();
  await clearCreds();
  const result = await ensureLoginCredentialsInPool();
  check('returns null', result === null);
  const aliases = await listAccountAliases();
  check('accounts/ still empty', aliases.length === 0);
}

// ======================================================================
//  2. Valid creds + empty accounts → migrates to "login"
// ======================================================================
header('valid creds + empty accounts → migrates under reserved alias');
{
  await resetAccounts();
  await writeFakeCreds();
  const result = await ensureLoginCredentialsInPool();
  check('returns the reserved alias', result === MIGRATED_LOGIN_ALIAS);
  check('reserved alias is "login" (documented contract)', MIGRATED_LOGIN_ALIAS === 'login');
  const aliases = await listAccountAliases();
  check('accounts/ now has exactly one entry', aliases.length === 1);
  check('that entry is the reserved alias', aliases[0] === MIGRATED_LOGIN_ALIAS);
  const migrated = await loadAccount(MIGRATED_LOGIN_ALIAS);
  check('access token copied from credentials.json', migrated?.accessToken === 'test-access-token-abc');
  check('refresh token copied from credentials.json', migrated?.refreshToken === 'test-refresh-token-xyz');
  check('scopes copied from credentials.json', Array.isArray(migrated?.scopes) && migrated.scopes.length === 3);
  check('deviceId populated (either from CC or random UUID fallback)', typeof migrated?.deviceId === 'string' && migrated.deviceId.length > 0);
  check('accountUuid populated (either from CC or random UUID fallback)', typeof migrated?.accountUuid === 'string' && migrated.accountUuid.length > 0);
}

// ======================================================================
//  3. Idempotency — second call after successful migration returns null
// ======================================================================
header('second call after migration → returns null (accounts/ no longer empty)');
{
  // Don't reset — state from test 2 still present.
  const result = await ensureLoginCredentialsInPool();
  check('returns null on re-call', result === null);
  const aliases = await listAccountAliases();
  check('accounts/ still has the one migrated entry', aliases.length === 1);
}

// ======================================================================
//  4. Skip when accounts/ already has an entry — even with valid creds
// ======================================================================
header('pre-existing pool entry → migration skipped');
{
  await resetAccounts();
  await writeFakeCreds();
  await saveAccount({
    alias: 'prior-entry',
    accessToken: 'prior-access',
    refreshToken: 'prior-refresh',
    expiresAt: Date.now() + 1_000_000,
    scopes: [],
    deviceId: 'prior-device',
    accountUuid: 'prior-uuid',
  });
  const result = await ensureLoginCredentialsInPool();
  check('returns null', result === null);
  const aliases = await listAccountAliases();
  check('accounts/ unchanged (just the prior entry)', aliases.length === 1 && aliases[0] === 'prior-entry');
  await removeAccount('prior-entry');
}

// ======================================================================
//  5. Invalid alias input → null, no write
// ======================================================================
header('invalid alias input → returns null, writes nothing');
{
  await resetAccounts();
  await writeFakeCreds();
  const result = await ensureLoginCredentialsInPool('../evil-traversal');
  check('returns null for path-traversal alias', result === null);
  const aliases = await listAccountAliases();
  check('accounts/ still empty', aliases.length === 0);
}

// ======================================================================
//  cleanup
// ======================================================================
await rm(tmpHome, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

// Storage-layer tests for the "altman" Codex account pool (dario#1009).
// Isolation strategy identical to ensure-login-in-pool.mjs: HOME/USERPROFILE
// pointed at a mkdtemp'd dir BEFORE importing the module under test, since
// CODEX_ACCOUNTS_DIR is computed at module-evaluation time from homedir().
// No network calls in this file — see codex-oauth.mjs for the OAuth
// primitives and test/manual/codex-refresh-race.mjs for live-account tests.

import { mkdtemp, rm } from 'node:fs/promises';
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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-accounts-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  listCodexAccountAliases,
  loadCodexAccount,
  loadAllCodexAccounts,
  saveCodexAccount,
  removeCodexAccount,
  getCodexAccountsDir,
  codexAccountNeedsRefresh,
} = await import('../dist/codex-accounts.js');

header('empty pool');
{
  check('no aliases yet', (await listCodexAccountAliases()).length === 0);
  check('load of unknown alias returns null', await loadCodexAccount('nope') === null);
}

header('save / load / list round-trip');
{
  const creds = { alias: 'work', accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 };
  await saveCodexAccount(creds);
  check('alias appears in list', (await listCodexAccountAliases()).includes('work'));
  const loaded = await loadCodexAccount('work');
  check('loaded accessToken matches', loaded?.accessToken === 'a1');
  check('loaded refreshToken matches', loaded?.refreshToken === 'r1');
  const all = await loadAllCodexAccounts();
  check('loadAllCodexAccounts returns it', all.some(a => a.alias === 'work'));
  check('storage dir is under ~/.dario, separate from Claude accounts/', getCodexAccountsDir().replace(/\\/g, '/').endsWith('.dario/codex-accounts'));
}

header('remove');
{
  const ok = await removeCodexAccount('work');
  check('remove returns true for existing alias', ok === true);
  check('alias gone from list', !(await listCodexAccountAliases()).includes('work'));
  const okAgain = await removeCodexAccount('work');
  check('remove of already-gone alias returns false, does not throw', okAgain === false);
}

header('alias safety — traversal and unsafe chars rejected');
{
  let threw = false;
  try { await saveCodexAccount({ alias: '../escape', accessToken: 'x', refreshToken: 'y', expiresAt: 0 }); }
  catch { threw = true; }
  check('save with path-traversal alias throws rather than writing outside codex-accounts/', threw);
  check('load with traversal alias returns null (not the escaped file)', await loadCodexAccount('../escape') === null);
}

header('codexAccountNeedsRefresh — 30 min buffer, same as Claude side');
{
  const now = Date.now();
  check('expires in 5 min → needs refresh', codexAccountNeedsRefresh({ expiresAt: now + 5 * 60_000 }));
  check('expires in 2h → does not need refresh yet', !codexAccountNeedsRefresh({ expiresAt: now + 2 * 3600_000 }));
  check('already expired → needs refresh', codexAccountNeedsRefresh({ expiresAt: now - 1000 }));
}

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);

await rm(tmpHome, { recursive: true, force: true });
if (fail > 0) process.exit(1);

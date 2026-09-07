// Accounts tab sources its list from the RUNNING PROXY, not local disk (#641).
//
// The TUI is its own process; in a containerized / admin / login-less-pool
// deployment the accounts live in the proxy's volume, so a local disk read in
// the TUI process comes up empty while the proxy serves several accounts. These
// tests drive refreshAccounts() with a stubbed proxy client and assert it
// reflects the proxy's /accounts view, plus the render branches.

import { AccountsTab, refreshAccounts } from '../dist/tui/tabs/accounts.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const DIM = { cols: 100, rows: 40 };
function ctxWith(getJson) {
  return { client: { getJson }, setState() {}, registerCleanup() {} };
}

header('refreshAccounts — pool view from the proxy (the #641 repro)');
{
  const ctx = ctxWith(async (p) => {
    if (p !== '/accounts') throw new Error('unexpected path ' + p);
    return {
      mode: 'pool',
      accounts: [
        { alias: 'fbk-arch', expiresInMs: 7738134, util5h: 0.12, util7d: 0.04, status: 'ok' },
        { alias: 'rama', expiresInMs: 9504667, util5h: 0, util7d: 0, status: 'ok' },
      ],
    };
  });
  const s = await refreshAccounts(ctx);
  check('source is the live pool', s.source === 'pool');
  check('both accounts surfaced (not "no accounts")', s.accounts.length === 2);
  check('aliases carried through', s.accounts[0].alias === 'fbk-arch' && s.accounts[1].alias === 'rama');
  check('expiresInMs → future expiresAt', s.accounts[0].expiresAt > Date.now());
  check('util fields carried', s.accounts[0].util5h === 0.12 && s.accounts[0].util7d === 0.04);

  const r = AccountsTab.render(s, DIM);
  check('render shows both aliases', r.includes('fbk-arch') && r.includes('rama'));
  check('render shows util columns', r.includes('util5h') && r.includes('12%'));
  check('render does NOT say "No accounts"', !r.includes('No accounts'));
}

header('refreshAccounts — single-account mode');
{
  const ctx = ctxWith(async () => ({ mode: 'single-account', accounts: 0 }));
  const s = await refreshAccounts(ctx);
  check('source single-account', s.source === 'single-account');
  check('no pool rows', s.accounts.length === 0);
  const r = AccountsTab.render(s, DIM);
  check('render explains single-account mode', r.includes('Single-account mode'));
  check('render does not misreport an empty pool', !r.includes('No accounts in the pool'));
}

header('refreshAccounts — proxy unreachable falls back to disk (flagged stale)');
{
  const ctx = ctxWith(async () => { throw new Error('ECONNREFUSED'); });
  const s = await refreshAccounts(ctx);
  check('source disk on unreachable', s.source === 'disk');
  // Disk read of the test env is typically empty; the point is it didn't throw
  // and it flagged the fallback so render can warn.
  const r = AccountsTab.render(s, DIM);
  check('render warns about stale disk view when accounts exist OR shows empty guidance',
    s.accounts.length === 0 ? r.includes('No accounts') || r.includes('Add one') : r.includes('proxy unreachable'));
}

header('refreshAccounts — no ctx (standalone) uses disk without throwing');
{
  const s = await refreshAccounts();
  check('source disk', s.source === 'disk');
  check('returns a valid state', typeof s.loading === 'boolean' && Array.isArray(s.accounts));
}

header('render — a parked seat shows how long it stays parked (#1244)');
{
  const ctx = ctxWith(async () => ({
    mode: 'pool',
    accounts: [
      { alias: 'busy', expiresInMs: 3_600_000, util5h: 1.04, util7d: 0.25, status: 'rejected', resetInMs: 37 * 60_000 },
      { alias: 'spare', expiresInMs: 3_600_000, util5h: 0.05, util7d: 0, status: 'allowed', resetInMs: 4 * 3_600_000 },
      { alias: 'later', expiresInMs: 3_600_000, util5h: 1.0, util7d: 0.5, status: 'rejected', resetInMs: 4 * 3_600_000 + 59 * 60_000 },
    ],
  }));
  const s = await refreshAccounts(ctx);
  check('resetInMs carried through', s.accounts[0].resetInMs === 37 * 60_000);
  const r = AccountsTab.render(s, DIM);
  check('a rejected row carries the countdown', r.includes('rejected 37m'));
  check('hours and minutes past an hour', r.includes('rejected 4h59m'));
  check('an allowed row shows no countdown', /spare[^\n]*allowed/.test(r) && !/allowed \d/.test(r));
  check('utilisation over 100% renders as the ratio it is', r.includes('104%'));
}

console.log(`\ntui-accounts-source: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

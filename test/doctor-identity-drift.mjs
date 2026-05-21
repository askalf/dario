// Unit tests for checkIdentityDrift (src/doctor.ts) — pure-function
// detection of pool-account identity drift vs the live ~/.claude.json
// snapshot. The I/O wrapper that wires this into runChecks is exercised
// by `dario doctor` itself; this file covers the comparison logic in
// isolation so we can assert each branch without touching the real
// filesystem.

import { checkIdentityDrift } from '../dist/doctor.js';

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

// ======================================================================
//  no ~/.claude.json → info row that explains Extra Usage routing
// ======================================================================
header('no ~/.claude.json — info row about Extra Usage billing');
{
  const out = checkIdentityDrift({ live: null, poolAccounts: [] });
  check('returns exactly 1 row', out.length === 1);
  check('status is info', out[0].status === 'info');
  check('label is Identity', out[0].label === 'Identity');
  check('detail mentions ~/.claude.json', out[0].detail.includes('~/.claude.json'));
  check('detail mentions Extra Usage', out[0].detail.includes('Extra Usage'));
}

// Empty live object (both fields blank) is treated the same as null —
// the proxy's loadClaudeIdentity returns { deviceId: '', accountUuid: '' }
// when no .claude.json variant exposes a userID, so the check has to
// fold that case in.
header('empty live identity (both fields blank) — same info row');
{
  const out = checkIdentityDrift({ live: { deviceId: '', accountUuid: '' }, poolAccounts: [] });
  check('returns 1 row', out.length === 1);
  check('status is info', out[0].status === 'info');
  check('detail mentions Extra Usage', out[0].detail.includes('Extra Usage'));
}

// ======================================================================
//  single-account mode (no pool) → info row about live-per-request reads
// ======================================================================
header('single-account mode — info row, no drift detection possible');
{
  const out = checkIdentityDrift({
    live: { deviceId: 'a'.repeat(64), accountUuid: '11111111-2222-3333-4444-555555555555' },
    poolAccounts: [],
  });
  check('returns 1 row', out.length === 1);
  check('status is info (not warn/fail)', out[0].status === 'info');
  check('detail mentions single-account', out[0].detail.includes('single-account'));
  check('detail shows short userID', out[0].detail.includes('aaaaaaaa…'));
  check('detail mentions non-Haiku 401', out[0].detail.includes('non-Haiku'));
}

// ======================================================================
//  pool aligned with live → ok row
// ======================================================================
header('pool aligned with live ~/.claude.json — ok row');
{
  const live = { deviceId: 'd'.repeat(64), accountUuid: '11111111-2222-3333-4444-555555555555' };
  const out = checkIdentityDrift({
    live,
    poolAccounts: [
      { alias: 'work', deviceId: live.deviceId, accountUuid: live.accountUuid },
      { alias: 'home', deviceId: live.deviceId, accountUuid: live.accountUuid },
    ],
  });
  check('returns 1 row', out.length === 1);
  check('status is ok', out[0].status === 'ok');
  check('detail says 2/2 match', out[0].detail.includes('2/2'));
  check('detail mentions pool accounts plural', out[0].detail.includes('accounts'));
  check('detail shows short userID', out[0].detail.includes('dddddddd…'));
}

// ======================================================================
//  one pool account drifted → warn row, names the alias + which field
// ======================================================================
header('one account drifted (accountUuid mismatch) — warn row');
{
  const live = { deviceId: 'd'.repeat(64), accountUuid: '11111111-2222-3333-4444-555555555555' };
  const out = checkIdentityDrift({
    live,
    poolAccounts: [
      { alias: 'work', deviceId: live.deviceId, accountUuid: 'ffffffff-2222-3333-4444-555555555555' },
      { alias: 'home', deviceId: live.deviceId, accountUuid: live.accountUuid },
    ],
  });
  check('returns 1 row', out.length === 1);
  check('status is warn', out[0].status === 'warn');
  check('detail says 1/2 drifted', out[0].detail.includes('1/2'));
  check('detail names the drifted alias', out[0].detail.includes('work'));
  check('detail says accountUuid differs', out[0].detail.includes('accountUuid'));
  check('detail recommends re-add', out[0].detail.includes('dario accounts add'));
  check('detail warns about 401', out[0].detail.includes('401'));
}

header('both fields differ on a single account — surfaces as "both"');
{
  const live = { deviceId: 'd'.repeat(64), accountUuid: '11111111-2222-3333-4444-555555555555' };
  const out = checkIdentityDrift({
    live,
    poolAccounts: [
      { alias: 'work', deviceId: 'e'.repeat(64), accountUuid: 'ffffffff-2222-3333-4444-555555555555' },
    ],
  });
  check('status is warn', out[0].status === 'warn');
  check('detail says "both"', out[0].detail.includes('both'));
}

header('deviceId mismatch only — surfaces as "deviceId"');
{
  const live = { deviceId: 'd'.repeat(64), accountUuid: '11111111-2222-3333-4444-555555555555' };
  const out = checkIdentityDrift({
    live,
    poolAccounts: [
      { alias: 'work', deviceId: 'e'.repeat(64), accountUuid: live.accountUuid },
    ],
  });
  check('status is warn', out[0].status === 'warn');
  check('detail says deviceId differs', out[0].detail.includes('deviceId'));
  check('detail does NOT say "both"', !out[0].detail.includes('both'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

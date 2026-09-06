// Unit tests for src/seat-pin.ts — the pure decision behind x-dario-account.

import { resolveSeatPin, SEAT_PIN_HEADER, SEAT_PIN_TOKEN_HEADER } from '../dist/seat-pin.js';

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

const tok = Buffer.from('admin-secret-token');
const on = { adminEnabled: true, adminTokenBuf: tok };

header('no header → none, regardless of admin state');
{
  check('admin on', resolveSeatPin({}, on).kind === 'none');
  check('admin off', resolveSeatPin({}, { adminEnabled: false, adminTokenBuf: null }).kind === 'none');
}

header('header present, admin API off → disabled (refused, never ignored)');
{
  check('DARIO_ADMIN unset', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login', [SEAT_PIN_TOKEN_HEADER]: 'admin-secret-token' }, { adminEnabled: false, adminTokenBuf: tok }).kind === 'disabled');
  check('admin on but no token configured', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login', [SEAT_PIN_TOKEN_HEADER]: 'x' }, { adminEnabled: true, adminTokenBuf: null }).kind === 'disabled');
}

header('header present, token missing or wrong → unauthorized');
{
  check('no token header', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login' }, on).kind === 'unauthorized');
  check('empty token', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login', [SEAT_PIN_TOKEN_HEADER]: '' }, on).kind === 'unauthorized');
  check('wrong token, same length', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login', [SEAT_PIN_TOKEN_HEADER]: 'admin-secret-tokeN' }, on).kind === 'unauthorized');
  check('wrong token, different length', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login', [SEAT_PIN_TOKEN_HEADER]: 'nope' }, on).kind === 'unauthorized');
  check('the proxy API key is not the admin token', resolveSeatPin({ [SEAT_PIN_HEADER]: 'login', authorization: 'Bearer admin-secret-token' }, on).kind === 'unauthorized');
}

header('authorized → pinned, alias validated');
{
  const p = resolveSeatPin({ [SEAT_PIN_HEADER]: ' spare ', [SEAT_PIN_TOKEN_HEADER]: 'admin-secret-token' }, on);
  check('pinned with trimmed alias', p.kind === 'pinned' && p.alias === 'spare');
  const arr = resolveSeatPin({ [SEAT_PIN_HEADER]: ['login', 'spare'], [SEAT_PIN_TOKEN_HEADER]: ['admin-secret-token'] }, on);
  check('array-valued headers use the first value', arr.kind === 'pinned' && arr.alias === 'login');
  for (const bad of ['', '../login', "x'; DROP TABLE t; --", '.hidden', 'a'.repeat(65)]) {
    const r = resolveSeatPin({ [SEAT_PIN_HEADER]: bad, [SEAT_PIN_TOKEN_HEADER]: 'admin-secret-token' }, on);
    check(`invalid alias ${JSON.stringify(bad).slice(0, 24)} → invalid-alias`, r.kind === 'invalid-alias');
  }
  check('auth is checked before the alias (bad alias + bad token → unauthorized)',
    resolveSeatPin({ [SEAT_PIN_HEADER]: '../x', [SEAT_PIN_TOKEN_HEADER]: 'nope' }, on).kind === 'unauthorized');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// Tests for describeAuthReject + authenticateRequest (dario#97).
//
// describeAuthReject is a pure function over an IncomingMessage.headers-like
// object. It produces operator-facing reject reasons for the 401 path in
// proxy.ts — header names only, never values. We also cover the matrix of
// authenticateRequest outcomes that each reason corresponds to, so a future
// refactor can't drift the two apart.

import { authenticateRequest, describeAuthReject } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const KEY = Buffer.from('dario');

// ─────────────────────────────────────────────────────────────
header('describeAuthReject — header-presence matrix');
{
  check('neither header → "no ... Authorization header"',
    describeAuthReject({}) === 'no x-api-key or Authorization header');

  check('only x-api-key → "x-api-key present but value mismatch"',
    describeAuthReject({ 'x-api-key': 'wrong' }) === 'x-api-key present but value mismatch');

  check('only Authorization → "Authorization present but value mismatch"',
    describeAuthReject({ authorization: 'Bearer wrong' }) === 'Authorization present but value mismatch');

  check('both headers → "both ... neither value matches"',
    describeAuthReject({ 'x-api-key': 'wrong', authorization: 'Bearer also-wrong' }) ===
      'both headers present but neither value matches');

  // Empty-string values are still "present" — node already collapsed them to
  // string type. Operators should see the header counted as present so they
  // notice the client is sending empty auth rather than no auth.
  check('empty x-api-key still counts as present',
    describeAuthReject({ 'x-api-key': '' }) === 'x-api-key present but value mismatch');
}

// ─────────────────────────────────────────────────────────────
header('describeAuthReject — never leaks the provided value');
{
  const suspect = 'sk-ant-oat01-real-token-do-not-leak';
  const reason = describeAuthReject({ 'x-api-key': suspect });
  check('description does not contain the provided key substring',
    !reason.includes(suspect));
  check('description does not contain the "sk-" prefix',
    !reason.includes('sk-'));
}

// ─────────────────────────────────────────────────────────────
header('authenticateRequest — pre-existing matrix still green');
{
  // Null key buffer → auth disabled, every request passes.
  check('null key → always pass (no header)', authenticateRequest({}, null) === true);
  check('null key → always pass (wrong header)',
    authenticateRequest({ 'x-api-key': 'whatever' }, null) === true);

  // Key set → validated against both header paths.
  check('correct x-api-key → pass', authenticateRequest({ 'x-api-key': 'dario' }, KEY) === true);
  check('wrong x-api-key → fail', authenticateRequest({ 'x-api-key': 'nope' }, KEY) === false);

  check('Authorization: Bearer <key> → pass',
    authenticateRequest({ authorization: 'Bearer dario' }, KEY) === true);
  check('Authorization: <key> (no Bearer) → pass',
    authenticateRequest({ authorization: 'dario' }, KEY) === true);
  check('Authorization: Bearer <wrong> → fail',
    authenticateRequest({ authorization: 'Bearer nope' }, KEY) === false);

  check('no header → fail', authenticateRequest({}, KEY) === false);

  // Length-shield: a short provided value must not accidentally match a
  // prefix-equal longer configured key. timingSafeEqual would throw on
  // mismatched lengths; authenticateRequest guards with a length check first.
  check('length mismatch → fail (short provided, long configured)',
    authenticateRequest({ 'x-api-key': 'd' }, KEY) === false);
  check('length mismatch → fail (long provided, short configured)',
    authenticateRequest({ 'x-api-key': 'dariodario' }, KEY) === false);
}

// ─────────────────────────────────────────────────────────────
header('describeAuthReject / authenticateRequest — consistency');
{
  // Any input that makes authenticateRequest return false should also produce
  // a non-empty description. No "success" output from describeAuthReject.
  const cases = [
    {},
    { 'x-api-key': 'wrong' },
    { authorization: 'Bearer wrong' },
    { 'x-api-key': 'wrong', authorization: 'Bearer also-wrong' },
    { 'x-api-key': '' },
  ];
  for (const h of cases) {
    const allowed = authenticateRequest(h, KEY);
    const reason = describeAuthReject(h);
    check(`reject + non-empty reason for ${JSON.stringify(h)}`,
      allowed === false && reason.length > 0);
  }
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

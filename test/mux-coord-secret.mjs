#!/usr/bin/env node
/**
 * test/mux-coord-secret.mjs
 *
 * Auth-gate unit tests for dario's two-lane auth:
 *   lane A: DARIO_API_KEY via x-api-key or Authorization: Bearer
 *   lane B: MUX_COORD_SECRET via X-Mux-Coord-Secret (mux lender mode)
 *
 * Both lanes are optional; with neither configured the proxy allows all
 * (loopback-only default). Exercises `authenticateRequest(headers, apiKeyBuf,
 * mcsBuf)` exported from src/proxy.ts.
 */

import { authenticateRequest } from '../dist/proxy.js';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

function buf(s) { return s == null ? null : Buffer.from(s); }

console.log('\n  mux coord-secret auth\n  ' + '─'.repeat(40));

// No auth configured → open
check('no creds set → allow',
  authenticateRequest({}, null, null) === true);

// DARIO_API_KEY only
{
  const k = buf('dario-api-key-abc123');
  check('api-key lane: x-api-key matches → allow',
    authenticateRequest({ 'x-api-key': 'dario-api-key-abc123' }, k, null) === true);
  check('api-key lane: Bearer Authorization matches → allow',
    authenticateRequest({ 'authorization': 'Bearer dario-api-key-abc123' }, k, null) === true);
  check('api-key lane: wrong key → deny',
    authenticateRequest({ 'x-api-key': 'wrong-key-xxxxxxxxx' }, k, null) === false);
  check('api-key lane: missing header → deny',
    authenticateRequest({}, k, null) === false);
  check('api-key lane: shorter value → deny (length mismatch, no side-channel)',
    authenticateRequest({ 'x-api-key': 'short' }, k, null) === false);
  check('api-key lane: coord-secret header is ignored when MUX_COORD_SECRET unset',
    authenticateRequest({ 'x-mux-coord-secret': 'dario-api-key-abc123' }, k, null) === false);
}

// MUX_COORD_SECRET only
{
  const s = buf('mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  check('coord lane: matching secret → allow',
    authenticateRequest({ 'x-mux-coord-secret': 'mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, null, s) === true);
  check('coord lane: wrong secret → deny',
    authenticateRequest({ 'x-mux-coord-secret': 'mcs_bbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, null, s) === false);
  check('coord lane: missing header → deny',
    authenticateRequest({}, null, s) === false);
  check('coord lane: length mismatch → deny',
    authenticateRequest({ 'x-mux-coord-secret': 'too-short' }, null, s) === false);
  check('coord lane: api-key header is not accepted as coord secret',
    authenticateRequest({ 'x-api-key': 'mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, null, s) === false);
  check('coord lane: Bearer is not accepted as coord secret',
    authenticateRequest({ 'authorization': 'Bearer mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, null, s) === false);
}

// Both set — either lane authenticates
{
  const k = buf('dario-api-key-abc123');
  const s = buf('mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  check('dual: api-key alone authenticates',
    authenticateRequest({ 'x-api-key': 'dario-api-key-abc123' }, k, s) === true);
  check('dual: coord secret alone authenticates',
    authenticateRequest({ 'x-mux-coord-secret': 'mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, k, s) === true);
  check('dual: both present and valid → allow',
    authenticateRequest({
      'x-api-key': 'dario-api-key-abc123',
      'x-mux-coord-secret': 'mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }, k, s) === true);
  check('dual: coord valid + api-key wrong → allow (coord lane wins)',
    authenticateRequest({
      'x-api-key': 'wrong-key-xxxxxxxxx',
      'x-mux-coord-secret': 'mcs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }, k, s) === true);
  check('dual: coord wrong + api-key valid → allow (api-key lane wins)',
    authenticateRequest({
      'x-api-key': 'dario-api-key-abc123',
      'x-mux-coord-secret': 'mcs_bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }, k, s) === true);
  check('dual: both wrong → deny',
    authenticateRequest({
      'x-api-key': 'wrong-key-xxxxxxxxx',
      'x-mux-coord-secret': 'mcs_bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }, k, s) === false);
  check('dual: no headers → deny',
    authenticateRequest({}, k, s) === false);
}

// Header shape edge cases
{
  const s = buf('mcs_xxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  check('coord lane: array-valued header takes first element',
    authenticateRequest({ 'x-mux-coord-secret': ['mcs_xxxxxxxxxxxxxxxxxxxxxxxxxxxx'] }, null, s) === true);
  check('coord lane: empty string → deny',
    authenticateRequest({ 'x-mux-coord-secret': '' }, null, s) === false);
}

console.log('\n' + '─'.repeat(42));
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// Unit tests for `orderHeadersForOutbound` (src/cc-template.ts) — the v3.16
// helper that brings proxy-mode header ordering up to parity with the
// v3.13 shim's `rewriteHeaders`. The helper is a pure function so we can
// exercise it against synthetic inputs without spinning up the proxy.
//
// The deferred v3.13 item was: "Proxy-mode replay of header_order is
// deferred — the same template.header_order field is already loaded into
// the proxy's template replay path and will pick up automatically when
// the proxy's outbound header builder is extended." v3.16 extends it.

import { orderHeadersForOutbound } from '../dist/cc-template.js';

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

function pairKeys(pairs) {
  return pairs.map(([k]) => k.toLowerCase());
}
function pairMap(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) m.set(k.toLowerCase(), v);
  return m;
}

// ======================================================================
//  No header_order → passthrough unchanged
// ======================================================================
// Pre-dario#45 the bundled template had no header_order; calling with
// `undefined` would fall back to baked (also undefined) and return the
// input unchanged. After dario#45 the baked template ships with
// header_order populated — so the fallback path in real usage now
// DOES reorder. The passthrough contract still holds when an explicit
// empty order is passed, which is the hermetic form the test asserts.
header('orderHeadersForOutbound — empty order returns input unchanged');
{
  const h = { 'user-agent': 'claude-cli/2.1.104', 'authorization': 'Bearer xxx' };

  const out2 = orderHeadersForOutbound(h, []);
  check('empty order → same record (reference-equal)', out2 === h);
}

// ======================================================================
//  With header_order → array of pairs in captured order
// ======================================================================
header('orderHeadersForOutbound — captured order is preserved');
{
  const h = {
    'content-type': 'application/json',
    'authorization': 'Bearer xxx',
    'user-agent': 'claude-cli/2.1.104',
    'x-anthropic-billing-header': 'cc_version=2.1.104;',
    'anthropic-beta': 'claude-code-20250219',
  };
  const order = [
    'user-agent',
    'authorization',
    'x-anthropic-billing-header',
    'anthropic-beta',
    'content-type',
  ];

  const out = orderHeadersForOutbound(h, order);
  check('returns an array (not an object)', Array.isArray(out));
  check('all five headers present', out.length === 5);
  check(
    'exact captured sequence',
    JSON.stringify(pairKeys(out)) === JSON.stringify(order),
  );
  const m = pairMap(out);
  check('user-agent value round-trips', m.get('user-agent') === 'claude-cli/2.1.104');
  check('authorization value round-trips', m.get('authorization') === 'Bearer xxx');
  check('anthropic-beta value round-trips', m.get('anthropic-beta') === 'claude-code-20250219');
}

// ======================================================================
//  Case-insensitive matching, case-preserving emission
// ======================================================================
header('orderHeadersForOutbound — case handling');
{
  // Caller supplies mixed-case keys; captured order is lowercase (that's how
  // live-fingerprint.ts stores it). The lowercase key in the captured order
  // should match the mixed-case caller key, and the emission should use the
  // captured-order's case (lowercase).
  const h = {
    'Authorization': 'Bearer xxx',
    'User-Agent': 'claude-cli/2.1.104',
    'Content-Type': 'application/json',
  };
  const order = ['user-agent', 'authorization', 'content-type'];

  const out = orderHeadersForOutbound(h, order);
  check('matched case-insensitively, length=3', out.length === 3);
  check(
    'emitted in captured-order case',
    out[0][0] === 'user-agent' && out[1][0] === 'authorization' && out[2][0] === 'content-type',
  );
  const m = pairMap(out);
  check('values preserved despite case mismatch', m.get('user-agent') === 'claude-cli/2.1.104');
}

// ======================================================================
//  Extras (caller-supplied, not in captured order) are appended at tail
// ======================================================================
header('orderHeadersForOutbound — extras go at the tail, in insertion order');
{
  const h = {
    'authorization': 'Bearer xxx',
    'user-agent': 'claude-cli/2.1.104',
    'x-custom-1': 'alpha',
    'x-custom-2': 'beta',
    'anthropic-beta': 'claude-code-20250219',
  };
  const order = ['user-agent', 'authorization', 'anthropic-beta'];

  const out = orderHeadersForOutbound(h, order);
  check('total length includes extras', out.length === 5);

  const keys = pairKeys(out);
  check('captured order first', keys[0] === 'user-agent' && keys[1] === 'authorization' && keys[2] === 'anthropic-beta');
  check('extras preserved in caller insertion order', keys[3] === 'x-custom-1' && keys[4] === 'x-custom-2');
  check('no duplicates', new Set(keys).size === keys.length);
}

// ======================================================================
//  Missing-from-caller names in captured order are skipped (not invented)
// ======================================================================
header('orderHeadersForOutbound — absent names are skipped, not emitted as undefined');
{
  const h = { 'user-agent': 'claude-cli/2.1.104' };
  const order = ['user-agent', 'x-not-present', 'anthropic-beta'];

  const out = orderHeadersForOutbound(h, order);
  check('only present headers emitted', out.length === 1);
  check('the present header is correct', out[0][0] === 'user-agent' && out[0][1] === 'claude-cli/2.1.104');
}

// ======================================================================
//  Duplicate names in captured order — first wins, duplicate skipped
// ======================================================================
header('orderHeadersForOutbound — duplicate captured names are deduped');
{
  const h = { 'user-agent': 'claude-cli/2.1.104', 'authorization': 'Bearer xxx' };
  const order = ['user-agent', 'authorization', 'user-agent'];

  const out = orderHeadersForOutbound(h, order);
  check('dedup: length=2 even with duplicate in order', out.length === 2);
  check('first occurrence wins (position 0)', out[0][0] === 'user-agent');
  check('no second user-agent anywhere', pairKeys(out).filter(k => k === 'user-agent').length === 1);
}

// ======================================================================
//  Empty caller record
// ======================================================================
header('orderHeadersForOutbound — empty caller record with captured order');
{
  const out = orderHeadersForOutbound({}, ['user-agent', 'authorization']);
  check('nothing to emit → empty array (not the record)', Array.isArray(out) && out.length === 0);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

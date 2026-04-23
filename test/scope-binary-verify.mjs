// Tests for filterScopesByBinaryPresence — the partial scope auto-
// detection added in v3.31.11 as review item #11.
//
// End-to-end scanBinaryForOAuthConfig tests live in oauth-detector.mjs
// and validate against the real installed CC binary; this file covers
// the pure helper with synthetic buffers so the "what if a scope
// disappeared from CC's binary" case is testable without a patched
// binary.

import { filterScopesByBinaryPresence } from '../dist/cc-oauth-detect.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const ALL_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

// ─────────────────────────────────────────────────────────────
header('all scopes present as quoted literals → all returned');
{
  const body = ALL_SCOPES.map((s) => `"${s}"`).join(', ');
  const buf = Buffer.from(body);
  const out = filterScopesByBinaryPresence(buf, ALL_SCOPES);
  check('length 6', out.length === 6);
  check('returned in input order', out.join(' ') === ALL_SCOPES.join(' '));
}

header('subset present → only those returned, order preserved');
{
  // Only 3 of the 6 scope literals exist in this buffer.
  const buf = Buffer.from('random text "user:profile" more "user:inference" even more "user:file_upload"');
  const out = filterScopesByBinaryPresence(buf, ALL_SCOPES);
  check('length 3', out.length === 3);
  check('only expected scopes present', out.join(',') === 'user:profile,user:inference,user:file_upload');
}

header('one scope missing (the dario#71 failure mode, simulated)');
{
  // Simulate CC v2.1.107 where `org:create_api_key` was dropped from
  // CC's active set. Binary still contains 5 literal scopes but not
  // the one Anthropic now rejects.
  const body = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload']
    .map((s) => `"${s}"`).join(', ');
  const buf = Buffer.from(body);
  const out = filterScopesByBinaryPresence(buf, ALL_SCOPES);
  check('filtered down to 5',                 out.length === 5);
  check('org:create_api_key dropped',         !out.includes('org:create_api_key'));
  check('all five user: scopes preserved',    out.every((s) => s.startsWith('user:')));
}

header('no scopes present → empty');
{
  const buf = Buffer.from('no scope literals whatsoever in this fake binary');
  const out = filterScopesByBinaryPresence(buf, ALL_SCOPES);
  check('empty', out.length === 0);
}

header('exact-substring false-positive guarded by surrounding quotes');
{
  // "user:profile" appears as an unquoted substring. Without the
  // quoted-literal check, a naive scan would match. With it, nothing
  // matches because there's no `"user:profile"` sequence.
  const buf = Buffer.from('this contains user:profile as a bare token, no quotes around it');
  const out = filterScopesByBinaryPresence(buf, ALL_SCOPES);
  check('bare substring does NOT match (quote-bound check)', out.length === 0);
}

header('expected list empty → empty result, no throw');
{
  const buf = Buffer.from('"user:profile"');
  const out = filterScopesByBinaryPresence(buf, []);
  check('empty input → empty output', out.length === 0);
}

header('buffer contains single-quoted literals → not matched');
{
  // CC minified source uses DOUBLE quotes for string literals. If a
  // build tool ever output single quotes, our filter would report the
  // scope as missing — that's correct: we've lost our signal and
  // should fall back loudly.
  const buf = Buffer.from("some 'user:profile' and 'user:inference'");
  const out = filterScopesByBinaryPresence(buf, ALL_SCOPES);
  check('single-quoted does NOT match', out.length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// Golden-vector + property tests for the deterministic cch (src/cch.ts, dario#528).
//
// The fixture test/fixtures/cch-cc2.1.177.json is a REAL Claude Code 2.1.177
// /v1/messages body captured by lwsh123k and published in dario#528
// (gist ee4ee290106511d1139f6da129bbe991). Its in-body billing token is
// cch=a82da, so a correct implementation must recompute exactly a82da.
//
// A second independent live capture (this box, cc 2.1.177 build .e2d, a 139 KB
// body -> b6ada) was verified locally and is intentionally NOT committed — it
// carries a real device id. The fixture here is the one that's already public.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xxh64, cchForBody, cchWithSeed, CCH_SEEDS } from '../dist/cch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);

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

// ── xxHash64 primitive: canonical empty-string vector (exercises len<32 path) ──
header('xxh64 — canonical test vector');
check('XXH64("", seed=0) === ef46db3751d8e999',
  xxh64(enc(''), 0n) === 0xef46db3751d8e999n);

// ── full algorithm against the real public 2.1.177 capture ──
header('cchForBody — real Claude Code 2.1.177 capture (dario#528)');
const body = readFileSync(join(__dirname, 'fixtures', 'cch-cc2.1.177.json'), 'utf8');
check('fixture carries the expected billing token cch=a82da', /cch=a82da/.test(body));
check("cchForBody(body, '2.1.177') === 'a82da'", cchForBody(body, '2.1.177') === 'a82da');
check('output is exactly 5 lowercase hex',
  /^[0-9a-f]{5}$/.test(cchForBody(body, '2.1.177') ?? ''));

// ── fail-safe: unknown version -> null (caller keeps random) ──
header('cchForBody — fail-safe behavior');
check("unknown version '2.1.999' -> null", cchForBody(body, '2.1.999') === null);
check('empty version -> null', cchForBody(body, '') === null);
check('body with no cch token -> null',
  cchForBody(JSON.stringify({ model: 'claude-opus-4-8', messages: [] }), '2.1.177') === null);
check('2.1.177 seed is registered', CCH_SEEDS['2.1.177'] === 0x4d659218e32a3268n);

// ── projection invariance: model / max_tokens are EXCLUDED from the hash ──
// This is the property that makes the value survive dario's body rewrites.
header('cchForBody — model & max_tokens do not affect the hash');
{
  const parsed = JSON.parse(body);
  parsed.model = 'claude-sonnet-4-6-some-totally-different-id';
  parsed.max_tokens = 12345;
  parsed.fallbacks = [{ model: 'x' }];
  parsed.fallback_credit_token = 'tok_deadbeef';
  const rewritten = JSON.stringify(parsed);
  check('cch unchanged after rewriting model/max_tokens/fallbacks',
    cchForBody(rewritten, '2.1.177') === 'a82da');
}

// ── token-reset invariance: whatever cch is present, it's zeroed before hashing ──
header('cchForBody — pre-existing cch token value is ignored');
{
  const withZeros = body.replace(/cch=a82da/, 'cch=00000');
  const withOther = body.replace(/cch=a82da/, 'cch=fffff');
  check('cch=00000 in body -> a82da', cchForBody(withZeros, '2.1.177') === 'a82da');
  check('cch=fffff in body -> a82da', cchForBody(withOther, '2.1.177') === 'a82da');
}

// ── cchWithSeed: explicit-seed helper used by scripts/cch-calibrate.mjs ──
header('cchWithSeed — explicit seed (calibration helper)');
check("known 2.1.177 seed reproduces a82da", cchWithSeed(body, 0x4d659218e32a3268n) === 'a82da');
check('the stale 2.1.37 seed (0x6E52…) does NOT', cchWithSeed(body, 0x6e52736ac806831en) !== 'a82da');
check('matches cchForBody for the registered version',
  cchWithSeed(body, CCH_SEEDS['2.1.177']) === cchForBody(body, '2.1.177'));
check('no cch token -> null', cchWithSeed(JSON.stringify({ model: 'x', messages: [] }), 0x4d659218e32a3268n) === null);

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

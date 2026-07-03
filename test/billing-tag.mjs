// Billing-tag shape + cch-gating tests (src/proxy.ts buildBillingTag,
// src/cch.ts hasCchSeed).
//
// Claude Code DROPPED the cch integrity token between 2.1.177 and 2.1.199
// (live capture 2026-07-03, sdk-cli entrypoint — the entrypoint dario claims).
// Real CC 2.1.199 emits `cc_version=2.1.199.<suffix>; cc_entrypoint=sdk-cli;`
// with no `cch=`. dario must match: emit cch ONLY for versions we hold a
// calibrated seed for (so stampCch can write the correct deterministic value),
// and omit it otherwise — a random cch never validates and is a field genuine
// CC no longer carries (a 100%-vs-0% tell).

import { buildBillingTag } from '../dist/proxy.js';
import { hasCchSeed, CCH_SEEDS } from '../dist/cch.js';

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

// ── hasCchSeed: gate keyed on CCH_SEEDS coverage ──
header('hasCchSeed — only calibrated versions report a seed');
check("'2.1.177' has a seed", hasCchSeed('2.1.177') === true);
check("'2.1.199' has NO seed (CC dropped cch)", hasCchSeed('2.1.199') === false);
check("'2.1.198' has NO seed", hasCchSeed('2.1.198') === false);
check("unknown '9.9.9' has NO seed", hasCchSeed('9.9.9') === false);
check('hasCchSeed agrees with CCH_SEEDS membership',
  Object.keys(CCH_SEEDS).every(v => hasCchSeed(v)) && !hasCchSeed('nope'));

// ── buildBillingTag: cch omitted when null, present when supplied ──
header('buildBillingTag — cch token gated by the caller');
{
  const withoutCch = buildBillingTag('2.1.199', 'hi', null);
  const withCch = buildBillingTag('2.1.177', 'hi', 'a82da');

  check('null cch -> no `cch=` token at all', !withoutCch.includes('cch='));
  check('null cch -> block ends at `cc_entrypoint=sdk-cli;`',
    withoutCch.endsWith('; cc_entrypoint=sdk-cli;'));
  check('supplied cch -> `cch=<value>;` appended after entrypoint',
    withCch.endsWith('; cc_entrypoint=sdk-cli; cch=a82da;'));
  check('both keep cc_version first, then cc_entrypoint',
    /^x-anthropic-billing-header: cc_version=[^;]+; cc_entrypoint=sdk-cli;/.test(withoutCch)
    && /^x-anthropic-billing-header: cc_version=[^;]+; cc_entrypoint=sdk-cli;/.test(withCch));
}

// ── golden vector: matches real CC 2.1.199 for the `hi` prompt ──
// Live capture 2026-07-03: `claude --print -p hi` on CC 2.1.199 emitted
//   x-anthropic-billing-header: cc_version=2.1.199.ef3; cc_entrypoint=sdk-cli;
// computeBuildTag('hi', '2.1.199') === 'ef3' (the degenerate empty-chars case),
// so dario's output for this prompt is byte-identical to genuine CC. The value
// of the suffix for OTHER prompts is a separate concern (build-suffix drift);
// this vector pins the SHAPE: cc_version-first, sdk-cli, and no cch.
header('buildBillingTag — golden vector vs real CC 2.1.199 (`hi`)');
check('byte-matches the live 2.1.199 `hi` capture',
  buildBillingTag('2.1.199', 'hi', null)
    === 'x-anthropic-billing-header: cc_version=2.1.199.ef3; cc_entrypoint=sdk-cli;');

// ── composition: the production gating expression ──
// proxy.ts builds cch as `hasCchSeed(v) ? computeCch() : null`. Simulate it
// with a fixed placeholder and assert cch presence tracks seed availability.
header('gating composition — cch presence tracks the seed');
for (const v of ['2.1.177', '2.1.199', '2.1.198', '9.9.9']) {
  const cch = hasCchSeed(v) ? 'xxxxx' : null;
  const tag = buildBillingTag(v, 'hello world', cch);
  const expectCch = hasCchSeed(v);
  check(`${v}: cch ${expectCch ? 'present' : 'absent'} in billing tag`,
    tag.includes('cch=') === expectCch);
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

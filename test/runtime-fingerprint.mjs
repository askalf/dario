// Unit tests for `classifyRuntimeFingerprint` (src/runtime-fingerprint.ts).
// The classifier is pure over three inputs — runningUnderBun, availableBunVersion,
// env — so every combination can be exercised without spawning a process.
//
// v3.23 (direction #3) — proxy mode terminates TLS in dario's process, and
// when dario runs on Node instead of Bun the ClientHello Anthropic sees is
// OpenSSL-shaped rather than CC's Bun/BoringSSL shape. This classifier is
// what doctor and the proxy startup banner call to decide whether to warn.

import {
  classifyRuntimeFingerprint,
  bunBootstrap,
  bunVersionMeetsJa3Floor,
  JA3_VERIFIED_BUN_FLOOR,
} from '../dist/runtime-fingerprint.js';

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
//  runningUnderBun === true, version ≥ JA3 floor → bun-match, no hint
// ======================================================================
header('classifyRuntimeFingerprint — running under recent Bun → bun-match');
{
  const out = classifyRuntimeFingerprint(true, '1.4.0', {});
  check('status === "bun-match"', out.status === 'bun-match');
  check('runtime === "bun"', out.runtime === 'bun');
  check('runtimeVersion captured', out.runtimeVersion === '1.4.0');
  check('no hint (nothing to fix)', out.hint === undefined);
  check('detail mentions Bun', out.detail.includes('Bun'));
  check('detail mentions the version', out.detail.includes('1.4.0'));
}

// ======================================================================
//  Under Bun BELOW the JA3-verified floor → bun-ja3-unverified (warn)
// ======================================================================
header('classifyRuntimeFingerprint — old Bun below JA3 floor → bun-ja3-unverified');
{
  // #813: dario auto-relaunches into whatever Bun is on PATH. Bun 1.0.9's
  // BoringSSL emits a divergent ClientHello (2ae7…) vs CC's e97f…, so being
  // "under Bun" must not report a green match at an old version.
  const out = classifyRuntimeFingerprint(true, '1.0.9', {});
  check('status === "bun-ja3-unverified"', out.status === 'bun-ja3-unverified');
  check('runtime === "bun"', out.runtime === 'bun');
  check('runtimeVersion captured', out.runtimeVersion === '1.0.9');
  check('hint present (actionable upgrade)', typeof out.hint === 'string' && out.hint.length > 0);
  check('hint points at bun.sh', out.hint.includes('bun.sh'));
  check('detail names the known-good floor', out.detail.includes(JA3_VERIFIED_BUN_FLOOR));
}

// ======================================================================
//  The JA3 floor version itself → bun-match (boundary is inclusive)
// ======================================================================
header('classifyRuntimeFingerprint — Bun at the JA3 floor → bun-match');
{
  const out = classifyRuntimeFingerprint(true, JA3_VERIFIED_BUN_FLOOR, {});
  check('status === "bun-match" at the floor', out.status === 'bun-match');
  check('no hint at the floor', out.hint === undefined);
}

// ======================================================================
//  Under Bun without a version string → tolerated as "unknown"
// ======================================================================
header('classifyRuntimeFingerprint — Bun version unknown still classifies as match');
{
  // Defensive: if globalThis.Bun is present but .version isn't readable
  // for any reason, the detector passes `undefined` through. With no version
  // to check against the JA3 floor there's nothing to warn on, so the
  // classifier falls back to a best-effort bun-match (a KNOWN old version
  // is what gets flagged bun-ja3-unverified — see #813 — not an absent one).
  const out = classifyRuntimeFingerprint(true, undefined, {});
  check('status === "bun-match"', out.status === 'bun-match');
  check('runtimeVersion === "unknown"', out.runtimeVersion === 'unknown');
  check('no hint', out.hint === undefined);
}

// ======================================================================
//  Not under Bun + Bun available on PATH → bypassed
// ======================================================================
header('classifyRuntimeFingerprint — Node with Bun on PATH → bun-bypassed');
{
  const out = classifyRuntimeFingerprint(false, '1.1.30', {}, 'v20.11.1');
  check('status === "bun-bypassed"', out.status === 'bun-bypassed');
  check('runtime === "node"', out.runtime === 'node');
  check('runtimeVersion captured from Node', out.runtimeVersion === 'v20.11.1');
  check('availableBunVersion recorded', out.availableBunVersion === '1.1.30');
  check('bypassReason === "unknown" (no DARIO_NO_BUN)', out.bypassReason === 'unknown');
  check('hint present (actionable)', typeof out.hint === 'string' && out.hint.length > 0);
  check('detail mentions both versions', out.detail.includes('v20.11.1') && out.detail.includes('1.1.30'));
}

// ======================================================================
//  DARIO_NO_BUN set → bypassReason recorded as the env var
// ======================================================================
header('classifyRuntimeFingerprint — DARIO_NO_BUN is reported as the bypass reason');
{
  const out = classifyRuntimeFingerprint(false, '1.1.30', { DARIO_NO_BUN: '1' });
  check('status === "bun-bypassed"', out.status === 'bun-bypassed');
  check('bypassReason === "DARIO_NO_BUN"', out.bypassReason === 'DARIO_NO_BUN');
  check('hint mentions DARIO_NO_BUN', out.hint !== undefined && out.hint.includes('DARIO_NO_BUN'));
}

// ======================================================================
//  Not under Bun + Bun absent → node-only
// ======================================================================
header('classifyRuntimeFingerprint — Node without Bun on PATH → node-only');
{
  const out = classifyRuntimeFingerprint(false, undefined, {}, 'v20.11.1');
  check('status === "node-only"', out.status === 'node-only');
  check('runtime === "node"', out.runtime === 'node');
  check('availableBunVersion is undefined', out.availableBunVersion === undefined);
  check('bypassReason undefined (nothing to bypass)', out.bypassReason === undefined);
  check('hint present', typeof out.hint === 'string' && out.hint.length > 0);
  check('hint mentions bun.sh install URL', out.hint.includes('bun.sh'));
  check(
    'detail calls out JA3 divergence',
    out.detail.includes('diverges') || out.detail.includes('diverge'),
  );
}

// ======================================================================
//  Env is NOT mutated (classifier must be pure over its input)
// ======================================================================
header('classifyRuntimeFingerprint — does not mutate the env argument');
{
  const env = { DARIO_NO_BUN: '1', FOO: 'bar' };
  const before = JSON.stringify(env);
  classifyRuntimeFingerprint(false, '1.1.30', env);
  const after = JSON.stringify(env);
  check('env unchanged after classify call', before === after);
}

// ======================================================================
//  DARIO_NO_BUN set + no Bun installed → still node-only (not bypassed)
// ======================================================================
header('classifyRuntimeFingerprint — DARIO_NO_BUN with no Bun → still node-only');
{
  // When DARIO_NO_BUN is set but Bun isn't even installed, the user didn't
  // bypass anything — there's nothing to bypass. Status stays node-only,
  // with the install-Bun hint, not the unset-DARIO_NO_BUN hint.
  const out = classifyRuntimeFingerprint(false, undefined, { DARIO_NO_BUN: '1' });
  check('status === "node-only"', out.status === 'node-only');
  check('bypassReason undefined', out.bypassReason === undefined);
  check('hint points at Bun install, not the env var', out.hint.includes('bun.sh'));
}

// ======================================================================
//  bunBootstrap — runner string is the canonical upstream installer
// ======================================================================
header('bunBootstrap — installer command shape');
{
  // The installer is a side-effecting child process; we don't actually
  // run it through (would mutate the test machine). Instead we force a
  // fail-fast by clearing PATH so the spawn can't resolve a shell, and
  // verify the runner string is the canonical upstream URL regardless
  // of exit code.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  const result = await bunBootstrap();
  process.env.PATH = savedPath;
  check('returns { exitCode, runner }', typeof result.exitCode === 'number' && typeof result.runner === 'string');
  check('runner targets the canonical bun.sh URL', result.runner.includes('bun.sh'));
  check(
    'runner is platform-correct',
    process.platform === 'win32'
      ? result.runner.includes('powershell') && result.runner.includes('install.ps1')
      : result.runner.includes('curl') && result.runner.includes('install'),
  );
}

// ======================================================================
//  bunVersionMeetsJa3Floor — numeric-tuple compare, canary-suffix tolerant
// ======================================================================
header('bunVersionMeetsJa3Floor — version comparisons');
{
  check('floor meets itself (≥ is inclusive)', bunVersionMeetsJa3Floor(JA3_VERIFIED_BUN_FLOOR) === true);
  check('1.4.0 ≥ floor', bunVersionMeetsJa3Floor('1.4.0') === true);
  check('1.3.14 ≥ floor (exact)', bunVersionMeetsJa3Floor('1.3.14') === true);
  check('1.3.13 < floor', bunVersionMeetsJa3Floor('1.3.13') === false);
  check('1.0.9 < floor (measured-divergent)', bunVersionMeetsJa3Floor('1.0.9') === false);
  check('0.8.1 < floor', bunVersionMeetsJa3Floor('0.8.1') === false);
  check('numeric compare, not lexical (1.10.0 ≥ 1.3.14)', bunVersionMeetsJa3Floor('1.10.0') === true);
  check('canary suffix compares as base triple (1.4.0-canary.9 ≥ floor)', bunVersionMeetsJa3Floor('1.4.0-canary.9') === true);
  check('2.0.0 ≥ floor', bunVersionMeetsJa3Floor('2.0.0') === true);
  check('unparseable version → undefined', bunVersionMeetsJa3Floor('nonsense') === undefined);
  check('explicit floor arg honored', bunVersionMeetsJa3Floor('1.2.0', '1.1.0') === true);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

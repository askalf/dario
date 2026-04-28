// Unit tests for `classifyRuntimeFingerprint` (src/runtime-fingerprint.ts).
// The classifier is pure over three inputs — runningUnderBun, availableBunVersion,
// env — so every combination can be exercised without spawning a process.
//
// v3.23 (direction #3) — proxy mode terminates TLS in dario's process, and
// when dario runs on Node instead of Bun the ClientHello Anthropic sees is
// OpenSSL-shaped rather than CC's Bun/BoringSSL shape. This classifier is
// what doctor and the proxy startup banner call to decide whether to warn.

import { classifyRuntimeFingerprint, bunBootstrap } from '../dist/runtime-fingerprint.js';

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
//  runningUnderBun === true → bun-match, no hint, no warning
// ======================================================================
header('classifyRuntimeFingerprint — running under Bun → bun-match');
{
  const out = classifyRuntimeFingerprint(true, '1.1.30', {});
  check('status === "bun-match"', out.status === 'bun-match');
  check('runtime === "bun"', out.runtime === 'bun');
  check('runtimeVersion captured', out.runtimeVersion === '1.1.30');
  check('no hint (nothing to fix)', out.hint === undefined);
  check('detail mentions Bun', out.detail.includes('Bun'));
  check('detail mentions the version', out.detail.includes('1.1.30'));
}

// ======================================================================
//  Under Bun without a version string → tolerated as "unknown"
// ======================================================================
header('classifyRuntimeFingerprint — Bun version unknown still classifies as match');
{
  // Defensive: if globalThis.Bun is present but .version isn't readable
  // for any reason, the detector passes `undefined` through. The classifier
  // should still return bun-match — the runtime identification is what
  // matters for TLS, not the version string.
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
  check('hint mentions shim as alternative', out.hint.includes('shim'));
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
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

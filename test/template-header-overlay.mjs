// Unit tests for `overlayTemplateHeaderValues` (src/cc-template.ts) — the
// outbound header_values overlay, and the keys it must refuse to replay.
//
// dario#854. The proxy computes `x-stainless-os` / `x-stainless-arch` correctly
// for the running process (OS_NAME, arch), then overlays the template's captured
// header_values on top. Those two keys describe the machine that ran the
// CAPTURE, so the overlay clobbered correct runtime values with bake-host ones:
// the bundled template had been baked on Windows for several releases
// (#820/#828/#840/#849/#851), so the Linux Hetzner box announced
// `x-stainless-os: Windows` on every upstream call.
//
// It also produced a rebake loop. cc-drift-template-watch captures live on the
// Linux runner every 30 min and diffs against the bundle, so a Windows-baked
// bundle read as permanent drift — auto-rebaking to Linux (#852), which the next
// Windows-side bake (#854) would flip straight back.
//
// Fixed on both sides: extractStaticHeaderValues no longer STORES these (new
// captures are clean — see test/live-fingerprint.mjs), and this overlay refuses
// to REPLAY them, which is what makes already-baked templates and warm caches
// self-heal without waiting for a re-bake. That self-healing path is the half
// this file covers.
//
// Pure function, so no proxy needed — same rationale as proxy-header-order.mjs.

import { overlayTemplateHeaderValues } from '../dist/cc-template.js';

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

// What the proxy builds before the overlay, on a Linux host.
function runtimeHeaders() {
  return {
    'accept': 'application/json',
    'Content-Type': 'application/json',
    'user-agent': 'claude-cli/2.1.220 (external, cli)',
    'x-app': 'cli',
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-package-version': '0.81.0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v24.3.0',
  };
}

// A template baked on Windows — the exact shape shipped by #851 and re-introduced
// by #854. 30 tools incl. PowerShell, and these header values.
const WINDOWS_BAKED = {
  'user-agent': 'claude-cli/2.1.220 (external, sdk-cli)',
  'x-app': 'cli',
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Windows',
  'x-stainless-package-version': '0.81.0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
};

header('overlayTemplateHeaderValues — host-specific keys are never replayed');
{
  const h = overlayTemplateHeaderValues(runtimeHeaders(), WINDOWS_BAKED);
  check('x-stainless-os keeps the RUNTIME value, not the Windows bake',
    h['x-stainless-os'] === 'Linux');
  check('x-stainless-arch keeps the RUNTIME value', h['x-stainless-arch'] === 'x64');
  // The whole point of the overlay: a CC release that nudges a real wire value
  // must still be picked up. Only the host-specific keys are pinned.
  check('user-agent IS overlaid from the template (CC-determined)',
    h['user-agent'] === 'claude-cli/2.1.220 (external, sdk-cli)');
  check('x-stainless-lang IS overlaid', h['x-stainless-lang'] === 'js');
  check('x-stainless-package-version IS overlaid', h['x-stainless-package-version'] === '0.81.0');
}

header('overlayTemplateHeaderValues — an arm64 mac is not told it is x64 Linux');
{
  const mac = { ...runtimeHeaders(), 'x-stainless-os': 'MacOS', 'x-stainless-arch': 'arm64' };
  const linuxBaked = { ...WINDOWS_BAKED, 'x-stainless-os': 'Linux', 'x-stainless-arch': 'x64' };
  const h = overlayTemplateHeaderValues(mac, linuxBaked);
  check('mac keeps MacOS against a Linux-baked bundle', h['x-stainless-os'] === 'MacOS');
  check('mac keeps arm64 against an x64-baked bundle', h['x-stainless-arch'] === 'arm64');
}

header('overlayTemplateHeaderValues — x-api-key stays excluded (dario#42 regression)');
{
  const h = overlayTemplateHeaderValues(runtimeHeaders(), {
    ...WINDOWS_BAKED,
    'x-api-key': 'sk-dario-fingerprint-capture',
  });
  check('x-api-key is not replayed', !('x-api-key' in h));
  check('case-insensitive: X-API-Key is not replayed either',
    !('X-API-Key' in overlayTemplateHeaderValues(runtimeHeaders(), { 'X-API-Key': 'sk-x' })));
  check('case-insensitive: X-Stainless-OS is not replayed either',
    overlayTemplateHeaderValues(runtimeHeaders(), { 'X-Stainless-OS': 'Windows' })['x-stainless-os'] === 'Linux');
}

header('overlayTemplateHeaderValues — degenerate inputs');
{
  const base = runtimeHeaders();
  check('undefined header_values returns the record unchanged (bundled-only install)',
    overlayTemplateHeaderValues(base, undefined) === base);
  check('empty header_values leaves the runtime values intact',
    overlayTemplateHeaderValues(runtimeHeaders(), {})['x-stainless-os'] === 'Linux');
  check('a template key the runtime never set is still added',
    overlayTemplateHeaderValues(runtimeHeaders(), { 'x-new-cc-header': 'v1' })['x-new-cc-header'] === 'v1');
}

console.log(`\n  template-header-overlay: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

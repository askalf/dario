// Unit tests for the CC version compat matrix (v3.17):
//   - compareVersions: dotted-numeric comparator with prerelease suffix
//   - checkCCCompat: below-min / ok / untested-above / unknown branches
//
// Both are pure functions. `checkCCCompat` accepts an injected installed
// version so tests don't depend on having `claude` on PATH.

import {
  SUPPORTED_CC_RANGE,
  compareVersions,
  checkCCCompat,
} from '../dist/live-fingerprint.js';

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
//  compareVersions — numeric prefix
// ======================================================================
header('compareVersions — dotted-numeric prefix');
{
  check('1.0.0 < 2.0.0', compareVersions('1.0.0', '2.0.0') < 0);
  check('2.0.0 > 1.9.99', compareVersions('2.0.0', '1.9.99') > 0);
  check('2.1.104 == 2.1.104', compareVersions('2.1.104', '2.1.104') === 0);
  check('2.1.104 < 2.1.105', compareVersions('2.1.104', '2.1.105') < 0);
  check('2.1.104 < 2.2.0', compareVersions('2.1.104', '2.2.0') < 0);
  check('3.0.0 > 2.99.99', compareVersions('3.0.0', '2.99.99') > 0);
  // Different length — missing component treated as 0
  check('2.1 == 2.1.0', compareVersions('2.1', '2.1.0') === 0);
  check('2.1.1 > 2.1', compareVersions('2.1.1', '2.1') > 0);
}

// ======================================================================
//  compareVersions — suffix / prerelease handling
// ======================================================================
header('compareVersions — prerelease suffix tiebreaker');
{
  // Release beats prerelease at the same numeric version.
  check('2.1.104 > 2.1.104-beta', compareVersions('2.1.104', '2.1.104-beta') > 0);
  check('2.1.104-beta < 2.1.104', compareVersions('2.1.104-beta', '2.1.104') < 0);
  // Lex compare between two suffixes at the same numeric version.
  check('2.1.104-alpha < 2.1.104-beta', compareVersions('2.1.104-alpha', '2.1.104-beta') < 0);
  check('2.1.104-beta == 2.1.104-beta', compareVersions('2.1.104-beta', '2.1.104-beta') === 0);
  // Numeric prefix still dominates over suffix.
  check('2.2.0-alpha > 2.1.999', compareVersions('2.2.0-alpha', '2.1.999') > 0);
}

// ======================================================================
//  checkCCCompat — branches
// ======================================================================
header('checkCCCompat — unknown when probe returned null');
{
  const r = checkCCCompat(null);
  check('status = unknown', r.status === 'unknown');
  check('installedVersion propagates as null', r.installedVersion === null);
  check('range echoed', r.range.min === SUPPORTED_CC_RANGE.min && r.range.maxTested === SUPPORTED_CC_RANGE.maxTested);
  check('message mentions "unchecked"', r.message.toLowerCase().includes('unchecked'));
}

header('checkCCCompat — below-min');
{
  const r = checkCCCompat('0.9.0');
  check('status = below-min', r.status === 'below-min');
  check('message names installed version', r.message.includes('0.9.0'));
  check('message names the floor', r.message.includes(SUPPORTED_CC_RANGE.min));
  check('message hints at upgrade', r.message.toLowerCase().includes('upgrade'));
}

header('checkCCCompat — ok (inside the tested range)');
{
  const r = checkCCCompat(SUPPORTED_CC_RANGE.maxTested);
  check('status = ok at maxTested', r.status === 'ok');
  check('installed echoed', r.installedVersion === SUPPORTED_CC_RANGE.maxTested);

  const rMin = checkCCCompat(SUPPORTED_CC_RANGE.min);
  check('status = ok at min boundary', rMin.status === 'ok');
}

header('checkCCCompat — untested-above');
{
  // Bump a major above maxTested to guarantee "above" regardless of what
  // the current maxTested constant is.
  const future = '99.0.0';
  const r = checkCCCompat(future);
  check('status = untested-above', r.status === 'untested-above');
  check('message names installed version', r.message.includes(future));
  check('message names maxTested', r.message.includes(SUPPORTED_CC_RANGE.maxTested));
  check('message softens ("usually fine")', r.message.toLowerCase().includes('usually fine'));
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

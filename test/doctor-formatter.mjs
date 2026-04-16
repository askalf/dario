// Unit tests for the pure parts of `dario doctor` (src/doctor.ts):
//   - formatChecks: column alignment, status prefixes
//   - exitCodeFor: exit code derivation from check statuses
//
// Integration coverage (runChecks() against a real machine) is handled
// by just running `dario doctor` once after build — there's no point
// unit-testing execFileSync probes against fixtures when the whole
// point is to reflect the current host.

import { formatChecks, exitCodeFor } from '../dist/doctor.js';

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
//  formatChecks — prefix + column alignment
// ======================================================================
header('formatChecks — one check of each status');
{
  const out = formatChecks([
    { status: 'ok', label: 'Node', detail: 'v20.10.0' },
    { status: 'warn', label: 'CC binary', detail: 'v99.0.0 newer than tested' },
    { status: 'fail', label: 'OAuth', detail: 'not authenticated' },
    { status: 'info', label: 'dario', detail: 'v3.17.0' },
  ]);
  check('contains [ OK ] prefix', out.includes('[ OK ]'));
  check('contains [WARN] prefix', out.includes('[WARN]'));
  check('contains [FAIL] prefix', out.includes('[FAIL]'));
  check('contains [INFO] prefix', out.includes('[INFO]'));
  check('includes Node detail', out.includes('v20.10.0'));
  check('includes OAuth detail', out.includes('not authenticated'));

  // Column alignment — label column is padded to the widest label
  // ("CC binary" = 9 chars). Extract each row and verify the label
  // segment is 9 chars wide across all rows.
  const lines = out.split('\n');
  check('4 rows rendered', lines.length === 4);
  const labelField = (line) => {
    // Format: "  [XXXX]  <paddedLabel>  <detail>".
    // The padded label itself contains trailing spaces, so a naive
    // indexOf('  ') would land inside the padding. Anchor on the first
    // non-space char of the detail to find the real boundary.
    const after = line.slice(10); // strip "  [XXXX]  "
    const m = /^(.*?)  (\S.*)$/.exec(after);
    return m ? m[1] : null;
  };
  const fields = lines.map(labelField);
  check('every row had a parseable label field', fields.every((f) => f !== null));
  const widths = new Set(fields.map((f) => f.length));
  check('all label fields have the same padded width', widths.size === 1);
  check('padded width = widest label (9)', [...widths][0] === 9);
}

header('formatChecks — empty list');
{
  const out = formatChecks([]);
  check('empty input returns empty string', out === '');
}

// ======================================================================
//  exitCodeFor — 0 unless any FAIL
// ======================================================================
header('exitCodeFor — exit code rules');
{
  check('empty → 0', exitCodeFor([]) === 0);
  check('all OK → 0', exitCodeFor([{ status: 'ok', label: 'a', detail: '' }, { status: 'ok', label: 'b', detail: '' }]) === 0);
  check('any INFO only → 0', exitCodeFor([{ status: 'info', label: 'a', detail: '' }]) === 0);
  check('WARN alone → 0 (advisory, not blocking)', exitCodeFor([
    { status: 'ok', label: 'a', detail: '' },
    { status: 'warn', label: 'b', detail: '' },
  ]) === 0);
  check('one FAIL → 1', exitCodeFor([
    { status: 'ok', label: 'a', detail: '' },
    { status: 'fail', label: 'b', detail: '' },
    { status: 'warn', label: 'c', detail: '' },
  ]) === 1);
  check('all FAIL → 1', exitCodeFor([
    { status: 'fail', label: 'a', detail: '' },
    { status: 'fail', label: 'b', detail: '' },
  ]) === 1);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

// Tests for the pure helpers in src/config-report.ts
// (`dario config` subcommand). collectEffectiveConfig is covered by an
// end-to-end smoke (`node dist/cli.js config` post-build) since it
// reads filesystem + accounts/backends modules — no point in a
// filesystem-mocked unit test.

import {
  formatAge,
  formatEffectiveConfig,
  formatEffectiveConfigJson,
} from '../dist/config-report.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('formatAge');
{
  check('<1s → 0s', formatAge(0) === '0s');
  check('30s', formatAge(30_000) === '30s');
  check('59s', formatAge(59_000) === '59s');
  check('1m (60s → 1m)', formatAge(60_000) === '1m');
  check('1h', formatAge(60 * 60_000) === '1h');
  check('1d', formatAge(24 * 60 * 60_000) === '1d');
  check('negative → 0s', formatAge(-5000) === '0s');
}

// ─────────────────────────────────────────────────────────────
header('formatEffectiveConfig — shape');
{
  const report = {
    generatedAt: '2026-04-23T00:00:00.000Z',
    version: '3.31.9',
    sections: [
      {
        title: 'Identity',
        rows: [
          { label: 'version', value: 'v3.31.9' },
          { label: 'runtime', value: 'node v22 on linux' },
        ],
      },
      {
        title: 'Auth gate',
        rows: [
          { label: 'DARIO_API_KEY', value: 'unset' },
          { label: 'longer_label',  value: 'on' },
        ],
      },
    ],
  };
  const out = formatEffectiveConfig(report);
  check('contains first section title',  out.includes('Identity'));
  check('contains second section title', out.includes('Auth gate'));
  check('contains a divider line',       out.includes('────────'));
  check('contains values',               out.includes('v3.31.9') && out.includes('unset'));

  // Rows within the same section are aligned — the shorter label gets
  // padded to the width of the longer one, so the VALUE column is at
  // the same index across rows. Longer of the two test labels is
  // "DARIO_API_KEY" (13 chars). Value starts at: 4 (leading indent) +
  // 13 (padded label) + 2 (separator) = column 19.
  const EXPECTED_VALUE_COL = 4 + 13 + 2;
  const authLines = out.split('\n').filter((l) => /DARIO_API_KEY|longer_label/.test(l));
  check('both Auth gate rows rendered', authLines.length === 2);
  if (authLines.length === 2) {
    const row1Value = authLines[0].slice(EXPECTED_VALUE_COL);
    const row2Value = authLines[1].slice(EXPECTED_VALUE_COL);
    check('row 1 value at expected column (starts with "unset")', row1Value.startsWith('unset'));
    check('row 2 value at expected column (starts with "on")',    row2Value.startsWith('on'));
  }
}

header('formatEffectiveConfig — empty sections');
{
  const out = formatEffectiveConfig({
    generatedAt: '2026-04-23T00:00:00.000Z',
    version: '3.31.9',
    sections: [],
  });
  check('empty sections → empty-ish output', out.trim() === '');
}

// ─────────────────────────────────────────────────────────────
header('formatEffectiveConfigJson — round-trip');
{
  const report = {
    generatedAt: '2026-04-23T00:00:00.000Z',
    version: '3.31.9',
    sections: [
      { title: 'S1', rows: [{ label: 'a', value: 'b' }] },
    ],
  };
  const parsed = JSON.parse(formatEffectiveConfigJson(report));
  check('version field round-trips',      parsed.version === '3.31.9');
  check('sections array length preserved', Array.isArray(parsed.sections) && parsed.sections.length === 1);
  check('row round-trips',                 parsed.sections[0].rows[0].label === 'a' && parsed.sections[0].rows[0].value === 'b');
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

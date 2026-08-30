// Unit tests for the pure parts of `dario doctor` (src/doctor.ts):
//   - formatChecks: column alignment, status prefixes
//   - formatChecksJson: structured JSON envelope shape
//   - exitCodeFor: exit code derivation from check statuses
//
// Integration coverage (runChecks() against a real machine) is handled
// by just running `dario doctor` once after build — there's no point
// unit-testing execFileSync probes against fixtures when the whole
// point is to reflect the current host.

import { formatChecks, formatChecksJson, exitCodeFor, formatReset, failoverReadiness } from '../dist/doctor.js';

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
//  formatChecksJson — structured envelope shape
// ======================================================================
header('formatChecksJson — envelope shape');
{
  const checks = [
    { status: 'ok',   label: 'Node',     detail: 'v22.5.1' },
    { status: 'warn', label: 'CC',       detail: 'untested' },
    { status: 'info', label: 'Platform', detail: 'linux x64' },
  ];
  const parsed = JSON.parse(formatChecksJson(checks));
  check('exitCode field present and matches exitCodeFor', parsed.exitCode === exitCodeFor(checks));
  check('summary.ok is 1',   parsed.summary.ok   === 1);
  check('summary.warn is 1', parsed.summary.warn === 1);
  check('summary.info is 1', parsed.summary.info === 1);
  check('summary.fail is 0', parsed.summary.fail === 0);
  check('checks array preserved',     Array.isArray(parsed.checks) && parsed.checks.length === 3);
  check('first check round-trips',    parsed.checks[0].label === 'Node' && parsed.checks[0].detail === 'v22.5.1');
  check('generatedAt is ISO-8601',    typeof parsed.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(parsed.generatedAt));
}

header('formatChecksJson — fail exits 1');
{
  const checks = [
    { status: 'ok',   label: 'a', detail: '' },
    { status: 'fail', label: 'b', detail: 'OAuth expired' },
  ];
  const parsed = JSON.parse(formatChecksJson(checks));
  check('exitCode is 1 when any fail', parsed.exitCode === 1);
  check('summary.fail is 1',           parsed.summary.fail === 1);
}

header('formatChecksJson — empty checks');
{
  const parsed = JSON.parse(formatChecksJson([]));
  check('empty list → exitCode 0',    parsed.exitCode === 0);
  check('empty list → all summary 0', Object.values(parsed.summary).every((n) => n === 0));
  check('empty list → checks: []',    Array.isArray(parsed.checks) && parsed.checks.length === 0);
}

// ======================================================================
//  formatReset — relative rate-limit reset times
// ======================================================================
header('formatReset — relative reset times');
{
  const now = 1000000000000; // 1,000,000,000 seconds

  check('resets in past/now returns 0m', formatReset(1000000000 - 10, now) === '0m');
  check('resets in 45s rounds to 1m', formatReset(1000000000 + 45, now) === '1m');
  check('resets in 45m returns 45m', formatReset(1000000000 + 45 * 60, now) === '45m');
  check('resets in 69m returns 1h 9m', formatReset(1000000000 + 69 * 60, now) === '1h 9m');
  check('resets in 2d 3h returns 2d 3h', formatReset(1000000000 + (2 * 1440 + 3 * 60) * 60, now) === '2d 3h');
}

// ======================================================================
header('failoverReadiness — every branch, including the ones this host cannot be in');
{
  // The whole reason this is a pure function: a real box only ever exercises
  // the branch matching its own credentials, which is exactly how the INERT
  // state stayed invisible until the fleet went dark on 2026-08-29.
  const r = (chain, codexAccounts, backends) =>
    failoverReadiness({ chain, codexAccounts, backends });

  check('unarmed reports info, not a problem (failover is opt-in)',
    r([], 0, []).status === 'info');

  const inert = r(['gpt-5.6-sol'], 0, []);
  check('armed with NOTHING to fall back to warns — the outage state',
    inert.status === 'warn');
  check('...and says so in the word INERT, not just "configured"',
    inert.detail.includes('INERT'));
  check('...and names a concrete fix rather than only diagnosing',
    inert.detail.includes('dario add altman'));

  const oneWay = r(['gpt-5.6-sol'], 1, []);
  check('a single-entry chain with a Codex account is ok but flagged one-way',
    oneWay.status === 'ok' && oneWay.detail.includes('One-way'));
  check('...and reports that it covers both wire shapes',
    oneWay.detail.includes('both wire shapes'));

  const sym = r(['gpt-5.6-sol', 'claude-sonnet-5'], 1, []);
  check('a two-entry chain with a Codex account reports symmetric',
    sym.status === 'ok' && sym.detail.startsWith('symmetric:'));
  check('...pluralising the account count correctly at 1',
    sym.detail.includes('1 Codex account,') || sym.detail.includes('1 Codex account'));
  check('...and at 2',
    r(['a', 'b'], 2, []).detail.includes('2 Codex accounts'));

  const keyOnly = r(['gpt-5.6-sol'], 0, ['openai']);
  check('a backend but no Codex account is ok, named, and marked OpenAI-path-only',
    keyOnly.status === 'ok' && keyOnly.detail.includes('openai') && keyOnly.detail.includes('OpenAI path only'));
  check('...and points at the subscription as the way to cover Anthropic clients',
    keyOnly.detail.includes('Anthropic-shape'));

  check('a Codex account is preferred over a backend when both exist',
    r(['gpt-5.6-sol'], 1, ['openai']).detail.includes('codex'));
  check('an unarmed chain stays info even with providers available',
    r([], 2, ['openai']).status === 'info');
}

//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

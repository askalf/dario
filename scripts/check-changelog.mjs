// A PR that changes shipping code must say so in CHANGELOG.md.
//
// WHY THIS EXISTS. v6.0.22 (2026-09-05) shipped six codex changes and the
// release notes listed two: four PRs touched src/ and never added a bullet,
// so the generated GitHub Release under-reported what users were getting.
// The convention ("land changes under ## [Unreleased]") was written down in
// CHANGELOG.md's header and in the PR template, and four of six PRs skipped
// it anyway — advice is not a gate. This is the gate.
//
// Rule: if the PR diff touches anything under src/ it must also touch
// CHANGELOG.md. Escape hatch: the `no-changelog` label, for refactors and
// test-only shuffles that genuinely change nothing a user can observe.
//
// Runs on pull_request only (a push to master has no diff base to judge).
// Inputs via env so it is trivially runnable by hand:
//   BASE_SHA  the PR base commit (fetched by the workflow)
//   HEAD_SHA  the PR head commit
//   PR_LABELS comma-separated label names (may be empty)
import { execFileSync } from 'node:child_process';

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA || 'HEAD';
const labels = (process.env.PR_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!base) {
  console.log('check-changelog: no BASE_SHA — not a pull_request run, nothing to judge.');
  process.exit(0);
}
if (labels.includes('no-changelog')) {
  console.log('check-changelog: `no-changelog` label present — skipped by request.');
  process.exit(0);
}

const files = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf-8' })
  .split('\n').map((s) => s.trim()).filter(Boolean);

const shipping = files.filter((f) => f.startsWith('src/'));
const hasChangelog = files.includes('CHANGELOG.md');

if (shipping.length === 0) {
  console.log('check-changelog: no src/ changes — nothing to record.');
  process.exit(0);
}
if (hasChangelog) {
  console.log(`check-changelog: ${shipping.length} src/ file(s) changed and CHANGELOG.md is in the diff — ok.`);
  process.exit(0);
}

console.error(`FAIL: ${shipping.length} shipping file(s) changed with no CHANGELOG.md entry:`);
for (const f of shipping) console.error(`  ${f}`);
console.error('');
console.error('Add a bullet under `## [Unreleased]` in CHANGELOG.md describing the user-visible change,');
console.error('or apply the `no-changelog` label if there genuinely is none (pure refactor, test-only).');
process.exit(1);

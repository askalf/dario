#!/usr/bin/env node
/**
 * Auto-draft a drift-fix PR from a check-cc-drift.mjs report.
 *
 * Watcher arc, part 3. When scripts/check-cc-drift.mjs flags drift that
 * is a known one-line constant change (currently: the `compat.range`
 * medium-severity item that says "bump SUPPORTED_CC_RANGE.maxTested"),
 * this script applies the patch locally and emits metadata the calling
 * workflow uses to open a DRAFT PR. Maintainer reviews + merges as usual.
 *
 * Out of scope for this file (and intentionally so — these need human
 * judgment):
 *   - Version bumps in package.json (release-prep step, not patch-step)
 *   - Template re-capture (template.version drift). Needs a live CC
 *     binary + MITM capture + scrub + review.
 *   - Scope rotations (scope literal missing from binary, or authorize
 *     probe rejected). Needs cross-checking with CC's active scope
 *     array, not automatable reliably.
 *   - authorizeUrl / clientId / tokenUrl changes. These are rare and
 *     security-sensitive; a misread of the drift report here could
 *     point dario at an attacker's endpoint. Kept manual.
 *
 * Output is JSON on stdout:
 *   {
 *     "fixed": bool,
 *     "branchName": string?,
 *     "prTitle": string?,
 *     "prBody": string?,
 *     "changedFiles": string[],
 *     "reason": string          // why we fixed / didn't fix
 *   }
 *
 * Exit codes: always 0 on nominal operation (drift or no-drift). Non-
 * zero only for infrastructure failures (can't read the report, patch
 * target not found). The `fixed` field is the signal the workflow keys
 * on, not the exit code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOlderThan, patchMaxTested, appendUnreleased } from './_drift-patch-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const REPORT_PATH = process.argv[2] ?? 'drift-report.json';

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf-8'));
} catch (err) {
  emit({
    fixed: false,
    changedFiles: [],
    reason: `could not read ${REPORT_PATH}: ${(err instanceof Error ? err.message : String(err))}`,
  });
  process.exit(1);
}

if (!report.drift || !Array.isArray(report.items) || report.items.length === 0) {
  emit({ fixed: false, changedFiles: [], reason: 'drift report has no items to fix' });
  process.exit(0);
}

const ccVersion = typeof report.ccVersion === 'string' ? report.ccVersion : null;
const pinnedMaxTested = report?.pinned?.maxTested;
if (!ccVersion) {
  emit({ fixed: false, changedFiles: [], reason: 'report is missing ccVersion' });
  process.exit(0);
}

// Which item are we handling? For v1 only `compat.range` — the
// maxTested bump. Future items get an if-chain here with their own
// patch routines.
const compatItem = report.items.find(
  (i) => i && typeof i === 'object' && i.category === 'compat.range',
);
if (!compatItem) {
  emit({
    fixed: false,
    changedFiles: [],
    reason:
      'no auto-fixable drift item in report. Found: ' +
      report.items.map((i) => i.category).join(', '),
  });
  process.exit(0);
}

// Sanity-check the drift direction. We only auto-fix when the pinned
// maxTested is OLDER than the observed ccVersion — bumping forward.
// If somehow the pinned is AHEAD, that's a different issue (a bad
// release) and shouldn't be auto-patched.
if (pinnedMaxTested && !isOlderThan(pinnedMaxTested, ccVersion)) {
  emit({
    fixed: false,
    changedFiles: [],
    reason: `pinned maxTested v${pinnedMaxTested} is not older than ccVersion v${ccVersion}; skipping auto-fix`,
  });
  process.exit(0);
}

// Apply the patch: bump SUPPORTED_CC_RANGE.maxTested in
// src/live-fingerprint.ts. The target line is a trivial constant
// assignment; we match on the surrounding labeled property name +
// old version to avoid misfiring if someone adds a second maxTested
// reference elsewhere.
const targetFile = 'src/live-fingerprint.ts';
const absPath = join(repoRoot, targetFile);
let source;
try {
  source = readFileSync(absPath, 'utf-8');
} catch (err) {
  emit({
    fixed: false,
    changedFiles: [],
    reason: `could not read ${targetFile}: ${(err instanceof Error ? err.message : String(err))}`,
  });
  process.exit(1);
}

// Canonical patch shape: `maxTested: 'X.Y.Z'` inside SUPPORTED_CC_RANGE.
// Anchor on the property name; accept either quote style.
const { patched, before, after } = patchMaxTested(source, pinnedMaxTested, ccVersion);
if (!patched) {
  emit({
    fixed: false,
    changedFiles: [],
    reason:
      `could not locate a maxTested: '${pinnedMaxTested}' line in ${targetFile}. ` +
      `The file shape may have drifted from what this script expects; falling back to manual patch.`,
  });
  process.exit(0);
}

writeFileSync(absPath, patched, 'utf-8');

// Also append a CHANGELOG entry under Unreleased so the maintainer
// doesn't have to write one at merge time. Keep it short, factual,
// and clearly marked as bot-generated so a reviewer can replace it
// with narrative prose if they prefer.
const changelogPath = join(repoRoot, 'CHANGELOG.md');
let changelog;
try {
  changelog = readFileSync(changelogPath, 'utf-8');
} catch {
  changelog = '';
}

const changelogUpdated = appendUnreleased(
  changelog,
  `- **CC drift patch** — \`SUPPORTED_CC_RANGE.maxTested\` bumped \`${before}\` → \`${after}\` for CC v${ccVersion}. Auto-drafted by \`cc-drift-watch.yml\`; maintainer confirm the template doesn't also need a re-capture (run \`node scripts/capture-and-bake.mjs\` locally).`,
);
if (changelogUpdated !== changelog) {
  writeFileSync(changelogPath, changelogUpdated, 'utf-8');
}

const branchName = `bot/cc-drift-v${ccVersion}`;
const prTitle = `chore(cc-drift): bump SUPPORTED_CC_RANGE.maxTested → v${ccVersion}`;
const prBody = buildPrBody(ccVersion, before, after, report);

emit({
  fixed: true,
  branchName,
  prTitle,
  prBody,
  changedFiles: [targetFile, changelogPath === '' ? '' : 'CHANGELOG.md'].filter(Boolean),
  reason: `auto-patched maxTested ${before} → ${after}`,
});
process.exit(0);

// ──────────────────────────────────────────────────────────────────
// isOlderThan / patchMaxTested / appendUnreleased live in
// _drift-patch-helpers.mjs so the test can import them without
// running this file's top-level "read argv + patch files" chain.

function buildPrBody(ccVersion, before, after, report) {
  const driftLines = report.items
    .map((i) => `- **${i.category}** (${i.severity ?? 'info'}) — ${i.message ?? ''}`)
    .join('\n');
  return [
    '## Auto-drafted by cc-drift-watch.yml',
    '',
    `The nightly drift watcher flagged CC v${ccVersion} as outside the current supported range. This PR bumps \`SUPPORTED_CC_RANGE.maxTested\` from \`${before}\` → \`${after}\` so users on the new CC no longer see the "untested-above" soft warning in \`dario doctor\`.`,
    '',
    '### Items in the drift report',
    '',
    driftLines,
    '',
    '### Maintainer checklist before merging',
    '',
    '- [ ] Install the new CC locally: `npm install -g @anthropic-ai/claude-code@' + ccVersion + '`',
    '- [ ] Run `dario doctor` and confirm it comes back clean against v' + ccVersion,
    '- [ ] If any fingerprint-sensitive fields changed, re-capture the bundled template: `npm run build && node scripts/capture-and-bake.mjs` — then amend this PR with the new `src/cc-template-data.json` and update the CHANGELOG entry below.',
    '- [ ] Bump `package.json` version (patch bump: e.g. `3.31.11` → `3.31.12`) — this PR deliberately does NOT touch the version; that\'s a release-prep step.',
    '- [ ] Confirm the CHANGELOG entry under `## [Unreleased]` reads cleanly. The bot wrote a short factual line; feel free to rewrite with more context.',
    '- [ ] Mark as ready for review + merge. Auto-merge will ship it through CI.',
    '',
    '### About this auto-draft',
    '',
    'Only `compat.range` items are auto-patched. Other drift categories (template re-capture, scope rotations, URL / clientId / tokenUrl changes) require judgment and stay manual — the bot opens the plain drift-issue for those as before.',
    '',
    '---',
    '',
    '_Generated by `scripts/auto-draft-drift-fix.mjs`. Closes the detection-latency arc started in [#112](https://github.com/askalf/dario/pull/112) / [#113](https://github.com/askalf/dario/pull/113)._',
  ].join('\n');
}

#!/usr/bin/env node
/**
 * Auto-draft a drift-fix PR from a check-cc-drift.mjs report.
 *
 * Watcher arc, part 3. When scripts/check-cc-drift.mjs flags drift that
 * is a known one-line constant change (currently: the `compat.range`
 * medium-severity item that says "bump SUPPORTED_CC_RANGE.maxTested"),
 * this script applies the patch locally and emits metadata the calling
 * workflow uses to open a ready (non-draft) PR with auto-merge enabled.
 * On green CI it merges and releases itself with zero maintainer action;
 * a human only intervenes if a required check fails. (master requires no
 * review, so no approval gates the auto-merge.)
 *
 * Out of scope for this file (and intentionally so — these need human
 * judgment):
 *   - Version bumps in package.json (release-prep step, not patch-step)
 *   - Template re-capture (template.version drift). Handled autonomously
 *     by cc-drift-template-watch.yml — live capture + scrub + auto-rebake
 *     PR on the self-hosted runner every 30 min. Out of scope for THIS
 *     file, but no longer a manual step.
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
import {
  isOlderThan,
  patchMaxTested,
  syncLockfileVersion,
  appendUnreleased,
  bumpPackageJsonPatch,
  promoteUnreleased,
} from './_drift-patch-helpers.mjs';

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

// Bump package.json's patch version. The downstream `cc-drift-auto-
// release.yml` workflow fires on merge of this PR, reads the bumped
// version from master, and tags + cuts the GitHub release from it —
// which triggers the existing publish workflow on release:published.
// So the version bump is both the CHANGELOG promotion anchor and the
// release-cut trigger.
const pkgPath = join(repoRoot, 'package.json');
let packageBumpResult = null;
try {
  const pkgSource = readFileSync(pkgPath, 'utf-8');
  packageBumpResult = bumpPackageJsonPatch(pkgSource);
  writeFileSync(pkgPath, packageBumpResult.content, 'utf-8');
} catch (err) {
  emit({
    fixed: false,
    changedFiles: [],
    reason: `could not bump package.json: ${(err instanceof Error ? err.message : String(err))}`,
  });
  process.exit(1);
}
const newDarioVersion = packageBumpResult.after;

// Mirror the new version into package-lock.json's two version slots. The
// required `validate-package-json` check runs scripts/preflight.mjs, which
// fails when the lockfile disagrees with package.json — so skipping this step
// leaves the bot's own PR red on a defect the bot itself introduced.
const lockPath = join(repoRoot, 'package-lock.json');
try {
  const lockSource = readFileSync(lockPath, 'utf-8');
  writeFileSync(lockPath, syncLockfileVersion(lockSource, newDarioVersion), 'utf-8');
} catch (err) {
  emit({
    fixed: false,
    changedFiles: [],
    reason: `could not sync package-lock.json to v${newDarioVersion}: ${(err instanceof Error ? err.message : String(err))}`,
  });
  process.exit(1);
}

// Update CHANGELOG:
//   1. Promote `## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD` with a
//      fresh `## [Unreleased]` above (the convention documented in
//      the top-of-file HTML comment since v3.31.10).
//   2. Append the drift-fix bullet under the NEW version heading, so
//      a reader of the released changelog sees the one-line summary.
const changelogPath = join(repoRoot, 'CHANGELOG.md');
let changelog;
try {
  changelog = readFileSync(changelogPath, 'utf-8');
} catch {
  changelog = '';
}

const today = new Date().toISOString().slice(0, 10);
const promoted = promoteUnreleased(changelog, newDarioVersion, today);
const driftBullet =
  `- **Claude Code ${ccVersion} is in the supported range.** ` +
  `\`dario doctor\` and proxy startup no longer warn that it is untested, as they did for anything newer than ${before}.`;
const changelogUpdated = appendUnreleased(
  promoted,
  driftBullet,
  new RegExp(`^## \\[${newDarioVersion}\\] - ${today}\\s*$`, 'm'),
);
if (changelogUpdated !== changelog) {
  writeFileSync(changelogPath, changelogUpdated, 'utf-8');
}

const branchName = `bot/cc-drift-v${ccVersion}`;
// The title is also the commit subject (cc-drift-watch.yml commits with it): plain text, no dashes or arrows.
const prTitle = `chore(cc-drift): v${newDarioVersion}: maxTested to v${ccVersion}`;
const prBody = buildPrBody(ccVersion, before, after, newDarioVersion, report);

emit({
  fixed: true,
  branchName,
  prTitle,
  prBody,
  newDarioVersion,
  changedFiles: [targetFile, 'package.json', 'package-lock.json', changelogPath === '' ? '' : 'CHANGELOG.md'].filter(Boolean),
  reason: `auto-patched maxTested ${before} to ${after}, bumped dario ${packageBumpResult.before} to ${newDarioVersion}`,
});
process.exit(0);

// ──────────────────────────────────────────────────────────────────
// isOlderThan / patchMaxTested / appendUnreleased live in
// _drift-patch-helpers.mjs so the test can import them without
// running this file's top-level "read argv + patch files" chain.

function buildPrBody(ccVersion, before, after, newDarioVersion, report) {
  const driftLines = report.items
    .map((i) => `- **${i.category}** (${i.severity ?? 'info'}): ${i.message ?? ''}`)
    .join('\n');
  return [
    '## Drafted by cc-drift-watch.yml',
    '',
    `The drift watcher found CC v${ccVersion} above the supported range. This PR:`,
    '',
    `1. Bumps \`SUPPORTED_CC_RANGE.maxTested\` from \`${before}\` to \`${after}\` in \`src/live-fingerprint.ts\``,
    `2. Bumps the \`package.json\` and \`package-lock.json\` versions to \`${newDarioVersion}\``,
    `3. Adds a \`## [${newDarioVersion}] - ${new Date().toISOString().slice(0, 10)}\` section to \`CHANGELOG.md\` under \`## [Unreleased]\`, with the release note`,
    '',
    '### Items in the drift report',
    '',
    driftLines,
    '',
    '### Merge and release',
    '',
    '- **Merge:** the platform review gate squash-merges this PR after the required checks pass (`build (18|20|22)`, `validate-package-json`, `analyze`, `actionlint`) and Redline approves. The `master` ruleset requires an approving review and dismisses it on any later push. It merges only while its `package.json` version is above the one on `master`.',
    `- **Release:** after merge, \`cc-drift-auto-release.yml\` tags \`v${newDarioVersion}\` and publishes \`@askalf/dario@${newDarioVersion}\` to npm (with \`--provenance\`) and GHCR. The box autodeploy timer picks it up within about 15 minutes.`,
    `- **Template:** \`cc-drift-template-watch.yml\` captures real CC traffic on the self-hosted runner every 30 minutes. If the bundled template drifts against v${ccVersion}, it opens a separate \`bot/template-rebake-*\` PR.`,
    '',
    'If a required check fails, the PR stays open with the failure visible and the bot branch is kept.',
    '',
    '### Scope of this script',
    '',
    'Only `compat.range` items are patched here. Template re-capture is handled by `cc-drift-template-watch.yml`. Scope rotations and URL, clientId, or tokenUrl changes need judgment and stay manual; the bot opens a drift issue for those.',
  ].join('\n');
}

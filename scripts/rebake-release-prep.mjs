#!/usr/bin/env node
/**
 * Release-prep for an auto-rebake of the bundled CC template.
 *
 * cc-drift-template-watch.yml runs this right after capture-and-bake.mjs
 * writes a fresh src/cc-template-data.json. It bumps package.json's patch
 * version and promotes the CHANGELOG, so the resulting bot/template-rebake-*
 * PR is version-bumping — which is what makes cc-drift-auto-release.yml ship
 * it on merge.
 *
 * Without this step a rebake lands on master with only cc-template-data.json
 * changed → no version bump → auto-release's version-gate fast-exits → the
 * freshly-baked template never reaches npm (it only ships if an unrelated
 * version-bumping release happens to ride along, as happened for #317).
 *
 * Mirrors the bump + CHANGELOG-promotion auto-draft-drift-fix.mjs already
 * does for compat.range fixes, reusing the same helpers.
 *
 * The CHANGELOG entry and rebake-summary.md (the "What changes" list of the
 * PR body) are written from the diff between the committed bundle and the
 * baked one. A sentence that only says "the template was re-captured" tells a
 * reader nothing, and the --check log names less than the bake ships.
 *
 * Prints the new version to stdout for the workflow to consume.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bumpPackageJsonPatch,
  promoteUnreleased,
  appendUnreleased,
  syncLockfileVersion,
} from './_drift-patch-helpers.mjs';
import { describeBundleChange, formatRebakeChangelog, formatRebakeSummary } from './drift-report.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(repoRoot, 'package.json');
const changelogPath = join(repoRoot, 'CHANGELOG.md');
const lockPath = join(repoRoot, 'package-lock.json');

const { content: bumpedPkg, before, after } = bumpPackageJsonPatch(readFileSync(pkgPath, 'utf-8'));
writeFileSync(pkgPath, bumpedPkg, 'utf-8');

// Keep the lockfile's two version slots in step — preflight.mjs, run by the
// required `validate-package-json` check, fails the PR when they disagree.
writeFileSync(lockPath, syncLockfileVersion(readFileSync(lockPath, 'utf-8'), after), 'utf-8');

const today = new Date().toISOString().slice(0, 10);

// The bundle being replaced is the committed one; the bake wrote the new one
// to the working tree. Outside a checkout that has both there is no diff to
// describe, and the entry says only that the template was re-captured.
const BUNDLE = 'src/cc-template-data.json';
let change = null;
try {
  const committed = JSON.parse(execFileSync('git', ['show', `HEAD:${BUNDLE}`], {
    cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  change = describeBundleChange(committed, JSON.parse(readFileSync(join(repoRoot, BUNDLE), 'utf-8')));
} catch {
  change = null;
}
const bullet = change
  ? formatRebakeChangelog(change).join('\n')
  : '- **The bundled template follows Claude Code\'s current request shape.** A live capture ' +
    'no longer matched `src/cc-template-data.json`, so the template was re-captured from it. ' +
    'Requests that fall back to the bundled template send the new shape.';
writeFileSync(
  join(repoRoot, 'rebake-summary.md'),
  (change ? formatRebakeSummary(change) : ['- The bundled template was re-captured from a live capture.']).join('\n') + '\n',
  'utf-8',
);

const promoted = promoteUnreleased(readFileSync(changelogPath, 'utf-8'), after, today);
const updated = appendUnreleased(
  promoted,
  bullet,
  new RegExp(`^## \\[${after}\\] - ${today}\\s*$`, 'm'),
);
if (updated !== promoted) {
  writeFileSync(changelogPath, updated, 'utf-8');
}

console.error(`[rebake-release-prep] package.json ${before} → ${after}; CHANGELOG promoted`);
process.stdout.write(after + '\n');

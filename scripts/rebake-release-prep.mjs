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
 * With --carry-range, a bake captured from a Claude Code version newer than
 * SUPPORTED_CC_RANGE.maxTested also moves maxTested to it, lists the version
 * in test/compat-pinned.json and files the release note for the bump, so the
 * rebake PR is the one release for that Claude Code version. Whether to pass
 * the flag is the workflow's decision, made by mayCarry in
 * scripts/range-bump-carrier.mjs: no bump PR of cc-drift-watch.yml's open, a
 * passing upstream check, a passing wire-drift check on the version the
 * bundle was captured from, and no wire-drift issue open. This script only
 * applies it. A version the bundle does not name as x.y.z, a source file without a
 * maxTested line, and a maxTested already at or past the version all leave
 * the range alone.
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
  patchMaxTested,
  addPinnedVersion,
  rangeBullet,
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
// to the working tree. Where git cannot produce the committed one there is
// no diff to describe, and the entry says only that the template was
// re-captured. Nothing else is caught: an error in describing the diff
// should stop the release prep, not hide behind that sentence.
const BUNDLE = 'src/cc-template-data.json';
let committedText = null;
try {
  committedText = execFileSync('git', ['show', `HEAD:${BUNDLE}`], {
    cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  committedText = null;
}
// The workflow builds before it bakes, so dist/ is there to name the families
// that sit within a wider one.
const { VARIANT_FAMILIES } = await import('../dist/live-fingerprint.js');
const within = Object.fromEntries(VARIANT_FAMILIES.filter((f) => f.within).map((f) => [f.key, f.within]));
const baked = JSON.parse(readFileSync(join(repoRoot, BUNDLE), 'utf-8'));
const change = committedText === null
  ? null
  : describeBundleChange(JSON.parse(committedText), baked, within);

// The supported range follows the bake when the workflow asks for it. The
// bundle was captured from this version and the upstream check ran on it,
// which is the evidence a maxTested claim stands on.
let range = null;
if (process.argv.includes('--carry-range') && typeof baked._version === 'string' && /^\d+\.\d+\.\d+$/.test(baked._version)) {
  const rangePath = join(repoRoot, 'src', 'live-fingerprint.ts');
  let source = null;
  try { source = readFileSync(rangePath, 'utf-8'); } catch { source = null; }
  const patch = source === null ? { patched: null } : patchMaxTested(source, null, baked._version);
  if (patch.patched) {
    writeFileSync(rangePath, patch.patched, 'utf-8');
    range = { before: patch.before, after: baked._version, pinned: false };
    const pinnedPath = join(repoRoot, 'test', 'compat-pinned.json');
    try {
      const listText = readFileSync(pinnedPath, 'utf-8');
      const listed = addPinnedVersion(listText, baked._version);
      if (listed !== null && listed !== listText) writeFileSync(pinnedPath, listed, 'utf-8');
      range.pinned = listed !== null;
    } catch {
      // No readable list: the bump still ships, without the test that pins it.
    }
  }
}

const rebakeBullet = change
  ? formatRebakeChangelog(change).join('\n')
  : '- **The bundled template follows Claude Code\'s current request shape.** A live capture ' +
    'no longer matched `src/cc-template-data.json`, so the template was re-captured from it. ' +
    'Requests that fall back to the bundled template send the new shape.';
const bullet = range ? `${rangeBullet(range.after, range.before)}\n${rebakeBullet}` : rebakeBullet;
writeFileSync(
  join(repoRoot, 'rebake-summary.md'),
  [
    ...(range ? [`- **Supported range:** \`SUPPORTED_CC_RANGE.maxTested\` goes from ${range.before} to ${range.after}${range.pinned ? `, and \`test/compat-pinned.json\` lists ${range.after}` : ''}. No separate PR moves it.`] : []),
    ...(change ? formatRebakeSummary(change) : ['- The bundled template was re-captured from a live capture.']),
  ].join('\n') + '\n',
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

console.error(`[rebake-release-prep] package.json ${before} → ${after}; CHANGELOG promoted${range ? `; maxTested ${range.before} → ${range.after}` : ''}`);
process.stdout.write(after + '\n');

#!/usr/bin/env node
/**
 * Label-only sync of the bundled CC template + release-prep.
 *
 * Driven by cc-drift-template-watch.yml when `capture-and-bake.mjs --check`
 * exits 3: the live wire shape MATCHES the bundle (computeDrift returned
 * empty), but the bundled `_version` label lags the installed CC version, so
 * sdk-drift-watch.yml flags a pin delta against npm with nothing to re-bake.
 *
 * This script bumps ONLY the version-label fields — deterministically, no
 * re-capture (bumpTemplateLabels touches `_version`, `_supportedMaxTested`,
 * and the `claude-cli/<v>` token in the user-agent header, nothing else) —
 * then bumps package.json's patch + promotes the CHANGELOG so merging the
 * resulting bot/template-label-* PR ships the refresh to npm via
 * cc-drift-auto-release.yml.
 *
 * It is the label-only sibling of rebake-release-prep.mjs: that one runs
 * AFTER a full capture-and-bake re-capture (real wire-shape drift); this one
 * runs when there is no shape change to bake, only a stale label to refresh.
 *
 * Usage:  node scripts/label-sync.mjs <target-cc-version>
 * Stdout: the new dario package version (for the workflow to consume).
 * Exits:  0 wrote changes; 1 on bad input / not-newer / template-shape drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bumpTemplateLabels,
  bumpPackageJsonPatch,
  promoteUnreleased,
  appendUnreleased,
  syncLockfileVersion,
} from './_drift-patch-helpers.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(repoRoot, 'src/cc-template-data.json');
const pkgPath = join(repoRoot, 'package.json');
const changelogPath = join(repoRoot, 'CHANGELOG.md');
const lockPath = join(repoRoot, 'package-lock.json');

const target = (process.argv[2] || '').trim();
if (!target) {
  console.error('[label-sync] error: target CC version required as argv[1]');
  process.exit(1);
}

// 1) Surgical label bump of the bundled template. Throws (→ exit 1) on a
//    not-newer target or if the template shape drifted so a label anchor no
//    longer matches — in which case this is NOT a label-only case and the
//    full rebake path should have handled it.
let result;
try {
  result = bumpTemplateLabels(readFileSync(OUT, 'utf-8'), target);
} catch (err) {
  console.error(`[label-sync] error: ${err.message}`);
  process.exit(1);
}
writeFileSync(OUT, result.text, 'utf-8');
console.error(
  `[label-sync] cc-template-data.json: _version ${result.before} → ${result.after} ` +
  `(+ _supportedMaxTested, user-agent); wire shape untouched`,
);

// 2) Release-prep: patch-bump package.json + promote the CHANGELOG, so the PR
//    is version-bumping and cc-drift-auto-release.yml ships it on merge.
const { content: bumpedPkg, before: pkgBefore, after: pkgAfter } =
  bumpPackageJsonPatch(readFileSync(pkgPath, 'utf-8'));
writeFileSync(pkgPath, bumpedPkg, 'utf-8');

// Keep the lockfile's two version slots in step — preflight.mjs, run by the
// required `validate-package-json` check, fails the PR when they disagree.
writeFileSync(lockPath, syncLockfileVersion(readFileSync(lockPath, 'utf-8'), pkgAfter), 'utf-8');

const today = new Date().toISOString().slice(0, 10);
// Release-note voice: what changed for a user, no bot narration (the gating review
// blocks generated-sounding release text on this public repo; dario#1405).
const bullet =
  `- **Template labels follow Claude Code ${target}.** \`_version\`, \`_supportedMaxTested\` ` +
  `and the \`user-agent\` header now read \`${target}\`. A live capture against Claude Code ` +
  `${target} matched the bundled template, so the request shape is unchanged and ` +
  '`_captured` keeps the date of the last real capture.';

const promoted = promoteUnreleased(readFileSync(changelogPath, 'utf-8'), pkgAfter, today);
const updated = appendUnreleased(
  promoted,
  bullet,
  new RegExp(`^## \\[${pkgAfter}\\] - ${today}\\s*$`, 'm'),
);
if (updated !== promoted) {
  writeFileSync(changelogPath, updated, 'utf-8');
}

console.error(`[label-sync] package.json ${pkgBefore} → ${pkgAfter}; CHANGELOG promoted`);
process.stdout.write(pkgAfter + '\n');

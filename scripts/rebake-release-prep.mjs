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
 * Prints the new version to stdout for the workflow to consume.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bumpPackageJsonPatch, promoteUnreleased, appendUnreleased } from './_drift-patch-helpers.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(repoRoot, 'package.json');
const changelogPath = join(repoRoot, 'CHANGELOG.md');

const { content: bumpedPkg, before, after } = bumpPackageJsonPatch(readFileSync(pkgPath, 'utf-8'));
writeFileSync(pkgPath, bumpedPkg, 'utf-8');

const today = new Date().toISOString().slice(0, 10);
const bullet =
  '- **Template rebake** — re-captured `src/cc-template-data.json` after ' +
  'cc-drift-template-watch detected wire-fingerprint drift against a live CC capture. ' +
  'Bundled fallback template now matches the current CC wire shape.';

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

#!/usr/bin/env node
/**
 * Content-diff gate for an auto-rebake of the bundled CC template (dario#990).
 *
 * cc-drift-template-watch.yml runs this between capture-and-bake.mjs and
 * rebake-release-prep.mjs, in place of the `git diff --quiet` sanity check
 * that step used to rely on. That check asked the right question — "did the
 * bake actually change the bundle?" — of the wrong thing: `_captured` is
 * restamped by every bake, so the file is always textually dirty and the gate
 * could never fire.
 *
 * PR #990 is what that costs. A transient `--check` capture (whose base
 * matched the dario#881 residue signature) opened a rebake PR whose
 * src/cc-template-data.json was byte-identical to the previous release apart
 * from `_captured` — carrying a patch bump and a CHANGELOG entry announcing a
 * "wire-fingerprint drift" that was not in the diff. The tripwire warned a
 * human to check; nothing stopped the PR from existing.
 *
 * Compares the freshly-baked working-tree bundle against the committed one
 * key by key, ignoring TRANSIENT_TEMPLATE_FIELDS.
 *
 * Exits: 0 the bake ships real content (changed keys listed on stdout)
 *        1 content-empty — caller should skip the PR
 *        2 usage / git error (also treated as skip-worthy by the caller)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { meaningfulTemplateKeys, TRANSIENT_TEMPLATE_FIELDS } from './drift-report.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'src/cc-template-data.json';

let committed;
try {
  committed = JSON.parse(
    execFileSync('git', ['show', `HEAD:${REL}`], { cwd: repoRoot, encoding: 'utf-8' }),
  );
} catch (err) {
  console.error(`error: cannot read HEAD:${REL} — ${err.message}`);
  process.exit(2);
}

let baked;
try {
  baked = JSON.parse(readFileSync(join(repoRoot, REL), 'utf-8'));
} catch (err) {
  console.error(`error: cannot read the freshly-baked ${REL} — ${err.message}`);
  process.exit(2);
}

const changed = meaningfulTemplateKeys(committed, baked);

if (changed.length === 0) {
  const ignored = [...TRANSIENT_TEMPLATE_FIELDS].join(', ');
  console.error(
    `::warning title=content-empty rebake::--check reported drift but the bake produced no content change vs HEAD (only ${ignored} moved) — transient capture, skipping PR. See dario#990.`,
  );
  console.error('');
  console.error('CONTENT-EMPTY REBAKE (dario#990)');
  console.error(`  every key of ${REL} except ${ignored} is identical to HEAD.`);
  console.error('  The --check capture that triggered this rebake did not survive');
  console.error('  the bake\'s own capture, so there is nothing to ship. Opening a PR');
  console.error('  here would cut a release whose CHANGELOG claims a wire-shape change');
  console.error('  that is not in its diff.');
  process.exit(1);
}

console.log(changed.join(' '));

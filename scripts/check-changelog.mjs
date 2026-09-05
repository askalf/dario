// A PR that changes shipping code must say so in CHANGELOG.md.
//
// WHY THIS EXISTS. v6.0.22 (2026-09-05) shipped six codex changes and the
// release notes listed two: four PRs touched src/ and never added a bullet,
// so the generated GitHub Release under-reported what users were getting.
// The convention ("land changes under ## [Unreleased]") was written down in
// CHANGELOG.md's header and in the PR template, and four of six PRs skipped
// it anyway — advice is not a gate. This is the gate.
//
// Rule: if the PR diff touches anything under src/, CHANGELOG.md at HEAD must
// carry at least one bullet that BASE did not have, either under
// `## [Unreleased]` or under a release heading that did not exist at BASE
// (a version-bump PR renames Unreleased to the new version and files its
// bullets there). Merely touching the file is not enough — fixing a typo in
// an old entry, or deleting text, does not describe the change (review
// finding on #1217). Escape hatch: the `no-changelog` label, for refactors
// and test-only shuffles that genuinely change nothing a user can observe.
//
// Runs on pull_request only (a push to master has no diff base to judge).
// Inputs via env so it is trivially runnable by hand:
//   BASE_SHA  the PR base commit (fetched by the workflow)
//   HEAD_SHA  the PR head commit
//   PR_LABELS comma-separated label names (may be empty)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHANGELOG = 'CHANGELOG.md';
const UNRELEASED = /^## \[unreleased\]/i;
const HEADING = /^## /;
const BULLET = /^- /;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' });
}

/** Read a file at a commit; '' when it does not exist there. */
function fileAt(sha, path) {
  try { return git(['show', `${sha}:${path}`]); } catch { return ''; }
}

/**
 * Section heading → set of bullet lines (trimmed, first line of each bullet
 * only — a multi-line bullet's continuation lines are not bullets).
 * Exported for the unit test.
 */
export function sectionsOf(text) {
  const out = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (HEADING.test(line)) {
      current = line.trim();
      if (!out.has(current)) out.set(current, new Set());
      continue;
    }
    if (current !== null && BULLET.test(line)) out.get(current).add(line.trim());
  }
  return out;
}

/**
 * Bullets present at HEAD that BASE lacked, counting only sections a PR is
 * allowed to write release notes into: `## [Unreleased]`, or a heading that is
 * new at HEAD (the version a bump PR just cut). A bullet added to an OLD
 * release's section is a history edit, not a release note for this change.
 */
export function newReleaseNoteBullets(baseText, headText) {
  const base = sectionsOf(baseText);
  const head = sectionsOf(headText);
  const baseUnreleased = new Set();
  for (const [h, bullets] of base) if (UNRELEASED.test(h)) for (const b of bullets) baseUnreleased.add(b);
  const added = [];
  for (const [h, bullets] of head) {
    const writable = UNRELEASED.test(h) || !base.has(h);
    if (!writable) continue;
    for (const b of bullets) {
      // A bump PR moves Unreleased bullets under the new heading; those are
      // not new notes for THIS PR, so they are excluded too.
      if (baseUnreleased.has(b)) continue;
      if (base.get(h)?.has(b)) continue;
      added.push(b);
    }
  }
  return added;
}

export function main(env = process.env) {
  const base = env.BASE_SHA;
  const head = env.HEAD_SHA || 'HEAD';
  const labels = (env.PR_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!base) {
    console.log('check-changelog: no BASE_SHA — not a pull_request run, nothing to judge.');
    return 0;
  }
  if (labels.includes('no-changelog')) {
    console.log('check-changelog: `no-changelog` label present — skipped by request.');
    return 0;
  }

  const files = git(['diff', '--name-only', base, head]).split('\n').map((s) => s.trim()).filter(Boolean);
  const shipping = files.filter((f) => f.startsWith('src/'));
  if (shipping.length === 0) {
    console.log('check-changelog: no src/ changes — nothing to record.');
    return 0;
  }

  const added = files.includes(CHANGELOG)
    ? newReleaseNoteBullets(fileAt(base, CHANGELOG), fileAt(head, CHANGELOG))
    : [];
  if (added.length > 0) {
    console.log(`check-changelog: ${shipping.length} src/ file(s) changed; ${added.length} new release-note bullet(s) found — ok.`);
    for (const b of added) console.log(`  ${b.slice(0, 100)}`);
    return 0;
  }

  console.error(`FAIL: ${shipping.length} shipping file(s) changed with no new CHANGELOG bullet:`);
  for (const f of shipping) console.error(`  ${f}`);
  console.error('');
  if (files.includes(CHANGELOG)) {
    console.error('CHANGELOG.md was edited, but nothing new was added under `## [Unreleased]` (or a new release heading).');
    console.error('Editing an older entry does not describe this change.');
  }
  console.error('Add a bullet under `## [Unreleased]` in CHANGELOG.md describing the user-visible change,');
  console.error('or apply the `no-changelog` label if there genuinely is none (pure refactor, test-only).');
  return 1;
}

// Run when invoked directly; importable (for the test) without side effects.
// Compared as URLs, not by basename — the unit test file shares this name.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

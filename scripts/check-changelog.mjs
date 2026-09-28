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
//   BASE_SHA  the PR base branch tip (fetched by the workflow)
//   HEAD_SHA  what to judge — in CI the pull_request MERGE commit Actions
//             checked out (github.sha), so the diff is "base with this PR
//             applied", never a stale head against a moved base
//   PR_LABELS comma-separated label names (may be empty)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHANGELOG = 'CHANGELOG.md';
const UNRELEASED = /^## \[unreleased\]/i;
/** A release heading as this repo writes them: `## [6.0.23] - 2026-09-05`. Only
 *  these (when new at HEAD) count as a place to file release notes — an
 *  arbitrary new `## Notes` heading is not a release section (review on #1217). */
export const RELEASE = /^## \[\d+\.\d+\.\d+\](?:\s+-\s+\d{4}-\d{2}-\d{2})?$/;
const HEADING = /^## /;
const BULLET = /^- /;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' });
}

/** Read a file at a commit; '' when it does not exist there. */
function fileAt(sha, path) {
  // stderr piped: a path missing at a commit is an expected '' here, not noise.
  try { return execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return ''; }
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
 * allowed to write release notes into: `## [Unreleased]`, or a RELEASE heading
 * (`## [x.y.z] - date`) that is new at HEAD (the version a bump PR just cut).
 * A bullet added to an OLD release's section is a history edit, and a bullet
 * under some other new heading (`## Notes`) is not a release note at all.
 */
export function newReleaseNoteBullets(baseText, headText) {
  const base = sectionsOf(baseText);
  const head = sectionsOf(headText);
  const baseUnreleased = new Set();
  for (const [h, bullets] of base) if (UNRELEASED.test(h)) for (const b of bullets) baseUnreleased.add(b);
  // Every bullet at HEAD in a section this PR may write release notes into.
  const eligible = [];
  for (const [h, bullets] of head) {
    const writable = UNRELEASED.test(h) || (RELEASE.test(h) && !base.has(h));
    if (!writable) continue;
    for (const b of bullets) eligible.push(b);
  }
  // The gate is a COUNT, not a string comparison (third review on #1217):
  // rewording an existing Unreleased bullet changes its text without adding a
  // note, and by text alone that reads as "new". A bump PR that only MOVES the
  // Unreleased bullets under the freshly cut heading keeps the count equal too,
  // so it adds nothing — while a bump that carries its own bullet grows it.
  if (eligible.length <= baseUnreleased.size) return [];
  // Report the ones that are textually new, for the log line.
  return eligible.filter((b) => !baseUnreleased.has(b));
}

/**
 * The commit to diff FROM. The PR's own changes are HEAD relative to the point
 * it forked from base, not relative to base's CURRENT tip: with a two-dot diff
 * against the tip, an unrelated src/ commit merged after the fork shows up in
 * reverse and fails a docs-only PR (third review on #1217). Prefer the merge
 * base; in CI HEAD is the pull_request MERGE commit (github.sha) whose first
 * parent is base, so falling back to base itself is exact there too.
 */
export function diffFrom(base, head) {
  try { return git(['merge-base', base, head]).trim() || base; } catch { return base; }
}

/**
 * What stops a version-bump PR's release notes from being whole, as
 * human-readable lines; empty when they are. The bump is the release and its
 * GitHub Release body is the new version's section, so at HEAD:
 *   - `## [Unreleased]` holds nothing: a bullet left there ships its code in
 *     this release and its note in none (fold-unreleased.mjs moves it);
 *   - the new version has a section with at least one bullet, or the release
 *     publishes with "(no changelog section found for this version)".
 */
export function releaseNoteProblems(headText, version) {
  const problems = [];
  const sections = sectionsOf(headText);
  let pending = 0;
  let own = null;
  let current = null;
  for (const raw of headText.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (HEADING.test(line)) { current = line.trim(); continue; }
    if (current !== null && UNRELEASED.test(current) && line.trim() !== '' && !/^### /.test(line)) pending++;
  }
  for (const [h, bullets] of sections) {
    if (RELEASE.test(h) && h.startsWith(`## [${version}]`)) { own = bullets; break; }
  }
  if (pending > 0) {
    problems.push(`\`## [Unreleased]\` still holds ${pending} line(s) of notes. This release ships that code but its notes would sit in no release. Run \`node scripts/fold-unreleased.mjs\` to move them into ## [${version}].`);
  }
  if (own === null) problems.push(`no \`## [${version}] - YYYY-MM-DD\` section for the version package.json now carries.`);
  else if (own.size === 0 && pending === 0) problems.push(`\`## [${version}]\` has no bullets, so the release would publish with no notes.`);
  return problems;
}

function versionAt(sha) {
  try { return JSON.parse(fileAt(sha, 'package.json')).version ?? null; } catch { return null; }
}

export function main(env = process.env) {
  const base = env.BASE_SHA;
  const head = env.HEAD_SHA || 'HEAD';
  const labels = (env.PR_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!base) {
    console.log('check-changelog: no BASE_SHA — not a pull_request run, nothing to judge.');
    return 0;
  }
  // A version bump is a release whatever else the PR touches, and the label
  // below is for refactors that change nothing a user sees, so this runs
  // first and nothing skips it.
  const from = diffFrom(base, head);
  const headVersion = versionAt(head);
  if (headVersion !== null && headVersion !== versionAt(from)) {
    const problems = releaseNoteProblems(fileAt(head, CHANGELOG), headVersion);
    if (problems.length > 0) {
      console.error(`FAIL: this PR releases ${headVersion} without all of its notes:`);
      for (const p of problems) console.error(`  ${p}`);
      return 1;
    }
    console.log(`check-changelog: releases ${headVersion}; \`## [Unreleased]\` is empty and its section has notes — ok.`);
  }

  if (labels.includes('no-changelog')) {
    console.log('check-changelog: `no-changelog` label present — skipped by request.');
    return 0;
  }

  const files = git(['diff', '--name-only', from, head]).split('\n').map((s) => s.trim()).filter(Boolean);
  const shipping = files.filter((f) => f.startsWith('src/'));
  if (shipping.length === 0) {
    console.log('check-changelog: no src/ changes — nothing to record.');
    return 0;
  }

  const added = files.includes(CHANGELOG)
    ? newReleaseNoteBullets(fileAt(from, CHANGELOG), fileAt(head, CHANGELOG))
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

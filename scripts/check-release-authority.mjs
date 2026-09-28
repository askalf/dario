// An outside contributor's PR may not cut a release.
//
// WHY THIS EXISTS. The version bump on master IS the release: the merge fires
// cc-drift-auto-release, which tags, cuts a GitHub Release and publishes to
// npm and GHCR with no further human step (RELEASING.md). dario#1450, a fork
// PR, bumped package.json to 6.12.8 on its own while addressing review (the
// review never asked for it), and merging the fix shipped a release its
// author had decided on. Nothing stopped it; version-bump-advice had in fact
// told every PR, forks included, to add the bump. Whether and when to ship is
// the maintainer's call. This is the gate.
//
// Rule: a PR whose head lives on a fork, opened by someone who is not an
// OWNER / MEMBER / COLLABORATOR, fails when it changes the version in
// package.json or package-lock.json, or adds a release heading
// (`## [x.y.z] - date`) to CHANGELOG.md. Its notes go under `## [Unreleased]`
// and a maintainer cuts the release afterwards. Same-repo branches are exempt:
// pushing one takes write access, and the drift bots' bump PRs are built that
// way. No label escape hatch: a maintainer who wants a contributor's bump
// can push it to the branch, and it still has to be their decision.
//
// Inputs via env so it is trivially runnable by hand:
//   BASE_SHA            the PR base branch tip (fetched by the workflow)
//   HEAD_SHA            what to judge; in CI the pull_request merge commit
//   HEAD_REPO           owner/repo the PR head lives in
//   GITHUB_REPOSITORY   owner/repo of this repository
//   AUTHOR_ASSOCIATION  the PR author's association with this repository
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sectionsOf, diffFrom, RELEASE } from './check-changelog.mjs';

/** Associations that may decide a release. */
export const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function fileAt(sha, path) {
  try { return execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf-8' }); } catch { return ''; }
}

function jsonAt(sha, path) {
  try { return JSON.parse(fileAt(sha, path)); } catch { return null; }
}

/** True when the PR is an outside contributor's: fork head AND no maintainer association. */
export function isOutsideContributor({ headRepo, baseRepo, association }) {
  if (headRepo && baseRepo && headRepo === baseRepo) return false;
  return !MAINTAINER_ASSOCIATIONS.has(association ?? '');
}

/** Release headings present at HEAD that BASE did not have. */
export function newReleaseHeadings(baseText, headText) {
  const base = sectionsOf(baseText);
  return [...sectionsOf(headText).keys()].filter((h) => RELEASE.test(h) && !base.has(h));
}

/**
 * Every release-cutting change between two states of the three files, as
 * human-readable lines. Empty when the PR leaves the release alone.
 */
export function releaseChanges({ basePkg, headPkg, baseLock, headLock, baseLog, headLog }) {
  const out = [];
  if (basePkg?.version !== headPkg?.version) {
    out.push(`package.json version ${basePkg?.version} -> ${headPkg?.version}`);
  }
  if (baseLock?.version !== headLock?.version) {
    out.push(`package-lock.json version ${baseLock?.version} -> ${headLock?.version}`);
  }
  const baseRoot = baseLock?.packages?.['']?.version;
  const headRoot = headLock?.packages?.['']?.version;
  if (baseRoot !== headRoot) {
    out.push(`package-lock.json packages[""].version ${baseRoot} -> ${headRoot}`);
  }
  for (const h of newReleaseHeadings(baseLog, headLog)) out.push(`CHANGELOG.md adds release heading "${h}"`);
  return out;
}

export function main(env = process.env) {
  const base = env.BASE_SHA;
  const head = env.HEAD_SHA || 'HEAD';
  if (!base) {
    console.log('check-release-authority: no BASE_SHA — not a pull_request run, nothing to judge.');
    return 0;
  }
  const who = { headRepo: env.HEAD_REPO, baseRepo: env.GITHUB_REPOSITORY, association: env.AUTHOR_ASSOCIATION };
  if (!isOutsideContributor(who)) {
    console.log(`check-release-authority: ${who.association || 'unknown'} on ${who.headRepo || 'this repo'} — may cut a release.`);
    return 0;
  }

  const from = diffFrom(base, head);
  const changes = releaseChanges({
    basePkg: jsonAt(from, 'package.json'),
    headPkg: jsonAt(head, 'package.json'),
    baseLock: jsonAt(from, 'package-lock.json'),
    headLock: jsonAt(head, 'package-lock.json'),
    baseLog: fileAt(from, 'CHANGELOG.md'),
    headLog: fileAt(head, 'CHANGELOG.md'),
  });
  if (changes.length === 0) {
    console.log('check-release-authority: outside contributor, no release-cutting change — ok.');
    return 0;
  }

  console.error('FAIL: this PR would cut a release when it merges:');
  for (const c of changes) console.error(`  ${c}`);
  console.error('');
  console.error('Merging a version bump publishes to npm and GHCR with no further step, so a maintainer');
  console.error('decides when to ship. Revert the version in package.json and package-lock.json, and put');
  console.error('your CHANGELOG bullet under `## [Unreleased]` instead of a new release heading.');
  return 1;
}

// Run when invoked directly; importable (for the test) without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

#!/usr/bin/env node
// Pick out the cc-drift PRs that a newly-opened one supersedes.
//
// WHY THIS EXISTS. cc-drift-watch runs hourly. It already skips re-drafting
// when a PR for *its own* branch is open, but it never looked at the older
// sibling branches — so whenever CC moved again before the previous drift PR
// merged, the old PR stayed open forever.
//
// That is not merely untidy, it is actively wrong. An older drift PR carries a
// LOWER `maxTested` and an OLDER package version, so merging it walks master
// backwards. #966 (maxTested 2.1.231, v5.5.14) sat open for a day while #970
// (2.1.232, same v5.5.14) and then #973 (v5.5.15) landed. It went conflicted,
// still collected an approving review, and had to be closed by hand.
//
// The selection is kept pure and tested here; the actual `gh pr close` calls
// stay in the workflow. Same split as scripts/resolve-release-conflicts.mjs.
//
// CLI: reads `gh pr list --json number,headRefName` on stdin, takes the new
// branch as argv[2], prints one PR number per line (nothing when none apply).
//
//   gh pr list --state open --json number,headRefName \
//     | node scripts/close-superseded-drift-prs.mjs "bot/cc-drift-v2.1.232"

import { pathToFileURL } from 'node:url';
import { isOlderThan } from './_drift-patch-helpers.mjs';

export const DRIFT_BRANCH_PREFIX = 'bot/cc-drift-v';

/** Version out of `bot/cc-drift-v2.1.231`, or null when it is not one of ours. */
export function versionFromBranch(branch) {
  if (typeof branch !== 'string' || !branch.startsWith(DRIFT_BRANCH_PREFIX)) return null;
  const v = branch.slice(DRIFT_BRANCH_PREFIX.length);
  // Guard against `bot/cc-drift-vfoo` and against a trailing suffix that would
  // make isOlderThan's parseInt silently read NaN -> 0 and mis-rank the branch.
  return /^\d+(\.\d+)*$/.test(v) ? v : null;
}

/**
 * Which open PRs does `newBranch` supersede?
 *
 * Strictly older only. A same-version PR is the caller's own (the workflow
 * already exits early on that), and a NEWER one must never be closed — if the
 * watcher ever runs out of order, silently closing the ahead PR would be the
 * expensive failure, so the comparison refuses rather than guesses.
 *
 * @param {Array<{number:number, headRefName:string}>} openPrs
 * @param {string} newBranch
 * @returns {Array<{number:number, branch:string, version:string}>}
 */
export function selectSupersededPrs(openPrs, newBranch) {
  const newVersion = versionFromBranch(newBranch);
  if (!newVersion) return [];

  const out = [];
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    if (!pr || typeof pr.number !== 'number') continue;
    if (pr.headRefName === newBranch) continue;
    const version = versionFromBranch(pr.headRefName);
    if (!version) continue;
    if (!isOlderThan(version, newVersion)) continue;
    out.push({ number: pr.number, branch: pr.headRefName, version });
  }
  // Oldest first, so the log reads in the order they were overtaken.
  out.sort((a, b) => (isOlderThan(a.version, b.version) ? -1 : 1));
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Run the CLI only when invoked directly, so the test can import the pure
// helpers above without this block swallowing stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const newBranch = process.argv[2];
  if (!newBranch) {
    console.error('usage: close-superseded-drift-prs.mjs <new-branch>  (PR JSON on stdin)');
    process.exit(2);
  }
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let parsed = [];
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    // A malformed listing must not fail the run: the new PR is already open and
    // auto-merging by this point. Emit nothing and let the workflow continue.
    console.error('could not parse PR listing; closing nothing');
    process.exit(0);
  }
  for (const pr of selectSupersededPrs(parsed, newBranch)) {
    console.log(pr.number);
  }
}

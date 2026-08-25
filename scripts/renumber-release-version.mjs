#!/usr/bin/env node
// Renumber a drift-bot PR's release version above the base branch tip.
//
// THE GAP THIS FILLS. Every drafter (auto-draft-drift-fix, label-sync,
// rebake-release-prep) computes its bump with bumpPackageJsonPatch() off the
// package.json in its own checkout — i.e. off master AT DRAFT TIME. Two PRs
// drafted before either merges therefore claim the SAME version (#954/#955
// both took 5.5.10 off 5.5.9), and a PR drafted before an unrelated release
// lands claims one that is already published (#1027 bumped 5.5.24 -> 5.5.25
// with v5.5.25 already tagged and on npm).
//
// version-advances.sh already catches that and refuses to auto-merge the
// loser, which is correct — merging it would either fast-exit the duplicate-
// tag guard green having shipped nothing, or move master's version BACKWARDS
// below a published tag. But refusing is where the automation stopped: nothing
// renumbers the loser, so it sits open, goes BEHIND as master moves, and waits
// for a human. That wait is the backlog. With required reviews on master, the
// hand-fix also pushes a commit, which dismisses any approval it had collected
// and sends it back to the review queue — so each collision costs a full round
// trip, and collisions arrive faster than rounds complete.
//
// This is the "recompute the patch from origin/master at merge time" half.
// The rule is mechanical, so it lives in a script rather than in a prompt or a
// maintainer's head:
//
//   version > floor   -> leave everything alone (already advances)
//   version <= floor  -> set version to bumpPatch(floor), rename the
//                        CHANGELOG heading that carried the old version, and
//                        mirror the new version into package-lock.json's two
//                        version slots (root and packages[""]) so the three
//                        files never disagree
//
// REFUSES rather than guesses when the CHANGELOG does not carry exactly one
// heading for the version being replaced. A renumbered package.json whose
// CHANGELOG still announces the old version is worse than an untouched PR: it
// ships a release whose notes name a different version.
//
// Usage:
//   node scripts/renumber-release-version.mjs <floor-version> [--pkg P] [--changelog C] [--lock L]
//
// Exit 0 = files are correct for a release above <floor-version>. Prints
//          "renumbered <before> -> <after>" or "unchanged <version>".
// Exit 1 = refused; the working tree is left exactly as it was found.

import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bumpPatch } from './_drift-patch-helpers.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// CRLF is load-bearing, for the same reason resolve-release-conflicts.mjs
// spells it out: a Windows checkout leaves headings as "## [1.2.3] - x\r", and
// a `$`-anchored match without normalization silently finds nothing. Silently
// finding nothing here means "no heading to rename", which routes to a REFUSAL
// rather than a bad write — safe, but it would make the script useless on a
// Windows runner for reasons no log line would explain.
const detectEol = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const toLf = (t) => t.replace(/\r\n/g, '\n');
const restoreEol = (t, eol) => (eol === '\r\n' ? t.replace(/\n/g, '\r\n') : t);

/**
 * Escape every RegExp metacharacter, backslash included.
 *
 * `before` is already validated as X.Y.Z before this runs, so no backslash can
 * reach the pattern today. Escaping only `.` still made the safety of that line
 * depend on a precondition established forty lines away — the kind of coupling
 * that holds right up until someone relaxes the validator. CodeQL flags the
 * narrow version as js/incomplete-sanitization and is right to.
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse "1.2.3" into comparable numeric parts, or null when not X.Y.Z. */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true iff a > b. Both must be X.Y.Z. */
export function isGreater(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a X.Y.Z version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/**
 * Pure core. Returns the rewritten texts, or a refusal.
 *
 * `floor` is the version this PR must land ABOVE — the base branch tip. The
 * result is always strictly greater than it, which is exactly the predicate
 * version-advances.sh applies, so the two cannot disagree about what "safe"
 * means.
 */
export function renumber(pkgJsonString, changelogText, floor, lockJsonString) {
  const pkg = JSON.parse(pkgJsonString);
  if (typeof pkg.version !== 'string') {
    return { ok: false, reason: 'package.json has no version field' };
  }
  if (!parseVersion(pkg.version)) {
    return { ok: false, reason: `package.json version is not X.Y.Z: ${pkg.version}` };
  }
  if (!parseVersion(floor)) {
    return { ok: false, reason: `floor version is not X.Y.Z: ${floor}` };
  }

  const before = pkg.version;
  if (isGreater(before, floor)) {
    return { ok: true, changed: false, before, after: before, reason: `${before} already advances past ${floor}` };
  }

  const after = bumpPatch(floor);

  // The CHANGELOG must carry exactly one heading for the version we are
  // replacing. Zero means the drafter did not promote a section (or already
  // renamed it) and we would be renumbering a package.json whose notes say
  // nothing; more than one means the file is malformed and picking a heading
  // would be a guess.
  const eol = detectEol(changelogText);
  const lf = toLf(changelogText);
  const headingRe = new RegExp(`^## \\[${escapeRegExp(before)}\\]`, 'gm');
  const hits = lf.match(headingRe);
  if (!hits || hits.length !== 1) {
    return {
      ok: false,
      reason: `CHANGELOG has ${hits ? hits.length : 0} headings for ${before}; expected exactly 1`,
    };
  }
  const newChangelog = restoreEol(lf.replace(headingRe, `## [${after}]`), eol);

  const pkgEol = detectEol(pkgJsonString);
  pkg.version = after;
  const newPkg = restoreEol(JSON.stringify(pkg, null, 2) + '\n', pkgEol);

  // package-lock.json carries the SAME version twice (root `.version` and
  // `.packages[""].version`). Renumbering package.json without it leaves the
  // two disagreeing — real drift, which `npm run preflight` now fails on, so a
  // healed PR would go red on a defect the healer itself introduced.
  //
  // Unlike the CHANGELOG above, this needs no refusal. Those slots are not
  // independent information: they MIRROR package.json's version by
  // definition. Writing `after` into them is derivation, not a guess, so
  // there is nothing here to get wrong by assuming. Slots that are absent are
  // simply left alone rather than invented.
  let newLock;
  if (typeof lockJsonString === 'string' && lockJsonString.length > 0) {
    const lockEol = detectEol(lockJsonString);
    const lock = JSON.parse(lockJsonString);
    if (typeof lock.version === 'string') lock.version = after;
    if (lock.packages && lock.packages[''] && typeof lock.packages[''].version === 'string') {
      lock.packages[''].version = after;
    }
    newLock = restoreEol(JSON.stringify(lock, null, 2) + '\n', lockEol);
  }

  return { ok: true, changed: true, before, after, pkg: newPkg, changelog: newChangelog, lock: newLock, reason: `${before} -> ${after} (floor ${floor})` };
}

export function main(argv) {
  const floor = argv.find((a) => !a.startsWith('--'));
  if (!floor) {
    console.error('usage: renumber-release-version.mjs <floor-version> [--pkg P] [--changelog C]');
    return 1;
  }
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const pkgPath = flag('--pkg', join(repoRoot, 'package.json'));
  const clPath = flag('--changelog', join(repoRoot, 'CHANGELOG.md'));
  const lockPath = flag('--lock', join(repoRoot, 'package-lock.json'));

  let result;
  try {
    // The lockfile is optional: a checkout without one still renumbers, it
    // just has no third slot to keep in step.
    const lockText = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8') : undefined;
    result = renumber(readFileSync(pkgPath, 'utf-8'), readFileSync(clPath, 'utf-8'), floor, lockText);
  } catch (err) {
    console.error(`[renumber] refused: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!result.ok) {
    console.error(`[renumber] refused: ${result.reason}`);
    return 1;
  }
  if (!result.changed) {
    console.error(`[renumber] unchanged ${result.before} — ${result.reason}`);
    return 0;
  }
  // All writes or none: a renumbered package.json beside a CHANGELOG still
  // announcing the old version -- or beside a lockfile still carrying it -- is
  // the one outcome worse than not running.
  writeFileSync(pkgPath, result.pkg);
  writeFileSync(clPath, result.changelog);
  if (result.lock !== undefined) writeFileSync(lockPath, result.lock);
  console.error(`[renumber] renumbered ${result.before} -> ${result.after}`);
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main(process.argv.slice(2)));

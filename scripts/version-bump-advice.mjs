#!/usr/bin/env node
/**
 * version-bump-advice — does THIS PR need a package.json version bump?
 *
 * WHY THIS EXISTS. cc-drift-auto-release only ships when package.json's
 * version moves on master. A PR that changes shipping code without bumping is
 * therefore green everywhere — CI passes, mergeable is clean, the merge
 * succeeds — and then releases NOTHING. The defect is invisible until an
 * after-the-fact sweep notices the deployed version never moved; seven PRs in
 * the 48h to 2026-08-30 (#1153, #1151, #1150, #1147, #1139, #1131, #1010)
 * landed or sat in exactly that state.
 *
 * The gate is correct and stays as it is. What was missing is VISIBILITY at
 * the moment it can still be acted on cheaply, i.e. while the PR is open. So
 * this is advisory: it decides, the workflow comments, nothing blocks.
 *
 * THE RULE. A PR needs a bump when it touches a file that reaches users, and
 * its head version equals its base version. "Reaches users" is derived from
 * what actually ships:
 *
 *   - package.json `files` (dist, docs, README.md, LICENSE) — the npm tarball;
 *     dist/ is built from src/, so src/ is the real source entry. `files` also
 *     carries NEGATIONS (`!docs/recovery.md`), which are exclusions from the
 *     tarball and so must be exclusions here too.
 *   - the Docker image inputs (Dockerfile, docker-entrypoint.sh) — the GHCR
 *     leg of the same release pipeline. Note the image copies src/ and
 *     package.json only; it carries no docs, so a doc excluded from the
 *     tarball reaches a user by neither route.
 *   - package.json / package-lock.json themselves — a dependency change is
 *     shipped code even when no first-party line moved.
 *
 * Everything else (test/, .github/, scripts/, tools/, fuzz/, reviews/, the
 * root docs that are not README) changes nothing a user can install, so
 * nagging about it would train people to ignore the comment. CHANGELOG.md is
 * exempt for the same reason AND because a bump always carries one, so
 * counting it would make every bump PR self-justifying.
 *
 * Ordering ("is this version above the tip?") is a different question with a
 * different answer, already enforced by scripts/version-advances.sh. This
 * script only asks whether a bump is PRESENT.
 *
 * Usage:
 *   node scripts/version-bump-advice.mjs <base_ver> <head_ver> [files-file]
 *
 * `files-file` is a newline-delimited list of changed paths; omit it (or pass
 * `-`) to read the list from stdin.
 *
 * Writes exactly TWO lines to stdout, matching version-advances.sh:
 *   1  needs_bump  "true" | "false"
 *   2  reason      short human-readable explanation
 *
 * Exit status is 0 for a decision of either kind; non-zero means it could not
 * decide, which callers must treat as "say nothing" — an advisory that guesses
 * is worse than one that stays quiet.
 */
import { readFileSync } from 'node:fs';

/**
 * Paths that never reach an installed artifact. Prefix match on the repo-
 * relative path, plus an exact-name list for root files.
 */
const EXEMPT_PREFIXES = [
  'test/',
  '.github/',
  'scripts/',
  'tools/',
  'fuzz/',
  'reviews/',
  'cloudflare/',
  'redis-lock/',
];

const EXEMPT_FILES = new Set([
  'CHANGELOG.md',
  'CLAUDE.md',
  'CODEOWNERS',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'DISCLAIMER.md',
  'MIGRATION.md',
  'RELEASING.md',
  'SECURITY.md',
  'STABILITY.md',
  '.gitignore',
  '.npmignore',
  '.dockerignore',
  // Mirrors the `!docs/recovery.md` negation in package.json `files`: docs/
  // ships, this one file explicitly does not. The list is static rather than
  // read from the manifest because the workflow sparse-checks out only this
  // script — package.json is not on disk when it runs. test/version-bump-
  // advice.mjs pins the two together, so adding a negation to `files` without
  // adding it here fails CI.
  'docs/recovery.md',
]);

/** True when changing this path can change what a user installs or runs. */
export function shipsToUsers(path) {
  if (!path) return false;
  if (EXEMPT_FILES.has(path)) return false;
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return false;
  return true;
}

/**
 * The `files` negations this script claims to mirror, for the manifest-drift
 * test. Exported rather than derived at runtime for the sparse-checkout reason
 * above.
 */
export const MANIFEST_EXCLUSIONS = ['docs/recovery.md'];

/**
 * @param {string} baseVer  version at the PR's merge base
 * @param {string} headVer  version the PR proposes
 * @param {string[]} files  changed paths, repo-relative
 * @returns {{ needsBump: boolean, reason: string, shipping: string[] }}
 */
export function adviseBump(baseVer, headVer, files) {
  const shipping = (files ?? []).filter(shipsToUsers);

  if (headVer !== baseVer) {
    return {
      needsBump: false,
      reason: `version bumped ${baseVer} -> ${headVer}`,
      shipping,
    };
  }
  if (shipping.length === 0) {
    return {
      needsBump: false,
      reason: 'no shipping files changed - a release would carry nothing',
      shipping,
    };
  }
  const sample = shipping.slice(0, 3).join(', ');
  const more = shipping.length > 3 ? ` (+${shipping.length - 3} more)` : '';
  return {
    needsBump: true,
    reason: `version stays at ${baseVer} but ${shipping.length} shipping file(s) changed: ${sample}${more}`,
    shipping,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Guarded so the test file can import the pure functions above without the
// argv handling running, same shape as scripts/drift-report.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [baseVer, headVer, filesArg] = process.argv.slice(2);

  // Fail CLOSED, and "closed" for an advisory means SILENT: a caller that
  // could not read a version must not post a comment guessing at one.
  if (!baseVer || !headVer) {
    console.error('usage: version-bump-advice.mjs <base_ver> <head_ver> [files-file]');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(!filesArg || filesArg === '-' ? 0 : filesArg, 'utf8');
  } catch (e) {
    console.error(`could not read changed-file list: ${e.message}`);
    process.exit(2);
  }

  const files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  const { needsBump, reason } = adviseBump(baseVer, headVer, files);
  process.stdout.write(`${needsBump}\n${reason}\n`);
}

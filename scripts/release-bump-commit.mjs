#!/usr/bin/env node
/**
 * Find the commit that set package.json to the version being released.
 *
 * cc-drift-auto-release.yml names a release after the PR that bumped the
 * version and, from that PR's head branch, decides whether the release is a
 * pre-release (a bot/* head). It used to read the PR off HEAD, which is the
 * bump only when nothing merged after it: a docs PR landing between a bot
 * bump and the hourly tick would have named the release and turned the bot's
 * build into a regular release, and the reverse order would have marked a
 * person's release as a pre-release. So the PR is read off the bump commit:
 * the newest commit in the fetched history whose package.json carries the
 * version while its parent's does not.
 *
 *   node scripts/release-bump-commit.mjs <X.Y.Z> [--cwd <repo>] [--max <commits>]
 *
 * Prints one JSON object and exits 0 either way. Found:
 *   {"sha":"<40 hex>","subject":"...","prNumber":1234|null,"parentVersion":"6.16.0"}
 * Not found (the workflow then releases without PR context):
 *   {"sha":null,"reason":"..."}
 *
 * prNumber comes from the squash-merge subject suffix `(#N)`. A commit whose
 * parent is outside the fetched history (the boundary of a shallow clone)
 * cannot be judged and is skipped, so a clone too shallow to reach the bump
 * reports sha null rather than guessing. Only a usage error exits non-zero.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * package.json's version at a revision: the string, null when the file parses
 * but has no string version, undefined when the revision or the file cannot be
 * read (a parent outside a shallow clone, or no package.json yet).
 */
function versionAt(rev, cwd) {
  let text;
  try {
    text = git(['show', `${rev}:package.json`], cwd);
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(text).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The PR number a squash-merge subject ends with, `... (#123)`, or null. */
export function prNumberFromSubject(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The newest commit among the last `max` that touched package.json whose
 * version is `version` and whose parent's is not.
 */
export function findVersionBump(version, { cwd = process.cwd(), max = 50 } = {}) {
  const lines = git(['log', `--max-count=${max}`, '--format=%H%x1f%s', '--', 'package.json'], cwd)
    .split('\n')
    .filter(Boolean);
  if (lines.length === 0) return { sha: null, reason: 'no fetched commit touches package.json' };
  let boundary = 0;
  for (const line of lines) {
    const [sha, subject = ''] = line.split('\x1f');
    if (versionAt(sha, cwd) !== version) continue;
    const parentVersion = versionAt(`${sha}^`, cwd);
    if (parentVersion === undefined) {
      boundary++;
      continue;
    }
    if (parentVersion === version) continue;
    return { sha, subject, prNumber: prNumberFromSubject(subject), parentVersion };
  }
  return {
    sha: null,
    reason: boundary > 0
      ? `the commit that set ${version} has no fetched parent: the clone is too shallow to tell where ${version} began`
      : `no fetched commit sets package.json to ${version}`,
  };
}

export function parseArgs(args) {
  const out = { version: null, cwd: process.cwd(), max: 50 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cwd') out.cwd = args[++i];
    else if (a === '--max') out.max = Number(args[++i]);
    else if (out.version === null) out.version = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (typeof out.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(out.version)) {
    throw new Error('usage: release-bump-commit.mjs <X.Y.Z> [--cwd <repo>] [--max <commits>]');
  }
  if (typeof out.cwd !== 'string' || out.cwd === '') throw new Error('--cwd needs a directory');
  if (!Number.isInteger(out.max) || out.max < 1) throw new Error('--max needs a positive integer');
  return out;
}

// CLI only when invoked directly (not when imported by tests); the URL compare
// is the cross-platform form extract-release-notes.mjs uses.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  console.log(JSON.stringify(findVersionBump(opts.version, { cwd: opts.cwd, max: opts.max })));
}

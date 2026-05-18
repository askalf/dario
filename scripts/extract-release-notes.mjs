#!/usr/bin/env node
// Extract a single version's section from CHANGELOG.md.
//
// Used by `cc-drift-auto-release.yml` to populate the GitHub release
// body so users see what was in the bump instead of a generic
// "see CHANGELOG" pointer.
//
// History: the original implementation was a `node -e` one-liner
// embedded directly in the workflow YAML. The regex used `/m` flag +
// lookahead on multiline `$`, which silently captured the empty
// string for every version (because every section begins with a blank
// separator line and `$` in /m matches before any `\n`). 39 releases
// shipped with empty bodies before the bug was caught. The fix lives
// here, in a real file that has real tests — `test/extract-release-
// notes.mjs` locks the empirical contract so the same class of bug
// can't ship again.
//
// CLI:
//   node scripts/extract-release-notes.mjs <version> < CHANGELOG.md
//   node scripts/extract-release-notes.mjs <version> --file <path>
//
// Stdin/file is the CHANGELOG markdown source. Stdout is the trimmed
// section body (or a "(no changelog section …)" sentinel if the
// version is absent or the section is empty). Always exits 0 — the
// caller is the GitHub release body, not a fail-or-pass gate.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FALLBACK = '(no changelog section found for this version)';

/**
 * Return the trimmed content of the `## [version]` section in
 * CHANGELOG markdown, or null if not present / empty after trim.
 *
 * The regex:
 *   (?:^|\n)## \[<verEsc>\][^\n]*\n([\s\S]*?)(?=\n## \[|$)
 *
 * Reads as: at start-of-string or after a newline, match the heading
 * line for this version, then lazily capture everything up to the
 * next `## [` heading (or end-of-string for the latest entry).
 *
 * Why this shape:
 *   - `(?:^|\n)` instead of `^` with /m flag: with /m, `$` in the
 *     lookahead would match before any `\n`, including the blank
 *     separator line right after the heading, collapsing the lazy
 *     capture to "". Without /m, `$` matches only end-of-string,
 *     which is what the lookahead intends.
 *   - `\d{1,2}` is NOT used here because version segments can be 2+
 *     digits (e.g., `3.38.10`). The escape `version.replace(/\./g,
 *     '\\.')` handles the regex metachar.
 *   - `[^\n]*` after the closing `]` tolerates date suffixes like
 *     ` - 2026-05-15` on the heading line without committing to a
 *     specific format.
 */
export function extractReleaseNotes(md, version) {
  if (typeof md !== 'string' || typeof version !== 'string' || version.length === 0) {
    return null;
  }
  const verEsc = version.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)## \\[${verEsc}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`,
  );
  const m = re.exec(md);
  if (!m) return null;
  const trimmed = m[1].trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * CLI entry. Reads CHANGELOG markdown from stdin (default) or from
 * `--file <path>`, writes the section (or the fallback sentinel) to
 * stdout, exits 0.
 */
function runCli(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stderr.write(
      'Usage: extract-release-notes.mjs <version> [--file CHANGELOG.md]\n' +
      '  Reads stdin if --file is not given.\n' +
      '  Always exits 0; prints fallback sentinel if the version section is missing or empty.\n'
    );
    return 0;
  }
  const version = args[0];
  let md = '';
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0 && args[fileIdx + 1]) {
    try {
      md = readFileSync(args[fileIdx + 1], 'utf-8');
    } catch (err) {
      process.stderr.write(`extract-release-notes: cannot read ${args[fileIdx + 1]}: ${err.message}\n`);
      process.stdout.write(FALLBACK);
      return 0;
    }
  } else {
    md = readFileSync(0, 'utf-8');
  }
  const section = extractReleaseNotes(md, version);
  process.stdout.write(section ?? FALLBACK);
  return 0;
}

// CLI only when invoked directly (not when imported by tests).
// `pathToFileURL` handles Windows backslashes vs POSIX consistently;
// comparing against `import.meta.url` (which is always a file:// URL
// with forward slashes) avoids the cross-platform mismatch a naive
// string replace would have.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv));
}

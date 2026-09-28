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
 * The release body for `version`: its CHANGELOG section, plus whatever was
 * still under `## [Unreleased]` in the tree being released, minus bullets the
 * previous GitHub Release already announced. Null when all of that is empty.
 *
 * Why the Unreleased part. The release job builds, tags and publishes master
 * as it stands, not the commit that bumped the version, so a contribution that
 * merged after its release PR was drafted ships in this build while its note
 * sits under Unreleased. A bot bump that auto-merges on stale CI does exactly
 * that: 6.8.7 shipped `--pool-headroom-floor` (dario#1333) with the note left
 * in Unreleased, and 6.10.3 did the same to the gated-model 400. Those notes
 * belong to the release that carried the code.
 *
 * Why the exclusion. The next bump promotes those bullets into its own section,
 * so without it they would be announced twice. `previousBody` is the prior
 * release's published body; a bullet found verbatim in its "Also in this
 * build" block is dropped (fold and promote move bullets without rewording
 * them). Only that block: a release's own section can repeat the previous
 * one's text on purpose, and rebake-release-prep writes the same bullet for
 * every template rebake, so matching the whole body would publish a second
 * rebake in a row with no notes (review on #1456). Pass '' when it could not
 * be read: repeating a note beats losing one.
 */
export const ALSO_IN_THIS_BUILD = '### Also in this build';

/** Bullets the previous release announced under "Also in this build", trimmed. */
export function alsoInThisBuild(previousBody) {
  const lines = String(previousBody).split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === ALSO_IN_THIS_BUILD);
  const out = new Set();
  if (at === -1) return out;
  for (const line of lines.slice(at + 1)) {
    // The block ends at the next heading or the release footer's rule.
    if (/^#{1,6} /.test(line) || /^---\s*$/.test(line)) break;
    if (line.trim().startsWith('- ')) out.add(line.trim());
  }
  return out;
}

export function composeReleaseNotes(md, version, previousBody = '') {
  const announced = alsoInThisBuild(previousBody);
  const withoutAnnounced = (text) => {
    if (!text) return '';
    const kept = [];
    let skipping = false;
    for (const line of text.split('\n')) {
      if (line.startsWith('- ')) skipping = announced.has(line.trim());
      else if (line.trim() === '' || /^#{1,6} /.test(line)) skipping = false;
      if (!skipping) kept.push(line);
    }
    // A subsection whose every bullet was dropped loses its heading too.
    const out = kept.filter((line, i) => {
      if (!/^#{3,6} /.test(line)) return true;
      for (let j = i + 1; j < kept.length; j++) {
        if (/^#{1,6} /.test(kept[j])) return false;
        if (kept[j].trim() !== '') return true;
      }
      return false;
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const own = withoutAnnounced(extractReleaseNotes(md, version) ?? '');
  const m = /(?:^|\n)## \[Unreleased\][^\n]*\n([\s\S]*?)(?=\n## \[|$)/i.exec(String(md));
  const pending = withoutAnnounced(
    (m ? m[1] : '').split('\n').filter((l) => !/^#{3,6} /.test(l)).join('\n'),
  );

  const parts = [];
  if (own) parts.push(own);
  if (pending) {
    parts.push(ALSO_IN_THIS_BUILD + '\n\nMerged after this release was drafted; CHANGELOG.md lists these under the next version.\n\n' + pending);
  }
  return parts.length ? parts.join('\n\n') : null;
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
      'Usage: extract-release-notes.mjs <version> [--file CHANGELOG.md] [--previous prev-release.md]\n' +
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
  // --previous <file>: the prior release's published body. Unreadable or
  // absent means nothing is excluded, never a reason to fail the release.
  let previous = '';
  const prevIdx = args.indexOf('--previous');
  if (prevIdx >= 0 && args[prevIdx + 1]) {
    try { previous = readFileSync(args[prevIdx + 1], 'utf-8'); } catch { previous = ''; }
  }
  const section = composeReleaseNotes(md, version, previous);
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

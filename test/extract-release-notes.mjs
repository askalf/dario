#!/usr/bin/env node
// Tests for scripts/extract-release-notes.mjs.
//
// Locks the empirical contract that the workflow's release-body
// extraction has to obey. The original implementation was a one-line
// regex buried in `cc-drift-auto-release.yml` that silently captured
// the empty string for every version — 39 releases shipped with
// empty bodies before anyone noticed. This file makes that class of
// silent regression impossible: a future change that breaks the
// extraction breaks CI before it ships.
//
// Run: `node test/extract-release-notes.mjs` (or via npm test).

import { extractReleaseNotes } from '../scripts/extract-release-notes.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('Basic — single entry, no Unreleased header');
{
  const md = `# Changelog

## [1.0.0] - 2026-01-01

### Added — initial release

First public release.
`;
  const out = extractReleaseNotes(md, '1.0.0');
  check('extracts content', out && out.includes('initial release'));
  check('trims leading/trailing whitespace', out === '### Added — initial release\n\nFirst public release.');
}

// ─────────────────────────────────────────────────────────────
header('Multiple entries — extracts only the requested one');
{
  const md = `# Changelog

## [Unreleased]

## [2.0.0] - 2026-02-01

### Changed — v2 stuff

Second release content.

## [1.0.0] - 2026-01-01

### Added — initial release

First release content.
`;
  const v2 = extractReleaseNotes(md, '2.0.0');
  const v1 = extractReleaseNotes(md, '1.0.0');
  check('v2 extracts v2 content', v2 && v2.includes('Second release content'));
  check('v2 does NOT include v1 content', v2 && !v2.includes('First release content'));
  check('v2 does NOT include Unreleased boundary', v2 && !v2.includes('## ['));
  check('v1 extracts v1 content', v1 && v1.includes('First release content'));
  check('v1 (latest in file order) terminates at EOF', v1 && v1.endsWith('First release content.'));
}

// ─────────────────────────────────────────────────────────────
header('Regression — multiline /m flag bug that shipped 39 empty releases');
{
  // The pre-fix regex was:
  //   ^## \[VERSION\][^\n]*\n([\s\S]*?)(?=\n## \[|$)  with /m flag
  //
  // Every CHANGELOG section begins with a blank line right after the
  // heading — the position right after the heading's `\n` is at the
  // start of that blank line, and `$` in /m mode matches before any
  // `\n`. So the lookahead's `$` alternative fired on the first
  // possible position, the lazy `[\s\S]*?` settled on 0 chars, and
  // `m[1]` was empty.
  //
  // The fix drops /m and uses `(?:^|\n)` to anchor start. This test
  // pins that behavior — extracting from a CHANGELOG that starts
  // with the blank-separator-after-heading shape MUST return non-
  // empty content, not the empty string.
  const md = `# Changelog

## [3.38.6] - 2026-05-15

### Fixed — drop legacy todo mapping

CC v2.1.142 removed the TodoWrite tool.

## [3.38.5] - 2026-05-15

### Fixed — adaptive thinking gate

Per-model gate.
`;
  const out = extractReleaseNotes(md, '3.38.6');
  check('regression: non-empty after blank separator', out && out.length > 30);
  check('regression: contains the heading', out && out.includes('### Fixed — drop legacy todo mapping'));
  check('regression: contains the prose', out && out.includes('CC v2.1.142 removed'));
  check('regression: stops at next ## [', out && !out.includes('3.38.5'));
}

// ─────────────────────────────────────────────────────────────
header('Version with regex metacharacters');
{
  // SemVer always contains dots, which are regex metachars. Internal
  // .replace() must escape them. Without escaping, `3.38.6` would
  // match `3X38Y6` for any chars X/Y — a CHANGELOG with a typo
  // version would be silently matched.
  const md = `## [3.38.6] - 2026-05-15

Real content.

## [3X38Y6] - decoy

This should not match.
`;
  const real = extractReleaseNotes(md, '3.38.6');
  const decoy = extractReleaseNotes(md, '3X38Y6');
  check('3.38.6 finds the real entry', real && real.includes('Real content'));
  check('3.38.6 does NOT match 3X38Y6 (dot is escaped)', real && !real.includes('should not match'));
  check('3X38Y6 finds the decoy entry verbatim', decoy && decoy.includes('should not match'));
}

// ─────────────────────────────────────────────────────────────
header('Missing version → null fallback');
{
  const md = `## [1.0.0] - 2026-01-01

Content.
`;
  const out = extractReleaseNotes(md, '99.99.99');
  check('returns null for missing version', out === null);
}

// ─────────────────────────────────────────────────────────────
header('Empty section → null (treats as "missing")');
{
  // A version heading with nothing between it and the next heading
  // should be treated the same as a missing version, so the
  // workflow's fallback sentinel fires instead of writing zero bytes.
  const md = `## [Unreleased]

## [1.0.0] - 2026-01-01

Content.
`;
  const out = extractReleaseNotes(md, 'Unreleased');
  check('empty Unreleased section returns null', out === null);
}

// ─────────────────────────────────────────────────────────────
header('Bad input handling');
{
  check('null markdown → null',       extractReleaseNotes(null, '1.0.0') === null);
  check('undefined markdown → null',  extractReleaseNotes(undefined, '1.0.0') === null);
  check('number markdown → null',     extractReleaseNotes(42, '1.0.0') === null);
  check('null version → null',        extractReleaseNotes('## [1.0.0]\n\nx', null) === null);
  check('empty-string version → null', extractReleaseNotes('## [1.0.0]\n\nx', '') === null);
}

// ─────────────────────────────────────────────────────────────
header('Heading-only-then-EOF (latest entry has no trailing entry)');
{
  // The latest version's terminator is `$` (end-of-string), not
  // `\n## [`. This used to be the broken case under /m mode.
  const md = `## [1.0.0]\n\nOnly entry, no trailing heading.\n`;
  const out = extractReleaseNotes(md, '1.0.0');
  check('extracts content with EOF terminator', out === 'Only entry, no trailing heading.');
}

// ─────────────────────────────────────────────────────────────
header('Heading line variants — date suffix, no date, extra whitespace');
{
  const variants = [
    { line: '## [1.0.0] - 2026-01-01',                  expectsMatch: true },
    { line: '## [1.0.0]',                               expectsMatch: true },
    { line: '## [1.0.0]   ',                            expectsMatch: true },
    { line: '## [1.0.0] - 2026-01-01 - extra annotation', expectsMatch: true },
    { line: '##[1.0.0] - missing space',                expectsMatch: false },
  ];
  for (const v of variants) {
    const md = `${v.line}\n\nVariant content for: ${v.line}\n`;
    const out = extractReleaseNotes(md, '1.0.0');
    const ok = v.expectsMatch
      ? (out !== null && out.includes('Variant content'))
      : (out === null);
    check(`heading "${v.line}" ${v.expectsMatch ? 'matches' : 'does NOT match'}`, ok);
  }
}

// ─────────────────────────────────────────────────────────────
header('Real CHANGELOG.md — every release section extracts content');
{
  // Cross-check against the live CHANGELOG.md. Every version listed
  // in the file should extract a non-null section (no "(no changelog
  // section …)" sentinel ever fires for a version that's actually
  // present). This catches a regression where the regex
  // accidentally stops working on the real document while still
  // passing the synthetic cases above.
  const repoRoot = join(__dirname, '..');
  const md = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf-8');
  const headings = md.match(/^## \[[^\]]+\]/gm) || [];
  check('CHANGELOG has at least 5 version headings', headings.length >= 5);
  let extractedCount = 0;
  let nullCount = 0;
  for (const h of headings) {
    const v = h.match(/^## \[([^\]]+)\]/)[1];
    if (v === 'Unreleased') continue;          // intentionally empty most days
    const section = extractReleaseNotes(md, v);
    if (section === null) {
      nullCount++;
      console.log(`    [null] ${v}`);
    } else {
      extractedCount++;
    }
  }
  check(`extracted ${extractedCount} sections`, extractedCount > 0);
  check('every non-Unreleased section is non-null', nullCount === 0);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

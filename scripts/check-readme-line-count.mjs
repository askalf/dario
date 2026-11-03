#!/usr/bin/env node
// The "~Nk lines of TypeScript across N files" claim is a load-bearing selling
// point -- it is the thing that makes "audit it yourself" credible -- and it
// rots on its own, silently, every release.
//
// It has already rotted twice. #582 refreshed it, #717 rewrote the hero line
// back to ~22k, and #877's changelog records "Source is 23,833 lines across 52
// files, not ~22k across 49" -- a correction that never reached the hero line,
// which still read ~22k on 2026-08-01 at an actual 23,986. A number nobody
// re-measures is a number that only ever drifts in the flattering direction,
// so this measures it on every PR instead.
//
// The same claim is repeated in CONTRIBUTING.md and on the landing page
// (site/index.html), and those copies drifted further (CONTRIBUTING said
// ~12,650 lines across 27 files at 44k across 88), so every copy is checked,
// not only the README's.
//
// Tolerance is +/- 1000 lines, i.e. "~24k" is honest anywhere in 23k-25k, and
// +/- 5 files. That is loose enough that ordinary PRs do not trip it and tight
// enough that the claim never misleads by a full thousand lines.
//
//   node scripts/check-readme-line-count.mjs [root]   (root defaults to .)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LINE_TOLERANCE = 1000;
const FILE_TOLERANCE = 5;
// After tags and ** markers are replaced by spaces: "~44k lines of TypeScript across 88 files",
// "~44k lines across 88 TypeScript files", or "~44k lines" alone.
const CLAIM = /~(\d+)k\s+lines(?:\s+of\s+TypeScript)?(?:\s+across\s+(\d+)\s+(?:TypeScript\s+)?files)?/g;
// The README must carry the claim; the other copies are checked when present.
const REQUIRED = 'README.md';
const COPIES = ['README.md', 'CONTRIBUTING.md', 'site/index.html'];

const root = process.argv[2] || '.';

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** The claims in one file's text: markup becomes spaces, so "<b>~44k</b><span>lines" reads as "~44k lines". */
function claimsIn(text) {
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\*\*/g, ' ').replace(/\s+/g, ' ');
  return [...plain.matchAll(CLAIM)].map((m) => ({ k: Number(m[1]), files: m[2] === undefined ? null : Number(m[2]), text: m[0] }));
}

const files = tsFiles(join(root, 'src'));
const actual = files.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length - 1, 0);

const problems = [];
let checked = 0;
for (const rel of COPIES) {
  const path = join(root, rel);
  if (!existsSync(path)) continue;
  const claims = claimsIn(readFileSync(path, 'utf8'));
  if (rel === REQUIRED && claims.length === 0) {
    problems.push(
      'README.md no longer contains a "~Nk lines" claim. If it was removed on purpose, delete this\n' +
        'check and its CI step -- do not leave a guard pointing at nothing.',
    );
  }
  for (const c of claims) {
    checked++;
    const drift = actual - c.k * 1000;
    if (Math.abs(drift) > LINE_TOLERANCE) {
      problems.push(`${rel}: "${c.text}" claims ~${c.k}k lines; src/ has ${actual.toLocaleString()} (off by ${drift > 0 ? '+' : ''}${drift}). Update it to ~${Math.round(actual / 1000)}k.`);
    }
    if (c.files !== null && Math.abs(files.length - c.files) > FILE_TOLERANCE) {
      problems.push(`${rel}: "${c.text}" claims ${c.files} files; src/ has ${files.length}. Update it to ${files.length}.`);
    }
  }
}

if (problems.length) {
  console.error('FAIL:\n  ' + problems.join('\n  '));
  process.exit(1);
}

console.log(
  `ok  ${checked} line-count claim(s) vs actual ${actual.toLocaleString()} lines across ${files.length} files ` +
    `(tolerance ${LINE_TOLERANCE} lines, ${FILE_TOLERANCE} files)`,
);

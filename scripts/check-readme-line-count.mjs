#!/usr/bin/env node
// The README's "~Nk lines you can read in a weekend" claim is a load-bearing
// selling point -- it is the thing that makes "audit it yourself" credible --
// and it rots on its own, silently, every release.
//
// It has already rotted twice. #582 refreshed it, #717 rewrote the hero line
// back to ~22k, and #877's changelog records "Source is 23,833 lines across 52
// files, not ~22k across 49" -- a correction that never reached the hero line,
// which still read ~22k on 2026-08-01 at an actual 23,986. A number nobody
// re-measures is a number that only ever drifts in the flattering direction,
// so this measures it on every PR instead.
//
// Tolerance is +/- 1000 lines, i.e. "~24k" is honest anywhere in 23k-25k. That
// is loose enough that ordinary PRs do not trip it and tight enough that the
// claim never misleads by a full thousand lines.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOLERANCE = 1000;
const CLAIM = /~(\d+)k lines you can read in a weekend/;

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

const files = tsFiles('src');
const actual = files.reduce(
  (n, f) => n + readFileSync(f, 'utf8').split('\n').length - 1,
  0,
);

const readme = readFileSync('README.md', 'utf8');
const m = readme.match(CLAIM);

if (!m) {
  console.error(
    'FAIL: README.md no longer contains a "~Nk lines you can read in a weekend"\n' +
      'claim. If it was removed on purpose, delete this check and its CI step --\n' +
      'do not leave a guard pointing at nothing.',
  );
  process.exit(1);
}

const claimed = Number(m[1]) * 1000;
const drift = actual - claimed;

if (Math.abs(drift) > TOLERANCE) {
  console.error(
    `FAIL: README claims ~${m[1]}k lines; src/ actually has ${actual.toLocaleString()} ` +
      `across ${files.length} files (off by ${drift > 0 ? '+' : ''}${drift}).\n` +
      `Update the hero line in README.md to ~${Math.round(actual / 1000)}k.`,
  );
  process.exit(1);
}

console.log(
  `ok  README ~${m[1]}k vs actual ${actual.toLocaleString()} lines ` +
    `across ${files.length} files (${drift > 0 ? '+' : ''}${drift}, tolerance ${TOLERANCE})`,
);

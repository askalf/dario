// Tests for enumerateClaudeCandidates + findClaudeBinary's new version-aware
// selection, added in v3.32.0 after the dario#71/#105 bake friction
// (maintainer's PATH had AppData/Roaming/npm/claude.cmd@2.1.117 and
// .local/bin/claude.exe@2.1.118; the old first-match order silently picked
// the older wrapper).

import { enumerateClaudeCandidates } from '../dist/live-fingerprint.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

function setupFakePath(layout) {
  // layout: Array<{dir: string (under tmpdir), files: string[]}>
  const root = mkdtempSync(join(tmpdir(), 'dario-findcc-'));
  const dirs = [];
  for (const { dir, files } of layout) {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    for (const f of files) writeFileSync(join(abs, f), '');
    dirs.push(abs);
  }
  return { root, dirs };
}

function withPath(value, fn) {
  const prev = process.env.PATH;
  process.env.PATH = value;
  try { return fn(); }
  finally { process.env.PATH = prev; }
}

const pathSep = process.platform === 'win32' ? ';' : ':';

// ─────────────────────────────────────────────────────────────

header('enumerateClaudeCandidates — empty PATH');
{
  const out = withPath('', () => enumerateClaudeCandidates());
  check('no dirs → no candidates', out.length === 0);
}

header('enumerateClaudeCandidates — single candidate on Unix-like layout');
{
  const layout = [{ dir: 'bin', files: ['claude'] }];
  const { root, dirs } = setupFakePath(layout);
  try {
    const out = withPath(dirs.join(pathSep), () => enumerateClaudeCandidates());
    // On Windows the picker also tries claude.exe/claude.cmd with the
    // `claude` (no-ext) name, but we seeded only the extensionless file,
    // so only one should match.
    check(
      `exactly one candidate returned (got ${out.length})`,
      out.length === 1,
    );
    if (out.length === 1) {
      check(
        'candidate is the expected absolute path',
        out[0] === join(dirs[0], 'claude'),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

header('enumerateClaudeCandidates — PATH order preserved');
{
  // Two dirs, each with a `claude` binary; whichever is first in PATH
  // should also be first in the returned array. (Actual version-based
  // selection happens later in findClaudeBinary — this asserts the
  // enumeration stage is dir-order-stable for predictable tests.)
  const layout = [
    { dir: 'first', files: ['claude'] },
    { dir: 'second', files: ['claude'] },
  ];
  const { root, dirs } = setupFakePath(layout);
  try {
    const out = withPath(dirs.join(pathSep), () => enumerateClaudeCandidates());
    check(
      `two candidates, first-PATH-dir first (got ${out.length})`,
      out.length === 2 && out[0].startsWith(dirs[0] + sep) && out[1].startsWith(dirs[1] + sep),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

header('enumerateClaudeCandidates — dedup when same path appears twice in PATH');
{
  const layout = [{ dir: 'bin', files: ['claude'] }];
  const { root, dirs } = setupFakePath(layout);
  try {
    // Put the same dir in PATH twice.
    const path = [dirs[0], dirs[0]].join(pathSep);
    const out = withPath(path, () => enumerateClaudeCandidates());
    check(
      `duplicate PATH entry → single candidate (got ${out.length})`,
      out.length === 1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform === 'win32') {
  header('enumerateClaudeCandidates — Windows: .exe ordered before .cmd within same dir');
  {
    const layout = [{ dir: 'bin', files: ['claude.cmd', 'claude.exe'] }];
    const { root, dirs } = setupFakePath(layout);
    try {
      const out = withPath(dirs[0], () => enumerateClaudeCandidates());
      check(
        '.exe listed before .cmd for the same dir (native binary preferred when version-probe tiebreaks fail)',
        out.length >= 2 &&
          out[0].endsWith('claude.exe') &&
          out[1].endsWith('claude.cmd'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  header('enumerateClaudeCandidates — Windows: cross-dir finds both a .cmd and an .exe');
  {
    // Simulates the real-world dual-install: npm wrapper in AppData/Roaming/npm
    // (.cmd) plus a native binary in ~/.local/bin (.exe). Enumeration must
    // return both so the version-probe picker can choose between them.
    const layout = [
      { dir: 'npm-global', files: ['claude.cmd', 'claude'] },
      { dir: 'local-bin', files: ['claude.exe'] },
    ];
    const { root, dirs } = setupFakePath(layout);
    try {
      const out = withPath(dirs.join(pathSep), () => enumerateClaudeCandidates());
      const paths = out.join('\n');
      check(
        'found claude.cmd in first dir',
        paths.includes(join(dirs[0], 'claude.cmd')),
      );
      check(
        'found claude.exe in second dir',
        paths.includes(join(dirs[1], 'claude.exe')),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

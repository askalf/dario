#!/usr/bin/env node
// findClaudeOnPath: the detector's PATH search after its fixed install candidates.
//
// A `claude` on PATH under a prefix the fixed list does not name (a distro Node's
// /usr/lib/node_modules behind /usr/bin/claude) must be found, resolved through its
// symlink to the real binary, so the scan reads the executable and not the link.
// Runs on temp directories only. No real CC binary is read.

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, delimiter } from 'node:path';
import { findClaudeOnPath } from '../dist/cc-oauth-detect.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};

const root = mkdtempSync(join(tmpdir(), 'dario-cc-path-'));
try {
  const empty = join(root, 'empty');
  const bin = join(root, 'bin');
  const pkg = join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  const dirOnly = join(root, 'dironly');
  for (const d of [empty, bin, pkg, dirOnly]) mkdirSync(d, { recursive: true });
  const real = join(pkg, 'claude.exe');
  writeFileSync(real, 'binary');
  mkdirSync(join(dirOnly, 'claude'));

  check('nothing on PATH: null', findClaudeOnPath([empty].join(delimiter), ['claude']) === null);
  check('unset PATH: null', findClaudeOnPath(undefined, ['claude']) === null);
  check('empty PATH entries are skipped', findClaudeOnPath(`${delimiter}${empty}${delimiter}`, ['claude']) === null);
  check('a directory named claude is not a binary', findClaudeOnPath(dirOnly, ['claude']) === null);

  if (platform() !== 'win32') {
    symlinkSync(real, join(bin, 'claude'));
    const got = findClaudeOnPath([empty, bin].join(delimiter), ['claude']);
    check('a symlinked claude resolves to the package binary', got === realpathSync(real), String(got));
    check('the first PATH entry holding claude wins', findClaudeOnPath([bin, pkg].join(delimiter), ['claude', 'claude.exe']) === realpathSync(real));
  } else {
    console.log('  SKIP symlink cases: creating symlinks needs elevation on Windows');
  }

  const direct = findClaudeOnPath(pkg, ['claude.exe']);
  check('a regular file is returned as its real path', direct === realpathSync(real), String(direct));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

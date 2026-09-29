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
  const first = join(root, 'first');
  const second = join(root, 'second');
  for (const d of [empty, bin, pkg, dirOnly, first, second]) mkdirSync(d, { recursive: true });
  const real = join(pkg, 'claude.exe');
  writeFileSync(real, 'binary');
  mkdirSync(join(dirOnly, 'claude'));
  writeFileSync(join(first, 'claude'), 'first');
  writeFileSync(join(second, 'claude'), 'second');

  check('nothing on PATH: null', findClaudeOnPath([empty].join(delimiter), ['claude']) === null);
  check('unset PATH: null', findClaudeOnPath(undefined, ['claude']) === null);
  check('empty PATH entries are skipped', findClaudeOnPath(`${delimiter}${empty}${delimiter}`, ['claude']) === null);
  check('a directory named claude is not a binary', findClaudeOnPath(dirOnly, ['claude']) === null);

  const forward = findClaudeOnPath([first, second].join(delimiter), ['claude']);
  check('the first PATH entry holding claude wins', forward === realpathSync(join(first, 'claude')), String(forward));
  const reversed = findClaudeOnPath([second, first].join(delimiter), ['claude']);
  check('the first PATH entry wins in reverse order too', reversed === realpathSync(join(second, 'claude')), String(reversed));

  if (platform() !== 'win32') {
    symlinkSync(real, join(bin, 'claude'));
    const got = findClaudeOnPath([empty, bin].join(delimiter), ['claude']);
    check('a symlinked claude resolves to the package binary', got === realpathSync(real), String(got));
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

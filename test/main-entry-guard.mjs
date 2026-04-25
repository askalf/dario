#!/usr/bin/env node
// Regression test for dario#143 — the v3.31.18 silent-CLI bug.
//
// The main-entry guard added in v3.31.15 (#137) was a strict string
// compare between `import.meta.url` and `pathToFileURL(process.argv[1])`.
// That works when you run `node dist/cli.js` directly but breaks the
// moment npm installs dario globally and Node receives `argv[1]` as
// a bin-shim symlink (e.g. `/usr/local/bin/dario`). The strings differ,
// the guard returns false, and the entire CLI body is gated out —
// `dario doctor` produces no output and exits 0.
//
// Three contracts to pin so this can't regress:
//   1. Direct invocation (no symlink): argv[1] === module path → true.
//   2. Symlink invocation (the bug): argv[1] is a symlink whose realpath
//      equals the module path → true.
//   3. Library import: argv[1] points somewhere else, not a symlink to
//      the module → false.
// Plus edge cases: undefined / null / empty argv[1] → false; realpath
// throws (path doesn't exist) → false.

import { isMainEntry } from '../dist/cli.js';
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`, ...rest); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ----------------------------------------------------------------------
//  1. Direct invocation — argv[1] is exactly the module path
// ----------------------------------------------------------------------
header('isMainEntry — direct invocation (node dist/cli.js)');
{
  const modulePath = '/usr/local/lib/node_modules/@askalf/dario/dist/cli.js';
  const moduleHref = pathToFileURL(modulePath).href;
  // realpath stub never gets called in this path
  const result = isMainEntry(modulePath, moduleHref, p => p);
  check('argv[1] === module path → true', result === true);
}

// ----------------------------------------------------------------------
//  2. Symlink invocation — npm-global bin shim (the dario#143 case)
// ----------------------------------------------------------------------
header('isMainEntry — symlink invocation (npm-global bin shim)');
{
  const realModulePath = '/usr/local/lib/node_modules/@askalf/dario/dist/cli.js';
  const symlinkPath = '/usr/local/bin/dario';
  const moduleHref = pathToFileURL(realModulePath).href;
  // Stub realpath: when given the symlink, return the real file
  const realpathStub = (p) => (p === symlinkPath ? realModulePath : p);
  const result = isMainEntry(symlinkPath, moduleHref, realpathStub);
  check('argv[1]=symlink, realpath resolves to module → true', result === true);
}

header('isMainEntry — symlink invocation on macOS (homebrew style)');
{
  const realModulePath = '/opt/homebrew/lib/node_modules/@askalf/dario/dist/cli.js';
  const symlinkPath = '/opt/homebrew/bin/dario';
  const moduleHref = pathToFileURL(realModulePath).href;
  const realpathStub = (p) => (p === symlinkPath ? realModulePath : p);
  check('homebrew bin symlink → true',
    isMainEntry(symlinkPath, moduleHref, realpathStub) === true);
}

header('isMainEntry — symlink invocation on Linux (~/.local/bin)');
{
  const realModulePath = '/home/user/.local/lib/node_modules/@askalf/dario/dist/cli.js';
  const symlinkPath = '/home/user/.local/bin/dario';
  const moduleHref = pathToFileURL(realModulePath).href;
  const realpathStub = (p) => (p === symlinkPath ? realModulePath : p);
  check('~/.local/bin symlink → true',
    isMainEntry(symlinkPath, moduleHref, realpathStub) === true);
}

// ----------------------------------------------------------------------
//  3. Library import — test or third-party importing a named export
// ----------------------------------------------------------------------
header('isMainEntry — library import returns false');
{
  const modulePath = '/usr/local/lib/node_modules/@askalf/dario/dist/cli.js';
  const moduleHref = pathToFileURL(modulePath).href;

  // Test runner running an unrelated test file
  check('argv[1] is unrelated test file → false',
    isMainEntry('/somewhere/test/request-queue.mjs', moduleHref, p => p) === false);

  // node REPL (no real argv[1] script)
  check('argv[1] is node binary itself → false',
    isMainEntry('/usr/local/bin/node', moduleHref, p => p) === false);

  // Importer where realpath also doesn't match (importer is a different package)
  const realpathStub = (p) =>
    p === '/usr/local/bin/some-other-tool' ? '/some/other/dist/cli.js' : p;
  check('argv[1] is a different bin shim → false',
    isMainEntry('/usr/local/bin/some-other-tool', moduleHref, realpathStub) === false);
}

// ----------------------------------------------------------------------
//  4. Edge cases — undefined / null / empty / realpath throws
// ----------------------------------------------------------------------
header('isMainEntry — edge cases');
{
  const modulePath = '/usr/local/lib/node_modules/@askalf/dario/dist/cli.js';
  const moduleHref = pathToFileURL(modulePath).href;

  check('argv[1] undefined → false', isMainEntry(undefined, moduleHref, p => p) === false);
  check('argv[1] null → false',      isMainEntry(null,      moduleHref, p => p) === false);
  check('argv[1] empty string → false', isMainEntry('',     moduleHref, p => p) === false);

  // Real-world failure mode: argv[1] doesn't exist on disk → realpath throws ENOENT.
  // The guard must NOT propagate the error — it should return false.
  const throwingRealpath = () => { throw new Error('ENOENT'); };
  check('realpath throws → catches and returns false',
    isMainEntry('/nonexistent/path', moduleHref, throwingRealpath) === false);
}

// ----------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

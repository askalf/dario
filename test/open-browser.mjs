// Tests for src/open-browser.ts — the hardened replacement for the
// inline `child_process.exec("start \\"\\" \\"${url}\\"")` patterns that
// previously lived in src/oauth.ts and src/accounts.ts.
//
// Two contracts to pin:
//   1. URL validation — rejects non-http(s) protocols and obviously-
//      malformed URLs *before* any spawn.
//   2. Argv shape — the (bin, args) pair we hand to execFile is correct
//      per platform and never contains shell metacharacters in the bin
//      slot. Validated via the exported `browserDispatchCommand` helper
//      so we don't need to actually spawn anything.
//
// We also exercise `openBrowser` end-to-end with a stubbed exec so the
// integration of validate + dispatch + spawn is covered without touching
// the real OS.

import { browserDispatchCommand, openBrowser } from '../dist/open-browser.js';

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
//  URL validation
// ----------------------------------------------------------------------
header('browserDispatchCommand — accepts http/https URLs');
{
  const a = browserDispatchCommand('http://example.com/foo?bar=baz', 'linux');
  check('http URL accepted', a.bin === 'xdg-open' && a.args.length === 1);
  check('URL passed through as single argv element', a.args[0] === 'http://example.com/foo?bar=baz');

  const b = browserDispatchCommand('https://claude.ai/oauth/authorize?code=true', 'darwin');
  check('https URL accepted', b.bin === 'open');
  check('URL preserved verbatim', b.args[0] === 'https://claude.ai/oauth/authorize?code=true');
}

header('browserDispatchCommand — rejects non-http(s) protocols');
{
  for (const evil of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.com/',
  ]) {
    let threw = false;
    try { browserDispatchCommand(evil, 'linux'); } catch { threw = true; }
    check(`rejects ${evil.slice(0, 30)}…`, threw);
  }
}

header('browserDispatchCommand — rejects malformed URLs');
{
  for (const evil of [
    'not a url',
    '',
    '   ',
    'http://',                    // no host
  ]) {
    let threw = false;
    try { browserDispatchCommand(evil, 'linux'); } catch { threw = true; }
    check(`rejects "${evil}"`, threw);
  }
}

// ----------------------------------------------------------------------
//  Shell-metacharacter URLs are passed verbatim as argv (NOT shelled)
// ----------------------------------------------------------------------
header('browserDispatchCommand — shell metacharacters in URL stay in argv (not shelled)');
{
  // These are valid URLs (every char is legal in URL query). The point
  // is that they *would* have been catastrophic in the previous
  // `exec("xdg-open \\"${url}\\"")` shape because xdg-open would have
  // received `url & calc.exe`. With argv they're a single element.
  const evil = 'https://example.com/?x=1&y=$(calc.exe)&z=`whoami`&w=|cat';
  const cmd = browserDispatchCommand(evil, 'linux');
  check('shell metacharacters preserved as a single argv element', cmd.args.length === 1 && cmd.args[0] === evil);
  check('bin is the URL handler binary, not a shell', cmd.bin === 'xdg-open');
}

// ----------------------------------------------------------------------
//  Per-platform binary selection
// ----------------------------------------------------------------------
header('browserDispatchCommand — per-platform bin');
{
  check('win32 → explorer.exe', browserDispatchCommand('https://x.test', 'win32').bin === 'explorer.exe');
  check('darwin → open',        browserDispatchCommand('https://x.test', 'darwin').bin === 'open');
  check('linux → xdg-open',     browserDispatchCommand('https://x.test', 'linux').bin === 'xdg-open');
  check('freebsd → xdg-open',   browserDispatchCommand('https://x.test', 'freebsd').bin === 'xdg-open');
  // Unknown platforms fall through to xdg-open as the most-common Unix default.
  check('unknown → xdg-open',   browserDispatchCommand('https://x.test', 'aix').bin === 'xdg-open');
}

// ----------------------------------------------------------------------
//  openBrowser — end-to-end with stubbed exec
// ----------------------------------------------------------------------
header('openBrowser — invokes execFile with argv (no shell)');
{
  let called = null;
  const stub = (file, args, cb) => {
    called = { file, args };
    cb(null, '', '');
  };
  openBrowser('https://example.com/?x=1&y=2', { exec: stub });
  check('exec was called', called !== null);
  check('exec received URL handler binary, not shell', called && (called.file === 'explorer.exe' || called.file === 'open' || called.file === 'xdg-open'));
  check('URL passed as single argv element', called && called.args.length === 1 && called.args[0] === 'https://example.com/?x=1&y=2');
}

header('openBrowser — throws on unsafe protocol before spawning');
{
  let called = false;
  const stub = (_file, _args, cb) => { called = true; cb(null, '', ''); };
  let threw = false;
  try { openBrowser('javascript:alert(1)', { exec: stub }); } catch { threw = true; }
  check('throws synchronously', threw);
  check('exec was NOT called when validation fails', called === false);
}

// ----------------------------------------------------------------------
//  Result
// ----------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

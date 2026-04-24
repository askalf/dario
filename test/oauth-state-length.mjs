// Invariant: every OAuth `state` parameter generated in dario's codebase
// must use `randomBytes(32)` → 43-char base64url. Anthropic's authorize
// endpoint rejects shorter states with "Invalid request format" (dario#71).
// RFC 6749 only requires state to be "non-guessable," so 16 bytes is
// spec-compliant, but Anthropic got stricter than spec — and any future
// regression to `randomBytes(16)` silently breaks OAuth for anyone who
// hits the flow without shortcutting to existing CC credentials.
//
// Strategy: scan every file that imports `randomBytes` from `node:crypto`
// and look for `state` assignments. Each must use `randomBytes(32)`.
// Grep-based rather than runtime behavioral — the test is defensive
// against a refactor that reverts the constant without anyone noticing.
// Same pattern as `scope-binary-verify.mjs`.
//
// Scope: all files under src/ and scripts/. Test files themselves are
// excluded (they may stub OAuth with fake values).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const SCAN_DIRS = [join(repoRoot, 'src'), join(repoRoot, 'scripts')];
// Extensions that could define an OAuth state call site.
const EXT = new Set(['.ts', '.mjs', '.js', '.cjs']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}

const files = SCAN_DIRS.flatMap(d => walk(d));
// A state call site looks like: `state: base64url(randomBytes(N))` or
// `const state = base64url(randomBytes(N))`. The regex accepts either
// pattern; N is captured so we can assert it's 32.
const STATE_CALL_RE = /state[\s:=]+[\w.]+\(\s*randomBytes\((\d+)\)/g;

console.log(`\n======================================================================`);
console.log(`  OAuth state length invariant — randomBytes(32) at every call site`);
console.log(`======================================================================`);

let callSites = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  let m;
  while ((m = STATE_CALL_RE.exec(src)) !== null) {
    callSites++;
    const n = parseInt(m[1], 10);
    const rel = relative(repoRoot, f).replace(/\\/g, '/');
    check(`${rel}: state uses randomBytes(32)`, n === 32);
  }
}

// Defensive: if scanning finds zero call sites, either the regex drifted
// or all OAuth code got deleted. Either way we want to know.
check('at least one OAuth state call site scanned (regex still matches)', callSites >= 4);

console.log(`\n  (scanned ${files.length} files, found ${callSites} OAuth state call sites)`);
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

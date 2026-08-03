#!/usr/bin/env node
/**
 * DARIO_IGNORE_CC_CREDENTIALS — isolate dario from a live Claude Code session.
 *
 * The problem this solves (the "dario rotates my CC OAuth" complaint): when
 * dario runs on the same machine/account as an interactive `claude` session,
 * loadCredentials() reads dario's own ~/.dario/credentials.json AND CC's
 * ~/.claude/.credentials.json AND the OS keychain, then uses the FRESHEST. The
 * moment CC's token is fresher (e.g. right after you log into CC), dario grabs
 * that same token, refreshes it, Anthropic rotates it, and the interactive
 * session still holding the old copy starts 401ing.
 *
 * The flag narrows the source set to dario's OWN file only — keeping the Max
 * subscription ($0) while never touching the interactive session's token. The
 * API-key path (ANTHROPIC_UPSTREAM_API_KEY) also isolates but drops onto retail
 * billing, which defeats the point of running dario at all.
 *
 * credentialSourcePlan / ignoreCcCredentials are pure + exported so the
 * isolation guarantee is testable without real credentials on disk — same
 * pattern as pickFreshestCredentials in credential-freshness.mjs.
 */

import { ignoreCcCredentials, credentialSourcePlan } from '../dist/oauth.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// ────────────────────────────────────────────────────────────────────
header('1. ignoreCcCredentials — env parsing (1/true/yes/on, case/space tolerant)');

for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON', '  true  ']) {
  check(`"${v}" → true`, ignoreCcCredentials({ DARIO_IGNORE_CC_CREDENTIALS: v }) === true);
}
for (const v of [undefined, '', '0', 'false', 'no', 'off', 'nope', '2']) {
  check(`${JSON.stringify(v)} → false (default keeps auto-detect)`, ignoreCcCredentials({ DARIO_IGNORE_CC_CREDENTIALS: v }) === false);
}
check('missing env key → false', ignoreCcCredentials({}) === false);

// ────────────────────────────────────────────────────────────────────
header('2. credentialSourcePlan(false) — default, reads ALL sources');

const off = credentialSourcePlan(false);
check('reads two files (dario + CC)', off.filePaths.length === 2);
check('first file is dario\'s own credentials.json', /[\\/]\.dario[\\/]credentials\.json$/.test(off.filePaths[0]));
check('second file is the Claude Code session file', /[\\/]\.claude[\\/]\.credentials\.json$/.test(off.filePaths[1]));
check('reads the OS keychain too', off.readKeychain === true);

// ────────────────────────────────────────────────────────────────────
header('3. credentialSourcePlan(true) — isolated, dario file ONLY');

const on = credentialSourcePlan(true);
check('reads exactly ONE file', on.filePaths.length === 1);
check('the one file is dario\'s own credentials.json', /[\\/]\.dario[\\/]credentials\.json$/.test(on.filePaths[0]));
check('does NOT read the Claude Code session file', !on.filePaths.some((p) => /[\\/]\.claude[\\/]/.test(p)));
check('does NOT read the OS keychain (modern CC stores its token there)', on.readKeychain === false);

// ────────────────────────────────────────────────────────────────────
header('4. the whole point: nothing in the isolated plan can reach a CC-session token');

// The interactive session's token lives in EITHER ~/.claude/.credentials.json
// OR the keychain. The isolated plan must exclude both — that is the property
// that stops dario rotating a live `claude` session.
check('no CC file path AND no keychain read when isolated',
  !on.filePaths.some((p) => /[\\/]\.claude[\\/]/.test(p)) && on.readKeychain === false);
// And the default must still include at least one CC source, or auto-detect
// would silently be broken for the dedicated-machine case.
check('default plan still includes a CC source (file or keychain)',
  off.filePaths.some((p) => /[\\/]\.claude[\\/]/.test(p)) || off.readKeychain === true);

console.log(`\n${'='.repeat(70)}`);
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

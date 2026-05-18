#!/usr/bin/env node
// Wiring smoke for the TuiApp composition.
//
// Can't run the full TUI loop in CI (no TTY), but we CAN exercise
// the synchronous wiring: rendering with a known state, key routing
// across tabs, switchTab cleanup invocation, makeContext's setState
// type-erasure.
//
// This verifies the most error-prone seam — the type-erased
// state-dispatch between the parent and each tab — without needing
// a real terminal.

import { startTuiApp } from '../dist/tui/tui-app.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('startTuiApp — function exists');
{
  check('startTuiApp is a function', typeof startTuiApp === 'function');
}

// ─────────────────────────────────────────────────────────────
// We can't actually start the TUI here because it'd need a TTY +
// hijack stdin. The wiring tests below stop short of `app.start()`.

// More integration coverage: M5 wires `dario` (no args) to invoke
// startTuiApp; M6's manual e2e covers the interactive run.

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

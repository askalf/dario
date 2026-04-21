#!/usr/bin/env node
// Unit tests for dario#77 — the strict-template + no-live-capture CLI flags.
// The runtime behaviour (exit vs proceed on bundled / drifted template) is
// exercised end-to-end through the proxy startup path; this file covers
// the small parsing / resolution primitives that feed the runtime checks.

import { parseBooleanEnv } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('parseBooleanEnv — truthy values');
{
  check('"1" → true',    parseBooleanEnv('1') === true);
  check('"true" → true', parseBooleanEnv('true') === true);
  check('"TRUE" (case) → true', parseBooleanEnv('TRUE') === true);
  check('"yes" → true',  parseBooleanEnv('yes') === true);
  check('"Yes" (case) → true', parseBooleanEnv('Yes') === true);
  check('"on" → true',   parseBooleanEnv('on') === true);
  check('"ON" (case) → true', parseBooleanEnv('ON') === true);
  check('"  true  " (whitespace) → true', parseBooleanEnv('  true  ') === true);
}

// ─────────────────────────────────────────────────────────────
header('parseBooleanEnv — falsy / unset values');
{
  check('undefined → undefined', parseBooleanEnv(undefined) === undefined);
  check('""       → undefined',  parseBooleanEnv('') === undefined);
  check('"0"      → undefined',  parseBooleanEnv('0') === undefined);
  check('"false"  → undefined',  parseBooleanEnv('false') === undefined);
  check('"no"     → undefined',  parseBooleanEnv('no') === undefined);
  check('"off"    → undefined',  parseBooleanEnv('off') === undefined);
  check('"xyz"    → undefined',  parseBooleanEnv('xyz') === undefined);
  check('" "      → undefined',  parseBooleanEnv(' ') === undefined);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

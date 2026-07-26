#!/usr/bin/env node
// Unit tests for dario#77 — the strict-template + no-live-capture CLI flags.
// The runtime behaviour (exit vs proceed on bundled / drifted template) is
// exercised end-to-end through the proxy startup path; this file covers
// the small parsing / resolution primitives that feed the runtime checks.

import { parseBooleanEnv, parseTriStateEnv } from '../dist/cli.js';

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
// Found while writing docs/configuration.md, not by a failing test: cli.ts
// documents `DARIO_OVERAGE_GUARD=off` as the env equivalent of
// --no-overage-guard, but parseBooleanEnv never returns false, so the value
// fell through `flag ?? env ?? fileCfg ?? true` and the guard stayed ON.
// parseTriStateEnv is the version that can say no. parseBooleanEnv keeps its
// truthy-only contract (asserted above) because its three call sites read it
// with `||`, where false and undefined are indistinguishable.
header('parseTriStateEnv — can express false, unlike parseBooleanEnv');
{
  check('"off"   → false', parseTriStateEnv('off') === false);
  check('"0"     → false', parseTriStateEnv('0') === false);
  check('"false" → false', parseTriStateEnv('false') === false);
  check('"no"    → false', parseTriStateEnv('no') === false);
  check('"OFF" (case) → false', parseTriStateEnv('OFF') === false);
  check('"  off  " (whitespace) → false', parseTriStateEnv('  off  ') === false);

  check('"1"    → true', parseTriStateEnv('1') === true);
  check('"true" → true', parseTriStateEnv('true') === true);
  check('"yes"  → true', parseTriStateEnv('yes') === true);
  check('"on"   → true', parseTriStateEnv('on') === true);

  // Unrecognised stays undefined so a typo defers to the config file and the
  // default instead of being guessed either way.
  check('undefined → undefined', parseTriStateEnv(undefined) === undefined);
  check('""        → undefined', parseTriStateEnv('') === undefined);
  check('"xyz"     → undefined', parseTriStateEnv('xyz') === undefined);

  // The bug, stated as the chain that produced it.
  const guardEnabled = (env) => undefined ?? parseTriStateEnv(env) ?? undefined ?? true;
  check('DARIO_OVERAGE_GUARD=off disables the guard', guardEnabled('off') === false);
  check('unset leaves the guard on', guardEnabled(undefined) === true);
  check('=on leaves the guard on', guardEnabled('on') === true);
  check('a typo leaves the guard on (fails safe)', guardEnabled('offf') === true);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

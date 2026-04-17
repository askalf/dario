// Unit tests for src/stream-drain.ts (v3.25, direction #5 — stream-consumption replay).
// Pure decision function + env resolver. Tests exercise every branch of
// `decideOnClientClose` without any sockets; `resolveDrainOnClose` is tested
// against a synthetic env map.

import { decideOnClientClose, resolveDrainOnClose } from '../dist/stream-drain.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ======================================================================
//  decideOnClientClose — writableEnded already → noop
// ======================================================================
header('decideOnClientClose — response already ended → "noop"');
{
  // Normal lifecycle: res.end() ran; req.on('close') fires as a teardown
  // notification. Whatever we do must not abort upstream (there's no
  // upstream left, the response is out) nor try to drain (nothing to
  // write to, since res is ended).
  check('writableEnded=true, drain=false → noop', decideOnClientClose(true, false, false) === 'noop');
  check('writableEnded=true, drain=true → noop', decideOnClientClose(true, false, true) === 'noop');
  check('writableEnded=true + upstreamAborted → noop', decideOnClientClose(true, true, false) === 'noop');
}

// ======================================================================
//  decideOnClientClose — upstream already aborted → noop
// ======================================================================
header('decideOnClientClose — upstream already aborted → "noop" (don\'t double-abort)');
{
  // Another path (timeout, SSE overflow, pool failover) already fired
  // upstreamAbort. onClientClose must not abort again — the abort is
  // idempotent but a second call logs a spurious reason.
  check('writableEnded=false, aborted=true, drain=false → noop', decideOnClientClose(false, true, false) === 'noop');
  check('writableEnded=false, aborted=true, drain=true → noop', decideOnClientClose(false, true, true) === 'noop');
}

// ======================================================================
//  decideOnClientClose — default behavior (no drain) → abort
// ======================================================================
header('decideOnClientClose — drainOnClose=false → "abort" (v3.24 and earlier behavior)');
{
  // The v3.24-and-earlier default: mid-stream client disconnect aborts
  // upstream so Anthropic stops generating. Saves tokens, but the
  // truncated SSE is a fingerprint axis.
  check('writableEnded=false, aborted=false, drain=false → abort', decideOnClientClose(false, false, false) === 'abort');
}

// ======================================================================
//  decideOnClientClose — drain on → "drain"
// ======================================================================
header('decideOnClientClose — drainOnClose=true → "drain"');
{
  // Mid-stream disconnect with drain enabled: keep upstream spinning
  // so the read-to-EOF pattern matches native CC. Gated writes ensure
  // nothing is pushed onto the closed socket.
  check('writableEnded=false, aborted=false, drain=true → drain', decideOnClientClose(false, false, true) === 'drain');
}

// ======================================================================
//  decideOnClientClose — truth-table completeness
// ======================================================================
header('decideOnClientClose — exhaustive 2×2×2 truth table');
{
  // 8 combinations — assert each one maps to the exact expected action
  // so a later refactor that changes one branch can't slip through.
  const cases = [
    // [writableEnded, upstreamAborted, drainOnClose, expected]
    [false, false, false, 'abort'],
    [false, false, true,  'drain'],
    [false, true,  false, 'noop'],
    [false, true,  true,  'noop'],
    [true,  false, false, 'noop'],
    [true,  false, true,  'noop'],
    [true,  true,  false, 'noop'],
    [true,  true,  true,  'noop'],
  ];
  for (const [ended, aborted, drain, expected] of cases) {
    const got = decideOnClientClose(ended, aborted, drain);
    check(
      `(ended=${ended}, aborted=${aborted}, drain=${drain}) → ${expected}`,
      got === expected,
    );
  }
}

// ======================================================================
//  resolveDrainOnClose — explicit options win
// ======================================================================
header('resolveDrainOnClose — explicit boolean overrides env');
{
  check('explicit true wins over env unset', resolveDrainOnClose(true, {}) === true);
  check('explicit false wins over env="1"', resolveDrainOnClose(false, { DARIO_DRAIN_ON_CLOSE: '1' }) === false);
  check('explicit true wins over env="0"', resolveDrainOnClose(true, { DARIO_DRAIN_ON_CLOSE: '0' }) === true);
}

// ======================================================================
//  resolveDrainOnClose — env truthy values
// ======================================================================
header('resolveDrainOnClose — env truthy values ("1", "true", "yes", case-insensitive)');
{
  check('env="1" → true', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: '1' }) === true);
  check('env="true" → true', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'true' }) === true);
  check('env="TRUE" → true (case-insensitive)', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'TRUE' }) === true);
  check('env="yes" → true', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'yes' }) === true);
  check('env="YES" → true', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'YES' }) === true);
}

// ======================================================================
//  resolveDrainOnClose — env falsy values
// ======================================================================
header('resolveDrainOnClose — anything else is false');
{
  check('env="0" → false', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: '0' }) === false);
  check('env="false" → false', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'false' }) === false);
  check('env="no" → false', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'no' }) === false);
  check('env="" → false', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: '' }) === false);
  check('env unset → false', resolveDrainOnClose(undefined, {}) === false);
  check('env="banana" → false (strict truthy set, not JS truthy)', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: 'banana' }) === false);
  check('env="2" → false (only "1" counts, not every numeric)', resolveDrainOnClose(undefined, { DARIO_DRAIN_ON_CLOSE: '2' }) === false);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

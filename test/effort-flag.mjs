#!/usr/bin/env node
// Unit tests for the --effort flag (dario#87). Covers the pure
// resolveEffort() function, the buildCCRequest integration (effort reaches
// the outbound body), the CLI parser + env mirror + validation path, and
// the haiku carve-out (no output_config on haiku regardless of flag).

import { resolveEffort, VALID_EFFORT_VALUES, buildCCRequest } from '../dist/cc-template.js';
import { resolveEffortFlag } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('VALID_EFFORT_VALUES — the allowed set');
{
  check('includes low', VALID_EFFORT_VALUES.includes('low'));
  check('includes medium', VALID_EFFORT_VALUES.includes('medium'));
  check('includes high', VALID_EFFORT_VALUES.includes('high'));
  check('includes xhigh', VALID_EFFORT_VALUES.includes('xhigh'));
  check('includes max', VALID_EFFORT_VALUES.includes('max'));
  check('includes client', VALID_EFFORT_VALUES.includes('client'));
  check('length === 6', VALID_EFFORT_VALUES.length === 6);
}

// ─────────────────────────────────────────────────────────────
header('resolveEffort — explicit values pin');
{
  check('undefined → high (default)', resolveEffort(undefined, {}) === 'high');
  check('low → low', resolveEffort('low', {}) === 'low');
  check('medium → medium', resolveEffort('medium', {}) === 'medium');
  check('high → high', resolveEffort('high', {}) === 'high');
  check('xhigh → xhigh', resolveEffort('xhigh', {}) === 'xhigh');
  check('max → max', resolveEffort('max', {}) === 'max');
}

header('resolveEffort — client passthrough');
{
  check('client, no output_config → high fallback',
    resolveEffort('client', {}) === 'high');
  check('client, output_config without effort → high fallback',
    resolveEffort('client', { output_config: {} }) === 'high');
  check('client, output_config.effort = "low" → low',
    resolveEffort('client', { output_config: { effort: 'low' } }) === 'low');
  check('client, output_config.effort = "xhigh" → xhigh',
    resolveEffort('client', { output_config: { effort: 'xhigh' } }) === 'xhigh');
  check('client, output_config.effort = "max" → max',
    resolveEffort('client', { output_config: { effort: 'max' } }) === 'max');
  check('client, non-string effort ignored → high',
    resolveEffort('client', { output_config: { effort: 42 } }) === 'high');
  check('client, empty string effort ignored → high',
    resolveEffort('client', { output_config: { effort: '' } }) === 'high');
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest — effort reaches outbound body');
{
  const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
  const cacheControl = { type: 'ephemeral' };
  const billingTag = 'billing';
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false };

  const defaultBuild = buildCCRequest(clientBody, billingTag, cacheControl, identity);
  check('default outbound effort = high', defaultBuild.body.output_config?.effort === 'high');

  const lowBuild = buildCCRequest(clientBody, billingTag, cacheControl, identity, { effort: 'low' });
  check('effort=low → outbound low', lowBuild.body.output_config?.effort === 'low');

  const xhighBuild = buildCCRequest(clientBody, billingTag, cacheControl, identity, { effort: 'xhigh' });
  check('effort=xhigh → outbound xhigh', xhighBuild.body.output_config?.effort === 'xhigh');

  const maxBuild = buildCCRequest(clientBody, billingTag, cacheControl, identity, { effort: 'max' });
  check('effort=max → outbound max', maxBuild.body.output_config?.effort === 'max');

  // client passthrough
  const clientBodyWithEffort = { ...clientBody, output_config: { effort: 'xhigh' } };
  const passthroughBuild = buildCCRequest(clientBodyWithEffort, billingTag, cacheControl, identity, { effort: 'client' });
  check('effort=client + client body.output_config.effort=xhigh → xhigh', passthroughBuild.body.output_config?.effort === 'xhigh');

  const passthroughNoneBuild = buildCCRequest(clientBody, billingTag, cacheControl, identity, { effort: 'client' });
  check('effort=client + no client output_config → high fallback', passthroughNoneBuild.body.output_config?.effort === 'high');
}

header('buildCCRequest — haiku carve-out: no output_config regardless of flag');
{
  const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
  const cacheControl = { type: 'ephemeral' };
  const billingTag = 'billing';
  const haikuBody = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], stream: false };

  const defaultHaiku = buildCCRequest(haikuBody, billingTag, cacheControl, identity);
  check('haiku default: no output_config', defaultHaiku.body.output_config === undefined);

  const xhighHaiku = buildCCRequest(haikuBody, billingTag, cacheControl, identity, { effort: 'xhigh' });
  check('haiku + effort=xhigh: still no output_config', xhighHaiku.body.output_config === undefined);

  const clientHaiku = buildCCRequest(haikuBody, billingTag, cacheControl, identity, { effort: 'client' });
  check('haiku + effort=client: still no output_config', clientHaiku.body.output_config === undefined);

  // And haiku should also skip thinking/context_management (existing behaviour)
  check('haiku: no thinking', defaultHaiku.body.thinking === undefined);
  check('haiku: no context_management', defaultHaiku.body.context_management === undefined);
}

// ─────────────────────────────────────────────────────────────
header('resolveEffortFlag — CLI parsing');
{
  check('no flag, no env → undefined',
    resolveEffortFlag([], undefined) === undefined);
  check('--effort=low → "low"',
    resolveEffortFlag(['--effort=low'], undefined) === 'low');
  check('--effort=xhigh → "xhigh"',
    resolveEffortFlag(['--effort=xhigh'], undefined) === 'xhigh');
  check('--effort=max → "max"',
    resolveEffortFlag(['--effort=max'], undefined) === 'max');
  check('--effort=CLIENT (case) → "client"',
    resolveEffortFlag(['--effort=CLIENT'], undefined) === 'client');
  check('--effort= HIGH (whitespace) → "high"',
    resolveEffortFlag(['--effort= HIGH '], undefined) === 'high');
  check('env DARIO_EFFORT=medium → "medium"',
    resolveEffortFlag([], 'medium') === 'medium');
  check('flag wins over env',
    resolveEffortFlag(['--effort=low'], 'xhigh') === 'low');
  check('empty env → undefined',
    resolveEffortFlag([], '') === undefined);
}

// ─────────────────────────────────────────────────────────────
// Invalid-value rejection path: resolveEffortFlag calls process.exit(1)
// on invalid input. We can't reasonably assert the exit inline without a
// subprocess, so just assert the exit HAPPENS via child_process.
header('resolveEffortFlag — invalid value exits non-zero');
{
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [
    '-e',
    `import('./dist/cli.js').then(({ resolveEffortFlag }) => { resolveEffortFlag(['--effort=ultra'], undefined); });`,
  ], { cwd: process.cwd(), encoding: 'utf-8', timeout: 5_000 });
  check('invalid value → non-zero exit', result.status !== 0);
  check('stderr names valid values', /low, medium, high, xhigh, max, client/.test(result.stderr));
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

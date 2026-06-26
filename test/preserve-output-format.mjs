#!/usr/bin/env node
// Unit tests for the --preserve-output-format flag. Covers buildCCRequest:
// the client's `output_config.format` is dropped by default and carried
// through when the flag is set — independent of skipFields (which opts out
// dario's injected fields, not the caller's schema) and of the haiku
// carve-out (the caller's directive rides on whatever model it chose).

import { buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const billingTag = 'test-billing-tag';
const cacheControl = { type: 'ephemeral' };
const identity = { deviceId: 'd1', accountUuid: 'a1', sessionId: 's1' };
const format = {
  type: 'json_schema',
  schema: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } }, required: ['x'] },
};
const sonnetBody = () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], output_config: { format } });
const haikuBody  = () => ({ model: 'claude-haiku-4-5',  messages: [{ role: 'user', content: 'hi' }], output_config: { format } });

// ─────────────────────────────────────────────────────────────
header('default — client output_config.format is dropped');
{
  const r = buildCCRequest(sonnetBody(), billingTag, cacheControl, identity, {});
  check('output_config carries no client format', r.body.output_config?.format === undefined);
}

// ─────────────────────────────────────────────────────────────
header('preserveOutputFormat — client format carried through');
{
  const r = buildCCRequest(sonnetBody(), billingTag, cacheControl, identity, { preserveOutputFormat: true });
  check('output_config.format preserved', JSON.stringify(r.body.output_config?.format) === JSON.stringify(format));
}

// ─────────────────────────────────────────────────────────────
header('preserveOutputFormat — no-op when client omits output_config.format');
{
  const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
  const r = buildCCRequest(body, billingTag, cacheControl, identity, { preserveOutputFormat: true });
  check('no format invented', r.body.output_config?.format === undefined);
}

// ─────────────────────────────────────────────────────────────
header('preserveOutputFormat — independent of skipFields=output_config');
{
  // skipFields opts out dario's INJECTED effort; the caller's format still rides through.
  const r = buildCCRequest(sonnetBody(), billingTag, cacheControl, identity, {
    preserveOutputFormat: true,
    skipFields: new Set(['thinking', 'context_management', 'output_config']),
  });
  check('format preserved despite output_config skip',
    JSON.stringify(r.body.output_config?.format) === JSON.stringify(format));
  check('no injected effort (output_config skipped)', r.body.output_config?.effort === undefined);
}

// ─────────────────────────────────────────────────────────────
header('preserveOutputFormat — rides the caller\'s model (haiku included)');
{
  const off = buildCCRequest(haikuBody(), billingTag, cacheControl, identity, {});
  check('haiku default: no output_config', off.body.output_config === undefined);
  const on = buildCCRequest(haikuBody(), billingTag, cacheControl, identity, { preserveOutputFormat: true });
  check('haiku + flag: format preserved', JSON.stringify(on.body.output_config?.format) === JSON.stringify(format));
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

#!/usr/bin/env node
// Unit tests for the --skip-fields flag. Covers the CLI parser, the
// buildCCRequest opt-out behavior (each named field stays out of the
// outbound body), and the haiku interaction (haiku omits all three
// regardless of skipFields).

import { buildCCRequest } from '../dist/cc-template.js';
import { parseSkipFieldsFlag } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const billingTag = 'test-billing-tag';
const cacheControl = { type: 'ephemeral' };
const identity = { deviceId: 'd1', accountUuid: 'a1', sessionId: 's1' };
const sonnetBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
const haikuBody  = { model: 'claude-haiku-4-5',  messages: [{ role: 'user', content: 'hi' }] };

// ─────────────────────────────────────────────────────────────
header('parseSkipFieldsFlag — CLI parser');
{
  check('flag absent + no env → []',
    JSON.stringify(parseSkipFieldsFlag([], undefined)) === '[]');
  check('--skip-fields=context_management → ["context_management"]',
    JSON.stringify(parseSkipFieldsFlag(['--skip-fields=context_management'], undefined)) === '["context_management"]');
  check('--skip-fields=a,b,c → ["a","b","c"]',
    JSON.stringify(parseSkipFieldsFlag(['--skip-fields=a,b,c'], undefined)) === '["a","b","c"]');
  check('--skip-fields= (empty) → []',
    JSON.stringify(parseSkipFieldsFlag(['--skip-fields='], 'context_management')) === '[]');
  check('env fallback when flag absent',
    JSON.stringify(parseSkipFieldsFlag([], 'thinking,output_config')) === '["thinking","output_config"]');
  check('CLI flag wins over env',
    JSON.stringify(parseSkipFieldsFlag(['--skip-fields=context_management'], 'thinking')) === '["context_management"]');
  check('whitespace trimmed',
    JSON.stringify(parseSkipFieldsFlag(['--skip-fields=  thinking , context_management  '], undefined)) === '["thinking","context_management"]');
  check('dedup',
    JSON.stringify(parseSkipFieldsFlag(['--skip-fields=thinking,thinking,output_config'], undefined)) === '["thinking","output_config"]');
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest + sonnet — default injects all three');
{
  const r = buildCCRequest(sonnetBody, billingTag, cacheControl, identity, {});
  check('thinking injected by default', r.body.thinking !== undefined);
  check('context_management injected by default', r.body.context_management !== undefined);
  check('output_config injected by default', r.body.output_config !== undefined);
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest + sonnet + skipFields={context_management}');
{
  const r = buildCCRequest(sonnetBody, billingTag, cacheControl, identity, {
    skipFields: new Set(['context_management']),
  });
  check('thinking still injected', r.body.thinking !== undefined);
  check('context_management omitted', r.body.context_management === undefined);
  check('output_config still injected', r.body.output_config !== undefined);
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest + sonnet + skipFields={thinking, output_config}');
{
  const r = buildCCRequest(sonnetBody, billingTag, cacheControl, identity, {
    skipFields: new Set(['thinking', 'output_config']),
  });
  check('thinking omitted', r.body.thinking === undefined);
  check('context_management still injected', r.body.context_management !== undefined);
  check('output_config omitted', r.body.output_config === undefined);
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest + sonnet + skipFields={all three}');
{
  const r = buildCCRequest(sonnetBody, billingTag, cacheControl, identity, {
    skipFields: new Set(['thinking', 'context_management', 'output_config']),
  });
  check('thinking omitted', r.body.thinking === undefined);
  check('context_management omitted', r.body.context_management === undefined);
  check('output_config omitted', r.body.output_config === undefined);
  check('metadata still set (Max billing intact)', r.body.metadata !== undefined);
  check('max_tokens still set', r.body.max_tokens !== undefined);
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest + haiku + skipFields — haiku carve-out unchanged');
{
  // Haiku skips all three by construction. skipFields is a no-op here.
  const defaultHaiku = buildCCRequest(haikuBody, billingTag, cacheControl, identity, {});
  check('haiku default: no thinking', defaultHaiku.body.thinking === undefined);
  check('haiku default: no context_management', defaultHaiku.body.context_management === undefined);
  check('haiku default: no output_config', defaultHaiku.body.output_config === undefined);

  const skippedHaiku = buildCCRequest(haikuBody, billingTag, cacheControl, identity, {
    skipFields: new Set(['context_management']),
  });
  check('haiku + skipFields: still no thinking', skippedHaiku.body.thinking === undefined);
  check('haiku + skipFields: still no context_management', skippedHaiku.body.context_management === undefined);
  check('haiku + skipFields: still no output_config', skippedHaiku.body.output_config === undefined);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

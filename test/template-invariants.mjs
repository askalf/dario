#!/usr/bin/env node
// Template-replay invariants — dario#81.
//
// The other test files assert specific shapes against specific template
// versions (exact system_prompt length, exact tool count, specific field
// order). When the template drifts (as it did between v3.30.0 and v3.30.1
// when `cache_control.ttl` was dropped), those tests need updating in
// lockstep with the code — meaning the invariants that *should* have been
// preserved across the change were implicit, not asserted.
//
// This file asserts properties that must hold REGARDLESS of template
// revision. If any of these breaks, the outbound body is structurally
// invalid and Anthropic will reject it — the dario#54 empty-text-block
// class of bug is exactly this shape.
//
// The invariants are exercised against multiple request scenarios
// (default sonnet, haiku, hybrid-tools, preserve-tools, multi-turn
// history, empty-content edge cases) so a regression on any path fails
// loudly instead of shipping and getting caught downstream.

import { buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ── Invariant primitives — each returns [ok, message] ──

function isNonEmptyString(x) {
  return typeof x === 'string' && x.length > 0;
}
function isPlainObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isPositiveInteger(x) {
  return typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x) && x > 0;
}

/**
 * Assert invariants that must hold for ANY non-haiku outbound body,
 * regardless of model, template version, mode. Throws on violation.
 */
function assertNonHaikuInvariants(body, context) {
  // Top-level required fields
  check(`${context}: model is non-empty string`, isNonEmptyString(body.model));
  check(`${context}: messages is array`, Array.isArray(body.messages));
  check(`${context}: max_tokens is positive integer`, isPositiveInteger(body.max_tokens));
  check(`${context}: thinking is object`, isPlainObject(body.thinking));
  check(`${context}: context_management is object`, isPlainObject(body.context_management));
  check(`${context}: output_config is object`, isPlainObject(body.output_config));
  check(`${context}: output_config.effort is non-empty string`, isNonEmptyString(body.output_config?.effort));

  // System — exactly 3 text blocks, every one non-empty, no undefined text
  check(`${context}: system is array`, Array.isArray(body.system));
  check(`${context}: system has exactly 3 blocks`, body.system?.length === 3);
  if (Array.isArray(body.system)) {
    body.system.forEach((b, i) => {
      check(`${context}: system[${i}] is object`, isPlainObject(b));
      check(`${context}: system[${i}].type === "text"`, b?.type === 'text');
      // dario#54: JSON.stringify silently omits `undefined` fields, so a
      // block with `text: undefined` serializes as {"type":"text"} — an
      // empty text block that Anthropic rejects with "text content blocks
      // must be non-empty". Asserting `text` is a non-empty string catches
      // every shape of that bug.
      check(`${context}: system[${i}].text is non-empty string`, isNonEmptyString(b?.text));
    });
    // Invariant: system[0] is the billing tag
    check(`${context}: system[0].text starts with x-anthropic-billing-header`,
      body.system[0]?.text?.startsWith('x-anthropic-billing-header:'));
  }

  // Metadata
  check(`${context}: metadata is object`, isPlainObject(body.metadata));
  check(`${context}: metadata.user_id is non-empty string`, isNonEmptyString(body.metadata?.user_id));
  // user_id is a JSON-encoded identity tuple; should parse cleanly
  try {
    const parsed = JSON.parse(body.metadata?.user_id ?? '');
    check(`${context}: metadata.user_id parses as JSON`, true);
    check(`${context}: metadata.user_id has device_id`, isNonEmptyString(parsed.device_id));
  } catch {
    check(`${context}: metadata.user_id parses as JSON`, false);
  }
}

/**
 * Assert message-level invariants: no text block in any role's content array
 * is `{type:'text'}` without a `text` field, and no text block carries
 * `text === ''` that would be empty on the wire. This is the dario#54 bug
 * class at depth.
 */
function assertMessageInvariants(body, context) {
  if (!Array.isArray(body.messages)) return;
  body.messages.forEach((msg, mi) => {
    if (Array.isArray(msg.content)) {
      msg.content.forEach((block, bi) => {
        if (block?.type === 'text') {
          check(`${context}: messages[${mi}].content[${bi}] has string text field`,
            typeof block.text === 'string');
          check(`${context}: messages[${mi}].content[${bi}].text is not empty string`,
            block.text !== '');
        }
      });
    }
  });
}

// ── Scenarios ──

const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
const cacheControl = { type: 'ephemeral' };
const billingTag = 'x-anthropic-billing-header: cc_version=test; cc_entrypoint=sdk-cli; cch=abc12;';

header('Invariants — default sonnet request, single user turn');
{
  const body = buildCCRequest(
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  assertNonHaikuInvariants(body, 'sonnet-default');
  assertMessageInvariants(body, 'sonnet-default');
}

header('Invariants — opus request, user content as array');
{
  const body = buildCCRequest(
    { model: 'claude-opus-4-7', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], stream: true },
    billingTag, cacheControl, identity,
  ).body;
  assertNonHaikuInvariants(body, 'opus-array-content');
  assertMessageInvariants(body, 'opus-array-content');
}

header('Invariants — multi-turn conversation with assistant thinking');
{
  const body = buildCCRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking ...' }, { type: 'text', text: 'first answer' }] },
        { role: 'user', content: 'follow-up' },
      ],
      stream: false,
    },
    billingTag, cacheControl, identity,
  ).body;
  assertNonHaikuInvariants(body, 'multi-turn');
  assertMessageInvariants(body, 'multi-turn');
}

header('Invariants — hybrid-tools mode');
{
  const body = buildCCRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object' } }],
      stream: false,
    },
    billingTag, cacheControl, identity,
    { hybridTools: true },
  ).body;
  assertNonHaikuInvariants(body, 'hybrid-tools');
  assertMessageInvariants(body, 'hybrid-tools');
}

header('Invariants — preserve-tools mode with custom schema');
{
  const body = buildCCRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'my_custom_tool', description: 'custom', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }],
      stream: false,
    },
    billingTag, cacheControl, identity,
    { preserveTools: true },
  ).body;
  assertNonHaikuInvariants(body, 'preserve-tools');
  assertMessageInvariants(body, 'preserve-tools');
}

header('Invariants — user content contains only a system-reminder tag (dario#54 regression guard)');
{
  // Pre-v3.30.3 bug: <system-reminder>-only blocks scrubbed to `{type:'text',text:''}`,
  // Anthropic rejected with "text content blocks must be non-empty".
  // sanitizeMessages now drops empty-text blocks post-scrub, but we only
  // call buildCCRequest here — sanitize happens at the proxy layer. Verify
  // buildCCRequest itself doesn't re-introduce the empty-block pattern.
  const body = buildCCRequest(
    {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      stream: false,
    },
    billingTag, cacheControl, identity,
  ).body;
  assertNonHaikuInvariants(body, 'single-text-block');
  assertMessageInvariants(body, 'single-text-block');
}

header('Invariants — JSON round-trip preserves all required fields (dario#54 serialization guard)');
{
  // The dario#54 bug surfaced because JSON.stringify silently drops
  // `undefined` field values. If CC_AGENT_IDENTITY had been undefined,
  // system[1] would serialize as {"type":"text","cache_control":{...}}
  // — valid TS, invalid wire. Round-tripping through JSON.stringify +
  // JSON.parse catches any new introduction of that pattern.
  const body = buildCCRequest(
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  const roundtripped = JSON.parse(JSON.stringify(body));
  assertNonHaikuInvariants(roundtripped, 'json-roundtrip');
  // Additional: the serialized-then-parsed system[1] has text (would fail
  // if text was undefined in the original).
  check('json-roundtrip: system[1].text survives serialization',
    typeof roundtripped.system[1]?.text === 'string' && roundtripped.system[1].text.length > 0);
}

header('Haiku invariants — no output_config/thinking/context_management, system still well-formed');
{
  const body = buildCCRequest(
    { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  check('haiku: model is non-empty', isNonEmptyString(body.model));
  check('haiku: messages is array', Array.isArray(body.messages));
  check('haiku: max_tokens is positive integer', isPositiveInteger(body.max_tokens));
  check('haiku: thinking is undefined', body.thinking === undefined);
  check('haiku: context_management is undefined', body.context_management === undefined);
  check('haiku: output_config is undefined', body.output_config === undefined);
  // But system invariants still hold — haiku also ships the 3-block shape
  check('haiku: system has 3 blocks', body.system?.length === 3);
  if (Array.isArray(body.system)) {
    body.system.forEach((b, i) => {
      check(`haiku: system[${i}].type === "text"`, b?.type === 'text');
      check(`haiku: system[${i}].text is non-empty string`, isNonEmptyString(b?.text));
    });
  }
  assertMessageInvariants(body, 'haiku');
}

header('Structural invariants — outbound body has no undefined leaves that JSON would drop silently');
{
  const body = buildCCRequest(
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  // Walk the body and flag any `undefined` field value — because
  // JSON.stringify silently drops undefineds without warning, and every
  // silently-dropped field is a potential dario#54-shaped bug.
  const undefinedPaths = [];
  (function walk(obj, path) {
    if (obj === null) return;
    if (typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === undefined) undefinedPaths.push(`${path}.${key}`);
      else if (typeof v === 'object') walk(v, `${path}.${key}`);
    }
  })(body, '$');
  check('no undefined leaves anywhere in outbound body',
    undefinedPaths.length === 0,
    undefinedPaths.length > 0 ? `found at: ${undefinedPaths.join(', ')}` : undefined);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Text-tool-protocol client detection — dario#40.
 *
 * Cline / Kilo Code / Roo Code (and forks) ship an XML tool-invocation
 * protocol in their system prompt and parse the model's output with a
 * regex tuned to that shape. Default dario mode swaps in CC's canonical
 * tools, which causes the model to emit Anthropic's generic
 * `<function_calls><invoke>` wrapper — well-formed for CC but
 * unparseable for the text-tool client.
 *
 * detectTextToolClient returns the family name when the system prompt
 * looks like one of these clients; buildCCRequest uses the signal to
 * auto-enable preserve-tools behavior for that request.
 *
 * Runs in-process. No proxy, no OAuth, no upstream.
 */

import { buildCCRequest, detectTextToolClient, detectNonCCByTools, CC_TOOL_DEFINITIONS } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// ────────────────────────────────────────────────────────────────────
header('1. detectTextToolClient — identity strings');

check(
  'You are Cline → cline',
  detectTextToolClient('You are Cline, a highly skilled software engineer.') === 'cline',
);
check(
  'You are Kilo Code → kilo',
  detectTextToolClient('You are Kilo Code, an open-source coding agent.') === 'kilo',
);
check(
  'You are Roo → roo',
  detectTextToolClient('You are Roo, a helpful AI coding assistant.') === 'roo',
);
check(
  'You are Arnie → arnie',
  detectTextToolClient('You are Arnie, a portable IT tech troubleshooting assistant running as a CLI.') === 'arnie',
);

// ────────────────────────────────────────────────────────────────────
header('2. detectTextToolClient — protocol-signature fallback');

check(
  '<attempt_completion> tool in prompt → cline-like',
  detectTextToolClient('Use <attempt_completion> when the task is done.') === 'cline-like',
);
check(
  '<ask_followup_question> in prompt → cline-like',
  detectTextToolClient('If you need clarification: <ask_followup_question>.') === 'cline-like',
);
check(
  'SEARCH/REPLACE diff fence → cline-like',
  detectTextToolClient('<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE') === 'cline-like',
);

// ────────────────────────────────────────────────────────────────────
header('3. detectTextToolClient — negatives');

check(
  'empty string → null',
  detectTextToolClient('') === null,
);
check(
  'undefined → null',
  detectTextToolClient(undefined) === null,
);
check(
  'plain assistant prompt → null',
  detectTextToolClient('You are a helpful assistant that answers questions.') === null,
);
check(
  'CC system prompt (no text-tool markers) → null',
  detectTextToolClient('You are an interactive agent that helps users with software engineering tasks. Use the tools available to you.') === null,
);
check(
  'generic discussion of search-and-replace → null',
  detectTextToolClient('When editing code, prefer precise search-and-replace over rewrites.') === null,
);

// ────────────────────────────────────────────────────────────────────
header('4. buildCCRequest — auto-preserve fires for Cline');

const billingTag = 'x-anthropic-billing-header: cc_version=test;';
const cache1h = { type: 'ephemeral' };
const identity = { deviceId: 'd', accountUuid: 'u', sessionId: 's' };

// Cline's real bootstrap: identity line + XML tool declaration. Uses
// a tool that IS in dario's TOOL_MAP (execute_command → Bash) so we
// can prove the auto-preserve path kept it rather than swapping in
// CC's canonical set.
const clineTools = [
  {
    name: 'execute_command',
    description: 'CLI command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, requires_approval: { type: 'boolean' } },
      required: ['command', 'requires_approval'],
    },
  },
];
const clineClientBody = {
  model: 'claude-sonnet-4-6',
  system: 'You are Cline, a highly skilled software engineer.\nUse <execute_command> to run shell commands.',
  messages: [{ role: 'user', content: 'list files' }],
  tools: clineTools,
};
const clineBuilt = buildCCRequest(clineClientBody, billingTag, cache1h, identity);
check('detectedClient === "cline"', clineBuilt.detectedClient === 'cline');
check('outbound tools === client tools (preserved)', clineBuilt.body.tools === clineTools);
check('outbound tools NOT replaced with CC canonical set', clineBuilt.body.tools !== CC_TOOL_DEFINITIONS);
check('outbound tools[0].name still "execute_command"', clineBuilt.body.tools?.[0]?.name === 'execute_command');

// ────────────────────────────────────────────────────────────────────
header('5. buildCCRequest — --hybrid-tools outranks auto-preserve');

// When the operator picks hybrid-tools explicitly, heuristic backs off.
// Detector still reports the client family (useful for logging) but
// outbound tools get the CC remap so the hybrid reverse-path works.
const hybridBuilt = buildCCRequest(clineClientBody, billingTag, cache1h, identity, { hybridTools: true });
check('detectedClient still reported under hybridTools', hybridBuilt.detectedClient === 'cline');
check('hybridTools → outbound tools === CC canonical set', hybridBuilt.body.tools === CC_TOOL_DEFINITIONS);

// ────────────────────────────────────────────────────────────────────
header('6. buildCCRequest — explicit --preserve-tools unchanged');

// No system prompt, no detection, operator-supplied preserveTools=true.
// Existing behavior: tools flow through unchanged. Regression guard.
const plainClientBody = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
  tools: clineTools,
};
const preservedBuilt = buildCCRequest(plainClientBody, billingTag, cache1h, identity, { preserveTools: true });
check('no system → detectedClient === undefined', preservedBuilt.detectedClient === undefined);
check('explicit preserveTools → tools preserved', preservedBuilt.body.tools === clineTools);

// ────────────────────────────────────────────────────────────────────
header('7. buildCCRequest — no detection, no flag → default remap');

// A plain OpenClaw-style client with no text-tool markers must still
// get the default behavior: tools replaced with the CC canonical set.
// Regression guard against false positives in the detector.
const plainBuilt = buildCCRequest(plainClientBody, billingTag, cache1h, identity);
check('no system + no flag → detectedClient === undefined', plainBuilt.detectedClient === undefined);
check('no system + no flag → tools === CC canonical set', plainBuilt.body.tools === CC_TOOL_DEFINITIONS);

// ────────────────────────────────────────────────────────────────────
header('8. System array form — detection still works');

// Anthropic's `system` field accepts either a string or an array of
// text blocks. The body-parse path in real dario gets the array form
// when a billing tag is already present. Detector must join blocks
// before running, and must skip the billing tag (which contains
// "x-anthropic-billing-header:" — otherwise the filter in
// extractSystemText would drop it and the identity string after).
const arraySystemBody = {
  model: 'claude-sonnet-4-6',
  system: [
    { type: 'text', text: billingTag },
    { type: 'text', text: 'You are Kilo Code, an open-source coding agent.' },
  ],
  messages: [{ role: 'user', content: 'hi' }],
  tools: clineTools,
};
const arrayBuilt = buildCCRequest(arraySystemBody, billingTag, cache1h, identity);
check('array-form system → detectedClient === "kilo"', arrayBuilt.detectedClient === 'kilo');
check('array-form + Kilo → tools preserved', arrayBuilt.body.tools === clineTools);

// ────────────────────────────────────────────────────────────────────
header('9. buildCCRequest — --no-auto-detect disables the detector');

// dario#40, ringge: operators who want the full CC fingerprint intact
// (tools array included) can opt out of v3.19.3's auto-preserve behavior
// even when the client's system prompt would trigger detection. Explicit
// --preserve-tools per session still works; this flag only affects the
// heuristic auto-switch.
const noDetectBuilt = buildCCRequest(clineClientBody, billingTag, cache1h, identity, { noAutoDetect: true });
check('noAutoDetect → detectedClient === undefined (detector skipped)', noDetectBuilt.detectedClient === undefined);
check('noAutoDetect → tools === CC canonical set (not preserved)', noDetectBuilt.body.tools === CC_TOOL_DEFINITIONS);
check('noAutoDetect → tools[0].name is a CC tool, not "execute_command"', noDetectBuilt.body.tools?.[0]?.name !== 'execute_command');

// noAutoDetect + explicit preserveTools: preserveTools still wins
// (explicit operator choice outranks everything).
const noDetectPreserveBuilt = buildCCRequest(clineClientBody, billingTag, cache1h, identity, { noAutoDetect: true, preserveTools: true });
check('noAutoDetect + preserveTools → tools preserved (explicit wins)', noDetectPreserveBuilt.body.tools === clineTools);

// noAutoDetect on a plain client is a no-op regression guard: default
// behavior (CC canonical tools) stays the same whether or not the flag
// is set, because nothing was going to be detected anyway.
const noDetectPlainBuilt = buildCCRequest(plainClientBody, billingTag, cache1h, identity, { noAutoDetect: true });
check('noAutoDetect on plain client → CC canonical (no-op)', noDetectPlainBuilt.body.tools === CC_TOOL_DEFINITIONS);
check('noAutoDetect on plain client → detectedClient still undefined', noDetectPlainBuilt.detectedClient === undefined);

// ────────────────────────────────────────────────────────────────────
header('10. detectNonCCByTools — structural fallback');

// Custom non-CC client surface where none of the tool names are in
// TOOL_MAP. Should trigger 'unknown-non-cc'. (Real arnie reuses some
// TOOL_MAP names like `shell`/`grep`, but its identity line guarantees
// auto-preserve via detectTextToolClient — this structural fallback is
// the safety net for *unknown* clients whose tool surface is mostly
// unrecognized.)
const customNonCCTools = [
  { name: 'network_check', input_schema: { type: 'object', properties: { host: { type: 'string' } } } },
  { name: 'event_log', input_schema: { type: 'object', properties: {} } },
  { name: 'service_status', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'port_scan', input_schema: { type: 'object', properties: { host: { type: 'string' } } } },
  { name: 'dns_lookup', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'disk_usage', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
];
check(
  'custom non-CC surface (6 unmapped) → unknown-non-cc',
  detectNonCCByTools(customNonCCTools) === 'unknown-non-cc',
);

// Two unmapped + one mapped (bash) → not enough unmapped fraction
const partialMapped = [
  { name: 'bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'custom_a', input_schema: { type: 'object', properties: {} } },
  { name: 'custom_b', input_schema: { type: 'object', properties: {} } },
];
check(
  '1 mapped + 2 unmapped (66% unmapped) → null (below threshold)',
  detectNonCCByTools(partialMapped) === null,
);

// 1 mapped + 4 unmapped (80% unmapped) → triggers
const fiveTools = [
  { name: 'bash', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_b', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_c', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_d', input_schema: { type: 'object', properties: {} } },
];
check(
  '1 mapped + 4 unmapped (80%) → unknown-non-cc',
  detectNonCCByTools(fiveTools) === 'unknown-non-cc',
);

// All-mapped (Cline-style hand-off) → null. All three are in TOOL_MAP.
const allMapped = [
  { name: 'execute_command', input_schema: { type: 'object', properties: {} } },
  { name: 'read_file', input_schema: { type: 'object', properties: {} } },
  { name: 'write_to_file', input_schema: { type: 'object', properties: {} } },
];
check(
  'all 3 mapped (Cline-style) → null (0% unmapped)',
  detectNonCCByTools(allMapped) === null,
);

// Edge cases
check('undefined tools → null', detectNonCCByTools(undefined) === null);
check('empty array → null', detectNonCCByTools([]) === null);
check('len < 3 (single custom tool) → null', detectNonCCByTools([
  { name: 'something_custom' },
]) === null);
check('len < 3 (two custom tools) → null', detectNonCCByTools([
  { name: 'foo' }, { name: 'bar' },
]) === null);

// ────────────────────────────────────────────────────────────────────
header('11. buildCCRequest — structural fallback drives auto-preserve');

// Client with no recognizable identity string but a custom tool surface
// (mostly unmapped names). Should auto-enable preserve-tools via the
// structural fallback even though detectTextToolClient returns null.
const customClientBody = {
  model: 'claude-opus-4-7',
  system: 'You are a helpful diagnostic agent that runs on the user machine.',  // no identity match
  messages: [{ role: 'user', content: 'check disk' }],
  tools: customNonCCTools,
};
const customBuilt = buildCCRequest(customClientBody, billingTag, cache1h, identity);
check('structural fallback: detectedClient === "unknown-non-cc"', customBuilt.detectedClient === 'unknown-non-cc');
check('structural fallback: tools preserved', customBuilt.body.tools === customNonCCTools);
check('structural fallback: tools[0].name still "network_check"', customBuilt.body.tools?.[0]?.name === 'network_check');

// Identity match takes precedence over structural fallback. arnie's real
// surface reuses TOOL_MAP names (shell, read_file, ...) — structural
// fallback would NOT fire on it; identity match must.
const arnieRealisticTools = [
  { name: 'shell', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
  { name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'network_check', input_schema: { type: 'object', properties: {} } },
  { name: 'event_log', input_schema: { type: 'object', properties: {} } },
];
// Sanity: this surface is mostly mapped, so structural fallback alone
// would NOT catch it.
check(
  'arnie-realistic surface (mostly mapped) → structural fallback does NOT fire',
  detectNonCCByTools(arnieRealisticTools) === null,
);
const arnieIdentityBody = {
  model: 'claude-opus-4-7',
  system: 'You are Arnie, a portable IT tech troubleshooting assistant running as a CLI.',
  messages: [{ role: 'user', content: 'hi' }],
  tools: arnieRealisticTools,
};
const arnieIdentityBuilt = buildCCRequest(arnieIdentityBody, billingTag, cache1h, identity);
check('arnie identity match → detectedClient === "arnie"', arnieIdentityBuilt.detectedClient === 'arnie');
check('arnie identity → tools preserved (schemas left alone)', arnieIdentityBuilt.body.tools === arnieRealisticTools);

// noAutoDetect disables structural fallback too
const customNoDetect = buildCCRequest(customClientBody, billingTag, cache1h, identity, { noAutoDetect: true });
check('noAutoDetect blocks structural fallback', customNoDetect.detectedClient === undefined);
check('noAutoDetect → tools NOT preserved (CC remap)', customNoDetect.body.tools !== customNonCCTools);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

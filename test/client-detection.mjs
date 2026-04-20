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

import { buildCCRequest, detectTextToolClient, CC_TOOL_DEFINITIONS } from '../dist/cc-template.js';

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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

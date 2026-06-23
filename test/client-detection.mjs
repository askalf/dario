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
check(
  'hands CLI mode → hands',
  detectTextToolClient('You are a computer control agent with FULL access to this Windows machine. You can do ANYTHING — not just coding.') === 'hands',
);
check(
  'hands SDK mode → hands',
  detectTextToolClient('You are a computer control agent on macOS. CRITICAL: Use the bash tool with shell commands instead of screenshot-click loops whenever possible.') === 'hands',
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

// Small FULLY-unmapped surfaces are flagged regardless of count.
// A 1-2 tool surface where every name is foreign can only be a non-CC client:
// real CC always carries Bash+Read, so it can't produce a 100%-unmapped set.
// These used to fall under a len<3 guard and get round-robined onto CC fallback
// slots, which corrupts the calls.
check('single fully-unmapped tool → unknown-non-cc', detectNonCCByTools([
  { name: 'something_custom' },
]) === 'unknown-non-cc');
check('two fully-unmapped tools → unknown-non-cc', detectNonCCByTools([
  { name: 'foo' }, { name: 'bar' },
]) === 'unknown-non-cc');
// forge inspection-agent capability floor — the exact surface behind the prod
// "tool substitution: 2/2 ... (db_query, memory_store)" log.
check('forge floor [memory_store, db_query] → unknown-non-cc', detectNonCCByTools([
  { name: 'memory_store' }, { name: 'db_query' },
]) === 'unknown-non-cc');
// A small MIXED surface (some mapped) stays null: a 1-2 tool partial CC load
// that reuses a TOOL_MAP alias must not be mis-flagged as foreign.
check('two tools, one mapped (bash) → null (mixed, below 3)', detectNonCCByTools([
  { name: 'bash' }, { name: 'custom_x' },
]) === null);

// ────────────────────────────────────────────────────────────────────
header('10b. detectNonCCByTools — CC-native tools are NOT foreign');

// A tool counts as "foreign" only if it's absent from BOTH TOOL_MAP and
// CC_NATIVE_NAMES (CC's live bundle). CC's newer agentic tools (Agent, Skill,
// Workflow, Task*, Cron*, NotebookEdit, Enter/ExitPlanMode, …) aren't in
// TOOL_MAP's cross-client alias table, but they ARE CC's own and identity-map
// to themselves in the remap path. Counting them as foreign (TOOL_MAP-only)
// mis-flagged an agentic-heavy CC client as 'unknown-non-cc' → preserve →
// CC tool fingerprint lost. The names below are proven CC-native cross-platform
// by the issue-29 "CC-native newer tools map to themselves" suite.

// All-CC-native surface: TOOL_MAP-only counting saw ratio === 1 (every name
// absent from TOOL_MAP) → unknown-non-cc; CC_NATIVE-aware → null (it's CC).
check('all-CC-native agentic surface → null (recognized as CC, was ratio===1)',
  detectNonCCByTools([
    { name: 'Agent' }, { name: 'AskUserQuestion' }, { name: 'Workflow' },
    { name: 'TaskCreate' }, { name: 'CronCreate' },
  ]) === null);

// Realistic modern CC: file tools (TOOL_MAP) + agentic (CC_NATIVE) → null.
check('modern CC (file + agentic tools) → null (no foreign tools)',
  detectNonCCByTools([
    { name: 'Bash' }, { name: 'Read' }, { name: 'Edit' },
    { name: 'Agent' }, { name: 'Workflow' }, { name: 'NotebookEdit' },
    { name: 'EnterPlanMode' }, { name: 'TaskCreate' },
  ]) === null);

// Mostly CC-native with a couple genuinely-foreign tools (40% foreign, < 0.8)
// → null. TOOL_MAP-only counting would have seen 5/5 = ratio 1 → unknown-non-cc.
check('CC-native + 2 foreign (40% foreign) → null (mostly CC, remap)',
  detectNonCCByTools([
    { name: 'Agent' }, { name: 'Workflow' }, { name: 'TaskCreate' },
    { name: 'custom_x' }, { name: 'custom_y' },
  ]) === null);

// Regression: a genuinely foreign-dominated surface still flags, even with one
// CC tool present. 1 mapped + 5 foreign (none CC-native) = 83% foreign ≥ 0.8.
check('foreign-dominated surface (1 CC + 5 foreign) → unknown-non-cc',
  detectNonCCByTools([
    { name: 'Bash' },
    { name: 'memory_store' }, { name: 'db_query' }, { name: 'vector_search' },
    { name: 'graph_walk' }, { name: 'ledger_post' },
  ]) === 'unknown-non-cc');

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

// A realistic forge inspection agent — custom system prompt with NO
// identity match, and only its 2-tool capability floor. Both tools are foreign
// (ratio === 1), so the structural fallback must auto-preserve end-to-end.
// Before the fix this 2-tool body fell under the len<3 guard and got the CC
// canonical remap (memory_store→Bash, db_query→Read), corrupting every call.
const forgeAgentBody = {
  model: 'claude-sonnet-4-6',
  system: '[PERSONALITY: Vigilant and protective.]\n\nYou are the Watchdog. Monitor system health every cycle and create tickets for anything that needs attention.',
  messages: [{ role: 'user', content: 'check system health' }],
  tools: [
    { name: 'memory_store', input_schema: { type: 'object', properties: { content: { type: 'string' } } } },
    { name: 'db_query', input_schema: { type: 'object', properties: { sql: { type: 'string' } } } },
  ],
};
const forgeBuilt = buildCCRequest(forgeAgentBody, billingTag, cache1h, identity);
check('forge 2-tool surface → detectedClient === "unknown-non-cc"', forgeBuilt.detectedClient === 'unknown-non-cc');
check('forge 2-tool surface → tools preserved (not remapped)', forgeBuilt.body.tools === forgeAgentBody.tools);
check('forge 2-tool surface → tools[0].name still "memory_store"', forgeBuilt.body.tools?.[0]?.name === 'memory_store');
check('forge 2-tool surface → tools[1].name still "db_query"', forgeBuilt.body.tools?.[1]?.name === 'db_query');

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

// Same shape for hands. Tool surface uses Anthropic's beta computer-use
// types: `bash` is in TOOL_MAP, `computer` and `text_editor` (str_replace
// _based_edit_tool) are not. 67% unmapped → below structural fallback's
// 80% threshold. Identity match is the only correct routing.
const handsRealisticTools = [
  { name: 'computer', type: 'computer_20251124', display_width_px: 1920, display_height_px: 1080, display_number: 1 },
  { name: 'bash', type: 'bash_20250124' },
  { name: 'str_replace_based_edit_tool', type: 'text_editor_20250728' },
];
check(
  'hands-realistic surface (mostly unmapped) → structural fallback does NOT fire (below threshold)',
  detectNonCCByTools(handsRealisticTools) === null,
);
const handsIdentityBody = {
  model: 'claude-opus-4-7',
  system: 'You are a computer control agent with FULL access to this Windows machine. You can do ANYTHING — not just coding.',
  messages: [{ role: 'user', content: 'hi' }],
  tools: handsRealisticTools,
};
const handsIdentityBuilt = buildCCRequest(handsIdentityBody, billingTag, cache1h, identity);
check('hands identity match → detectedClient === "hands"', handsIdentityBuilt.detectedClient === 'hands');
check('hands identity → tools preserved (beta types left alone)', handsIdentityBuilt.body.tools === handsRealisticTools);

// noAutoDetect disables structural fallback too
const customNoDetect = buildCCRequest(customClientBody, billingTag, cache1h, identity, { noAutoDetect: true });
check('noAutoDetect blocks structural fallback', customNoDetect.detectedClient === undefined);
check('noAutoDetect → tools NOT preserved (CC remap)', customNoDetect.body.tools !== customNonCCTools);

// ────────────────────────────────────────────────────────────────────
header('12. mergeTools — CC tools first, client custom tools appended (deduped)');

// Custom tools the client declares — none of these names are in CC's
// canonical set, so they should all survive the dedupe.
const mergeCustomTools = [
  { name: 'weather_check', input_schema: { type: 'object', properties: {} } },
  { name: 'database_query', input_schema: { type: 'object', properties: {} } },
];
const mergeBody = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
  tools: mergeCustomTools,
};
const mergeBuilt = buildCCRequest(mergeBody, billingTag, cache1h, identity, { mergeTools: true });
const mergeOut = mergeBuilt.body.tools;
check('merge mode: tools is an array', Array.isArray(mergeOut));
check('merge mode: starts with CC tool surface', mergeOut[0]?.name === CC_TOOL_DEFINITIONS[0]?.name);
check('merge mode: contains all of CC canonical', mergeOut.length === CC_TOOL_DEFINITIONS.length + mergeCustomTools.length);
check('merge mode: client custom tool appended (weather_check present)',
  mergeOut.some((t) => t.name === 'weather_check'));
check('merge mode: client custom tool appended (database_query present)',
  mergeOut.some((t) => t.name === 'database_query'));

// Dedupe: a client tool whose name collides with a CC tool gets dropped.
// CC's wire shape stays canonical and the client's "Bash" doesn't
// double-occupy the slot.
const collidingTools = [
  { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'unique_tool', input_schema: { type: 'object', properties: {} } },
];
const collidingBuilt = buildCCRequest(
  { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: collidingTools },
  billingTag, cache1h, identity, { mergeTools: true },
);
const collidingOut = collidingBuilt.body.tools;
check('merge mode: colliding name is deduped (Bash from CC kept, client Bash dropped)',
  collidingOut.filter((t) => t.name === 'Bash').length === 1);
check('merge mode: non-colliding name is appended (unique_tool present)',
  collidingOut.some((t) => t.name === 'unique_tool'));
check('merge mode: deduped count = CC + 1 (only unique_tool added)',
  collidingOut.length === CC_TOOL_DEFINITIONS.length + 1);

// Mutex: when preserveTools and mergeTools are both set, preserveTools
// wins (the proxy CLI rejects the combo at startup, but buildCCRequest
// itself degrades gracefully — preserve is the safer choice if both
// make it through). This is not the operator-facing contract; just a
// defense against a coding-bug regression.
const mutexBuilt = buildCCRequest(
  mergeBody, billingTag, cache1h, identity,
  { preserveTools: true, mergeTools: true },
);
check('merge + preserve: preserve wins (tools === client tools)',
  mutexBuilt.body.tools === mergeCustomTools);

// mergeTools blocks autoPreserve. A client whose system prompt would
// normally trigger auto-preserve (Cline/arnie/etc.) gets the merge body
// when the operator explicitly opted into merge — operator outranks
// heuristic.
const cliPlusMerge = buildCCRequest(
  {
    model: 'claude-sonnet-4-6',
    system: 'You are Cline, a highly skilled software engineer.',
    messages: [{ role: 'user', content: 'hi' }],
    tools: mergeCustomTools,
  },
  billingTag, cache1h, identity, { mergeTools: true },
);
check('merge + cline-detected: detectedClient still reported',
  cliPlusMerge.detectedClient === 'cline');
check('merge + cline-detected: tools shape is merge (CC + client), NOT preserve',
  cliPlusMerge.body.tools.length === CC_TOOL_DEFINITIONS.length + mergeCustomTools.length);

// Empty client tools + merge → still emit CC base array (operator chose
// merge, fingerprint shape matters).
const emptyToolsMergeBuilt = buildCCRequest(
  { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
  billingTag, cache1h, identity, { mergeTools: true },
);
check('merge + no client tools: still emits CC tools (fingerprint preserved)',
  emptyToolsMergeBuilt.body.tools === CC_TOOL_DEFINITIONS);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

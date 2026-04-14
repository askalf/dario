#!/usr/bin/env node
/**
 * Issue #29 regression test — reverse parameter shape translation.
 *
 * Reproduces boeingchoco's bug:
 *   1. Client sends a tool with name "process" and parameter "action"
 *   2. Dario forward-maps process → Bash with translateArgs converting
 *      `action` to CC's `command`
 *   3. Anthropic returns a tool_use with name "Bash" and input
 *      { command: "ls -la" }
 *   4. Dario reverse-maps Bash → process … and pre-v3.7.0 left the
 *      input as { command: "ls -la" } so the client validator rejected
 *      because it expected { action: "ls -la" }
 *
 * v3.7.0 fix: reverseMapResponse and createStreamingReverseMapper both
 * apply the mapping's translateBack to rewrite the input shape.
 *
 * This test runs entirely in-process — no live proxy, no OAuth, no
 * upstream requests — so it can run in CI and on a fresh checkout.
 */

import { buildCCRequest, reverseMapResponse, createStreamingReverseMapper } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// ── Build a toolMap that mirrors what proxy.ts would construct from
//    a real OpenClaw-style client request with the `process` tool. ──

const clientBody = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'list files' }],
  tools: [
    {
      name: 'process',
      description: 'Run a shell command',
      input_schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    },
    {
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
};
const billingTag = 'x-anthropic-billing-header: cc_version=test;';
const cache1h = { type: 'ephemeral', ttl: '1h' };
const identity = { deviceId: 'd', accountUuid: 'u', sessionId: 's' };

const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity);

// ── Test 1: Non-streaming reverse map for `process` (Bash) ──

header('1. Non-streaming: Bash tool_use → process with action shape');

const upstreamResponse = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [
    { type: 'text', text: 'Listing files now.' },
    { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls -la /tmp' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5 },
});

const mapped = JSON.parse(reverseMapResponse(upstreamResponse, toolMap));
const toolBlock = mapped.content.find(b => b.type === 'tool_use');

check('tool_use block is present after reverse-map', toolBlock !== undefined);
check('tool name rewritten Bash → process', toolBlock?.name === 'process');
check('input.action === "ls -la /tmp" (was input.command pre-v3.7.0)', toolBlock?.input?.action === 'ls -la /tmp');
check('input.command is GONE (would break client validator)', toolBlock?.input?.command === undefined);
check('text block untouched', mapped.content[0]?.text === 'Listing files now.');

// ── Test 2: Non-streaming reverse map for `read` (Read) ──

header('2. Non-streaming: Read tool_use → read with path shape');

const readResponse = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/etc/hosts' } },
  ],
  stop_reason: 'tool_use',
});

const mappedRead = JSON.parse(reverseMapResponse(readResponse, toolMap));
const readBlock = mappedRead.content[0];

check('tool name rewritten Read → read', readBlock?.name === 'read');
check('input.path === "/etc/hosts"', readBlock?.input?.path === '/etc/hosts');
check('input.file_path is GONE', readBlock?.input?.file_path === undefined);

// ── Test 3: Streaming reverse map for Bash → process ──

header('3. Streaming: Bash tool_use SSE → process with translated input');

const sseChunks = [
  // event: message_start (passthrough)
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
  // content_block_start tool_use
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_s","name":"Bash","input":{}}}\n\n`,
  // partial_json deltas — split across multiple SSE events
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"comm"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"and\\":\\"l"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"s -la /tmp\\"}"}}\n\n`,
  // content_block_stop
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  // message_stop
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

const streamMapper = createStreamingReverseMapper(toolMap);
const collected = [];
const encoder = new TextEncoder();

// Feed chunks one at a time, collecting output
for (const chunk of sseChunks) {
  const out = streamMapper.feed(encoder.encode(chunk));
  if (out.length > 0) collected.push(new TextDecoder().decode(out));
}
const tail = streamMapper.end();
if (tail.length > 0) collected.push(new TextDecoder().decode(tail));

const collectedText = collected.join('');

// Parse the output by extracting `data: ...` lines
const outputDataLines = collectedText
  .split('\n')
  .filter(l => l.startsWith('data: '))
  .map(l => {
    try { return JSON.parse(l.slice(6)); }
    catch { return null; }
  })
  .filter(x => x !== null);

const startEvents = outputDataLines.filter(e => e.type === 'content_block_start');
const deltaEvents = outputDataLines.filter(e => e.type === 'content_block_delta');
const stopEvents = outputDataLines.filter(e => e.type === 'content_block_stop');

check('exactly 1 content_block_start emitted', startEvents.length === 1);
check('start event renames Bash → process', startEvents[0]?.content_block?.name === 'process');
check('exactly 1 content_block_delta emitted (deltas were collapsed)', deltaEvents.length === 1);

// The synthetic delta's partial_json should parse to the translated input
const synthDeltaJson = deltaEvents[0]?.delta?.partial_json;
let synthInput = null;
try { synthInput = JSON.parse(synthDeltaJson); } catch { /* leave null */ }

check('synthetic delta parses as JSON', synthInput !== null);
check('synthetic delta input.action === "ls -la /tmp"', synthInput?.action === 'ls -la /tmp');
check('synthetic delta input.command is GONE', synthInput?.command === undefined);
check('exactly 1 content_block_stop emitted', stopEvents.length === 1);

// ── Test 4: Streaming with chunks split mid-line ──

header('4. Streaming: chunks split mid-line should still translate correctly');

// Same conceptual stream, but every byte is fed in a separate chunk to
// stress the line-buffering logic. If the mapper's line splitter is
// wrong, this test catches it.
const fullStream = sseChunks.join('');
const streamMapper2 = createStreamingReverseMapper(toolMap);
const collected2 = [];
for (let i = 0; i < fullStream.length; i++) {
  const out = streamMapper2.feed(encoder.encode(fullStream[i]));
  if (out.length > 0) collected2.push(new TextDecoder().decode(out));
}
const tail2 = streamMapper2.end();
if (tail2.length > 0) collected2.push(new TextDecoder().decode(tail2));
const collectedText2 = collected2.join('');

const dataLines2 = collectedText2
  .split('\n')
  .filter(l => l.startsWith('data: '))
  .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
  .filter(x => x !== null);

const startEvents2 = dataLines2.filter(e => e.type === 'content_block_start');
const deltaEvents2 = dataLines2.filter(e => e.type === 'content_block_delta');
let synthInput2 = null;
try { synthInput2 = JSON.parse(deltaEvents2[0]?.delta?.partial_json); } catch { /* leave null */ }

check('byte-by-byte streaming produces 1 start event', startEvents2.length === 1);
check('byte-by-byte streaming renames Bash → process', startEvents2[0]?.content_block?.name === 'process');
check('byte-by-byte streaming produces 1 collapsed delta', deltaEvents2.length === 1);
check('byte-by-byte streaming input.action === "ls -la /tmp"', synthInput2?.action === 'ls -la /tmp');

// ── Test 5: Tools without translateBack pass through unchanged ──

header('5. Tools without translateBack are name-only (still no input rewrite)');

// `glob` has no translateBack defined — ccTool: 'Glob' with no
// translation. The non-streaming mapper should rewrite the name but
// leave the input alone (because there's nothing to translate to).
const globClientBody = {
  ...clientBody,
  tools: [{ name: 'glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } }],
};
const { toolMap: globToolMap } = buildCCRequest(globClientBody, billingTag, cache1h, identity);
const globResponse = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_g', name: 'Glob', input: { pattern: '**/*.py' } }],
  stop_reason: 'tool_use',
});
const globMapped = JSON.parse(reverseMapResponse(globResponse, globToolMap));
const globBlock = globMapped.content[0];

check('Glob rewritten to client name (or kept as Glob if identity)', globBlock?.name === 'glob' || globBlock?.name === 'Glob');
check('glob input passes through untouched (no translateBack)', globBlock?.input?.pattern === '**/*.py');

// ── Summary ──

console.log(`\n${pass} pass, ${fail} fail\n`);
process.exit(fail > 0 ? 1 : 0);

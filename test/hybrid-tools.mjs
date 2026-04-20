#!/usr/bin/env node
/**
 * Hybrid tool mode regression test — issue #33.
 *
 * Reproduces the exact follow-on scenario from #29: a client (OpenClaw
 * style) declares a tool whose schema carries fields CC's schema
 * doesn't — `sessionId`, `requestId`, `channelId`, etc. In default
 * mode the model never sees those fields, so the reverse-mapped tool
 * call arrives at the client validator with them missing and gets
 * rejected. `--preserve-tools` works but loses the CC fingerprint.
 *
 * Hybrid mode: forward path still remaps to CC tools (fingerprint
 * preserved), reverse path injects request-context values into
 * client-declared fields that are still empty after translateBack.
 *
 * Runs in-process. No proxy, no OAuth, no upstream.
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

const clientBody = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'list files' }],
  tools: [
    {
      name: 'process',
      description: 'Run a shell command in a channel-bound session',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          sessionId: { type: 'string' },
          channelId: { type: 'string' },
          requestId: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['action', 'sessionId'],
      },
    },
    {
      name: 'read',
      description: 'Read a file in a session',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          session_id: { type: 'string' },
        },
        required: ['path', 'session_id'],
      },
    },
  ],
};
const billingTag = 'x-anthropic-billing-header: cc_version=test;';
const cache1h = { type: 'ephemeral' };
const identity = { deviceId: 'd', accountUuid: 'u', sessionId: 's' };

const ctx = {
  sessionId: 'sess_test_123',
  requestId: 'req_abc_xyz',
  channelId: 'chan_telegram_42',
  userId: 'user_99',
  timestamp: '2026-04-14T12:00:00.000Z',
};

function makeUpstream(ccToolName, input) {
  return JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      { type: 'text', text: 'Running now.' },
      { type: 'tool_use', id: 'toolu_a', name: ccToolName, input },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

// ======================================================================
//  1. Default mode — sessionId is dropped (the pre-#33 behavior)
// ======================================================================
header('1. Default mode — no hybrid, no injection');

{
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity);
  const upstream = makeUpstream('Bash', { command: 'ls -la /tmp' });
  const mapped = JSON.parse(reverseMapResponse(upstream, toolMap, ctx));
  const block = mapped.content.find(b => b.type === 'tool_use');
  check('tool_use present', !!block);
  check('name rewritten Bash → process', block?.name === 'process');
  check('action populated from translateBack', block?.input?.action === 'ls -la /tmp');
  check('sessionId ABSENT in default mode (no injection)', block?.input?.sessionId === undefined);
  check('channelId ABSENT in default mode', block?.input?.channelId === undefined);
}

// ======================================================================
//  2. Hybrid mode — sessionId injected from request context
// ======================================================================
header('2. Hybrid mode — inject sessionId + context fields');

{
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity, { hybridTools: true });
  const upstream = makeUpstream('Bash', { command: 'ls -la /tmp' });
  const mapped = JSON.parse(reverseMapResponse(upstream, toolMap, ctx));
  const block = mapped.content.find(b => b.type === 'tool_use');
  check('tool_use present', !!block);
  check('name still rewritten Bash → process', block?.name === 'process');
  check('action still populated from translateBack', block?.input?.action === 'ls -la /tmp');
  check('sessionId INJECTED from ctx', block?.input?.sessionId === 'sess_test_123');
  check('channelId INJECTED from ctx', block?.input?.channelId === 'chan_telegram_42');
  check('requestId INJECTED from ctx', block?.input?.requestId === 'req_abc_xyz');
  check('timestamp INJECTED from ctx', block?.input?.timestamp === '2026-04-14T12:00:00.000Z');
}

// ======================================================================
//  3. Hybrid mode — snake_case variant (session_id)
// ======================================================================
header('3. Hybrid mode — snake_case session_id variant');

{
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity, { hybridTools: true });
  const upstream = makeUpstream('Read', { file_path: '/home/u/file.txt' });
  const mapped = JSON.parse(reverseMapResponse(upstream, toolMap, ctx));
  const block = mapped.content.find(b => b.type === 'tool_use');
  check('name rewritten Read → read', block?.name === 'read');
  check('path populated from translateBack', block?.input?.path === '/home/u/file.txt');
  check('session_id (snake_case) injected from ctx.sessionId', block?.input?.session_id === 'sess_test_123');
}

// ======================================================================
//  4. Hybrid mode — no ctx is a no-op (does not crash)
// ======================================================================
header('4. Hybrid mode — no ctx supplied, no crash, no injection');

{
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity, { hybridTools: true });
  const upstream = makeUpstream('Bash', { command: 'ls' });
  const mapped = JSON.parse(reverseMapResponse(upstream, toolMap));
  const block = mapped.content.find(b => b.type === 'tool_use');
  check('action populated', block?.input?.action === 'ls');
  check('sessionId still absent without ctx', block?.input?.sessionId === undefined);
}

// ======================================================================
//  5. Hybrid mode — translateBack fields NOT overwritten
// ======================================================================
header('5. Hybrid mode — primary fields from translateBack not clobbered');

{
  const clientWithActionAndSession = {
    ...clientBody,
    tools: [clientBody.tools[0]],
  };
  const { toolMap } = buildCCRequest(clientWithActionAndSession, billingTag, cache1h, identity, { hybridTools: true });
  const upstream = makeUpstream('Bash', { command: 'rm -rf /' });
  const mapped = JSON.parse(reverseMapResponse(upstream, toolMap, ctx));
  const block = mapped.content.find(b => b.type === 'tool_use');
  check('action comes from translateBack (not injected)', block?.input?.action === 'rm -rf /');
  check('sessionId still injected alongside', block?.input?.sessionId === 'sess_test_123');
}

// ======================================================================
//  6. Hybrid + streaming — end-of-block injection
// ======================================================================
header('6. Hybrid mode + streaming reverse mapper');

{
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity, { hybridTools: true });
  const mapper = createStreamingReverseMapper(toolMap, ctx);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const sseEvents = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_x', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' /tmp"}' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];

  let out = '';
  for (const e of sseEvents) {
    const chunk = mapper.feed(enc.encode(e));
    if (chunk.length) out += dec.decode(chunk);
  }
  const tail = mapper.end();
  if (tail.length) out += dec.decode(tail);

  // Parse the emitted SSE — find the content_block_delta for index 0
  // whose partial_json should contain our translated+injected input.
  const groups = out.split('\n\n').filter(g => g.trim() !== '');
  const deltas = groups.filter(g => {
    const dataLine = g.split('\n').find(l => l.startsWith('data:'));
    if (!dataLine) return false;
    try {
      const ev = JSON.parse(dataLine.slice(5).trim());
      return ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta';
    } catch { return false; }
  });

  check('exactly one delta emitted for the tool_use block', deltas.length === 1);

  const deltaData = deltas[0].split('\n').find(l => l.startsWith('data:')).slice(5).trim();
  const deltaEvent = JSON.parse(deltaData);
  const injectedInput = JSON.parse(deltaEvent.delta.partial_json);

  check('streaming: action populated from translateBack', injectedInput.action === 'ls -la /tmp');
  check('streaming: sessionId injected', injectedInput.sessionId === 'sess_test_123');
  check('streaming: channelId injected', injectedInput.channelId === 'chan_telegram_42');
  check('streaming: every emitted event parses as valid JSON', groups.every(g => {
    const dl = g.split('\n').find(l => l.startsWith('data:'));
    if (!dl) return true;
    try { JSON.parse(dl.slice(5).trim()); return true; } catch { return false; }
  }));
}

// ======================================================================
//  dario#36 — exec/bash translateBack produces {command}, not {cmd}
// ======================================================================
//
// OpenClaw's `exec` tool takes {command, workdir, env, ...}. Pre-fix,
// TOOL_MAP.exec.translateBack emitted {cmd: ...} which left params.command
// undefined on OpenClaw's side and threw "Provide a command to start."
header('dario#36 — bash/exec reverse translation uses `command`');
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'run ls' }],
    tools: [
      {
        name: 'exec',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  const upstream = JSON.stringify({
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la /tmp' } },
    ],
  });
  const remapped = JSON.parse(reverseMapResponse(upstream, built.toolMap));
  const block = remapped.content[0];
  check('exec block name is `exec` (not `Bash`)', block.name === 'exec');
  check('exec block input has `command` (not `cmd`)', block.input.command === 'ls -la /tmp');
  check('exec block input has NO `cmd` field (the pre-fix bug)', block.input.cmd === undefined);
}

// ======================================================================
//  dario#36 — hybrid mode drops unmapped tools instead of round-robin
// ======================================================================
//
// OpenClaw declares ~50 custom tools (lobster, memory_get, feishu_*, ...).
// Pre-fix they got round-robin'd onto CC fallback tools, so calls returned
// with Grep's input shape instead of lobster's action-discriminator shape
// and threw "Unknown action". Fix: in hybrid mode, skip them entirely so
// the model upstream never sees them and can't mis-call them.
header('dario#36 — hybrid mode drops unmapped tools');
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'do something' }],
    tools: [
      {
        name: 'bash',
        description: 'shell',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      {
        name: 'lobster',
        description: 'task flow runner',
        input_schema: { type: 'object', properties: { action: { type: 'string' }, taskId: { type: 'string' } } },
      },
      {
        name: 'memory_get',
        description: 'memory read',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, from: { type: 'number' } } },
      },
    ],
  };
  const hybrid = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    { hybridTools: true },
  );
  check('hybrid: unmappedTools reports lobster and memory_get', hybrid.unmappedTools.includes('lobster') && hybrid.unmappedTools.includes('memory_get'));
  check('hybrid: lobster NOT in activeToolMap (dropped, not round-robin)', !hybrid.toolMap.has('lobster'));
  check('hybrid: memory_get NOT in activeToolMap (dropped)', !hybrid.toolMap.has('memory_get'));
  check('hybrid: bash still mapped (in TOOL_MAP)', hybrid.toolMap.has('bash'));

  // Default mode preserves the old round-robin behavior so simple clients
  // don't regress.
  const defaultMode = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  check('default mode: lobster IS round-robin mapped (old behavior preserved)', defaultMode.toolMap.has('lobster'));
  check('default mode: memory_get IS round-robin mapped', defaultMode.toolMap.has('memory_get'));
}

// ======================================================================
//  dario#37 — reverseScore breaks exec/process collision on Bash
// ======================================================================
//
// OpenClaw declares BOTH `exec` (bash-family, wants {command}) AND
// `process` (action-discriminator, wants {action}) as sibling tools.
// Both map to CC's Bash in TOOL_MAP. Pre-fix, the reverse lookup picked
// one via insertion-order last-wins, and when `process` won every Bash
// tool call returned as {action: "ls"} and OpenClaw threw "Unknown action".
// Fix: process has reverseScore: 1, so exec/bash (default 10) wins the
// reverse slot for CC Bash.
header('dario#37 — exec wins over process on CC Bash reverse slot');
{
  // Order matters — declare process LAST so pre-fix insertion-order
  // last-wins would have routed Bash → process.
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: [
      {
        name: 'exec',
        description: 'run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      {
        name: 'process',
        description: 'session manager',
        input_schema: { type: 'object', properties: { action: { type: 'string' }, sessionId: { type: 'string' } } },
      },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  const upstream = JSON.stringify({
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ],
  });
  const remapped = JSON.parse(reverseMapResponse(upstream, built.toolMap));
  const block = remapped.content[0];
  check('collision: Bash reverse routes to `exec`, NOT `process`', block.name === 'exec');
  check('collision: input carries `command`, NOT `action`', block.input.command === 'pwd');
  check('collision: no stray `action` field (the pre-fix bug)', block.input.action === undefined);
}

// Same scenario but with process declared FIRST — verifies the score
// wins over insertion order in either direction.
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: [
      {
        name: 'process',
        description: 'session manager',
        input_schema: { type: 'object', properties: { action: { type: 'string' } } },
      },
      {
        name: 'exec',
        description: 'run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  const upstream = JSON.stringify({
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }],
  });
  const remapped = JSON.parse(reverseMapResponse(upstream, built.toolMap));
  check('collision (reverse order): still routes to `exec`', remapped.content[0].name === 'exec');
  check('collision (reverse order): still carries `command`', remapped.content[0].input.command === 'pwd');
}

// ======================================================================
//  dario#37 (Glob half) — unmapped fallback must never claim a reverse slot.
// ======================================================================
//
// Original report (tetsuco, OpenClaw, v3.9.3):
//   Glob: { "pattern": "/tmp/*" } → {"tool":"image","error":"image required"}
//
// OpenClaw declares an `image` tool that's not in TOOL_MAP. Default mode
// round-robins it onto a CC fallback tool. The note in the input shape is
// the smoking gun: the input is `{pattern: "/tmp/*"}` — a Glob shape — but
// the output complains the `image` tool got the wrong arguments. So the
// model was calling Glob (a real CC tool that's always in CC_TOOL_DEFINITIONS),
// the upstream returned a Glob tool_use, and dario's reverse path rewrote
// the name to `image` because the unmapped fallback for `image` happened
// to land on Glob's slot in the reverse lookup.
//
// Fix: any mapping with reverseScore: 0 is excluded from the reverse map
// entirely. Unmapped fallbacks now have reverseScore: 0, so a real Glob
// tool_use with no legitimate mapping passes through unchanged (name stays
// "Glob"), and the client either handles it cleanly or rejects it cleanly
// — but no infinite loop where the model thinks it called Glob and the
// client thinks it received an image call.
header('dario#37 (Glob) — unmapped `image` cannot steal Glob reverse slot');
{
  // Force `image` onto Glob by padding earlier round-robin slots. With
  // CC_FALLBACK_TOOLS = [Bash, Read, Grep, Glob, ...] and three unmapped
  // padding tools claiming Bash/Read/Grep, the fourth unmapped tool lands
  // on Glob. No legitimate Glob mapping is declared — this matches the
  // original OpenClaw repro.
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'list /tmp' }],
    tools: [
      { name: 'unmapped_a', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'unmapped_b', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'unmapped_c', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'image', description: 'render an image', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  // Test premise: `image` actually landed on Glob via round-robin. If the
  // distribution algorithm ever changes, fail loud rather than silently.
  check('test premise: `image` is round-robin\'d onto Glob', built.toolMap.get('image')?.ccTool === 'Glob');

  // The model emits a real Glob tool_use (Glob is in CC_TOOL_DEFINITIONS).
  const upstream = JSON.stringify({
    content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '/tmp/*' } }],
  });
  const remapped = JSON.parse(reverseMapResponse(upstream, built.toolMap));
  const block = remapped.content[0];
  // Pre-fix: block.name === 'image' (the bug). Post-fix: block.name stays
  // 'Glob' so the client sees an honest unhandled-tool case instead of
  // routing through `image` with the wrong input shape.
  check('Glob tool_use is NOT rewritten to `image`', block.name !== 'image');
  check('Glob tool_use passes through with original name', block.name === 'Glob');
  check('input is preserved unchanged', block.input.pattern === '/tmp/*');
}

// Same scenario but a legitimate Glob mapping (`find_files`) is also
// declared. The legitimate mapping must claim the reverse slot, and the
// unmapped `image` must not interfere even though both forward to Glob.
// Note: when `find_files` is mapped, Glob is already in claimedCC, so the
// round-robin pool excludes Glob and `image` lands on a different fallback.
// This test verifies that path is also clean.
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'find python files' }],
    tools: [
      { name: 'find_files', description: 'glob for files', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } },
      { name: 'image', description: 'render an image', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  check('find_files is the legitimate Glob mapping', built.toolMap.get('find_files')?.ccTool === 'Glob');
  check('image is NOT round-robin\'d onto Glob (Glob already claimed)', built.toolMap.get('image')?.ccTool !== 'Glob');

  const upstream = JSON.stringify({
    content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '**/*.py' } }],
  });
  const remapped = JSON.parse(reverseMapResponse(upstream, built.toolMap));
  check('Glob reverse routes to legitimate `find_files`', remapped.content[0].name === 'find_files');
  check('input pattern preserved', remapped.content[0].input.pattern === '**/*.py');
}

// ======================================================================
//  dario#37 (Glob half) — streaming reverse mapper also preserves Glob
// ======================================================================
//
// Streaming is the production path for CC. buildReverseLookup is shared
// between reverseMapResponse (non-streaming) and createStreamingReverseMapper
// (SSE), so the reverseScore: 0 exclusion applies to both — but the
// streaming path has its own content_block_start / delta / stop handling
// that could in principle diverge. Cover it explicitly.
header('dario#37 (Glob) — streaming: real Glob passes through unchanged');
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'list /tmp' }],
    stream: true,
    tools: [
      { name: 'unmapped_a', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'unmapped_b', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'unmapped_c', description: 'x', input_schema: { type: 'object', properties: {} } },
      { name: 'image', description: 'render an image', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  // Test premise check — if round-robin ever changes this will fail loud.
  check('stream premise: `image` is round-robin\'d onto Glob', built.toolMap.get('image')?.ccTool === 'Glob');

  // Simulate a real upstream SSE stream carrying a Glob tool_use. If the
  // streaming reverse mapper rewrote block.name to `image`, OpenClaw would
  // see an `image` tool call in its SSE stream with a `{pattern: ...}` body
  // and hit the "image required" validation error on the wire.
  const sseChunks = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_g","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_g","name":"Glob","input":{}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"patt"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ern\\":\\"/tmp/*\\"}"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const mapper = createStreamingReverseMapper(built.toolMap);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const out = [];
  for (const chunk of sseChunks) {
    const bytes = mapper.feed(enc.encode(chunk));
    if (bytes.length > 0) out.push(dec.decode(bytes));
  }
  const tail = mapper.end();
  if (tail.length > 0) out.push(dec.decode(tail));
  const wire = out.join('');

  // Parse the emitted SSE using the same lightweight parser pattern as
  // issue-29 — look for content_block_start events and verify the tool
  // name is "Glob", not "image", and the partial_json input carries
  // `pattern`.
  const events = [];
  for (const group of wire.split('\n\n')) {
    if (!group.trim()) continue;
    let eventType = null, dataText = '';
    for (const line of group.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      else if (line.startsWith('data: ')) dataText += (dataText ? '\n' : '') + line.slice(6);
    }
    if (!dataText) continue;
    try { events.push({ eventType, data: JSON.parse(dataText) }); } catch { /* skip */ }
  }
  const starts = events.filter(e => e.data?.type === 'content_block_start');
  const deltas = events.filter(e => e.data?.type === 'content_block_delta');
  check('exactly 1 content_block_start emitted', starts.length === 1);
  check('streaming start event: tool name is `Glob`, NOT `image`', starts[0]?.data?.content_block?.name === 'Glob');
  check('streaming start event: block type is tool_use', starts[0]?.data?.content_block?.type === 'tool_use');
  // Deltas: Glob has no legitimate mapping here, so the mapper should
  // pass the original deltas through unchanged (not collapse them into
  // a synthetic single delta the way it does for translated blocks).
  check('streaming deltas pass through (≥1 emitted)', deltas.length >= 1);
  // Concatenate all partial_json fragments and parse — should yield the
  // original input shape.
  const fullInput = deltas.map(d => d.data?.delta?.partial_json || '').join('');
  let parsed = null;
  try { parsed = JSON.parse(fullInput); } catch { /* leave null */ }
  check('streaming input parses as JSON', parsed !== null);
  check('streaming input.pattern === "/tmp/*"', parsed?.pattern === '/tmp/*');
}

// ======================================================================
//
// ======================================================================
header('dario#36 — drop trailing assistant/empty turns (prefill rejection)');
{
  // Client preserves thinking in history (OpenClaw/Hermes pattern). The
  // tail assistant turn is thinking-only — after the strip it becomes
  // content: [] and Anthropic rejects the request as an invalid prefill
  // under adaptive thinking + claude-code beta.
  const body = {
    model: 'claude-opus-4-6',
    messages: [
      { role: 'user', content: 'read the config' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'I should read it' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/etc/x' } },
      ]},
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'still thinking...' }] },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    { hybridTools: true },
  );
  const finalMessages = built.body.messages;
  const lastMsg = finalMessages[finalMessages.length - 1];
  check('trailing thinking-only assistant turn dropped', finalMessages.length === 3);
  check('final message is user role', lastMsg.role === 'user');
  check('tool_result turn preserved', Array.isArray(lastMsg.content) && lastMsg.content[0].type === 'tool_result');
}

// ======================================================================
//
// ======================================================================
header('dario#37 — trailing assistant with real content is preserved (runaway loop fix)');
{
  // v3.10.1 popped any trailing assistant, including ones with real
  // text/tool_use content. That caused OpenClaw to runaway-loop: client
  // appends its assistant reply locally, dario strips it from the next
  // request, model regenerates the same reply, dario strips that, never
  // terminates. v3.10.2 drops ONLY empty trailing turns.
  const body = {
    model: 'claude-opus-4-6',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'partial response' }] },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  const finalMessages = built.body.messages;
  check('trailing assistant with text content preserved', finalMessages.length === 2);
  check('last message is still the assistant turn', finalMessages[1].role === 'assistant');
}

// ======================================================================
//
// ======================================================================
header('dario#36 — well-formed conversation untouched');
{
  // Regression guard: a normal tool-loop conversation ending on a
  // tool_result (user role) must not be modified by the trailing drop.
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: [
        { type: 'text', text: 'running ls' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ]},
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  check('all 3 messages preserved', built.body.messages.length === 3);
  check('final is user+tool_result', built.body.messages[2].role === 'user');
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

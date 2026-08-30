#!/usr/bin/env node
// In-process tests for the STREAMING half of
// src/openai-responses-translate.ts — responsesStreamToAnthropicSSE plus
// the SSE parse helpers (parseResponsesSSEEvent / createResponsesSSEParser).
// No network, no fs, no credentials: hand-written Responses-shaped stream
// events in, Anthropic SSE event objects out.
//
// Event names + field shapes match the OpenAI SDK type sources
// (openai-python types/responses/*): the item-index field is
// `output_index`, the text/arg/reasoning fragment rides a field named
// `delta`, reasoning-summary deltas add `summary_index`, and the stream
// error event's `type` is the bare string "error".
//
// Run: node --test test/openai-responses-stream.test.mjs
// (Build first — imports the compiled ../dist/*.js, like every sibling.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  responsesStreamToAnthropicSSE,
  parseResponsesSSEEvent,
  createResponsesSSEParser,
  formatResponsesAnthropicSSE,
} from '../dist/anthropic-responses-translate.js';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Push an array of Responses events, then end(); return all emitted events. */
function run(events, options) {
  const t = responsesStreamToAnthropicSSE(options);
  const out = [];
  for (const e of events) out.push(...t.push(e));
  out.push(...t.end());
  return out;
}

/**
 * Assert the emitted Anthropic stream is well-formed and reconstruct its
 * content. Enforces dario's discipline: message_start first, message_stop
 * last, exactly one message_delta (immediately before message_stop),
 * exactly one content block open at a time, block indices strictly
 * increasing from 0, every open block explicitly closed before the final
 * message_delta. Returns { blocks: [{index,type,...reconstructed}], messageDelta, messageStart }.
 */
function reconstruct(events) {
  assert.ok(events.length >= 3, 'at least message_start, message_delta, message_stop');
  assert.equal(events[0].type, 'message_start', 'first event is message_start');
  assert.equal(events[events.length - 1].type, 'message_stop', 'last event is message_stop');

  const messageStart = events[0];
  let messageDelta = null;
  let open = null;             // index of the currently open block, or null
  let expectedIndex = 0;       // strictly increasing block indices
  const blocks = new Map();    // index -> reconstructed block

  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    switch (e.type) {
      case 'content_block_start': {
        assert.equal(open, null, `no block open when starting index ${e.index}`);
        assert.equal(e.index, expectedIndex, `block index strictly increasing (got ${e.index}, want ${expectedIndex})`);
        expectedIndex++;
        open = e.index;
        const cb = e.content_block;
        if (cb.type === 'text') blocks.set(e.index, { index: e.index, type: 'text', text: '' });
        else if (cb.type === 'thinking') blocks.set(e.index, { index: e.index, type: 'thinking', thinking: '' });
        else if (cb.type === 'tool_use') blocks.set(e.index, { index: e.index, type: 'tool_use', id: cb.id, name: cb.name, partial_json: '' });
        else assert.fail(`unknown content_block type ${cb.type}`);
        break;
      }
      case 'content_block_delta': {
        assert.equal(e.index, open, `delta targets the open block (got ${e.index}, open ${open})`);
        const b = blocks.get(e.index);
        const d = e.delta;
        if (d.type === 'text_delta') b.text += d.text;
        else if (d.type === 'thinking_delta') b.thinking += d.thinking;
        else if (d.type === 'input_json_delta') b.partial_json += d.partial_json;
        else assert.fail(`unknown delta type ${d.type}`);
        break;
      }
      case 'content_block_stop': {
        assert.equal(e.index, open, `stop targets the open block (got ${e.index}, open ${open})`);
        open = null;
        break;
      }
      case 'message_delta': {
        assert.equal(open, null, 'all blocks closed before message_delta');
        assert.equal(messageDelta, null, 'exactly one message_delta');
        assert.equal(events[i + 1]?.type, 'message_stop', 'message_delta immediately precedes message_stop');
        messageDelta = e;
        break;
      }
      case 'message_stop':
        break;
      default:
        assert.fail(`unexpected event type ${e.type}`);
    }
  }
  assert.ok(messageDelta, 'a message_delta was emitted');
  assert.equal(open, null, 'no block left open');
  return {
    messageStart,
    messageDelta,
    blocks: [...blocks.values()].sort((a, b) => a.index - b.index),
  };
}

// A realistic captured Sol/Responses stream with reasoning ON + a tool
// call: reasoning summary (2 fragments) → assistant message text (2
// fragments) → function_call whose arguments arrive in 2 fragments →
// completed with usage. Items are emitted strictly in order.
const STREAM = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol', status: 'in_progress' } },
  { type: 'response.in_progress', response: { id: 'resp_1', model: 'gpt-5.6-sol', status: 'in_progress' } },

  { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } },
  { type: 'response.reasoning_summary_part.added', output_index: 0, item_id: 'rs_1', summary_index: 0, part: { type: 'summary_text', text: '' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'The user wants the OS; ' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'I should run uname -a.' },
  { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'rs_1', summary_index: 0, text: 'The user wants the OS; I should run uname -a.' },
  { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'The user wants the OS; I should run uname -a.' }] } },

  { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.content_part.added', output_index: 1, item_id: 'msg_1', content_index: 0, part: { type: 'output_text', text: '' } },
  { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta: 'Let me check ' },
  { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta: 'the kernel.' },
  { type: 'response.output_text.done', output_index: 1, item_id: 'msg_1', content_index: 0, text: 'Let me check the kernel.' },
  { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Let me check the kernel.' }] } },

  { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"command":' },
  { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '"uname -a"}' },
  { type: 'response.function_call_arguments.done', output_index: 2, item_id: 'fc_1', arguments: '{"command":"uname -a"}' },
  { type: 'response.output_item.done', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"command":"uname -a"}', status: 'completed' } },

  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-5.6-sol',
      status: 'completed',
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1024 },
        output_tokens: 64,
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 1264,
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────
// Full interleaved reasoning → text → tool stream
// ─────────────────────────────────────────────────────────────────────

test('reasoning + text + function_call stream → ordered thinking/text/tool_use blocks, tool_use stop', () => {
  const out = run(STREAM);
  const { messageStart, messageDelta, blocks } = reconstruct(out);

  // message_start: empty envelope, model from the event, usage 0/0.
  assert.equal(messageStart.message.id, 'msg_resp_1');
  assert.equal(messageStart.message.model, 'gpt-5.6-sol');
  assert.deepEqual(messageStart.message.content, []);
  assert.deepEqual(messageStart.message.usage, { input_tokens: 0, output_tokens: 0 });

  // Three blocks, indices 0/1/2 in upstream item order.
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => [b.index, b.type]),
    [[0, 'thinking'], [1, 'text'], [2, 'tool_use']],
  );

  // Reconstructed content.
  assert.equal(blocks[0].thinking, 'The user wants the OS; I should run uname -a.');
  assert.equal(blocks[1].text, 'Let me check the kernel.');
  assert.equal(blocks[2].id, 'call_9');
  assert.equal(blocks[2].name, 'Bash');
  assert.deepEqual(JSON.parse(blocks[2].partial_json), { command: 'uname -a' });

  // stop_reason tool_use, usage carried from response.completed.
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  assert.equal(messageDelta.delta.stop_sequence, null);
  assert.deepEqual(messageDelta.usage, { output_tokens: 64, input_tokens: 1200 });
});

test('event name === data.type on every emitted event (dario SSE discipline)', () => {
  const out = run(STREAM);
  for (const e of out) {
    const wire = formatResponsesAnthropicSSE(e);
    assert.ok(wire.startsWith(`event: ${e.type}\ndata: `), `frames as event: ${e.type}`);
    assert.ok(wire.endsWith('\n\n'));
    // the data payload round-trips and its own type matches the event line
    const dataJson = wire.slice(wire.indexOf('data: ') + 6, -2);
    assert.equal(JSON.parse(dataJson).type, e.type);
  }
});

test('requestModel option overrides the event model in message_start', () => {
  const out = run(STREAM, { requestModel: 'claude-opus-4-8' });
  assert.equal(out[0].type, 'message_start');
  assert.equal(out[0].message.model, 'claude-opus-4-8');
});

// ─────────────────────────────────────────────────────────────────────
// Empty stream
// ─────────────────────────────────────────────────────────────────────

test('empty stream (end only) → message_start, message_delta end_turn, message_stop', () => {
  const t = responsesStreamToAnthropicSSE();
  const out = t.end();
  assert.equal(out.length, 3);
  assert.equal(out[0].type, 'message_start');
  assert.deepEqual(out[0].message.content, []);
  assert.equal(out[0].message.model, 'unknown'); // no created event, no option
  assert.equal(out[1].type, 'message_delta');
  assert.equal(out[1].delta.stop_reason, 'end_turn');
  assert.deepEqual(out[1].usage, { output_tokens: 0 });
  assert.equal(out[2].type, 'message_stop');
});

// ─────────────────────────────────────────────────────────────────────
// Cut off before response.completed
// ─────────────────────────────────────────────────────────────────────

test('cut-off text stream (no completed) → end() closes the open text block cleanly, end_turn', () => {
  const t = responsesStreamToAnthropicSSE({ requestModel: 'm' });
  const out = [];
  out.push(...t.push({ type: 'response.created', response: { id: 'resp_c', model: 'm' } }));
  out.push(...t.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }));
  out.push(...t.push({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'partial ans' }));
  // stream cuts off here — no output_item.done, no response.completed.
  out.push(...t.end());

  const { messageDelta, blocks } = reconstruct(out);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, 'partial ans');
  assert.equal(messageDelta.delta.stop_reason, 'end_turn');
  assert.deepEqual(messageDelta.usage, { output_tokens: 0 }); // no usage was seen
});

test('cut-off after a function_call opened → stop_reason tool_use, block closed by end()', () => {
  const t = responsesStreamToAnthropicSSE();
  const out = [];
  out.push(...t.push({ type: 'response.created', response: { id: 'r', model: 'm' } }));
  out.push(...t.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_x', name: 'Bash', arguments: '' } }));
  out.push(...t.push({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta: '{"command":"ls"' }));
  out.push(...t.end());

  const { messageDelta, blocks } = reconstruct(out);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool_use');
  assert.equal(blocks[0].id, 'call_x');
  assert.equal(blocks[0].partial_json, '{"command":"ls"'); // truncated JSON preserved verbatim
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
});

// ─────────────────────────────────────────────────────────────────────
// Terminal handling: incomplete/max, idempotent end, post-terminal push
// ─────────────────────────────────────────────────────────────────────

test('response.incomplete (max_output_tokens) → stop_reason max_tokens; end() is idempotent', () => {
  const t = responsesStreamToAnthropicSSE();
  const out = [];
  out.push(...t.push({ type: 'response.created', response: { id: 'r', model: 'm' } }));
  out.push(...t.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', role: 'assistant', content: [] } }));
  out.push(...t.push({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg', content_index: 0, delta: 'truncated' }));
  out.push(...t.push({ type: 'response.incomplete', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 5 } } }));

  // end() after a terminal event yields nothing (idempotent).
  const tail = t.end();
  assert.deepEqual(tail, []);

  const { messageDelta, blocks } = reconstruct(out);
  assert.equal(blocks[0].text, 'truncated');
  assert.equal(messageDelta.delta.stop_reason, 'max_tokens');
  assert.deepEqual(messageDelta.usage, { output_tokens: 5, input_tokens: 10 });
});

test('push after a terminal event is ignored', () => {
  const t = responsesStreamToAnthropicSSE();
  t.push({ type: 'response.created', response: { id: 'r', model: 'm' } });
  t.push({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } });
  const after = t.push({ type: 'response.output_text.delta', output_index: 9, item_id: 'x', delta: 'ignored' });
  assert.deepEqual(after, []);
});

test('stream `error` event terminates cleanly (well-formed end, no content injected)', () => {
  const t = responsesStreamToAnthropicSSE({ requestModel: 'm' });
  const out = [];
  out.push(...t.push({ type: 'response.created', response: { id: 'r', model: 'm' } }));
  out.push(...t.push({ type: 'error', code: 'server_error', message: 'upstream blew up', param: null }));
  const { messageDelta, blocks } = reconstruct(out);
  assert.equal(blocks.length, 0, 'no content blocks fabricated from the error');
  assert.equal(messageDelta.delta.stop_reason, 'end_turn');
});

// ─────────────────────────────────────────────────────────────────────
// SSE parse helpers (single record + buffered cross-chunk)
// ─────────────────────────────────────────────────────────────────────

test('parseResponsesSSEEvent: data JSON, [DONE], comments, bad JSON, event-line type backfill', () => {
  assert.deepEqual(
    parseResponsesSSEEvent('event: response.completed', 'data: {"type":"response.completed","response":{"status":"completed"}}'),
    { type: 'response.completed', response: { status: 'completed' } },
  );
  assert.equal(parseResponsesSSEEvent(undefined, 'data: [DONE]'), null);
  assert.equal(parseResponsesSSEEvent(undefined, ': keep-alive'), null);
  assert.equal(parseResponsesSSEEvent(undefined, 'data: {bad json'), null);
  assert.equal(parseResponsesSSEEvent('event: x', 'data: '), null);
  // type missing from JSON is backfilled from the event line
  const ev = parseResponsesSSEEvent('event: response.created', 'data: {"response":{"id":"r"}}');
  assert.equal(ev.type, 'response.created');
  // CRLF line endings tolerated
  const crlf = parseResponsesSSEEvent('event: response.created\r', 'data: {"type":"response.created"}\r');
  assert.equal(crlf.type, 'response.created');
});

test('createResponsesSSEParser: reconstructs events across a chunk boundary that splits a record', () => {
  const frame = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
  const wire =
    frame('response.created', { response: { id: 'resp_1', model: 'gpt-5.6-sol' } }) +
    frame('response.output_item.added', { output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '' } }) +
    frame('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_1', delta: '{"command":"uname -a"}' }) +
    frame('response.output_item.done', { output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"command":"uname -a"}' } }) +
    frame('response.completed', { response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } } });

  // Split at an awkward point INSIDE the third frame's data line.
  const cut = wire.indexOf('uname') + 2;
  const parser = createResponsesSSEParser();
  const events = [];
  events.push(...parser.push(wire.slice(0, cut)));
  events.push(...parser.push(wire.slice(cut)));
  events.push(...parser.flush());

  assert.deepEqual(events.map((e) => e.type), [
    'response.created',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.output_item.done',
    'response.completed',
  ]);

  // End-to-end: parsed events drive the translator to a well-formed Bash tool_use.
  const t = responsesStreamToAnthropicSSE({ requestModel: 'claude-opus-4-8' });
  const anth = [];
  for (const e of events) anth.push(...t.push(e));
  anth.push(...t.end());
  const { messageDelta, blocks } = reconstruct(anth);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool_use');
  assert.equal(blocks[0].name, 'Bash');
  assert.deepEqual(JSON.parse(blocks[0].partial_json), { command: 'uname -a' });
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  assert.deepEqual(messageDelta.usage, { output_tokens: 3, input_tokens: 7 });
});

test('createResponsesSSEParser.flush parses a trailing record with no terminating blank line', () => {
  const parser = createResponsesSSEParser();
  let evs = parser.push('event: response.completed\ndata: {"type":"response.completed"}');
  assert.deepEqual(evs, [], 'incomplete record buffered, not yet emitted');
  evs = parser.flush();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'response.completed');
});

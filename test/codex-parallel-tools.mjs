// Several tool calls in one turn on the Codex backend.
//
// A call's arguments can arrive as deltas or only on its final events, and calls can open before
// the one ahead has finished. A translator that read only the deltas gave every call empty
// arguments, which Claude Code shows as "Error writing file". Each stream below is run through
// both translators, and through the real forwardToCodex for both shapes and both stream modes.
//
// (Build first: imports the compiled ../dist/*.js, like every sibling.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  responsesStreamToAnthropicSSE, createAnthropicMessageAssembler, completedArguments,
} from '../dist/anthropic-responses-translate.js';
import { createResponsesTranslator, forwardToCodex } from '../dist/codex-backend.js';

const call = (n) => ({ id: `fc_${n}`, type: 'function_call', call_id: `call_${n}`, name: 'Write' });
const args = (n) => JSON.stringify({ file_path: `/tmp/${n}.txt`, content: `file ${n}` });
const input = (n) => JSON.parse(args(n));

const created = { type: 'response.created', response: { id: 'resp_p', model: 'gpt-5.6-luna' } };
const completed = {
  type: 'response.completed',
  response: { id: 'resp_p', model: 'gpt-5.6-luna', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 5 } },
};
const added = (n) => ({ type: 'response.output_item.added', output_index: n, item: call(n) });
const delta = (n, d) => ({ type: 'response.function_call_arguments.delta', output_index: n, item_id: `fc_${n}`, delta: d });
const argsDone = (n, a = args(n)) => ({ type: 'response.function_call_arguments.done', output_index: n, item_id: `fc_${n}`, arguments: a });
const itemDone = (n, a = args(n)) => ({ type: 'response.output_item.done', output_index: n, item: { ...call(n), arguments: a } });
const bareDone = (n) => ({ type: 'response.output_item.done', output_index: n, item: call(n) });
const half = (n) => [args(n).slice(0, 9), args(n).slice(9)];

/** Every way a stream can deliver calls 0, 1 and 2. */
const STREAMS = {
  'all open first, arguments only on output_item.done':
    [added(0), added(1), added(2), itemDone(0), itemDone(1), itemDone(2)],
  'all open first, arguments only on function_call_arguments.done':
    [added(0), added(1), added(2), argsDone(0), argsDone(1), argsDone(2), bareDone(0), bareDone(1), bareDone(2)],
  'one after another, arguments only on the final event':
    [added(0), itemDone(0), added(1), itemDone(1), added(2), itemDone(2)],
  'one after another, deltas and final events':
    [0, 1, 2].flatMap((n) => [added(n), delta(n, half(n)[0]), delta(n, half(n)[1]), argsDone(n), itemDone(n)]),
  'deltas interleaved between calls':
    [added(0), added(1), added(2), delta(0, half(0)[0]), delta(1, half(1)[0]), delta(2, half(2)[0]),
      delta(2, half(2)[1]), delta(0, half(0)[1]), delta(1, half(1)[1]), itemDone(0), itemDone(1), itemDone(2)],
  'calls finishing out of order':
    [added(0), added(1), added(2), itemDone(2), itemDone(1), itemDone(0)],
  'no output_item.added at all':
    [itemDone(0), itemDone(1), itemDone(2)],
  'part by delta, the rest only on the final event':
    [added(0), added(1), added(2), delta(0, half(0)[0]), delta(2, half(2)[0]), itemDone(0), itemDone(1), itemDone(2)],
};

/** Run events through the Anthropic translator, holding it to the block order a client relies on. */
function anthropic(events, { finish = true } = {}) {
  const t = responsesStreamToAnthropicSSE({ requestModel: 'gpt-5.6-luna' });
  const out = [];
  for (const e of [created, ...events, ...(finish ? [completed] : [])]) out.push(...t.push(e));
  out.push(...t.end());
  return out;
}

function blocksOf(out) {
  const blocks = [];
  let open = null;
  for (const e of out) {
    if (e.type === 'content_block_start') {
      assert.equal(open, null, `block ${e.index} started while block ${open?.index} was open`);
      open = { index: e.index, block: e.content_block, json: '', text: '' };
      assert.equal(e.index, blocks.length, 'block indices run in order');
      blocks.push(open);
    } else if (e.type === 'content_block_delta') {
      assert.equal(e.index, open?.index, `a delta for block ${e.index} arrived outside it`);
      if (e.delta.type === 'input_json_delta') open.json += e.delta.partial_json;
      if (e.delta.type === 'text_delta') open.text += e.delta.text;
    } else if (e.type === 'content_block_stop') {
      assert.equal(e.index, open?.index, `block ${e.index} stopped while it was not the open one`);
      open = null;
    }
  }
  assert.equal(open, null, 'every block closed');
  return blocks;
}

function toolInputs(out) {
  const found = {};
  for (const b of blocksOf(out)) {
    if (b.block.type === 'tool_use') found[b.block.id] = b.json ? JSON.parse(b.json) : {};
  }
  return found;
}

const expected = () => ({ call_0: input(0), call_1: input(1), call_2: input(2) });

/** Run events through the chat translator: what a streaming client assembles, and the collapsed body. */
function chat(events) {
  const t = createResponsesTranslator('gpt-5.6-luna');
  let wire = '';
  for (const e of [created, ...events, completed]) wire += t.chunk(`data: ${JSON.stringify(e)}`) ?? '';
  const calls = [];
  for (const line of wire.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    for (const d of JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls ?? []) {
      const c = (calls[d.index] ??= { id: '', name: '', arguments: '' });
      if (d.id) c.id = d.id;
      if (d.function?.name) c.name = d.function.name;
      c.arguments += d.function?.arguments ?? '';
    }
  }
  return { streamed: calls, body: t.complete(), wire };
}

for (const [name, events] of Object.entries(STREAMS)) {
  test(`Anthropic stream, ${name}: each call keeps its own arguments`, () => {
    const out = anthropic(events);
    assert.deepEqual(toolInputs(out), expected());
    assert.equal(out.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
  });

  test(`Anthropic collapse, ${name}: the assembled message has the inputs`, () => {
    const a = createAnthropicMessageAssembler();
    a.push(anthropic(events));
    const got = Object.fromEntries(a.message('m').content.filter((b) => b.type === 'tool_use').map((b) => [b.id, b.input]));
    assert.deepEqual(got, expected());
  });

  test(`chat stream, ${name}: each call keeps its own arguments`, () => {
    const { streamed, body } = chat(events);
    const byId = Object.fromEntries(streamed.map((c) => [c.id, JSON.parse(c.arguments)]));
    assert.deepEqual(byId, expected());
    const collapsed = body.choices[0].message.tool_calls;
    assert.deepEqual(Object.fromEntries(collapsed.map((c) => [c.id, JSON.parse(c.function.arguments)])), expected());
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });
}

test('a call on its own still streams live: a delta is not held back', () => {
  const t = responsesStreamToAnthropicSSE();
  t.push(created);
  t.push(added(0));
  const out = t.push(delta(0, '{"a"'));
  assert.deepEqual(out.map((e) => e.type), ['content_block_delta']);
  assert.equal(out[0].delta.partial_json, '{"a"');
});

test('a final event repeating the deltas adds nothing', () => {
  const t = responsesStreamToAnthropicSSE();
  t.push(created);
  t.push(added(0));
  t.push(delta(0, args(0)));
  assert.deepEqual(t.push(argsDone(0)), []);
  assert.deepEqual(t.push(itemDone(0)).map((e) => e.type), ['content_block_stop']);
});

test('a final event that disagrees with what streamed changes nothing: it cannot be taken back', () => {
  const out = anthropic([added(0), delta(0, '{"a":1}'), itemDone(0, '{"b":2}')]);
  assert.deepEqual(toolInputs(out), { call_0: { a: 1 } });
  const { streamed } = chat([added(0), delta(0, '{"a":1}'), itemDone(0, '{"b":2}')]);
  assert.equal(streamed[0].arguments, '{"a":1}');
});

test('a call with no arguments anywhere stays a well-formed call', () => {
  const out = anthropic([added(0), bareDone(0)]);
  assert.deepEqual(toolInputs(out), { call_0: {} });
  assert.equal(chat([added(0), bareDone(0)]).streamed[0].arguments, '');
});

test('cut off while calls wait: every call still closes, with what it had', () => {
  const out = anthropic([added(0), added(1), delta(1, '{"late":true}')], { finish: false });
  assert.deepEqual(toolInputs(out), { call_0: {}, call_1: { late: true } });
  assert.equal(out.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('a message after waiting calls leaves the stream well-formed', () => {
  const message = { type: 'response.output_item.added', output_index: 2, item: { id: 'msg', type: 'message' } };
  const text = { type: 'response.output_text.delta', output_index: 2, delta: 'done' };
  const out = anthropic([added(0), added(1), itemDone(1), message, text]);
  const blocks = blocksOf(out);
  assert.deepEqual(blocks.map((b) => b.block.type), ['tool_use', 'tool_use', 'text']);
  assert.equal(blocks[1].json, args(1));
  assert.equal(blocks[2].text, 'done');
});

test('text and reasoning ahead of the calls keep their places', () => {
  const reasoning = { type: 'response.output_item.added', output_index: 0, item: { id: 'rs', type: 'reasoning' } };
  const thought = { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'hm' };
  const out = anthropic([reasoning, thought, added(1), added(2), itemDone(1), itemDone(2)]);
  assert.deepEqual(blocksOf(out).map((b) => b.block.type), ['thinking', 'tool_use', 'tool_use']);
  assert.deepEqual(toolInputs(out), { call_1: input(1), call_2: input(2) });
});

test('completedArguments: extends, never replaces', () => {
  assert.equal(completedArguments('', '{"a":1}'), '{"a":1}');
  assert.equal(completedArguments('{"a"', '{"a":1}'), '{"a":1}');
  assert.equal(completedArguments('{"a":1}', '{"a":1}'), '{"a":1}');
  assert.equal(completedArguments('{"a":1}', '{"b":2}'), '{"a":1}');
  assert.equal(completedArguments('{"a":1}', undefined), '{"a":1}');
  assert.equal(completedArguments('', 7), '');
});

// The real forwarder, so the wiring is covered and not only the translators.
const CREDS = { alias: 'test', accessToken: 'tok', idToken: undefined };
const reported = STREAMS['all open first, arguments only on output_item.done'];

function fakeRes() {
  return {
    statusCode: null, headers: null, chunks: [], ended: false, headersSent: false, listeners: {},
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs; this.headersSent = true; },
    write(s) { this.chunks.push(s); return true; },
    end(s) { if (s !== undefined) this.chunks.push(s); this.ended = true; },
    on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; },
    removeListener() { return this; },
    get body() { return this.chunks.join(''); },
  };
}
const upstream = (events) => async () => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')));
      c.close();
    },
  }),
});
const forward = async (shape, stream) => {
  const res = fakeRes();
  const body = shape === 'anthropic'
    ? { model: 'gpt-5.6-luna', max_tokens: 100, stream, messages: [{ role: 'user', content: 'write three files' }] }
    : { model: 'gpt-5.6-luna', stream, messages: [{ role: 'user', content: 'write three files' }] };
  await forwardToCodex({}, res, Buffer.from(JSON.stringify(body)), CREDS, '*', {}, 5000, false, shape, upstream([created, ...reported, completed]));
  return res.body;
};

test('forwardToCodex, Anthropic shape, streaming', async () => {
  const out = (await forward('anthropic', true)).split('\n')
    .filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(toolInputs(out), expected());
});

test('forwardToCodex, Anthropic shape, not streaming', async () => {
  const msg = JSON.parse(await forward('anthropic', false));
  assert.deepEqual(Object.fromEntries(msg.content.map((b) => [b.id, b.input])), expected());
  assert.equal(msg.stop_reason, 'tool_use');
});

test('forwardToCodex, OpenAI shape, not streaming', async () => {
  const msg = JSON.parse(await forward('openai', false));
  const calls = msg.choices[0].message.tool_calls;
  assert.deepEqual(Object.fromEntries(calls.map((c) => [c.id, JSON.parse(c.function.arguments)])), expected());
});

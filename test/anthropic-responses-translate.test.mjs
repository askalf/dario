#!/usr/bin/env node
// In-process tests for src/openai-responses-translate.ts — the pure
// Anthropic Messages ⇄ OpenAI *Responses API* translation layer. No
// network, no fs, no credentials: hand-written Responses-shaped fixtures
// in, shape assertions out. Fixtures follow the shapes confirmed against
// the OpenAI SDK type sources (types/responses/*).
//
// Run: node --test test/openai-responses-translate.test.mjs
// (Build first — imports the compiled ../dist/*.js, like every sibling.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  anthropicToResponsesRequest,
  responsesToAnthropicResponse,
  REASONING_EFFORT_LOW_MAX,
  REASONING_EFFORT_MEDIUM_MAX,
} from '../dist/anthropic-responses-translate.js';
import { anthropicUsageFromResponses } from '../dist/anthropic-responses-translate.js';

// ─────────────────────────────────────────────────────────────────────
// anthropicToResponsesRequest — system, tools, reasoning
// ─────────────────────────────────────────────────────────────────────

test('system (string + array) flattens to top-level instructions, cache_control dropped', () => {
  const strOut = anthropicToResponsesRequest(
    { model: 'claude-opus-4-8', max_tokens: 512, system: 'You are Claude Code.', messages: [{ role: 'user', content: 'hi' }] },
    'gpt-5.6-sol',
  );
  assert.equal(strOut.model, 'gpt-5.6-sol');
  assert.equal(strOut.instructions, 'You are Claude Code.');
  assert.equal(strOut.store, false, 'store defaults to false (stateless)');
  assert.equal(strOut.max_output_tokens, 512);
  // instructions is a top-level string, NOT a role message in input
  assert.deepEqual(strOut.input, [{ role: 'user', content: 'hi' }]);

  const arrOut = anthropicToResponsesRequest(
    {
      model: 'm',
      max_tokens: 1,
      system: [
        { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Be terse.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
    'gpt-5.6-sol',
  );
  assert.equal(arrOut.instructions, 'You are Claude Code.\n\nBe terse.');
  assert.ok(!JSON.stringify(arrOut).includes('cache_control'), 'cache_control must not survive');
});

test('tools are FLATTENED function tools (not nested under .function); web search carried as the hosted tool', () => {
  const out = anthropicToResponsesRequest(
    {
      model: 'm',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search' }, // server tool, no input_schema
        {
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
    },
    'gpt-5.6-sol',
  );
  assert.equal(out.tools.length, 2, 'the web search server tool becomes the hosted web_search tool; the function tool follows');
  assert.deepEqual(out.tools[0], { type: 'web_search' });
  assert.deepEqual(out.include, ['web_search_call.action.sources'], 'sources are asked for so the result block can list them');
  assert.deepEqual(out.tools[1], {
    type: 'function',
    name: 'get_weather',
    description: 'Get current weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  });
  // no `.function` wrapper anywhere
  assert.ok(!Object.prototype.hasOwnProperty.call(out.tools[1], 'function'));
  // an unknown server tool (no input_schema, not web search) is still skipped, and no include is asked for
  const other = anthropicToResponsesRequest({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'code_execution_20260521', name: 'code_execution' }] }, 'gpt-5.6-sol');
  assert.equal(other.tools, undefined);
  assert.equal(other.include, undefined);
});

test('web search options: allowed_domains → filters, user_location → approximate location; the rest dropped', () => {
  const out = anthropicToResponsesRequest(
    { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_domains: ['openai.com', 'anthropic.com'], blocked_domains: ['x.com'], user_location: { type: 'approximate', city: 'Austin', region: 'TX', country: 'US', timezone: 'America/Chicago' } }] },
    'gpt-5.6-sol',
  );
  assert.deepEqual(out.tools, [{ type: 'web_search', filters: { allowed_domains: ['openai.com', 'anthropic.com'] }, user_location: { type: 'approximate', city: 'Austin', region: 'TX', country: 'US', timezone: 'America/Chicago' } }]);
  assert.ok(!JSON.stringify(out).includes('blocked_domains') && !JSON.stringify(out).includes('max_uses'));
});

test('thinking → reasoning:{effort} at documented thresholds, summary:auto by default', () => {
  const reasoning = (thinking, opts) =>
    anthropicToResponsesRequest(
      { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], thinking },
      'gpt-5.6-sol',
      opts,
    ).reasoning;

  assert.equal(reasoning(undefined), undefined);
  assert.equal(reasoning({ type: 'disabled' }), undefined);
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: 2048 }), { effort: 'low', summary: 'auto' });
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: REASONING_EFFORT_LOW_MAX }), { effort: 'low', summary: 'auto' });
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: REASONING_EFFORT_LOW_MAX + 1 }), { effort: 'medium', summary: 'auto' });
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: REASONING_EFFORT_MEDIUM_MAX }), { effort: 'medium', summary: 'auto' });
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: REASONING_EFFORT_MEDIUM_MAX + 1 }), { effort: 'high', summary: 'auto' });
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: 31999 }), { effort: 'high', summary: 'auto' });

  // summary can be omitted
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: 2048 }, { reasoningSummary: null }), { effort: 'low' });
  assert.deepEqual(reasoning({ type: 'enabled', budget_tokens: 2048 }, { reasoningSummary: 'detailed' }), { effort: 'low', summary: 'detailed' });
});

test('reasoning ON drops temperature/top_p; reasoning OFF forwards them', () => {
  const base = { model: 'm', max_tokens: 1, temperature: 0.7, top_p: 0.9, messages: [{ role: 'user', content: 'x' }] };

  const on = anthropicToResponsesRequest({ ...base, thinking: { type: 'enabled', budget_tokens: 2048 } }, 'gpt-5.6-sol');
  assert.equal(on.reasoning.effort, 'low');
  assert.equal(on.temperature, undefined, 'reasoning models reject temperature');
  assert.equal(on.top_p, undefined, 'reasoning models reject top_p');

  const off = anthropicToResponsesRequest(base, 'gpt-5.6-sol');
  assert.equal(off.reasoning, undefined);
  assert.equal(off.temperature, 0.7);
  assert.equal(off.top_p, 0.9);
});

test('store defaults false but is overridable', () => {
  const out = anthropicToResponsesRequest(
    { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] },
    'gpt-5.6-sol',
    { store: true },
  );
  assert.equal(out.store, true);
});

// ─────────────────────────────────────────────────────────────────────
// anthropicToResponsesRequest — call_id threading round trip
// ─────────────────────────────────────────────────────────────────────

test('tool_use → tool_result becomes function_call / function_call_output with matching call_id', () => {
  const out = anthropicToResponsesRequest(
    {
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: '18C, sunny' }] },
            { type: 'text', text: 'thanks — and Berlin?' },
          ],
        },
      ],
    },
    'gpt-5.6-sol',
  );

  // input order: user text, assistant text msg, assistant function_call,
  // function_call_output (answers the call), remaining user text.
  assert.equal(out.input.length, 5);
  assert.deepEqual(out.input[0], { role: 'user', content: 'Weather in Paris?' });
  assert.deepEqual(out.input[1], { role: 'assistant', content: 'Let me check.' });
  assert.deepEqual(out.input[2], {
    type: 'function_call',
    call_id: 'toolu_01',
    name: 'get_weather',
    arguments: '{"city":"Paris"}',
  });
  // tool result feeds back on the SAME call_id, output is a string, BEFORE new user text
  assert.deepEqual(out.input[3], {
    type: 'function_call_output',
    call_id: 'toolu_01',
    output: '18C, sunny',
  });
  assert.deepEqual(out.input[4], { role: 'user', content: 'thanks — and Berlin?' });
});

test('assistant tool_use with no text yields no message item; empty tool_result → empty string output', () => {
  const out = anthropicToResponsesRequest(
    {
      model: 'm',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      ],
    },
    'gpt-5.6-sol',
  );
  assert.deepEqual(out.input[0], { role: 'user', content: 'go' });
  // no assistant message item (no text) — just the function_call
  assert.deepEqual(out.input[1], { type: 'function_call', call_id: 't1', name: 'f', arguments: '{}' });
  assert.deepEqual(out.input[2], { type: 'function_call_output', call_id: 't1', output: '' });
});

test('images become input_image parts with a string image_url (base64 → data URI, url passthrough)', () => {
  const out = anthropicToResponsesRequest(
    {
      model: 'm',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/x.jpg' } },
          ],
        },
      ],
    },
    'gpt-5.6-sol',
  );
  const content = out.input[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: 'input_text', text: 'What is this?' });
  // image_url is a BARE STRING here, unlike chat completions' {url}
  assert.deepEqual(content[1], { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(content[2], { type: 'input_image', image_url: 'https://example.com/x.jpg' });
});

// ─────────────────────────────────────────────────────────────────────
// tool_choice variants → Responses spellings
// ─────────────────────────────────────────────────────────────────────

test('tool_choice variants map to Responses spellings (forced form is FLATTENED)', () => {
  const base = {
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'f', input_schema: { type: 'object' } }],
  };
  const tc = (tool_choice) => anthropicToResponsesRequest({ ...base, tool_choice }, 'gpt-5.6-sol').tool_choice;

  assert.equal(tc({ type: 'auto' }), 'auto');
  assert.equal(tc({ type: 'any' }), 'required');
  assert.equal(tc({ type: 'none' }), 'none');
  // {type:'function', name} — NOT {type:'function', function:{name}}
  assert.deepEqual(tc({ type: 'tool', name: 'f' }), { type: 'function', name: 'f' });
  assert.equal(tc(undefined), undefined);

  const par = anthropicToResponsesRequest(
    { ...base, tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
    'gpt-5.6-sol',
  );
  assert.equal(par.parallel_tool_calls, false);
});

test('forcing the hosted web search is the hosted-tool choice, not a function selection', () => {
  // Live (2026-09-11, codex backend): {type:'function', name:'web_search'}
  // 400s with "Tool choice 'function' not found in 'tools' parameter";
  // {type:'web_search'} runs the search, alone or alongside function tools.
  const base = { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] };
  const alone = anthropicToResponsesRequest(
    { ...base, tools: [{ type: 'web_search_20260209', name: 'web_search' }], tool_choice: { type: 'tool', name: 'web_search' } },
    'gpt-5.6-sol',
  );
  assert.deepEqual(alone.tool_choice, { type: 'web_search' });
  const mixed = anthropicToResponsesRequest(
    { ...base, tools: [{ name: 'f', input_schema: { type: 'object' } }, { type: 'web_search_20260209', name: 'search' }], tool_choice: { type: 'tool', name: 'search' } },
    'gpt-5.6-sol',
  );
  assert.deepEqual(mixed.tool_choice, { type: 'web_search' }, "matched by the client's own name for the tool");
  const fn = anthropicToResponsesRequest(
    { ...base, tools: [{ name: 'f', input_schema: { type: 'object' } }, { type: 'web_search_20260209', name: 'web_search' }], tool_choice: { type: 'tool', name: 'f' } },
    'gpt-5.6-sol',
  );
  assert.deepEqual(fn.tool_choice, { type: 'function', name: 'f' }, 'a forced function tool is still the flattened function form');
  const noSearch = anthropicToResponsesRequest(
    { ...base, tools: [{ name: 'web_search', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'web_search' } },
    'gpt-5.6-sol',
  );
  assert.deepEqual(noSearch.tool_choice, { type: 'function', name: 'web_search' }, 'a client FUNCTION that happens to be called web_search is a function');
});

test('tool_choice is dropped when there are no tools', () => {
  const out = anthropicToResponsesRequest(
    { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'any' } },
    'gpt-5.6-sol',
  );
  assert.equal(out.tools, undefined);
  assert.equal(out.tool_choice, undefined);
});

// ─────────────────────────────────────────────────────────────────────
// responsesToAnthropicResponse — output walk, reasoning, stop_reason
// ─────────────────────────────────────────────────────────────────────

// A realistic non-streaming Responses reply: a reasoning item (summary),
// then a function_call. Shapes per the SDK type sources: reasoning.summary
// is an array of {type:'summary_text', text}; function_call carries both
// `id` and `call_id`; usage uses input_tokens/output_tokens with nested
// details. status 'completed' — the tool call drives stop_reason.
const RESPONSES_FIXTURE = {
  id: 'resp_abc123',
  object: 'response',
  model: 'gpt-5.6-sol',
  status: 'completed',
  output: [
    {
      id: 'rs_1',
      type: 'reasoning',
      summary: [
        { type: 'summary_text', text: 'The user wants the OS.' },
        { type: 'summary_text', text: 'I should run uname -a via the shell tool.' },
      ],
    },
    {
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call_9',
      name: 'Bash',
      arguments: '{"command":"uname -a"}',
      status: 'completed',
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 64,
    output_tokens_details: { reasoning_tokens: 40 },
    total_tokens: 1264,
  },
};

test('Responses output with reasoning + function_call → thinking + tool_use blocks, stop_reason tool_use', () => {
  const out = responsesToAnthropicResponse(RESPONSES_FIXTURE, 'claude-opus-4-8');

  assert.equal(out.id, 'msg_resp_abc123');
  assert.equal(out.type, 'message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.model, 'claude-opus-4-8', 'echoes the requested model, not the upstream alias');
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.stop_sequence, null);
  // The 1,024 cached tokens sit INSIDE the Responses input_tokens total and
  // BESIDE the Anthropic one, so the translation nets them out of input_tokens
  // and reports them as cache_read_input_tokens (a client summing the
  // Anthropic fields would otherwise count the cached prefix twice).
  assert.deepEqual(out.usage, {
    input_tokens: 176, output_tokens: 64,
    cache_read_input_tokens: 1024, cache_creation_input_tokens: 0,
  });

  assert.equal(out.content.length, 2);
  // reasoning summary → thinking block (joined summary_text)
  assert.deepEqual(out.content[0], {
    type: 'thinking',
    thinking: 'The user wants the OS.\nI should run uname -a via the shell tool.',
  });
  // function_call → tool_use, id = call_id, input = parsed arguments
  assert.deepEqual(out.content[1], {
    type: 'tool_use',
    id: 'call_9',
    name: 'Bash',
    input: { command: 'uname -a' },
  });
});

test('message output_text → text block; bad-JSON args guard → {}', () => {
  const out = responsesToAnthropicResponse(
    {
      id: 'resp_x',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Here you go.', annotations: [] }],
        },
        { type: 'function_call', call_id: 'call_bad', name: 'Bash', arguments: '{"command": TRUNC' },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    'claude-opus-4-8',
  );

  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.content.length, 2);
  assert.deepEqual(out.content[0], { type: 'text', text: 'Here you go.' });
  // unparseable arguments degrade to {} rather than throwing
  assert.deepEqual(out.content[1], { type: 'tool_use', id: 'call_bad', name: 'Bash', input: {} });
});

test('reasoning item with no text is dropped; reasoning_text content used when summary empty', () => {
  const empty = responsesToAnthropicResponse(
    {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      ],
    },
    'm',
  );
  assert.deepEqual(empty.content, [{ type: 'text', text: 'hi' }], 'empty reasoning item dropped');

  const viaContent = responsesToAnthropicResponse(
    {
      status: 'completed',
      output: [{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'raw chain' }] }],
    },
    'm',
  );
  assert.deepEqual(viaContent.content, [{ type: 'thinking', thinking: 'raw chain' }]);
});

test('refusal part surfaces as a text block', () => {
  const out = responsesToAnthropicResponse(
    {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
    },
    'm',
  );
  assert.deepEqual(out.content, [{ type: 'text', text: 'I cannot help with that.' }]);
  assert.equal(out.stop_reason, 'end_turn');
});

test('stop_reason mapping: incomplete/max_output_tokens → max_tokens, content_filter → end_turn', () => {
  const mk = (status, reason) =>
    responsesToAnthropicResponse(
      { status, incomplete_details: reason ? { reason } : undefined, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }] },
      'm',
    ).stop_reason;

  assert.equal(mk('completed'), 'end_turn');
  assert.equal(mk('incomplete', 'max_output_tokens'), 'max_tokens');
  assert.equal(mk('incomplete', 'content_filter'), 'end_turn');
  assert.equal(mk('incomplete', undefined), 'max_tokens');

  // a tool call always wins over status
  const withTool = responsesToAnthropicResponse(
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] },
    'm',
  );
  assert.equal(withTool.stop_reason, 'tool_use');
});

test('output_text fallback when no items produced content; empty output → empty content', () => {
  const fallback = responsesToAnthropicResponse(
    { id: 'resp_z', status: 'completed', output: [], output_text: 'aggregated text' },
    'm',
  );
  assert.deepEqual(fallback.content, [{ type: 'text', text: 'aggregated text' }]);

  const empty = responsesToAnthropicResponse({ status: 'completed', output: [] }, 'm');
  assert.deepEqual(empty.content, []);
  assert.equal(empty.stop_reason, 'end_turn');
  assert.deepEqual(empty.usage, { input_tokens: 0, output_tokens: 0 });
});

// ---------------------------------------------------------------------
// Usage: OpenAI counts the cached prefix INSIDE input_tokens, Anthropic
// BESIDE it. The translation nets it out so a client summing the Anthropic
// fields (Claude Code's context meter) does not count the prefix twice.
// ---------------------------------------------------------------------

test('anthropicUsageFromResponses: no details → the two-field usage, unchanged', () => {
  assert.deepEqual(anthropicUsageFromResponses({ input_tokens: 7, output_tokens: 2 }), { input_tokens: 7, output_tokens: 2 });
  assert.deepEqual(anthropicUsageFromResponses(undefined), { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(anthropicUsageFromResponses(null), { input_tokens: 0, output_tokens: 0 });
});

test('anthropicUsageFromResponses: cached_tokens netted out of input and reported as cache_read', () => {
  assert.deepEqual(
    anthropicUsageFromResponses({ input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 64 }),
    { input_tokens: 176, output_tokens: 64, cache_read_input_tokens: 1024, cache_creation_input_tokens: 0 },
  );
});

test('anthropicUsageFromResponses: cache_write_tokens → cache_creation, also netted; never negative', () => {
  assert.deepEqual(
    anthropicUsageFromResponses({ input_tokens: 500, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 }, output_tokens: 1 }),
    { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 },
  );
  assert.deepEqual(
    anthropicUsageFromResponses({ input_tokens: 10, input_tokens_details: { cached_tokens: 50 }, output_tokens: 1 }),
    { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
  );
  // A details object with garbage inside is a miss, not a throw.
  assert.deepEqual(
    anthropicUsageFromResponses({ input_tokens: 9, input_tokens_details: { cached_tokens: 'x' }, output_tokens: 1 }),
    { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  );
});

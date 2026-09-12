// Unit tests for src/responses-inbound.ts — the OpenAI Responses shape on
// dario's front door. Request translation (Responses → Messages), response
// translation (Messages → Responses, buffered and streamed), and the write
// boundary. The end-to-end run through a real startProxy is in
// test/responses-inbound-wiring.mjs.

import {
  responsesRequestToAnthropic, ResponsesRequestError, unsupportedOnClaudeError, anthropicMessageToResponses, anthropicErrorToResponses,
  ResponsesOutStream, ResponsesOut,
} from '../dist/responses-inbound.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
const parseAll = (text) => text.split(/(?<=\n\n)/).filter((f) => f.trim() && !f.startsWith(':')).map((raw) => {
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line.slice(5));
});

// ---------------------------------------------------------------------------
header('responsesRequestToAnthropic — the Codex CLI 0.154 first turn');
{
  const req = {
    model: 'claude-sonnet-5', stream: true, store: false, include: ['reasoning.encrypted_content'], reasoning: { summary: 'auto' },
    instructions: 'You are a coding agent.', parallel_tool_calls: true, tool_choice: 'auto', prompt_cache_key: 'abc',
    input: [
      { type: 'message', id: 'm1', role: 'developer', content: [{ type: 'input_text', text: '<skills>…</skills>' }] },
      { type: 'message', id: 'm2', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
      { type: 'message', id: 'm3', role: 'user', content: [{ type: 'input_text', text: 'Reply with PONG' }] },
    ],
    tools: [
      { type: 'function', name: 'exec_command', description: 'Runs a command', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
      { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: {} } }] },
      { type: 'web_search', external_web_access: false },
    ],
  };
  const { body, warnings } = responsesRequestToAnthropic(req);
  check('model kept, stream kept, default max_tokens', body.model === 'claude-sonnet-5' && body.stream === true && body.max_tokens === 32000, JSON.stringify([body.model, body.stream, body.max_tokens]));
  check('instructions + developer message hoisted to system, in order', body.system === 'You are a coding agent.\n\n<skills>…</skills>', body.system);
  check('two user messages merged into one user turn with two text blocks', body.messages.length === 1 && body.messages[0].role === 'user' && body.messages[0].content.length === 2 && body.messages[0].content[1].text === 'Reply with PONG', JSON.stringify(body.messages));
  check('function tool translated, namespace flattened, web_search dropped', body.tools.length === 2 && body.tools[0].name === 'exec_command' && body.tools[0].input_schema.required[0] === 'cmd' && body.tools[1].name === 'spawn_agent', JSON.stringify(body.tools));
  check('auto tool_choice not sent (Anthropic default)', body.tool_choice === undefined);
  check('the dropped web_search is a warning, not silence', warnings.some((w) => w.includes('web_search')), warnings.join('; '));
  check('no stray Responses fields leak', !('input' in body) && !('instructions' in body) && !('store' in body) && !('include' in body) && !('prompt_cache_key' in body));
}

header('responsesRequestToAnthropic — a tool round trip and the rest of the surface');
{
  const req = {
    model: 'claude-opus-5', reasoning: { effort: 'high' }, max_output_tokens: 4096, temperature: 0.2, parallel_tool_calls: false,
    input: [
      { role: 'user', content: 'list the files' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA…' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'exec_command', arguments: 'not json' },
      { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two files.' }] },
    ],
    tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'required',
  };
  const { body, warnings } = responsesRequestToAnthropic(req);
  const m = body.messages;
  check('shorthand {role, content} message accepted', m[0].role === 'user' && m[0].content[0].text === 'list the files');
  check('reasoning item dropped silently', !JSON.stringify(m).includes('gAAAA'));
  check('function_call → assistant tool_use with parsed input', m[1].role === 'assistant' && m[1].content[0].type === 'tool_use' && m[1].content[0].id === 'call_1' && m[1].content[0].input.cmd === 'ls', JSON.stringify(m[1]));
  check('function_call_output → user tool_result (string)', m[2].role === 'user' && m[2].content[0].type === 'tool_result' && m[2].content[0].tool_use_id === 'call_1' && m[2].content[0].content === 'a.txt\nb.txt');
  check('unparseable arguments → {} with a warning', m[3].content[0].input && Object.keys(m[3].content[0].input).length === 0 && warnings.some((w) => w.includes('not valid JSON')));
  check('array output with an image → tool_result content blocks', Array.isArray(m[4].content[0].content) && m[4].content[0].content[1].type === 'image' && m[4].content[0].content[1].source.media_type === 'image/png');
  check('assistant output_text → assistant text', m[5].role === 'assistant' && m[5].content[0].text === 'Two files.');
  check('effort → model suffix dario already parses', body.model === 'claude-opus-5:high');
  check('max_output_tokens, temperature carried', body.max_tokens === 4096 && body.temperature === 0.2);
  check('required + parallel_tool_calls:false → any + disable_parallel_tool_use', body.tool_choice.type === 'any' && body.tool_choice.disable_parallel_tool_use === true, JSON.stringify(body.tool_choice));
  const named = responsesRequestToAnthropic({ model: 'x', input: 'hi', tools: [{ type: 'function', name: 'f', parameters: {} }], tool_choice: { type: 'function', name: 'f' } }).body;
  check('named function choice → tool', named.tool_choice.type === 'tool' && named.tool_choice.name === 'f');
  check('string input → one user message', responsesRequestToAnthropic({ model: 'x', input: 'hi' }).body.messages[0].content[0].text === 'hi');
  check('input that starts with an assistant turn gets a user opener', responsesRequestToAnthropic({ model: 'x', input: [{ role: 'assistant', content: 'earlier' }] }).body.messages[0].role === 'user');
  const t = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  check('previous_response_id is reported as unsupported, not refused (the route decides)', (() => { const r = responsesRequestToAnthropic({ model: 'x', input: 'hi', previous_response_id: 'resp_1' }); return r.unsupported.includes('previous_response_id') && r.body.messages.length === 1; })());
  check('the Claude-pool refusal names the field and the way out', (() => { const e = unsupportedOnClaudeError('previous_response_id'); return e.error.param === 'previous_response_id' && /ChatGPT-subscription/.test(e.error.message); })());
  check('nothing unsupported on a plain request', responsesRequestToAnthropic({ model: 'x', input: 'hi' }).unsupported.length === 0);
  check('missing model → error', t(() => responsesRequestToAnthropic({ input: 'hi' })) instanceof ResponsesRequestError);
  check('empty input → error', t(() => responsesRequestToAnthropic({ model: 'x', input: [] })) instanceof ResponsesRequestError);
}

// ---------------------------------------------------------------------------
header('anthropicMessageToResponses — buffered');
{
  const msg = { id: 'msg_01ABC', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: { cmd: 'ls' } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 } };
  const r = anthropicMessageToResponses(msg, 123);
  check('envelope', r.object === 'response' && r.id === 'resp_01ABC' && r.created_at === 123 && r.status === 'completed' && r.model === 'claude-sonnet-5');
  check('output: reasoning, message, function_call in order', r.output.map((o) => o.type).join(',') === 'reasoning,message,function_call', JSON.stringify(r.output.map((o) => o.type)));
  check('message item shape', r.output[1].role === 'assistant' && r.output[1].status === 'completed' && r.output[1].content[0].type === 'output_text' && r.output[1].content[0].text === 'Let me look.' && Array.isArray(r.output[1].content[0].annotations));
  check('function_call item: call_id = tool_use id, arguments as a JSON string', r.output[2].call_id === 'toolu_1' && r.output[2].name === 'exec_command' && r.output[2].arguments === '{"cmd":"ls"}' && r.output[2].status === 'completed');
  check('reasoning summary from thinking text', r.output[0].summary[0].text === 'hmm');
  check('usage in OpenAI terms: input includes the cached prefix, cached_tokens reports it', r.usage.input_tokens === 113 && r.usage.input_tokens_details.cached_tokens === 100 && r.usage.output_tokens === 5 && r.usage.total_tokens === 118, JSON.stringify(r.usage));
  const cut = anthropicMessageToResponses({ ...msg, stop_reason: 'max_tokens' });
  check('max_tokens → incomplete / max_output_tokens', cut.status === 'incomplete' && cut.incomplete_details.reason === 'max_output_tokens');
  check('error envelope (Anthropic shape)', anthropicErrorToResponses({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }).error.message === 'Overloaded');
  check('error envelope (dario pre-upstream shape)', anthropicErrorToResponses({ error: 'Proxy error', message: 'Failed to reach upstream API' }).error.message === 'Failed to reach upstream API');
}

// ---------------------------------------------------------------------------
header('ResponsesOutStream — Anthropic SSE → Responses SSE');
{
  const s = new ResponsesOutStream('claude-sonnet-5');
  let out = '';
  const feed = (raw) => { out += s.feed(raw); };
  feed(ev('message_start', { message: { id: 'msg_01XYZ', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 2 } } }));
  feed(ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }));
  feed(ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }));
  feed(ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
  feed(ev('content_block_stop', { index: 0 }));
  feed(ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }));
  feed(ev('ping', {}));
  feed(': dario continuation gpt (same model) after 3 chars\n\n');
  feed(ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Let me ' } }));
  feed(ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'look.' } }));
  feed(ev('content_block_stop', { index: 1 }));
  feed(ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'exec_command', input: {} } }));
  feed(ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }));
  feed(ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }));
  feed(ev('content_block_stop', { index: 2 }));
  feed(ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }));
  feed(ev('message_stop', {}));
  const events = parseAll(out);
  const types = events.map((e) => e.type);
  check('sequence: created, in_progress, items added/done, completed', types[0] === 'response.created' && types[1] === 'response.in_progress' && types.at(-1) === 'response.completed', types.join(','));
  check('sequence numbers strictly increasing from 0', events.every((e, i) => e.sequence_number === i));
  check('reasoning item: added, summary part added/delta/done, item done', ['response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done'].every((t) => types.includes(t)));
  check('message item: content_part.added, two text deltas, output_text.done, content_part.done, item done', types.filter((t) => t === 'response.output_text.delta').length === 2 && types.includes('response.output_text.done') && types.includes('response.content_part.done'));
  const fc = events.find((e) => e.type === 'response.output_item.done' && e.item.type === 'function_call');
  check('function_call item done with call_id and full arguments', fc && fc.item.call_id === 'toolu_9' && fc.item.name === 'exec_command' && fc.item.arguments === '{"cmd":"ls"}' && fc.item.status === 'completed', JSON.stringify(fc?.item));
  check('function_call_arguments deltas then done', types.filter((t) => t === 'response.function_call_arguments.delta').length === 2 && types.includes('response.function_call_arguments.done'));
  const done = events.at(-1);
  check('completed carries the assembled output and usage', done.response.status === 'completed' && done.response.output.length === 3 && done.response.output[1].content[0].text === 'Let me look.' && done.response.output[2].arguments === '{"cmd":"ls"}' && done.response.usage.output_tokens === 12 && done.response.usage.input_tokens === 9 && done.response.usage.input_tokens_details.cached_tokens === 2, JSON.stringify(done.response.usage));
  check('response id derived from the message id', done.response.id === 'resp_01XYZ' && events[0].response.id === 'resp_01XYZ');
  check('ping dropped, seam comment passed through verbatim', !out.includes('"ping"') && out.includes(': dario continuation gpt (same model) after 3 chars'));
  check('finished', s.finished === true);

  const e = new ResponsesOutStream('m');
  let eo = e.feed(ev('message_start', { message: { id: 'msg_1', model: 'm', usage: {} } }));
  eo += e.feed(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  eo += e.feed(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }));
  const ee = parseAll(eo);
  check('in-band error → response.failed + error event', ee.some((x) => x.type === 'response.failed' && x.response.status === 'failed' && x.response.error.message === 'Overloaded') && ee.at(-1).type === 'error');
  const inc = new ResponsesOutStream('m');
  let io = inc.feed(ev('message_start', { message: { id: 'msg_2', model: 'm', usage: {} } }));
  io += inc.feed(ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }));
  io += inc.feed(ev('message_stop', {}));
  check('max_tokens → completed event with status incomplete', parseAll(io).at(-1).response.status === 'incomplete');
}

// ---------------------------------------------------------------------------
header('ResponsesOut — the write boundary decides SSE vs JSON from the first bytes');
{
  const sse = new ResponsesOut('m');
  const a = sse.write(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_3","model":"m","usage":{}}}\n\n'));
  check('SSE mode: translated on the fly', a.startsWith('event: response.created'));
  check('SSE end flushes nothing extra', sse.end() === '');
  const json = new ResponsesOut('m');
  check('JSON mode: held until end', json.write('{"id":"msg_4","type":"message","role":"assistant","model":"m","content":[{"type":"text","te') === '' && json.write('xt":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}') === '');
  const j = JSON.parse(json.end());
  check('…then translated as a response object', j.object === 'response' && j.output[0].content[0].text === 'hi');
  const err = new ResponsesOut('m');
  err.write('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}');
  check('error body translated to the OpenAI envelope', JSON.parse(err.end()).error.message === 'bad key');
  const other = new ResponsesOut('m');
  other.write('not json at all');
  check('non-JSON passes through unchanged', other.end() === 'not json at all');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Live-request proof of the Responses shape on dario's front door
// (src/responses-inbound.ts): a real startProxy, a Codex-CLI-shaped
// `POST /v1/responses`, served by the Claude pool (translated both ways) and
// by a ChatGPT-subscription model (passed through to the codex backend).
//
// Hermetic, same technique as the other wiring tests: temp HOME with one fake
// Claude seat and one fake codex account, the Anthropic upstream is
// ProxyOptions.fetchImpl, the ChatGPT backend is a local stub. What is real:
// the handler, the translation at the front door, the write boundary, the
// codex passthrough, and every byte the client receives.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROXY_PORT = await freePort();
const CODEX_PORT = await freePort();
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const CODEX_SLUG = 'gpt-5.6-sol';
const CLAUDE_MODEL = 'claude-sonnet-5';
const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

// ---- codex backend stub: answers in the Responses shape, records the body ----
const codexSeen = { bodies: [], headers: [] };
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ slug: CODEX_SLUG, visibility: 'list' }] })); return; }
  if (!req.url.startsWith('/responses')) { res.writeHead(404).end(); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', async () => {
    const body = JSON.parse(Buffer.concat(parts).toString());
    codexSeen.bodies.push(body); codexSeen.headers.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, obj, seq) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...obj })}\n\n`);
    const fc = { id: 'fc_x', type: 'function_call', status: 'completed', call_id: 'call_x', name: 'exec_command', arguments: '{"cmd":"ls -a"}' };
    const full = { id: 'resp_x', object: 'response', created_at: 1, status: 'completed', model: CODEX_SLUG, output: [fc], usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 0 } } };
    ev('response.created', { response: { ...full, status: 'in_progress', output: [] } }, 0);
    ev('response.output_item.added', { output_index: 0, item: { ...fc, status: 'in_progress', arguments: '' } }, 1);
    ev('response.function_call_arguments.delta', { item_id: 'fc_x', output_index: 0, delta: '{"cmd":"ls -a"}' }, 2);
    ev('response.function_call_arguments.done', { item_id: 'fc_x', output_index: 0, arguments: '{"cmd":"ls -a"}' }, 3);
    ev('response.output_item.done', { output_index: 0, item: fc }, 4);
    ev('response.completed', { response: full }, 5);
    // Like the real backend: the terminal event is not EOF. dario must end the
    // client response on the terminal event, not wait for this.
    await sleep(300);
    res.end();
  });
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// ---- fake Anthropic upstream: a text block, then a tool_use ------------------
const anthropicSeen = { bodies: [] };
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: CLAUDE_MODEL, type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const raw = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf-8');
  const body = JSON.parse(raw);
  anthropicSeen.bodies.push(body);
  const hasToolResult = JSON.stringify(body.messages).includes('tool_result');
  if (!body.stream) {
    return new Response(JSON.stringify({ id: 'msg_buf', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [{ type: 'text', text: 'buffered answer' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder(); const put = (s) => c.enqueue(enc.encode(s));
      put(sse('message_start', { message: { id: 'msg_01A', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 8 } } }));
      put(sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }));
      put(sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
      put(sse('content_block_stop', { index: 0 }));
      put(sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }));
      for (const t of (hasToolResult ? 'Three files.' : 'Let me look.').match(/.{1,5}/g)) { put(sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })); await sleep(2); }
      put(sse('content_block_stop', { index: 1 }));
      if (!hasToolResult) {
        put(sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: {} } }));
        put(sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls' } }));
        put(sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: ' -a"}' } }));
        put(sse('content_block_stop', { index: 2 }));
      }
      put(sse('message_delta', { delta: { stop_reason: hasToolResult ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }));
      put(sse('message_stop', {}));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

// ---- home + proxy ------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-responses-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({ alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token', expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1' }));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({ alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000 }));
const { startProxy } = await import('../dist/proxy.js');
await startProxy({ port: PROXY_PORT, host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl: fakeFetch });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

// ---- client -------------------------------------------------------------------
const TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Runs a command', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: {} } }] },
  { type: 'web_search', external_web_access: false },
];
const codexLike = (model, extra = {}) => ({
  model, stream: true, store: false, include: ['reasoning.encrypted_content'], reasoning: { summary: 'auto' }, parallel_tool_calls: true, tool_choice: 'auto', prompt_cache_key: 'pck',
  instructions: 'You are a coding agent.',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills/>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run ls -a with the tool.' }] },
  ],
  tools: TOOLS, ...extra,
});
async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
  return { res, text, events, types: events.map((e) => e.type), items: events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item) };
}

header('A. Codex-shaped request on the Claude pool: translated in, Responses SSE out');
{
  const b0 = anthropicSeen.bodies.length;
  const { res, events, types, items, text } = await post(codexLike(CLAUDE_MODEL));
  check('200 text/event-stream', res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/event-stream'), `${res.status} ${res.headers.get('content-type')}`);
  check('one upstream Claude request, zero codex', anthropicSeen.bodies.length === b0 + 1 && codexSeen.bodies.length === 0);
  const up = anthropicSeen.bodies.at(-1);
  const sys = JSON.stringify(up.system);
  const toolNames = (up.tools ?? []).map((t) => t.name);
  check('upstream body is the Messages shape (after the CC template): instructions + developer text in system, function tools present, web_search gone', sys.includes('You are a coding agent.') && sys.includes('<skills/>') && toolNames.includes('exec_command') && toolNames.includes('spawn_agent') && !JSON.stringify(up).includes('web_search'), `tools=${toolNames.join(',')} sys=${sys.slice(0, 200)}`);
  check('upstream stream requested, max_tokens numeric', up.stream === true && typeof up.max_tokens === 'number' && up.max_tokens > 0, `${up.stream} ${up.max_tokens}`);
  check('Responses SSE: created first, completed last, sequence numbers from 0', types[0] === 'response.created' && types.at(-1) === 'response.completed' && events.every((e, i) => e.sequence_number === i), types.join(','));
  check('items: reasoning (empty summary), message, function_call', items.map((i) => i.type).join(',') === 'reasoning,message,function_call', items.map((i) => i.type).join(','));
  check('function_call carries the tool_use id as call_id and the assembled arguments', items[2].call_id === 'toolu_1' && items[2].name === 'exec_command' && items[2].arguments === '{"cmd":"ls -a"}', JSON.stringify(items[2]));
  check('message item text assembled from deltas', items[1].content[0].type === 'output_text' && items[1].content[0].text === 'Let me look.');
  const done = events.at(-1);
  check('completed: status, output, usage in OpenAI terms (cached_tokens from cache_read)', done.response.status === 'completed' && done.response.output.length === 3 && done.response.usage.output_tokens === 20 && done.response.usage.input_tokens === 20 && done.response.usage.input_tokens_details.cached_tokens === 8, JSON.stringify(done.response.usage));
  check('no Anthropic event names leaked', !text.includes('message_start') && !text.includes('content_block'));
}

header('B. the tool round trip: function_call_output reaches Claude as tool_result');
{
  const b0 = anthropicSeen.bodies.length;
  const turn2 = codexLike(CLAUDE_MODEL, {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run ls -a with the tool.' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me look.' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'toolu_1', name: 'exec_command', arguments: '{"cmd":"ls -a"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: '.\n..\nalpha.txt\nbeta.txt\ngamma.md' },
    ],
  });
  const { res, items, types } = await post(turn2);
  const up = anthropicSeen.bodies.at(-1);
  const m = up.messages;
  check('200 and one upstream request', res.status === 200 && anthropicSeen.bodies.length === b0 + 1);
  check('history: user, assistant(text + tool_use), user(tool_result) — reasoning dropped', m.length === 3 && m[1].role === 'assistant' && m[1].content.some((c) => c.type === 'tool_use' && c.id === 'toolu_1' && c.input.cmd === 'ls -a') && m[2].content[0].type === 'tool_result' && m[2].content[0].tool_use_id === 'toolu_1' && !JSON.stringify(m).includes('gAAAA'), JSON.stringify(m).slice(0, 400));
  check('final answer as a message item, completed', items.some((i) => i.type === 'message' && i.content[0].text === 'Three files.') && types.at(-1) === 'response.completed');
}

header('C. a ChatGPT-subscription model: passed through to the codex backend, bytes untouched');
{
  const c0 = codexSeen.bodies.length;
  const t0 = Date.now();
  const { res, events, types, items, text } = await post(codexLike(CODEX_SLUG, { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'exec', format: { type: 'grammar' } }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls' }] }], reasoning: { effort: 'low', context: 'all_turns' } }));
  const elapsed = Date.now() - t0;
  check('200 stream from the codex leg, one backend request', res.status === 200 && codexSeen.bodies.length === c0 + 1);
  const sent = codexSeen.bodies.at(-1);
  check('the backend got the client body as written: additional_tools item, custom tool, reasoning.context, include', sent.input[0].type === 'additional_tools' && sent.input[0].tools[0].type === 'custom' && sent.reasoning.context === 'all_turns' && Array.isArray(sent.include) && sent.instructions === 'You are a coding agent.', JSON.stringify(sent).slice(0, 300));
  check('stream forced, store off, model resolved', sent.stream === true && sent.store === false && sent.model === CODEX_SLUG);
  check('backend headers: bearer + originator', String(codexSeen.headers.at(-1).authorization).startsWith('Bearer ') && codexSeen.headers.at(-1).originator === 'codex_cli_rs');
  check('the backend SSE reached the client verbatim (its own ids and sequence numbers)', types.join(',') === 'response.created,response.output_item.added,response.function_call_arguments.delta,response.function_call_arguments.done,response.output_item.done,response.completed' && items[0].id === 'fc_x' && events[0].sequence_number === 0, types.join(','));
  check('the response ended on the terminal event, not on the backend EOF 300ms later', elapsed < 250, `${elapsed}ms`);
  check('no translation artefacts', !text.includes('msg_') && !text.includes('resp_x_'));
}

header('D. errors, non-stream, and the stateless rule');
{
  const { res, events } = await post({ ...codexLike(CODEX_SLUG), stream: false });
  check('non-stream on the codex leg → 400 in the OpenAI envelope naming stream', res.status === 400 && (await (async () => events)()).length === 0 && res.headers.get('content-type')?.includes('application/json'), res.status);
  const r2 = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...codexLike(CODEX_SLUG), stream: false }) });
  const e2 = await r2.json();
  check('…with error.message/type/param', e2.error && e2.error.param === 'stream' && e2.error.type === 'invalid_request_error', JSON.stringify(e2));
  const r3 = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: CLAUDE_MODEL, input: 'hi', previous_response_id: 'resp_1' }) });
  const e3 = await r3.json();
  check('previous_response_id → 400, OpenAI envelope, param named', r3.status === 400 && e3.error.param === 'previous_response_id', JSON.stringify(e3));
  const r4 = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: CLAUDE_MODEL, input: 'hi', stream: false }) });
  const j4 = await r4.json();
  check('non-stream on the Claude pool → a buffered Responses object', r4.status === 200 && j4.object === 'response' && j4.output[0].type === 'message' && j4.output[0].content[0].text === 'buffered answer' && j4.usage.total_tokens === 7, JSON.stringify(j4).slice(0, 300));
  const r5 = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":' });
  const e5 = await r5.json();
  check('invalid JSON → 400 in the OpenAI envelope (the write boundary is up before the body is read)', r5.status === 400 && typeof e5.error?.message === 'string' && !('type' in e5 && e5.type === 'error'), JSON.stringify(e5));
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

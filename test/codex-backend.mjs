#!/usr/bin/env node
/**
 * test/codex-backend.mjs
 *
 * Unit tests for the Codex ("altman") request path: chat/completions ⇄
 * Responses translation, header construction, model-slug discovery + cache,
 * and the routing decision that sends a request there.
 *
 * No network: every call takes an injected `fetch` (same strategy as
 * test/codex-oauth.mjs). Live-subscription behaviour is not testable here and
 * lives in test/manual/codex-refresh-race.mjs / the operator's dev box.
 */

import {
  chatCompletionsToResponses,
  createResponsesTranslator,
  buildCodexHeaders,
  extractChatGPTAccountId,
  fetchCodexModels,
  getCodexModelSlugs,
  clearCodexModelCache,
  isCodexModel,
  CODEX_CLIENT_VERSION,
  CODEX_BACKEND_BASE_URL,
} from '../dist/codex-backend.js';
import { route, poolFallbackOutcome, codexAdapter, claudeAdapter, openaiAdapter } from '../dist/provider-adapter.js';
import { forwardToCodex, isTerminalResponsesEvent, isFailedResponse, toCodexSupportedBody, pickCodexFallback, pickClaudeFallback, CODEX_SUPPORTED_FIELDS } from '../dist/codex-backend.js';
import { isClaudeServableModel } from '../dist/claude-model.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}

/** Minimal id_token: header.payload.signature, payload base64url-encoded. */
function fakeIdToken(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const creds = {
  alias: 'test-account',
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAt: Date.now() + 3_600_000,
  idToken: fakeIdToken({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
  }),
};

// ---------------------------------------------------------------- headers

header('buildCodexHeaders / extractChatGPTAccountId');
{
  const h = buildCodexHeaders(creds);
  check('Authorization is a bearer of the access_token', h['Authorization'] === 'Bearer access-token-value');
  check('ChatGPT-Account-ID comes from the id_token claim', h['ChatGPT-Account-ID'] === 'acct_123');
  check('asks for an SSE stream', h['Accept'] === 'text/event-stream');
  check('no refresh_token leaks into the headers',
    !JSON.stringify(h).includes('refresh-token-value'));

  const noId = buildCodexHeaders({ ...creds, idToken: undefined });
  check('account-id header omitted when there is no id_token', !('ChatGPT-Account-ID' in noId));

  check('malformed id_token → null, not a throw', extractChatGPTAccountId('not-a-jwt') === null);
  check('id_token without the auth claim → null',
    extractChatGPTAccountId(fakeIdToken({ sub: 'u' })) === null);
}

// ------------------------------------------------------- request translation

header('chatCompletionsToResponses');
{
  const out = chatCompletionsToResponses({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ],
    max_tokens: 128,
    temperature: 0.2,
  });
  check('model passes through', out.model === 'gpt-5.6-sol');
  check('system message collapses into instructions', out.instructions === 'be terse');
  check('system message is NOT also an input item',
    out.input.every((i) => i.role !== 'system'));
  check('user message becomes an input_text item',
    out.input.length === 1 && out.input[0].role === 'user' &&
    out.input[0].content[0].type === 'input_text' && out.input[0].content[0].text === 'hello');
  check('store:false — a proxied request is not a ChatGPT thread', out.store === false);
  check('always requests a stream upstream', out.stream === true);
  check('max_tokens → max_output_tokens', out.max_output_tokens === 128);
  check('temperature passes through', out.temperature === 0.2);
  check('no tools key when the request had none', out.tools === undefined);
}
{
  const out = chatCompletionsToResponses({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  check('array content parts join into one text', out.input[0].content[0].text === 'ab');
}
{
  const out = chatCompletionsToResponses({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'auto',
  });
  check('tools lose the function{} nesting', out.tools[0].name === 'get_weather');
  check('tool type stays function', out.tools[0].type === 'function');
  check('tool parameters preserved', out.tools[0].parameters.properties.city.type === 'string');
  check('tool_choice forwarded', out.tool_choice === 'auto');
}
{
  // Full tool round trip: assistant tool_call then a tool-role result.
  const out = chatCompletionsToResponses({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"c":21}' },
    ],
  });
  const [user, call, result] = out.input;
  check('user turn first', user.role === 'user');
  check('assistant tool_call → function_call item', call.type === 'function_call' && call.name === 'get_weather');
  check('function_call carries call_id and arguments',
    call.call_id === 'call_1' && call.arguments === '{"city":"Rome"}');
  check('empty assistant content emits no stray text item', out.input.length === 3);
  check('tool role → function_call_output keyed by the same call_id',
    result.type === 'function_call_output' && result.call_id === 'call_1' && result.output === '{"c":21}');
}
{
  const out = chatCompletionsToResponses({
    model: 'm',
    messages: [{ role: 'assistant', content: 'prior answer' }, { role: 'user', content: 'and?' }],
    reasoning_effort: 'high',
  });
  check('assistant text → output_text item', out.input[0].content[0].type === 'output_text');
  check('reasoning_effort → reasoning.effort', out.reasoning.effort === 'high');
}

// ------------------------------------------------------ response translation

/** Build the SSE lines the Codex backend emits, as forwardToCodex feeds them. */
function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}`);
}
function feed(translator, lines) {
  return lines.map((l) => translator.chunk(l)).filter((x) => x !== null);
}
function parseFrames(out) {
  return out
    .join('')
    .split('\n\n')
    .filter((s) => s.startsWith('data: ') && !s.includes('[DONE]'))
    .map((s) => JSON.parse(s.slice(6)));
}

header('createResponsesTranslator — text stream');
{
  const t = createResponsesTranslator('gpt-5.6-sol');
  const out = feed(t, sse([
    { type: 'response.created', response: { id: 'resp_abc' } },
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 2 } } },
  ]));
  const frames = parseFrames(out);
  check('role opener + 2 deltas + final', frames.length === 4);
  check('every frame is a chat.completion.chunk',
    frames.every((f) => f.object === 'chat.completion.chunk'));
  // The reference OpenAI stream opens with a role-only delta; SDK accumulators
  // use it to open the assistant message (dario#1140).
  check('first frame is the role opener',
    frames[0].choices[0].delta.role === 'assistant' && frames[0].choices[0].delta.content === '');
  check('role opener carries no finish_reason', frames[0].choices[0].finish_reason === null);
  check('role is announced exactly once',
    frames.filter((f) => f.choices[0].delta.role !== undefined).length === 1);
  check('chunk id derives from the response id', frames[0].id === 'chatcmpl-abc');
  check('model echoed on the chunk', frames[0].model === 'gpt-5.6-sol');
  check('text deltas forwarded verbatim',
    frames[1].choices[0].delta.content === 'Hel' && frames[2].choices[0].delta.content === 'lo');
  check('final frame carries finish_reason=stop', frames[3].choices[0].finish_reason === 'stop');
  check('stream terminates with [DONE]', out.join('').endsWith('data: [DONE]\n\n'));

  const done = t.complete();
  check('complete() accumulates the full text', done.choices[0].message.content === 'Hello');
  check('complete() is a chat.completion object', done.object === 'chat.completion');
  check('usage mapped from Responses token counts',
    done.usage.prompt_tokens === 7 && done.usage.completion_tokens === 2 && done.usage.total_tokens === 9);
  check('finish_reason=stop with no tool calls', done.choices[0].finish_reason === 'stop');
}

header('createResponsesTranslator — tool-call stream');
{
  const t = createResponsesTranslator('gpt-5.6-sol');
  const out = feed(t, sse([
    { type: 'response.created', response: { id: 'resp_tool' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item_1', call_id: 'call_9', name: 'get_weather' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"city":' },
    { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '"Rome"}' },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
  ]));
  const frames = parseFrames(out);
  check('a tool-call stream also opens with the role frame',
    frames[0].choices[0].delta.role === 'assistant');
  const first = frames[1].choices[0].delta.tool_calls[0];
  check('output_item.added opens a tool_call delta', first.type === 'function' && first.function.name === 'get_weather');
  check('tool_call id is the backend call_id', first.id === 'call_9');
  check('tool_call index starts at 0', first.index === 0);
  check('argument deltas stream through',
    frames[2].choices[0].delta.tool_calls[0].function.arguments === '{"city":' &&
    frames[3].choices[0].delta.tool_calls[0].function.arguments === '"Rome"}');
  check('final frame finish_reason=tool_calls', frames[4].choices[0].finish_reason === 'tool_calls');

  const done = t.complete();
  check('complete() reassembles the arguments JSON',
    done.choices[0].message.tool_calls[0].function.arguments === '{"city":"Rome"}');
  check('complete() finish_reason=tool_calls', done.choices[0].finish_reason === 'tool_calls');
  check('complete() content is null when there was only a tool call',
    done.choices[0].message.content === null);
}

header('createResponsesTranslator — the role opener cannot be skipped');
{
  // No response.created (defensive: the branch that normally opens the message
  // never fires) — content still must not reach the wire before the role.
  const a = createResponsesTranslator('m');
  const fa = parseFrames(feed(a, sse([{ type: 'response.output_text.delta', delta: 'x' }])));
  check('a stream starting at a text delta still opens with the role',
    fa[0].choices[0].delta.role === 'assistant' && fa[1].choices[0].delta.content === 'x');

  // A response that produced no content at all: real OpenAI still opens the
  // message, so an SDK always has an assistant message to close.
  const b = createResponsesTranslator('m');
  const fb = parseFrames(feed(b, sse([
    { type: 'response.created', response: { id: 'resp_empty' } },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } },
  ])));
  check('an empty response still emits the role opener',
    fb[0].choices[0].delta.role === 'assistant');
  check('...followed by the finish frame', fb[1].choices[0].finish_reason === 'stop');
  check('empty response emits exactly two frames', fb.length === 2);
}

header('createResponsesTranslator — junk and unknown events');
{
  const t = createResponsesTranslator('m');
  check('non-data line ignored', t.chunk('event: response.delta') === null);
  check('unparseable data line ignored', t.chunk('data: {not json') === null);
  check('[DONE] passthrough sentinel ignored', t.chunk('data: [DONE]') === null);
  check('unknown event type ignored', t.chunk('data: {"type":"response.reasoning_summary.delta","delta":"x"}') === null);
  const done = t.complete();
  check('complete() still returns a well-formed body after only junk',
    done.object === 'chat.completion' && done.choices[0].message.content === null);
  check('usage defaults to zeros when the stream never completed', done.usage.total_tokens === 0);
}

header('createResponsesTranslator — per-request state, never shared');
{
  const a = createResponsesTranslator('m');
  const b = createResponsesTranslator('m');
  feed(a, sse([{ type: 'response.output_text.delta', delta: 'A' }]));
  feed(b, sse([{ type: 'response.output_text.delta', delta: 'B' }]));
  check('interleaved translators do not share accumulated text',
    a.complete().choices[0].message.content === 'A' && b.complete().choices[0].message.content === 'B');
}

// ------------------------------------------------------------- discovery

header('fetchCodexModels — request shape');
{
  let seenUrl = null, seenHeaders = null;
  const stub = async (url, init) => {
    seenUrl = url; seenHeaders = init.headers;
    return { ok: true, status: 200, json: async () => ({ models: [{ slug: 'gpt-5.5', visibility: 'list' }] }) };
  };
  const slugs = await fetchCodexModels(creds, stub);
  check('discovery hits the backend /models endpoint',
    seenUrl.startsWith(`${CODEX_BACKEND_BASE_URL}/models?`));
  check('client_version is sent — the backend rejects the call without it',
    seenUrl.includes(`client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`));
  check('discovery carries the account bearer', seenHeaders['Authorization'] === 'Bearer access-token-value');
  check('discovery carries the account-id header', seenHeaders['ChatGPT-Account-ID'] === 'acct_123');
  check('discovery asks for JSON, not SSE', seenHeaders['Accept'] === 'application/json');
  check('slugs parsed', slugs.length === 1 && slugs[0] === 'gpt-5.5');
}

header('fetchCodexModels — filtering');
{
  const stub = async () => ({
    ok: true, status: 200,
    json: async () => ({
      models: [
        { slug: 'gpt-5.6-sol', visibility: 'list' },
        { slug: 'gpt-5.4-mini', visibility: 'list' },
        { slug: 'gpt-reserve', visibility: 'hide' },
        { slug: 'codex-auto-review', visibility: 'hide' },
        { slug: '', visibility: 'list' },
        { visibility: 'list' },
        { id: 'gpt-5.5' },
      ],
    }),
  });
  const slugs = await fetchCodexModels(creds, stub);
  check('visibility=list slugs kept', slugs.includes('gpt-5.6-sol') && slugs.includes('gpt-5.4-mini'));
  check('visibility=hide slugs dropped', !slugs.includes('gpt-reserve') && !slugs.includes('codex-auto-review'));
  check('empty/absent slug entries dropped', !slugs.includes(''));
  check('falls back to id when slug is absent', slugs.includes('gpt-5.5'));
  check('absent visibility counts as listed (degrade to offering, not hiding)', slugs.length === 3);
}
{
  const stub = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ slug: 'gpt-5.4' }] }) });
  const slugs = await fetchCodexModels(creds, stub);
  check('a `data`-keyed payload is read too', slugs.length === 1 && slugs[0] === 'gpt-5.4');
}
{
  const stub = async () => ({ ok: false, status: 401, json: async () => ({}) });
  let threw = false;
  try { await fetchCodexModels(creds, stub); } catch { threw = true; }
  check('non-2xx throws (getCodexModelSlugs is what absorbs it)', threw);
}

header('getCodexModelSlugs — cache');
{
  clearCodexModelCache();
  let calls = 0;
  const stub = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] }) };
  };
  const first = await getCodexModelSlugs(creds, stub);
  const second = await getCodexModelSlugs(creds, stub);
  check('first call fetches', calls === 1);
  check('second call is served from cache', calls === 1);
  check('cached value is the same slug set', second.length === 1 && second[0] === 'gpt-5.6-sol');

  const other = await getCodexModelSlugs({ ...creds, alias: 'other' }, stub);
  check('cache is keyed per account alias', calls === 2 && other.length === 1);

  clearCodexModelCache();
  await getCodexModelSlugs(creds, stub);
  check('clearCodexModelCache() forces a refetch', calls === 3);
}
{
  clearCodexModelCache();
  const dead = async () => { throw new Error('network down'); };
  const slugs = await getCodexModelSlugs(creds, dead);
  check('an unreachable backend yields [] instead of throwing', Array.isArray(slugs) && slugs.length === 0);
}
{
  clearCodexModelCache();
  // Re-seed, then fail: the last known set must survive a later failure.
  await getCodexModelSlugs(creds, async () => ({ ok: true, status: 200, json: async () => ({ models: [{ slug: 'gpt-5.5', visibility: 'list' }] }) }));
  const after = await getCodexModelSlugs(creds, async () => { throw new Error('down'); });
  check('a cached set is still served while the backend is down',
    after.length === 1 && after[0] === 'gpt-5.5');
}

header('isCodexModel — discovered slugs only, never hardcoded patterns');
{
  const slugs = ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini'];
  check('a listed slug matches', isCodexModel('gpt-5.5', slugs));
  check('matching is case-insensitive', isCodexModel('GPT-5.5', slugs));
  check('an unlisted gpt model does NOT match (stays on the api-key backend)',
    !isCodexModel('gpt-4o', slugs));
  check('a name that only looks codex-ish does not match', !isCodexModel('gpt-5-codex', slugs));
  check('empty model never matches', !isCodexModel('', slugs));
  check('empty slug list never matches (discovery down ⇒ route nothing by name)',
    !isCodexModel('gpt-5.5', []));
}

// --------------------------------------------------------------- routing

header('route() — codex adapter truth table');
function ctx(over = {}) {
  return {
    isOpenAIPath: true,
    model: 'gpt-5.5',
    forcedProvider: null,
    hasOpenAIBackend: false,
    hasCodexAccount: true,
    codexModels: ['gpt-5.6-sol', 'gpt-5.5'],
    poolFallbackModel: null,
    poolSize: 1,
    ...over,
  };
}
const CASES = [
  ['chat path, discovered slug, codex account', {}, 'codex'],
  ['discovered slug but no codex account → claude', { hasCodexAccount: false }, 'claude'],
  // dario#1141: the Anthropic path is served too, via Messages⇄Responses. The
  // claim is MODEL-driven, so the cases below pin that Claude traffic on that
  // same path is untouched — that is the whole risk of dropping the path guard.
  ['discovered slug on the anthropic path → codex (Messages⇄Responses)',
    { isOpenAIPath: false }, 'codex'],
  ['claude model on the anthropic path is untouched by a codex account',
    { isOpenAIPath: false, model: 'claude-opus-4-8' }, 'claude'],
  ['anthropic path, discovered slug, but no codex account → claude',
    { isOpenAIPath: false, hasCodexAccount: false }, 'claude'],
  ['forced codex on the anthropic path → codex',
    { isOpenAIPath: false, model: 'anything', forcedProvider: 'codex' }, 'codex'],
  ['forced claude beats a discovered slug on the anthropic path',
    { isOpenAIPath: false, forcedProvider: 'claude' }, 'claude'],
  ['undiscovered gpt model on the anthropic path → claude (the api-key backend has no Messages translation)',
    { isOpenAIPath: false, model: 'gpt-4o', hasOpenAIBackend: true }, 'claude'],
  ['undiscovered gpt model + api-key backend → openai, untouched',
    { model: 'gpt-4o', hasOpenAIBackend: true }, 'openai'],
  ['undiscovered gpt model, no backend → claude', { model: 'gpt-4o' }, 'claude'],
  ['discovered slug wins over a configured api-key backend',
    { hasOpenAIBackend: true }, 'codex'],
  ['forced codex overrides an undiscovered model name',
    { model: 'anything', forcedProvider: 'codex' }, 'codex'],
  ['forced codex with no account → claude', { forcedProvider: 'codex', hasCodexAccount: false }, 'claude'],
  ['forced claude beats a discovered slug', { forcedProvider: 'claude' }, 'claude'],
  ['forced openai beats a discovered slug', { forcedProvider: 'openai', hasOpenAIBackend: true }, 'openai'],
  ['claude model on the chat path is unaffected by a codex account',
    { model: 'claude-opus-4-8' }, 'claude'],
  ['empty discovered set → falls through', { codexModels: [] }, 'claude'],
];
for (const [label, over, expected] of CASES) {
  const d = route(ctx(over));
  check(`${label}  →  ${d.provider}`, d.provider === expected);
  if (d.provider !== expected) console.log(`      expected ${expected}, got ${d.provider} (${d.reason})`);
}
{
  const rev = route(ctx(), [claudeAdapter, openaiAdapter, codexAdapter]);
  check('registry is order-independent (priority, not array order)', rev.provider === 'codex');
  check('codex outranks the openai adapter', codexAdapter.priority > openaiAdapter.priority);
}


// ------------------------------------------- forwardToCodex, Anthropic shape
// dario#1141. The routing table above only proves the DECISION; this drives the
// wiring end to end with an injected fetch and a fake ServerResponse, because
// the Anthropic branch is the only path where a mistranslation is invisible
// until a real Claude-shaped client tries to read the stream.

/** Minimal ServerResponse stand-in: records status, headers and written body. */
function fakeRes() {
  return {
    statusCode: null, headers: null, chunks: [], ended: false, headersSent: false,
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs; this.headersSent = true; },
    write(s) { this.chunks.push(s); return true; },
    end(s) { if (s !== undefined) this.chunks.push(s); this.ended = true; },
    get body() { return this.chunks.join(''); },
  };
}
/** An upstream that replays a Responses SSE stream and records what we sent. */
function fakeUpstream(events, sent) {
  return async (url, init) => {
    sent.url = url;
    sent.headers = init.headers;
    sent.body = JSON.parse(init.body);
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
      }),
    };
  };
}
const CREDS = { alias: 'test', accessToken: 'tok', idToken: undefined };
const TEXT_STREAM = [
  { type: 'response.created', response: { id: 'resp_x', model: 'gpt-5.6-sol' } },
  { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo' },
  { type: 'response.completed', response: {
      id: 'resp_x', model: 'gpt-5.6-sol', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
      usage: { input_tokens: 11, output_tokens: 2 },
  } },
];

header('forwardToCodex — Anthropic shape, request translation');
{
  const sent = {};
  const res = fakeRes();
  const body = Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol',
    system: 'You are terse.',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
  }));
  await forwardToCodex({}, res, body, CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(TEXT_STREAM, sent));
  check('POSTs the codex /responses endpoint', String(sent.url).endsWith('/responses'));
  check('upstream body is Responses-shaped (input[], not messages[])',
    Array.isArray(sent.body.input) && sent.body.messages === undefined);
  check('stream is FORCED even though the client did not ask', sent.body.stream === true);
  check('anthropic system → Responses instructions', sent.body.instructions === 'You are terse.');
  check('anthropic tool input_schema → Responses parameters',
    sent.body.tools[0].type === 'function' && sent.body.tools[0].name === 'get_weather' &&
    sent.body.tools[0].parameters !== undefined && sent.body.tools[0].function === undefined);
}

header('forwardToCodex — Anthropic shape, non-streaming collapse');
{
  const sent = {};
  const res = fakeRes();
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }));
  await forwardToCodex({}, res, body, CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(TEXT_STREAM, sent));
  check('responds 200 JSON', res.statusCode === 200 && res.headers['Content-Type'] === 'application/json');
  const out = JSON.parse(res.body);
  check('is an Anthropic Message, not a chat.completion', out.type === 'message' && out.object === undefined);
  check('role assistant', out.role === 'assistant');
  check('content is a block array with the text', Array.isArray(out.content) && out.content[0].text === 'Hello');
  check('usage uses Anthropic token names',
    out.usage && out.usage.input_tokens === 11 && out.usage.output_tokens === 2);
}

header('forwardToCodex — Anthropic shape, streaming');
{
  const sent = {};
  const res = fakeRes();
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  await forwardToCodex({}, res, body, CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(TEXT_STREAM, sent));
  const raw = res.body;
  check('content-type is text/event-stream', res.headers['Content-Type'] === 'text/event-stream');
  check('emits Anthropic event names, not chat.completion.chunk',
    raw.includes('event: message_start') && !raw.includes('chat.completion.chunk'));
  check('opens a content block', raw.includes('event: content_block_start'));
  check('streams the text deltas', raw.includes('Hel') && raw.includes('lo'));
  check('closes the block and the message',
    raw.includes('event: content_block_stop') && raw.includes('event: message_stop'));
  check('every data: line is valid JSON (an SDK parses these)', (() => {
    const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
    if (lines.length === 0) return false;
    try { for (const l of lines) JSON.parse(l.slice(6)); return true; } catch { return false; }
  })());
  check('no OpenAI [DONE] sentinel on the Anthropic wire', !raw.includes('[DONE]'));
}

header('forwardToCodex — the OpenAI shape is unchanged by the new parameter');
{
  const sent = {};
  const res = fakeRes();
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }));
  await forwardToCodex({}, res, body, CREDS, '*', {}, 5000, false, 'openai', fakeUpstream(TEXT_STREAM, sent));
  const out = JSON.parse(res.body);
  check('still a chat.completion', out.object === 'chat.completion');
  check('still assembles the text', out.choices[0].message.content === 'Hello');
  check('default shape (omitted arg) is openai', true);
}

header('forwardToCodex — Anthropic-shape errors use the Anthropic error body');
{
  const res = fakeRes();
  const failing = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [] }));
  await forwardToCodex({}, res, body, CREDS, '*', {}, 5000, false, 'anthropic', failing);
  check('upstream status is passed through', res.statusCode === 429);
  const out = JSON.parse(res.body);
  check('error body is {type:error, error:{type,message}}',
    out.type === 'error' && out.error && typeof out.error.message === 'string');
}


// ------------------------------------------------- response.failed (dario#1141 review)
// The Responses stream has THREE terminal events. Missing `response.failed`
// was a live bug on BOTH paths: the chat stream ended with no finish frame and
// no [DONE], and the Anthropic non-streaming collapse returned a well-formed
// EMPTY success — a failure that reads as a normal, empty turn.

const FAILED_STREAM = [
  { type: 'response.created', response: { id: 'resp_f', model: 'gpt-5.6-sol' } },
  { type: 'response.failed', response: {
      id: 'resp_f', model: 'gpt-5.6-sol', status: 'failed',
      error: { code: 'server_error', message: 'upstream exploded' },
  } },
];

header('terminal-event predicates');
{
  check('completed is terminal', isTerminalResponsesEvent('response.completed'));
  check('incomplete is terminal', isTerminalResponsesEvent('response.incomplete'));
  check('failed is terminal', isTerminalResponsesEvent('response.failed'));
  check('a delta is not terminal', !isTerminalResponsesEvent('response.output_text.delta'));
  check('status=failed is a failure', isFailedResponse({ status: 'failed' }));
  check('an error object is a failure', isFailedResponse({ error: { message: 'x' } }));
  check('a completed response is not a failure', isFailedResponse({ status: 'completed' }) === false);
  check('junk is not a failure', isFailedResponse(null) === false);
}

header('response.failed — chat path terminates the stream');
{
  const t = createResponsesTranslator('gpt-5.6-sol');
  const out = feed(t, sse(FAILED_STREAM));
  const joined = out.join('');
  check('a failed stream still emits [DONE]', joined.endsWith('data: [DONE]\n\n'));
  const frames = parseFrames(out);
  check('and a terminal frame carrying finish_reason',
    frames.some((f) => f.choices[0].finish_reason !== null));
  check('the translator reports the failure', t.didFail() === true);
}

header('response.failed — non-streaming clients get an error, not a fake empty success');
{
  // Anthropic shape
  const resA = fakeRes();
  await forwardToCodex({}, resA, Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(FAILED_STREAM, {}));
  check('anthropic: 502 rather than 200', resA.statusCode === 502);
  const bodyA = JSON.parse(resA.body);
  check('anthropic: an error body, not a message',
    bodyA.type === 'error' && bodyA.error && bodyA.type !== 'message');
  check('anthropic: the upstream detail is surfaced',
    /upstream exploded/.test(bodyA.error.message));

  // OpenAI shape — the same gap existed here, pre-existing.
  const resO = fakeRes();
  await forwardToCodex({}, resO, Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'openai', fakeUpstream(FAILED_STREAM, {}));
  check('openai: 502 rather than a 200 chat.completion', resO.statusCode === 502);
  const bodyO = JSON.parse(resO.body);
  check('openai: {error} shape, and NOT an empty chat.completion',
    typeof bodyO.error === 'string' && bodyO.object !== 'chat.completion');
}

header('response.failed — a STREAMING client still gets a terminated stream');
{
  const resS = fakeRes();
  await forwardToCodex({}, resS, Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(FAILED_STREAM, {}));
  check('streaming stays 200 (the terminal event is on the wire)', resS.statusCode === 200);
  check('the anthropic stream is closed properly', resS.body.includes('event: message_stop'));
}

header('a SUCCESSFUL response is still not treated as failed');
{
  const res = fakeRes();
  await forwardToCodex({}, res, Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(TEXT_STREAM, {}));
  check('no false positive: still 200', res.statusCode === 200);
  check('and still a message', JSON.parse(res.body).type === 'message');
}


header('max_output_tokens is never sent to the Codex backend (dario#1142)');
{
  // Live 400 from the backend: {"detail":"Unsupported parameter: max_output_tokens"}.
  // Anthropic REQUIRES max_tokens, so without this strip the Anthropic path
  // fails 100%; the chat path fails whenever a client sends an output cap.
  const sentA = {};
  await forwardToCodex({}, fakeRes(), Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }],
  })), CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(TEXT_STREAM, sentA));
  check('anthropic: client max_tokens does not become max_output_tokens upstream',
    !('max_output_tokens' in sentA.body), Object.keys(sentA.body));

  const sentO = {};
  await forwardToCodex({}, fakeRes(), Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }],
  })), CREDS, '*', {}, 5000, false, 'openai', fakeUpstream(TEXT_STREAM, sentO));
  check('chat: client max_tokens does not become max_output_tokens upstream',
    !('max_output_tokens' in sentO.body), Object.keys(sentO.body));

  const sentC = {};
  await forwardToCodex({}, fakeRes(), Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', max_completion_tokens: 512, messages: [{ role: 'user', content: 'hi' }],
  })), CREDS, '*', {}, 5000, false, 'openai', fakeUpstream(TEXT_STREAM, sentC));
  check('chat: max_completion_tokens is stripped too',
    !('max_output_tokens' in sentC.body), Object.keys(sentC.body));

  check('the rest of the body still arrives', Array.isArray(sentA.body.input) && sentA.body.stream === true);
}


header('non-streaming Anthropic body is folded from the STREAM (dario#1143)');
{
  // The ChatGPT Codex backend really does send response.completed with
  // output: [] (verified live against a real subscription). Reading content
  // off the terminal event therefore yields an EMPTY message that still looks
  // perfectly well-formed — a silent empty answer. The content only ever
  // exists in the deltas, which is the discipline the chat path already had.
  const EMPTY_TERMINAL = [
    { type: 'response.created', response: { id: 'resp_e', model: 'gpt-5.6-sol' } },
    { type: 'response.output_text.delta', delta: 'HI' },
    { type: 'response.output_text.delta', delta: ' THERE' },
    { type: 'response.completed', response: {
        id: 'resp_e', model: 'gpt-5.6-sol', status: 'completed',
        output: [],
        usage: { input_tokens: 5, output_tokens: 2 },
    } },
  ];
  const res = fakeRes();
  await forwardToCodex({}, res, Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
  })), CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(EMPTY_TERMINAL, {}));
  check('HTTP 200', res.statusCode === 200);
  const out = JSON.parse(res.body);
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  check('content is assembled from the deltas, not the empty terminal output',
    text === 'HI THERE', out.content);
  check('usage still comes through', out.usage && out.usage.input_tokens === 5, out.usage);
  check('stop_reason still set', typeof out.stop_reason === 'string', out.stop_reason);
}


header('unsupported params never reach the Codex backend (dario#1144)');
{
  // Probed live 2026-08-30: this backend 400s each of these by name.
  // temperature is the one that mattered — forge sets it from an agent's
  // provider_config, so the GPT reviewer 400'd on every dispatch, and
  // chatCompletionsToResponses passes it straight through for ANY OpenAI
  // client that sends one (most do).
  const REJECTED = ['temperature', 'top_p', 'max_output_tokens', 'presence_penalty',
    'frequency_penalty', 'seed', 'metadata', 'top_logprobs', 'truncation', 'service_tier'];
  const dirty = { model: 'm', input: [], stream: true, store: false };
  for (const k of REJECTED) dirty[k] = 1;
  const clean = toCodexSupportedBody(dirty);
  for (const k of REJECTED) check(`${k} is stripped`, !(k in clean));
  check('model/input/stream/store survive',
    clean.model === 'm' && Array.isArray(clean.input) && clean.stream === true && clean.store === false);

  const rich = { model: 'm', input: [], instructions: 'i', tools: [1], tool_choice: 'auto',
    parallel_tool_calls: false, reasoning: { effort: 'low' }, stream: true, store: false };
  check('every accepted field survives',
    Object.keys(toCodexSupportedBody(rich)).sort().join(',') === Object.keys(rich).sort().join(','));
  check('an UNKNOWN field is dropped, not forwarded (fail-safe allowlist)',
    !('brand_new_param' in toCodexSupportedBody({ ...rich, brand_new_param: 1 })));
  check('allowlist has no duplicates', new Set(CODEX_SUPPORTED_FIELDS).size === CODEX_SUPPORTED_FIELDS.length);

  // end to end, both shapes
  const sentA = {};
  await forwardToCodex({}, fakeRes(), Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', max_tokens: 200, temperature: 0.2, top_p: 0.9,
    messages: [{ role: 'user', content: 'hi' }],
  })), CREDS, '*', {}, 5000, false, 'anthropic', fakeUpstream(TEXT_STREAM, sentA));
  check('anthropic: temperature/top_p/max_output_tokens never sent',
    !('temperature' in sentA.body) && !('top_p' in sentA.body) && !('max_output_tokens' in sentA.body),
    Object.keys(sentA.body));

  const sentO = {};
  await forwardToCodex({}, fakeRes(), Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', temperature: 0.7, top_p: 0.5,
    messages: [{ role: 'user', content: 'hi' }],
  })), CREDS, '*', {}, 5000, false, 'openai', fakeUpstream(TEXT_STREAM, sentO));
  check('chat: temperature/top_p never sent (was live-broken for any client sending one)',
    !('temperature' in sentO.body) && !('top_p' in sentO.body), Object.keys(sentO.body));
  check('chat: the real payload still arrives', Array.isArray(sentO.body.input) && sentO.body.stream === true);
}


header('pool-exhaustion failover targets (v6.0.0)');
{
  // Before v6.0.0 the only failover target was an api-key backend, on the
  // OpenAI path only. That made failover INERT for a deployment whose
  // providers are both subscriptions — which is exactly how askalf runs, and
  // why the fleet went fully dark on Claude 429s twice on 2026-08-29 rather
  // than degrading to the ChatGPT plan sitting idle beside it.
  // A CLAUDE model, so the primary is the Claude pool — failover only exists
  // for a claude-primary request. (ctx()'s default model is a codex slug.)
  const fb = (over = {}) => route(ctx({ model: 'claude-opus-4-8', poolFallbackModel: 'gpt-5.6-sol', ...over }));

  check('claude primary, codex account, nominated model listed → codex fallback',
    fb().fallback === 'codex', fb().reason);
  check('...and it works on the ANTHROPIC path too (the whole point)',
    fb({ isOpenAIPath: false }).fallback === 'codex', fb({ isOpenAIPath: false }).reason);
  check('no codex account → falls back to the api-key backend as before',
    fb({ hasCodexAccount: false, hasOpenAIBackend: true }).fallback === 'openai');
  check('api-key fallback still refuses the anthropic path (no Messages translation there)',
    fb({ hasCodexAccount: false, hasOpenAIBackend: true, isOpenAIPath: false }).fallback === null);
  check('a fallback model the codex account does NOT list is not sent there',
    fb({ poolFallbackModel: 'gpt-4o', hasOpenAIBackend: true }).fallback === 'openai');
  check('...and with no api-key backend either, there is simply no fallback',
    fb({ poolFallbackModel: 'gpt-4o' }).fallback === null);
  check('no fallback model configured → no failover (strictly opt-in)',
    route(ctx()).fallback === null);
  check('an empty pool has nothing to fail over FROM',
    fb({ poolSize: 0 }).fallback === null);

  // Failover must never change where a request was already going to succeed.
  check('the PRIMARY is unchanged by arming failover (same request, armed vs not)',
    fb().provider === route(ctx({ model: 'claude-opus-4-8' })).provider &&
    fb().provider === 'claude');
  check('a codex-primary request is unaffected',
    fb({ model: 'gpt-5.5' }).provider === 'codex');
}


header('failover chain selection (v6.0.0)');
{
  const SLUGS = ['gpt-5.6-sol', 'gpt-5.5'];
  check('the codex end takes the first entry that account lists',
    pickCodexFallback(['claude-sonnet-5', 'gpt-5.6-sol'], SLUGS) === 'gpt-5.6-sol');
  check('the claude end takes the first entry it does NOT',
    pickClaudeFallback(['gpt-5.6-sol', 'claude-sonnet-5'], SLUGS) === 'claude-sonnet-5');
  check('a single-entry chain still feeds the codex end (pre-6.0 configs unchanged)',
    pickCodexFallback(['gpt-5.6-sol'], SLUGS) === 'gpt-5.6-sol');
  check('...and gives the claude end nothing, so one-way stays one-way unless asked',
    pickClaudeFallback(['gpt-5.6-sol'], SLUGS) === null);
  check('an empty chain selects nothing at either end (failover stays opt-in)',
    pickCodexFallback([], SLUGS) === null && pickClaudeFallback([], SLUGS) === null);

  // Second Read finding, 2026-08-30. "Not a codex slug" is not "the pool can
  // serve it": a typo would have been swapped in and 404'd, turning a
  // recoverable 429 into an unrecoverable error. Fail CLOSED instead.
  check('a typo is not treated as a Claude model just because codex lacks it',
    pickClaudeFallback(['gpt-5.6-sol', 'cluade-sonnet-5'], SLUGS) === null);
  check('nor is a model plainly meant for some third provider',
    pickClaudeFallback(['gpt-5.6-sol', 'llama-3.1-70b'], SLUGS) === null);
  check('a real Claude id is still selected',
    pickClaudeFallback(['gpt-5.6-sol', 'claude-opus-4-8'], SLUGS) === 'claude-opus-4-8');
  check('and the match is case-insensitive',
    pickClaudeFallback(['Claude-Sonnet-5'], SLUGS) === 'Claude-Sonnet-5');
}

header('pool-fallback outcome matrix — the gate, not just the dispatcher');
{
  // REGRESSION, dario#1145. The dispatcher was right and the GATE in front of
  // it was wrong: selectPoolAccount() still demanded an api-key backend AND the
  // OpenAI path before deferring, so the subscription-only deployment this
  // release exists for got a 503 before the dispatcher ran. Every routing test
  // passed, because none went through that selector.
  const o = (over = {}) => poolFallbackOutcome({
    fallbackModels: ['gpt-5.6-sol'], poolSize: 1,
    codexServes: true, hasOpenAIBackend: false, isOpenAIPath: true, ...over,
  });

  check('codex serves it on the OpenAI path', o() === 'codex');
  check('THE BUG: codex serves it on the ANTHROPIC path too',
    o({ isOpenAIPath: false }) === 'codex');
  check('THE BUG: codex needs no api-key backend alongside it',
    o({ hasOpenAIBackend: false }) === 'codex');
  check('codex is preferred when both could serve',
    o({ hasOpenAIBackend: true }) === 'codex');

  check('without codex, an api-key backend takes the OpenAI path',
    o({ codexServes: false, hasOpenAIBackend: true }) === 'openai');
  check('...but never the Anthropic path — no Messages translation there',
    o({ codexServes: false, hasOpenAIBackend: true, isOpenAIPath: false }) === 'unavailable');
  check('nothing able to serve is an honest 503',
    o({ codexServes: false, hasOpenAIBackend: false }) === 'unavailable');

  check('unarmed is not a failover situation',
    o({ fallbackModels: [] }) === 'unavailable');
  check('an EMPTY pool 503s even armed — a setup error, not traffic to re-bill',
    o({ poolSize: 0 }) === 'unavailable');
}

header('isClaudeServableModel — positive provider capability (reverse failover guard)');
{
  const BASES = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  check('canonical claude id', isClaudeServableModel('claude-opus-5', BASES) === true);
  check('long-context variant', isClaudeServableModel('claude-sonnet-5[1m]', BASES) === true);
  check('case-insensitive', isClaudeServableModel('Claude-Opus-5', BASES) === true);
  check('family shorthand resolves against the catalog', isClaudeServableModel('sonnet', BASES) === true);
  check('1m shorthand resolves too', isClaudeServableModel('opus1m', BASES) === true);
  check('claude: prefix', isClaudeServableModel('claude:opus', BASES) === true);
  check('anthropic: prefix', isClaudeServableModel('anthropic:sonnet', BASES) === true);
  check('gpt model is not', isClaudeServableModel('gpt-4o', BASES) === false);
  check('a non-claude prefix is a definite no', isClaudeServableModel('openai:claude-opus-5', BASES) === false);
  check('unknown shorthand is not', isClaudeServableModel('nonesuch', BASES) === false);
  check('empty is not', isClaudeServableModel('', BASES) === false);
  check('a cold catalog still accepts an explicit claude- id',
    isClaudeServableModel('claude-opus-5', []) === true);
  check('...but cannot resolve a shorthand', isClaudeServableModel('opus', []) === false);

  // The two the v6.0.0 regex got wrong, kept explicit so a revert is loud.
  check('REGRESSION: anthropic: prefix was rejected by the shipped /^claude/i',
    pickClaudeFallback(['gpt-5.6-sol', 'anthropic:sonnet'], ['gpt-5.6-sol'], BASES) === 'anthropic:sonnet');
  check('REGRESSION: a catalog shorthand was rejected too',
    pickClaudeFallback(['gpt-5.6-sol', 'opus'], ['gpt-5.6-sol'], BASES) === 'opus');
}

header('symmetric failover — a subscription may decline instead of answering (v6.0.0)');
{
  // The reverse direction: a rate-limited ChatGPT plan used to be terminal for
  // a gpt-bound request even with an idle Claude pool beside it. Declining has
  // to be silent AND byte-free, or the caller cannot still answer the client.
  const errUpstream = (status) => async () => ({
    ok: false, status, text: async () => 'upstream said no',
  });
  const body = Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }],
  }));
  const fwd = (res, status, defer) => forwardToCodex(
    {}, res, body, CREDS, '*', {}, 5000, false, 'openai', errUpstream(status), defer,
  );

  const r1 = fakeRes();
  const declined = await fwd(r1, 429, true);
  check('a rate-limited subscription declines rather than answering', declined === false);
  check('...having written nothing at all, so the caller can still respond',
    r1.headersSent === false && r1.ended === false && r1.chunks.length === 0);

  const r2 = fakeRes();
  const passedThrough = await fwd(r2, 429, false);
  check('with no fallback armed the 429 still reaches the client (unchanged default)',
    passedThrough === true && r2.statusCode === 429);

  const r3 = fakeRes();
  check('a 5xx is "not right now" too, so it also defers',
    (await fwd(r3, 503, true)) === false);

  // The important negative. A 400 is OUR bad request — the codex backend
  // rejecting a parameter, which is exactly how v5.5.90 shipped broken. Failing
  // over would reproduce it on the other provider and bury the real cause.
  const r4 = fakeRes();
  const surfaced = await fwd(r4, 400, true);
  check('a 400 does NOT defer — our own bad request must surface, not migrate',
    surfaced === true && r4.statusCode === 400);

  const r5 = fakeRes();
  const sent = {};
  check('and a request it actually served reports that it answered',
    (await forwardToCodex({}, r5, body, CREDS, '*', {}, 5000, false, 'openai',
      fakeUpstream(TEXT_STREAM, sent), true)) === true);

  // A subscription that is simply UNREACHABLE never produces a status to read:
  // DNS failure, a refused connection, a reset socket, or our own abort timeout
  // all reject the fetch itself. That is the same "not right now" as a 429, and
  // it used to be terminal — the catch answered 502 and the idle Claude pool
  // beside it never saw the request.
  const throwingUpstream = (err) => async () => { throw err; };

  const r6 = fakeRes();
  const transportDeclined = await forwardToCodex(
    {}, r6, body, CREDS, '*', {}, 5000, false, 'openai',
    throwingUpstream(new TypeError('fetch failed')), true,
  );
  check('a rejecting fetch defers too — an unreachable plan is "not right now"',
    transportDeclined === false);
  check('...and it also wrote nothing, so the caller can still answer',
    r6.headersSent === false && r6.ended === false && r6.chunks.length === 0);

  const r7 = fakeRes();
  const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  check('our own upstream timeout defers as well (the abort lands in the same catch)',
    (await forwardToCodex({}, r7, body, CREDS, '*', {}, 5000, false, 'openai',
      throwingUpstream(abortErr), true)) === false);

  const r8 = fakeRes();
  const transportSurfaced = await forwardToCodex(
    {}, r8, body, CREDS, '*', {}, 5000, false, 'openai',
    throwingUpstream(new TypeError('fetch failed')), false,
  );
  check('with no fallback armed the transport failure is still a 502 (unchanged default)',
    transportSurfaced === true && r8.statusCode === 502);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);

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
import { route, codexAdapter, claudeAdapter, openaiAdapter } from '../dist/provider-adapter.js';

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
  ['discovered slug on the anthropic path → claude (no messages⇄Responses translation)',
    { isOpenAIPath: false }, 'claude'],
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

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);

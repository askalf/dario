#!/usr/bin/env node
// Exercise CLI persistence, catalog and real proxy dispatch with an offline fetch boundary.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const testHome = await mkdtemp(join(tmpdir(), 'dario-minimax-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.DARIO_LEDGER_PATH = join(testHome, 'ledger.json');
process.env.DARIO_CODEX_USAGE_POLL_MS = '0';
process.env.DARIO_NO_BUN = '1';
const realFetch = globalThis.fetch;
const captured = [];
const responseText = 'data: {"choices":[{"delta":{"reasoning_content":"reason","content":"ok"}}]}\n\ndata: [DONE]\n\n';
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
  if (String(url).endsWith('/chat/completions')) {
    captured.push({ url: String(url), headers: init.headers, body: JSON.parse(Buffer.from(init.body).toString()) });
    return new Response(responseText, { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error(`Unexpected external request: ${url}`);
};
const { saveBackend, removeBackend, isMiniMaxBackend } = await import('../dist/openai-backend.js');
const { startProxy, parseProviderPrefix, miniMaxShorthand } = await import('../dist/proxy.js');
const servers = [];
const start = async (opts = {}) => {
  const port = await freePort();
  const server = await startProxy({ port, host: '127.0.0.1', noClaudeAuth: true, noLiveCapture: true, ...opts });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await realFetch(`${base}/health`); return base; } catch { await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error('Proxy failed to listen');
};
const ask = async (base, body) => {
  const before = captured.length;
  const response = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(text, responseText, 'reasoning deltas and SSE framing are preserved');
  assert.equal(captured.length, before + 1);
  return captured.at(-1);
};
const messages = [
  { role: 'user', content: [
    { type: 'text', text: 'Describe these inputs' },
    { type: 'image_url', image_url: { url: 'https://example.invalid/image.png', detail: 'high' } },
    { type: 'video_url', video_url: { url: 'mm_file://fixture', fps: 1 } },
  ] },
  { role: 'assistant', content: '<think>previous reasoning</think>', reasoning_content: 'previous reasoning',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: 'result' },
];
try {
  assert.equal(parseProviderPrefix('minimax'), null, 'bare minimax is not a provider prefix');
  assert.equal(miniMaxShorthand('minimax', 'minimax'), 'minimax:MiniMax-M3.1-Flash', 'shorthand applies on a direct MiniMax endpoint');
  assert.equal(miniMaxShorthand('minimax', 'gateway'), 'openai:minimax', 'on a custom gateway the id goes to the gateway unchanged');
  assert.equal(miniMaxShorthand('minimax', null), 'minimax', 'with no compatible backend the id is left alone');
  assert.equal(miniMaxShorthand('MiniMax-M3', 'minimax'), 'MiniMax-M3');
  assert.equal(parseProviderPrefix('minimax:'), null);
  for (const [name, endpoint] of [['minimax', 'https://api.minimax.io/v1'], ['minimax-cn', 'https://api.minimax.cn/v1']]) {
    execFileSync(process.execPath, ['dist/cli.js', 'backend', 'add', name, '--key=fixture-key'], { env: process.env });
    const saved = JSON.parse(await readFile(join(testHome, '.dario', 'backends', `${name}.json`), 'utf8'));
    assert.equal(saved.baseUrl, endpoint);
    assert.equal(saved.provider, 'openai');
    const base = await start({ modelAliases: { saved: 'minimax:MiniMax-M2.7' } });
    const catalog = await (await realFetch(`${base}/v1/models`)).json();
    assert.deepEqual(catalog.data.filter(m => m.owned_by === 'minimax').map(m => m.id), ['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    assert(catalog.data.some(m => m.id === 'saved'), 'saved aliases remain visible');
    const defaultRequest = await ask(base, { model: 'minimax', messages });
    assert.equal(defaultRequest.url, `${endpoint}/chat/completions`);
    assert.equal(defaultRequest.headers.Authorization, 'Bearer fixture-key');
    assert.deepEqual(defaultRequest.body, { model: 'MiniMax-M3.1-Flash', messages }, 'default relies on upstream adaptive/max defaults');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const body = { model: 'MiniMax-M3.1-Flash', messages, thinking: { type: 'adaptive' }, reasoning_effort: effort, stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] };
      assert.deepEqual((await ask(base, body)).body, body);
    }
    for (const model of ['MiniMax-M3', 'MiniMax-M2.7', 'minimax:custom-model-high', 'saved']) {
      const body = { model, messages, thinking: { type: 'disabled' }, reasoning_effort: 'high', custom_setting: true };
      const expectedModel = model === 'saved' ? 'MiniMax-M2.7' : model.replace(/^minimax:/, '');
      assert.deepEqual((await ask(base, body)).body, { ...body, model: expectedModel });
    }
    // This route deliberately does not translate Messages for API-key backends.
    const before = captured.length;
    const unsupported = await realFetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'minimax', messages, max_tokens: 100 }) });
    await unsupported.text();
    assert(unsupported.status >= 400);
    assert.equal(captured.length, before);
    await removeBackend(name);
  }
  execFileSync(process.execPath, ['dist/cli.js', 'backend', 'add', 'minimax', '--key=fixture-key', '--base-url=https://gateway.example.invalid/v1'], { env: process.env });
  const custom = JSON.parse(await readFile(join(testHome, '.dario', 'backends', 'minimax.json'), 'utf8'));
  assert.equal(custom.baseUrl, 'https://gateway.example.invalid/v1');
  assert.equal(isMiniMaxBackend(custom), false);
  const bareBase = await start();
  const bare = await ask(bareBase, { model: 'minimax', messages });
  assert.equal(bare.url, 'https://gateway.example.invalid/v1/chat/completions', 'bare minimax on a custom gateway goes to the gateway');
  assert.equal(bare.body.model, 'minimax', 'with the gateway-owned id unchanged, not rewritten to Flash');
  const base = await start({ model: 'minimax:MiniMax-M3.1-Flash' });
  const catalog = await (await realFetch(`${base}/v1/models`)).json();
  assert.equal(catalog.data.filter(m => m.owned_by === 'minimax').length, 0);
  assert.equal((await ask(base, { model: 'client-default', messages })).body.model, 'MiniMax-M3.1-Flash');
  const explicit = await ask(base, { model: 'minimax:saved-model-high', messages });
  assert.equal(explicit.url, 'https://gateway.example.invalid/v1/chat/completions');
  assert.equal(explicit.body.model, 'saved-model-high');
  // The generic compatible backend keeps its established behavior.
  await saveBackend({ ...custom, baseUrl: 'https://api.openai.com/v1' });
  const generic = await start();
  const genericBody = { model: 'openai:custom-high', messages, reasoning_effort: 'none', service_tier: 'priority' };
  assert.deepEqual((await ask(generic, genericBody)).body, { ...genericBody, model: 'custom-high' });
  console.log('MiniMax CLI, regional catalog, default, saved/custom, gateway pass-through, effort and multimodal wire checks passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const server of servers) server?.close?.();
  globalThis.fetch = realFetch;
}
process.exit(process.exitCode ?? 0);

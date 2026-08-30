#!/usr/bin/env node
// dario#1145 review finding — tryCodexPoolFallback must PROPAGATE the
// subscription's decline.
//
// The bug: the helper dispatched forwardToCodex without `deferOnUnavailable`
// and then `return true` unconditionally, discarding the forward's boolean. So
// a Codex 429 / 5xx / transport failure was written straight to the client and
// both call sites — the selection-time one and the mid-flight-429 one — saw
// "served" and returned, instead of continuing to the configured api-key
// backend and only then to the honest 429/503. The chain the release advertises
// (`--pool-fallback=a,b`) stopped at its first hop whenever that hop was busy.
//
// Exercised through the MID-FLIGHT call site, which is reachable end-to-end
// without forging pool cool-down state: one pool account, a scripted Anthropic
// upstream that 429s, no peer to fail over to.
//
// Hermetic: HOME is a mkdtemp'd dir holding the Claude account, the codex
// account and the openai-compat backend; the ChatGPT backend and the
// openai-compat backend are local stubs; the Anthropic upstream is
// ProxyOptions.fetchImpl. No network, no real credentials.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stay clear of dario's 3456-3460 range and the other test files' ports.
const PROXY_PORT = 38811;
const CODEX_PORT = 38812;
const OPENAI_PORT = 38813;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

// The chain: entry 0 is what the api-key backend is asked for, entry 1 is the
// slug the ChatGPT backend lists. pickCodexFallback walks to the listed one;
// the openai-compat path uses entry 0, exactly as it did before v6.0.0.
const OPENAI_CHAIN_MODEL = 'gpt-stub-mini';
const LISTED_SLUG = 'gpt-5.6-sol';

// ---------------------------------------------------------------------------
// Stub ChatGPT backend. /models is discovery; /responses is scripted per case:
// '429' declines, 'reset' kills the socket (transport failure), 'ok' streams.
// ---------------------------------------------------------------------------
let codexMode = '429';
const codexSeen = { models: 0, responses: 0 };
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    codexSeen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    codexSeen.responses++;
    req.resume();
    req.on('end', () => {
      if (codexMode === 'reset') { req.socket.destroy(); return; }
      if (codexMode === '429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'codex is busy' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"hi from codex"}\n\n');
      res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// Stub openai-compat backend — the provider the request must reach once the
// subscription declines. Answers chat/completions shape.
// ---------------------------------------------------------------------------
const openaiSeen = { calls: 0, lastModel: null };
const openaiStub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    openaiSeen.calls++;
    try { openaiSeen.lastModel = JSON.parse(Buffer.concat(chunks).toString()).model; } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl_stub', object: 'chat.completion', model: OPENAI_CHAIN_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi from api-key backend' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((r) => openaiStub.listen(OPENAI_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// HOME is set BEFORE importing proxy.js: the accounts/backends modules resolve
// their directories at module-evaluation time (same strategy as
// test/codex-route-empty-pool.mjs).
// ---------------------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-defer-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;

await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(
  join(tmpHome, '.dario', 'accounts', 'main.json'),
  JSON.stringify({
    alias: 'main',
    accessToken: 'claude-access-token',
    refreshToken: 'claude-refresh-token',
    // Comfortably outside the 45-min startup self-heal window, so no refresh.
    expiresAt: Date.now() + 6 * 3_600_000,
    scopes: ['user:inference'],
    deviceId: 'dev-1',
    accountUuid: 'uuid-1',
  }),
);
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(
  join(tmpHome, '.dario', 'codex-accounts', 'live.json'),
  JSON.stringify({
    alias: 'live',
    accessToken: 'codex-access-token',
    refreshToken: 'codex-refresh-token',
    expiresAt: Date.now() + 6 * 3_600_000,
  }),
);
await mkdir(join(tmpHome, '.dario', 'backends'), { recursive: true });
await writeFile(
  join(tmpHome, '.dario', 'backends', 'stub.json'),
  JSON.stringify({
    provider: 'openai', name: 'stub', apiKey: 'sk-stub',
    baseUrl: `http://127.0.0.1:${OPENAI_PORT}/v1`,
  }),
);

const { startProxy } = await import('../dist/proxy.js');

// The ANTHROPIC upstream seam only. Every /v1/messages call 429s with no peer
// left, which is the state the mid-flight fallback exists for. The model
// catalog prewarm goes through here too and gets a minimal list.
let anthropicCalls = 0;
const fakeFetch = async (url) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  anthropicCalls++;
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'pool drained' } }), {
    status: 429, headers: { 'content-type': 'application/json' },
  });
};

await startProxy({
  port: PROXY_PORT,
  host: '127.0.0.1',
  verbose: false,
  noLiveCapture: true,
  poolFallbackModel: `${OPENAI_CHAIN_MODEL},${LISTED_SLUG}`,
  fetchImpl: fakeFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const chat = () => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'ping' }] }),
});

header('codex 429 on the fallback path → continue to the api-key backend');
{
  codexMode = '429';
  const before = { codex: codexSeen.responses, openai: openaiSeen.calls };
  const res = await chat();
  const json = await res.json();
  check('the subscription was actually tried', codexSeen.responses === before.codex + 1,
    `responses=${codexSeen.responses}`);
  check('client is NOT handed the codex 429', res.status === 200, `${res.status} ${JSON.stringify(json)}`);
  check('the api-key backend served it', openaiSeen.calls === before.openai + 1,
    `openai calls=${openaiSeen.calls}`);
  check('it was asked for the chain head', openaiSeen.lastModel === OPENAI_CHAIN_MODEL,
    String(openaiSeen.lastModel));
  check('content came from the api-key backend',
    json.choices?.[0]?.message?.content === 'hi from api-key backend', JSON.stringify(json));
}

header('codex transport failure → same continuation, no half-sent response');
{
  codexMode = 'reset';
  const before = { codex: codexSeen.responses, openai: openaiSeen.calls };
  const res = await chat();
  const json = await res.json();
  check('the subscription was tried', codexSeen.responses === before.codex + 1,
    `responses=${codexSeen.responses}`);
  check('client is NOT handed a 502', res.status === 200, `${res.status} ${JSON.stringify(json)}`);
  check('the api-key backend served it', openaiSeen.calls === before.openai + 1,
    `openai calls=${openaiSeen.calls}`);
  check('content came from the api-key backend',
    json.choices?.[0]?.message?.content === 'hi from api-key backend', JSON.stringify(json));
}

header('codex 200 still short-circuits — declining is the exception, not the rule');
{
  codexMode = 'ok';
  const before = { codex: codexSeen.responses, openai: openaiSeen.calls };
  const res = await chat();
  const json = await res.json();
  check('the subscription was tried', codexSeen.responses === before.codex + 1,
    `responses=${codexSeen.responses}`);
  check('status is 200', res.status === 200, String(res.status));
  check('content came from the subscription',
    json.choices?.[0]?.message?.content === 'hi from codex', JSON.stringify(json));
  check('the api-key backend was NOT called', openaiSeen.calls === before.openai,
    `openai calls=${openaiSeen.calls}`);
  check('the swap is announced', res.headers.get('x-dario-pool-fallback') === LISTED_SLUG,
    String(res.headers.get('x-dario-pool-fallback')));
}

check('the Claude pool was consulted first every time', anthropicCalls >= 3, `calls=${anthropicCalls}`);

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
openaiStub.close();
process.exit(fail === 0 ? 0 : 1);

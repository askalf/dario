#!/usr/bin/env node
// dario#1137 — a ChatGPT-subscription-only user must actually reach the codex
// route. The bug this locks down was invisible to the unit tests: routing was
// correct in provider-adapter.ts and the translation was correct in
// codex-backend.ts, but the request handler selected a Claude pool account —
// and answered 503 "No account configured" on an empty pool — BEFORE the
// provider decision ran. So every request from a user whose only credential is
// a ChatGPT subscription died at a guard for a credential they don't have.
//
// Hermetic: a real proxy on loopback, HOME pointed at a mkdtemp'd dir holding
// one stored codex account, and DARIO_CODEX_BASE_URL pointed at a local stub
// that serves both the /models discovery and the /responses SSE stream. No
// Claude login, no pool, no network.

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
const PROXY_PORT = 38791;
const STUB_PORT = 38792;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

// A slug the ChatGPT backend "lists" for this account. Deliberately NOT a name
// isOpenAIModel would recognise on its own — routing must come from discovery.
const LISTED_SLUG = 'gpt-5.6-sol';

// ---------------------------------------------------------------------------
// Stub ChatGPT backend: /models (discovery) + /responses (the SSE stream
// forwardToCodex translates back into chat/completions shape).
// ---------------------------------------------------------------------------
const seen = { models: 0, responses: 0, lastBody: null, lastAuth: null };
const stub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    seen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      models: [
        { slug: LISTED_SLUG, visibility: 'list' },
        { slug: 'gpt-reserve', visibility: 'hide' },
      ],
    }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    seen.responses++;
    seen.lastAuth = req.headers['authorization'] ?? null;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.lastBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_abc"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"hi from codex"}\n\n');
      res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// A stored codex account and no Claude credentials whatsoever. HOME is set
// BEFORE importing proxy.js: codex-accounts.ts resolves its directory at
// module-evaluation time (same strategy as test/codex-accounts.mjs).
// ---------------------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-route-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(
  join(tmpHome, '.dario', 'codex-accounts', 'live.json'),
  JSON.stringify({
    alias: 'live',
    accessToken: 'codex-access-token',
    refreshToken: 'codex-refresh-token',
    expiresAt: Date.now() + 3_600_000,
  }),
);

const { startProxy, requiresClaudeLogin } = await import('../dist/proxy.js');

// The startup gate is the second half of #1137: without the hasCodexAccount
// argument this process would have exited(1) on `dario proxy` before serving
// anything. Asserted directly here too, since a wrong answer kills the run.
header('startup gate — a stored codex account is a credential');
{
  check('empty pool + codex account → no Claude login demanded',
    requiresClaudeLogin(0, false, false, false, true) === false);
  check('empty pool + nothing at all → still demands login',
    requiresClaudeLogin(0, false, false, false, false) === true);
}

await startProxy({ port: PROXY_PORT, host: '127.0.0.1', passthrough: true, verbose: false });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const chat = (body) => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

header('empty Claude pool + listed codex slug → codex, not 503');
{
  const res = await chat({ model: LISTED_SLUG, messages: [{ role: 'user', content: 'ping' }] });
  const json = await res.json();
  check('status is 200, not the empty-pool 503', res.status === 200, `${res.status} ${JSON.stringify(json)}`);
  check('the codex backend was actually called', seen.responses === 1, `responses=${seen.responses}`);
  check('response is chat.completion shape', json.object === 'chat.completion', JSON.stringify(json));
  check('content came back translated', json.choices?.[0]?.message?.content === 'hi from codex', JSON.stringify(json));
  check('the stored account token was used', seen.lastAuth === 'Bearer codex-access-token', String(seen.lastAuth));
}

header('a codex:/chatgpt: prefix routes even for an undiscovered name');
{
  const res = await chat({ model: 'chatgpt:gpt-5.5', messages: [{ role: 'user', content: 'ping' }] });
  const json = await res.json();
  check('prefixed request is 200', res.status === 200, `${res.status} ${JSON.stringify(json)}`);
  check('backend called a second time', seen.responses === 2, `responses=${seen.responses}`);
  check('prefix was stripped before forwarding', JSON.parse(seen.lastBody).model === 'gpt-5.5', String(seen.lastBody));
}

header('streaming through the codex route');
{
  const res = await chat({ model: LISTED_SLUG, stream: true, messages: [{ role: 'user', content: 'ping' }] });
  const text = await res.text();
  check('stream is 200 SSE', res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    `${res.status} ${res.headers.get('content-type')}`);
  check('carries a translated delta', text.includes('"content":"hi from codex"'), text.slice(0, 200));
  check('terminates with [DONE]', text.includes('data: [DONE]'), text.slice(-120));
}

header('Claude-bound requests still get the empty-pool 503');
{
  // The guard did not disappear — it moved. A request the codex adapter
  // declines must still reach it, otherwise a genuinely unconfigured proxy
  // would fail somewhere less useful.
  const res = await chat({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'ping' }] });
  const json = await res.json();
  check('unroutable model → 503', res.status === 503, `${res.status} ${JSON.stringify(json)}`);
  check('with the "No account configured" message', json.error === 'No account configured', JSON.stringify(json));
}

header('/v1/models attributes codex slugs to openai');
{
  const res = await fetch(`${BASE}/v1/models`);
  const json = await res.json();
  const entry = json.data.find((m) => m.id === LISTED_SLUG);
  check('the listed slug is advertised', entry !== undefined, JSON.stringify(json.data?.slice(0, 5)));
  check('owned_by is openai for a codex slug', entry?.owned_by === 'openai', JSON.stringify(entry));
  check('hidden slugs are not advertised', !json.data.some((m) => m.id === 'gpt-reserve'));
  const claude = json.data.find((m) => m.id.startsWith('claude-'));
  check('Claude models are still owned_by anthropic', claude?.owned_by === 'anthropic', JSON.stringify(claude));
}

stub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

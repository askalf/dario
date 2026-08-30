#!/usr/bin/env node
// dario#1161 review — the effort a chain entry declares must reach the
// OUTBOUND Claude request, proved at the boundary rather than at the picker.
//
// The prior revision added picker-level assertions: pickClaudeTarget returns
// { model: 'claude-opus-5', effort: 'high' } for a `claude:opus:high` entry.
// The reviewer's objection was exact and correct — those never execute the one
// line that makes the fix real:
//
//     if (claudeTarget?.effort) requestEffort = claudeTarget.effort;   (proxy.ts)
//
// Delete that assignment and every picker assertion still passes, while a
// declined Codex request reaches Claude at the pool default effort. That is the
// same shape as the three wiring bugs this release already shipped: a correct
// piece behind a gate nobody proved was wired to it.
//
// So this drives the real handler. A codex-bound request is refused by the
// subscription (429), falls back down the chain to `claude:opus:high`, and the
// Anthropic-bound body is captured and inspected for BOTH halves:
//
//   body.model                 -> the canonical Opus id (suffix + prefix gone)
//   body.output_config.effort  -> 'high'  (the entry's own effort, carried)
//
// Hermetic: HOME is a mkdtemp'd dir with one Claude and one codex account, the
// ChatGPT backend is a local stub, and the Anthropic upstream is
// ProxyOptions.fetchImpl. No network.

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

const PROXY_PORT = 38841;
const CODEX_PORT = 38842;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

const LISTED_SLUG = 'gpt-5.6-sol';
// The chain the reviewer named: codex first, then a Claude entry that carries
// BOTH a provider prefix and a NON-DEFAULT effort suffix.
const CHAIN = `${LISTED_SLUG},claude:opus:low`;
const EXPECT_MODEL = 'claude-opus-5';
// Deliberately NOT 'high': that is dario's own default, so asserting it would
// pass even with the propagation line deleted — a test that proves nothing,
// which is the exact objection this file exists to answer. 'low' can only
// appear here if the chain entry's own suffix actually reached the request.
const EXPECT_EFFORT = 'low';

// --------------------------------------------------------------------------
// Codex stub: lists the slug (so the request routes here as PRIMARY), then
// refuses with a deferrable 429 so the reverse fallback has to fire.
// --------------------------------------------------------------------------
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
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited (stub)' } }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-effort-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;

await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main',
  accessToken: 'claude-access-token',
  refreshToken: 'claude-refresh-token',
  expiresAt: Date.now() + 6 * 3_600_000,
  scopes: ['user:inference'],
  deviceId: 'dev-1',
  accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({
  alias: 'live',
  accessToken: 'codex-access-token',
  refreshToken: 'codex-refresh-token',
  expiresAt: Date.now() + 6 * 3_600_000,
}));

const { startProxy } = await import('../dist/proxy.js');

// The Anthropic seam: capture the outbound body, answer 200 so the fallback
// completes normally. The catalog read must advertise Opus, or the classifier
// correctly refuses a model the pool cannot serve and the chain entry is
// skipped for the RIGHT reason — which would hide the thing under test.
const seen = { calls: 0, body: null };
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-5', type: 'model' },
        { id: 'claude-sonnet-5', type: 'model' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  seen.calls++;
  // The outbound body arrives as a Uint8Array, not a string or a Buffer —
  // String() on it yields comma-separated byte values, which parses as JSON
  // right up to the first comma and then fails misleadingly.
  const raw = init?.body;
  try {
    seen.body = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch { seen.body = null; }
  return new Response(JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: EXPECT_MODEL,
    content: [{ type: 'text', text: 'served by the claude pool' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

await startProxy({
  port: PROXY_PORT,
  host: '127.0.0.1',
  passthrough: false,
  verbose: false,
  noLiveCapture: true,
  poolFallbackModel: CHAIN,
  fetchImpl: fakeFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

header('a declined Codex request carries the chain entry\'s effort to Claude');
{
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Codex-bound: the stub lists this slug, so codex is PRIMARY here and the
    // 429 below is a genuine mid-flight decline, not a selection-time defer.
    body: JSON.stringify({
      model: LISTED_SLUG,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const text = await res.text();

  check('the subscription was asked first', codexSeen.responses === 1, `responses=${codexSeen.responses}`);
  check('...and declined, so the request reached the Claude pool', seen.calls === 1, `calls=${seen.calls}`);
  check('the client got a 200, not the codex 429', res.status === 200, `${res.status} ${text.slice(0, 160)}`);
  check('the substituted model is announced',
    res.headers.get('x-dario-pool-fallback') === EXPECT_MODEL,
    String(res.headers.get('x-dario-pool-fallback')));

  // THE POINT OF THIS FILE — both halves of the outbound body.
  check('the OUTBOUND body carries the canonical Opus id (prefix and suffix resolved)',
    seen.body?.model === EXPECT_MODEL, String(seen.body?.model));
  check('the OUTBOUND body carries the entry\'s own effort, not the pool default',
    seen.body?.output_config?.effort === EXPECT_EFFORT,
    JSON.stringify(seen.body?.output_config));
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

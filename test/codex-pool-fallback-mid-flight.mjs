#!/usr/bin/env node
// dario#1148 review finding — the MID-FLIGHT pool-exhaustion fallback, proved
// through a live request.
//
// The bug: proxy.ts has two terminal 429 handlers inside dispatchLoop. The
// first is the `else if (upstream.status === 429)` arm of the 400/long-context
// recovery chain, entered whenever `(status === 400 || status === 429) &&
// !passthrough` peeked the body. The second is the standalone
// `if (upstream.status === 429)` block further down, which is where the v6.0.0
// mid-flight Codex / openai-compat fallback dispatch lived. Because the peek
// consumes the body and the first branch returns, the second was reachable
// ONLY in passthrough mode — so in the mode dario actually runs in, a pool
// that drained MID-REQUEST enriched the 429 and handed it to the client with a
// healthy subscription sitting unused beside it.
//
// The sibling file test/pool-exhaustion-gate-wiring.mjs covers the OTHER
// exhaustion moment — drained BEFORE selection — and runs its proxies in
// passthrough mode, which is exactly why it could not see this. Every proxy
// here runs with passthrough:false so the peek happens, and every scenario
// uses a FRESH proxy whose single pool account is healthy at selection time
// and only 429s once dispatched. That is what makes the failure mid-flight
// rather than up-front: if the fallback fires, it can only have fired from
// the peeked-429 path.
//
// Hermetic: HOME is a mkdtemp'd dir with one Claude account, one codex
// account, and NO backends dir (openaiBackend stays null); the ChatGPT backend
// is a local stub; the Anthropic upstream is ProxyOptions.fetchImpl. No
// network.

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
const CODEX_PORT = 38831;
const PROXY_ANTHROPIC_PORT = 38832;
const PROXY_OPENAI_PORT = 38833;
const PROXY_NOSERVE_PORT = 38834;

// A slug the ChatGPT backend "lists" for this account. Deliberately NOT a name
// isOpenAIModel would recognise on its own — the failover target must come
// from discovery, as it does in production.
const LISTED_SLUG = 'gpt-5.6-sol';
// Armed on the third proxy: nothing lists it, so no provider can serve and the
// client is owed the honest enriched 429.
const UNLISTED_SLUG = 'gpt-nobody-lists-this';

// ---------------------------------------------------------------------------
// Stub ChatGPT backend: /models is discovery, /responses is the SSE stream
// forwardToCodex translates back into whichever shape the client asked in.
// ---------------------------------------------------------------------------
const codexSeen = { models: 0, responses: 0, lastBody: null };
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    codexSeen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    codexSeen.responses++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      codexSeen.lastBody = Buffer.concat(chunks).toString();
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
// HOME is set BEFORE importing proxy.js: the accounts/backends modules resolve
// their directories at module-evaluation time (same strategy as
// test/pool-exhaustion-gate-wiring.mjs).
// ---------------------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-midflight-'));
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
    // Comfortably outside the 45-min startup self-heal window, so the account
    // is eligible on the first request and no refresh is attempted.
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

const { startProxy } = await import('../dist/proxy.js');

// The ANTHROPIC-upstream seam only; the codex path uses global fetch against
// DARIO_CODEX_BASE_URL. Each proxy gets its own counter so "did this request
// actually reach Claude first" is answerable per scenario — that is the
// mid-flight/up-front discriminator.
const makeFetch = (calls) => async (url) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  calls.total++;
  // A plain Anthropic 429 — the unhelpful body enrich429 exists to improve,
  // plus the rate-limit headers the enriched response is expected to carry.
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 300),
    },
  });
};

const anthropicShapeCalls = { total: 0 };
const openaiShapeCalls = { total: 0 };
const noserveCalls = { total: 0 };

const common = { host: '127.0.0.1', passthrough: false, verbose: false, noLiveCapture: true };
await startProxy({ ...common, port: PROXY_ANTHROPIC_PORT, poolFallbackModel: LISTED_SLUG, fetchImpl: makeFetch(anthropicShapeCalls) });
await startProxy({ ...common, port: PROXY_OPENAI_PORT, poolFallbackModel: LISTED_SLUG, fetchImpl: makeFetch(openaiShapeCalls) });
await startProxy({ ...common, port: PROXY_NOSERVE_PORT, poolFallbackModel: UNLISTED_SLUG, fetchImpl: makeFetch(noserveCalls) });

const BASE_ANTHROPIC = `http://127.0.0.1:${PROXY_ANTHROPIC_PORT}`;
const BASE_OPENAI = `http://127.0.0.1:${PROXY_OPENAI_PORT}`;
const BASE_NOSERVE = `http://127.0.0.1:${PROXY_NOSERVE_PORT}`;
for (const base of [BASE_ANTHROPIC, BASE_OPENAI, BASE_NOSERVE]) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/health`); break; } catch { await sleep(100); }
  }
}

const messages = (base) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});
const chat = (base) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'ping' }] }),
});

header('THE BUG: Anthropic shape, 429 mid-flight, no peer → codex, not a 429');
{
  const before = codexSeen.responses;
  const res = await messages(BASE_ANTHROPIC);
  const text = await res.text();
  check('the request did reach the Claude upstream first (so this IS mid-flight)',
    anthropicShapeCalls.total === 1, `calls=${anthropicShapeCalls.total}`);
  check('not the pre-fix enriched 429', res.status !== 429, `${res.status} ${text.slice(0, 200)}`);
  check('status is 200', res.status === 200, `${res.status} ${text.slice(0, 200)}`);
  check('the subscription actually served it', codexSeen.responses === before + 1,
    `responses=${codexSeen.responses}`);
  check('the answer came from the subscription', text.includes('hi from codex'), text.slice(0, 200));
  check('the substituted model is announced', res.headers.get('x-dario-pool-fallback') === LISTED_SLUG,
    String(res.headers.get('x-dario-pool-fallback')));
  check('the subscription was asked for the listed slug',
    (codexSeen.lastBody ?? '').includes(LISTED_SLUG), (codexSeen.lastBody ?? '').slice(0, 200));
}

header('THE BUG: OpenAI shape, 429 mid-flight, no peer');
{
  const before = codexSeen.responses;
  const res = await chat(BASE_OPENAI);
  const json = await res.json();
  check('the request reached the Claude upstream first', openaiShapeCalls.total === 1,
    `calls=${openaiShapeCalls.total}`);
  check('not the pre-fix enriched 429', res.status !== 429, `${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  check('status is 200', res.status === 200, String(res.status));
  check('the subscription served it', codexSeen.responses === before + 1,
    `responses=${codexSeen.responses}`);
  check('content came from the subscription',
    json.choices?.[0]?.message?.content === 'hi from codex', JSON.stringify(json).slice(0, 200));
  check('the substituted model is announced', res.headers.get('x-dario-pool-fallback') === LISTED_SLUG,
    String(res.headers.get('x-dario-pool-fallback')));
}

header('nothing can serve → the honest enriched 429 still surfaces');
{
  // The fallback declines (no provider lists UNLISTED_SLUG, no api-key
  // backend), so the peeked-429 path must fall through to enrich429 exactly as
  // it did before. The fix adds a fallback attempt, not a swallow.
  const before = codexSeen.responses;
  const res = await messages(BASE_NOSERVE);
  const text = await res.text();
  check('status is 429', res.status === 429, `${res.status} ${text.slice(0, 200)}`);
  check('the rate-limit headers ride along',
    res.headers.get('anthropic-ratelimit-unified-status') === 'rejected',
    String(res.headers.get('anthropic-ratelimit-unified-status')));
  check('the subscription was not asked to serve a slug it never listed',
    codexSeen.responses === before, `responses=${codexSeen.responses}`);
  check('the client was not handed a fallback header it cannot trust',
    res.headers.get('x-dario-pool-fallback') === null,
    String(res.headers.get('x-dario-pool-fallback')));
}

check('model discovery was consulted', codexSeen.models >= 1, `models=${codexSeen.models}`);

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

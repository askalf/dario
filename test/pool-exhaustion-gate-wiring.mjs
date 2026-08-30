#!/usr/bin/env node
// dario#1145 review finding — the pool-exhaustion GATE, proved through a live
// request instead of through the specification surface.
//
// The bug (fixed in eabfed7b, on master): selectPoolAccount() computed
//
//     fallbackViable = poolFallbackModel !== null && openaiBackend !== null
//                      && isOpenAI && pool.size > 0
//
// and wrote its 503 before returning false, so a drained pool answered
// "No accounts available in pool" BEFORE tryCodexPoolFallback could run —
// whenever there was no api-key backend, or the client spoke Anthropic. That is
// the subscription-only deployment v6.0.0 exists for.
//
// It survived review because every routing test passed: route() was updated,
// the dispatcher was added and tested, and the gate in front of both was never
// touched. poolFallbackOutcome() now states the matrix, and its own doc comment
// (src/provider-adapter.ts) says outright that it is a SPECIFICATION surface —
// it cannot prove proxy.ts asks it at the right moment, which is precisely what
// broke, and "a live request still owes proof". This file is that proof.
//
// The pool is drained the way production drains it, not by forging internals:
// the first request 401s upstream, which puts the single account into
// markAuthFailure cool-down, so the NEXT select() returns null with pool.size
// still 1. That is exactly the "has accounts, none usable" state the gate
// misjudged — and it is reachable only through the handler, which is the point.
//
// Hermetic: HOME is a mkdtemp'd dir holding one Claude account and one codex
// account and NO backends dir (openaiBackend stays null, the half of the bug
// that a configured api-key backend hides); the ChatGPT backend is a local
// stub; the Anthropic upstream is ProxyOptions.fetchImpl. No network.

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
const PROXY_PORT = 38821;
const CODEX_PORT = 38822;
const PROXY_NOSERVE_PORT = 38823;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const BASE_NOSERVE = `http://127.0.0.1:${PROXY_NOSERVE_PORT}`;

// A slug the ChatGPT backend "lists" for this account. Deliberately NOT a name
// isOpenAIModel would recognise on its own — the failover target must come from
// discovery, as it does in production.
const LISTED_SLUG = 'gpt-5.6-sol';
// Armed on the second proxy: nothing lists it, so no provider can serve.
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
// test/codex-route-empty-pool.mjs).
//
// NOTE what is deliberately absent: ~/.dario/backends. openaiBackend is null
// for both proxies below, which is half of what the old gate demanded.
// ---------------------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-gate-'));
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
// DARIO_CODEX_BASE_URL. `mode` scripts it: '401' drains the pool the way
// production does, 'forbidden' makes any LATER Claude dispatch fail loudly, so
// a regression that routes back to the pool cannot pass quietly.
let anthropicMode = '401';
const anthropicCalls = { total: 0 };
const fakeFetch = async (url) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  anthropicCalls.total++;
  if (anthropicMode === 'forbidden') throw new Error(`unexpected Claude dispatch: ${target}`);
  return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'token invalidated' } }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
};

await startProxy({
  port: PROXY_PORT,
  host: '127.0.0.1',
  passthrough: true,
  verbose: false,
  noLiveCapture: true,
  poolFallbackModel: LISTED_SLUG,
  fetchImpl: fakeFetch,
});
await startProxy({
  port: PROXY_NOSERVE_PORT,
  host: '127.0.0.1',
  passthrough: true,
  verbose: false,
  noLiveCapture: true,
  poolFallbackModel: UNLISTED_SLUG,
  fetchImpl: fakeFetch,
});
for (const base of [BASE, BASE_NOSERVE]) {
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

// Drain the pool through the handler: one 401 puts the only account into
// auth cool-down, so the next select() returns null with pool.size still 1.
header('drain — a 401 leaves the pool populated but unusable');
{
  const res = await messages(BASE);
  check('the first request did reach the Claude upstream', anthropicCalls.total === 1,
    `calls=${anthropicCalls.total}`);
  check('...and the 401 surfaced (no peer to fail over to)', res.status === 401, String(res.status));

  const res2 = await messages(BASE_NOSERVE);
  check('the second proxy drained the same way', res2.status === 401, String(res2.status));
}
// From here on, ANY Claude dispatch is a regression, not a fallback.
anthropicMode = 'forbidden';

header('THE BUG: Anthropic shape, no api-key backend → codex, not 503');
{
  const before = codexSeen.responses;
  const res = await messages(BASE);
  const text = await res.text();
  check('not the pre-fix 503', res.status !== 503, `${res.status} ${text.slice(0, 200)}`);
  check('status is 200', res.status === 200, `${res.status} ${text.slice(0, 200)}`);
  check('the subscription actually served it', codexSeen.responses === before + 1,
    `responses=${codexSeen.responses}`);
  check('the answer came from the subscription', text.includes('hi from codex'), text.slice(0, 200));
  check('the substituted model is announced', res.headers.get('x-dario-pool-fallback') === LISTED_SLUG,
    String(res.headers.get('x-dario-pool-fallback')));
  check('the subscription was asked for the listed slug',
    (codexSeen.lastBody ?? '').includes(LISTED_SLUG), (codexSeen.lastBody ?? '').slice(0, 200));
}

header('THE BUG: OpenAI shape needs no api-key backend beside the subscription');
{
  const before = codexSeen.responses;
  const res = await chat(BASE);
  const json = await res.json();
  check('not the pre-fix 503', res.status !== 503, `${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  check('status is 200', res.status === 200, String(res.status));
  check('the subscription served it', codexSeen.responses === before + 1,
    `responses=${codexSeen.responses}`);
  check('content came from the subscription',
    json.choices?.[0]?.message?.content === 'hi from codex', JSON.stringify(json).slice(0, 200));
  check('the substituted model is announced', res.headers.get('x-dario-pool-fallback') === LISTED_SLUG,
    String(res.headers.get('x-dario-pool-fallback')));
}

header('deferred but unservable → the honest 503, not a fall-through 401');
{
  // Armed fallback, drained pool, but nothing lists UNLISTED_SLUG and there is
  // no api-key backend. The selector defers, every dispatch declines, and the
  // handler owes the client the message the selector used to give. Without the
  // final guard the request would reach the Claude path with an empty bearer
  // and return a confusing upstream 401 instead.
  const before = codexSeen.responses;
  const res = await messages(BASE_NOSERVE);
  const json = await res.json();
  check('status is 503', res.status === 503, `${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  check('it names the drained pool, not a missing account',
    json.error === 'No accounts available in pool', JSON.stringify(json));
  check('the subscription was not asked to serve a slug it never listed',
    codexSeen.responses === before, `responses=${codexSeen.responses}`);
}

check('no request escaped to the Claude upstream after the drain', anthropicCalls.total === 2,
  `calls=${anthropicCalls.total}`);
check('model discovery was consulted', codexSeen.models >= 1, `models=${codexSeen.models}`);

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

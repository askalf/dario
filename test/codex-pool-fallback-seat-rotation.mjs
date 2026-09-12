#!/usr/bin/env node
// Proxy-level proof that the CLAUDE-TO-CODEX fallback route rotates seats too.
//
// Asked for in review of #1288, and it was a real gap. The mid-flight peer
// retry went into the primary Codex route only. The fallback route —
// tryCodexPoolFallback, the one a Claude-pool 429 lands on — selected a single
// seat and forwarded once, deferring only when an api-key backend followed it:
//
//     const hasNextOption = openaiBackend !== null && shape === 'openai';
//
// So with a Claude→Codex pool fallback, two seats, and no openaiBackend, the
// fallback picked alpha, alpha answered 429, `hasNextOption` was false, and
// forwardToCodex wrote that 429 straight to the client and reported served.
// alpha was cooled for LATER requests, but THIS request never tried bravo —
// a healthy seat sitting unused, on the one route that exists for the case
// where the other provider has already given up.
//
// That is the same class of bug as the one test/codex-pool-seat-rotation.mjs
// pins on the primary route, which is why it deserves the same kind of test:
// end-to-end, and about OBSERVED TRAFFIC — which seat's bearer token did the
// upstream actually see, inside which client request.
//
// The shape here is deliberately the reviewer's reproduction: anthropic wire
// shape (so `shape === 'openai'` is false) and no api-key backend (so
// `openaiBackend` is null). Both halves of `hasNextOption` are false, which is
// what made the old code write the 429 instead of retrying.
//
// Hermetic: mkdtemp HOME, two codex seats, a local stub ChatGPT backend, the
// Claude upstream via fetchImpl. No network, no real credentials.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODEX_PORT = await freePort();
const PROXY_PORT = await freePort();
const LISTED_SLUG = 'gpt-5.6-sol';

// Which seat is currently told to 429, and every bearer the upstream saw.
const state = { rateLimit: new Set(), seen: [] };
const bearerAlias = (req) => {
  const auth = req.headers['authorization'] || '';
  // Tokens are `codex-at-<alias>`, so the seat is readable off the wire — the
  // point is asserting which ACCOUNT served, not merely that one did.
  const m = /codex-at-([a-z0-9]+)/i.exec(auth);
  return m ? m[1] : null;
};

const codexStub = createServer((req, res) => {
  const alias = bearerAlias(req);
  if (req.url.startsWith('/models')) {
    // Both seats list the same model here. The per-seat re-pick that the
    // fallback route needs is covered by codex-pool-peer-model-scan.mjs; this
    // file is about rotation on decline.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    req.on('data', () => {});
    req.on('end', () => {
      state.seen.push(alias);
      if (state.rateLimit.has(alias)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '120' });
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
      res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// HOME before importing proxy.js — the accounts modules resolve dirs at load.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-fallback-rotation-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
delete process.env.DARIO_CODEX_ACCOUNT;

const SIX_HOURS = Date.now() + 6 * 3_600_000;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-at', refreshToken: 'claude-rt',
  expiresAt: SIX_HOURS, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
// TWO seats. 'alpha' sorts first, so a fresh pool picks it; 'bravo' is the peer
// that must take over inside the same request.
for (const alias of ['alpha', 'bravo']) {
  await writeFile(join(tmpHome, '.dario', 'codex-accounts', `${alias}.json`), JSON.stringify({
    alias, accessToken: `codex-at-${alias}`, refreshToken: `codex-rt-${alias}`, expiresAt: SIX_HOURS,
  }));
}

const { startProxy } = await import('../dist/proxy.js');

// Claude always 429s, so every request reaches the codex fallback route. This
// is the ONLY upstream seam mocked; the codex side goes over real HTTP to the
// stub, which is what makes the bearer assertions meaningful.
const claudeCalls = { total: 0 };
const anthropicFetch = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  claudeCalls.total++;
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 300),
    },
  });
};

// No apiKey backend and the anthropic wire shape: `hasNextOption` is false on
// both counts. That is the configuration the finding described.
const server = await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, noLiveCapture: true,
  poolFallbackModel: LISTED_SLUG,
  fetchImpl: anthropicFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch { await sleep(100); }
}

const ask = async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 16,
      // A fresh conversation each time: the sticky binding is keyed on the
      // body, and reusing one would pin every request to the same seat.
      messages: [{ role: 'user', content: `fallback rotation probe ${Math.random()}` }],
    }),
  });
  await r.text().catch(() => '');
  return r.status;
};

// Order matters: the cool-downs are real (retry-after 120s) and persist across
// requests in this process, so the clean-pool cases must run first.

// ---------------------------------------------------------------------------
header('the fallback route reaches codex at all');
// ---------------------------------------------------------------------------
{
  state.seen.length = 0;
  const status = await ask();
  check('claude was tried first and 429d', claudeCalls.total > 0, String(claudeCalls.total));
  check('the client got a 200 from the fallback', status === 200, String(status));
  check('served by alpha', state.seen.at(-1) === 'alpha', state.seen.join(','));
}

// ---------------------------------------------------------------------------
header('MID-FLIGHT on the FALLBACK route: alpha 429s, bravo rescues it');
// ---------------------------------------------------------------------------
// This is the regression. Before the fix `hasNextOption` was false here, so
// alpha's 429 went to the client and bravo was never asked.
{
  state.rateLimit.add('alpha');
  state.seen.length = 0;
  const status = await ask();
  const touched = state.seen.slice();

  check('the client still got a 200', status === 200, String(status));
  check('two seats were touched in ONE request', new Set(touched).size === 2, touched.join(','));
  check('the limited seat was tried first', touched[0] === 'alpha', touched.join(','));
  check('the healthy peer served it', touched.at(-1) === 'bravo', touched.join(','));
}

// ---------------------------------------------------------------------------
header('the declined seat is cooling — the next fallback skips it');
// ---------------------------------------------------------------------------
{
  state.seen.length = 0;
  const status = await ask();
  const touched = state.seen.slice();
  check('request succeeded', status === 200, String(status));
  check('alpha was not re-probed while cooling', !touched.includes('alpha'), touched.join(','));
  check('bravo served it directly, no wasted attempt',
    touched.length === 1 && touched[0] === 'bravo', touched.join(','));
}

// ---------------------------------------------------------------------------
header('no peer left: the real upstream 429 reaches the client, not a 503');
// ---------------------------------------------------------------------------
// The other half of the change. Widening the defer condition must NOT turn
// "nothing can serve this" into a manufactured 503 — with no peer and no
// api-key backend there is nothing to defer TO, so the honest upstream error
// is what the client should see.
{
  state.rateLimit.add('bravo');
  state.seen.length = 0;
  const status = await ask();
  check('bravo was asked and declined', state.seen.includes('bravo'), state.seen.join(','));
  check('the client got a rate-limit status, not a generic 503',
    status === 429, String(status));
}

// ---------------------------------------------------------------------------
header('a fully-cooled pool stops spending upstream requests');
// ---------------------------------------------------------------------------
{
  state.seen.length = 0;
  await ask();
  check('no seat was probed once every seat is cooling', state.seen.length === 0,
    `saw ${state.seen.join(',')}`);
}

codexStub.close();
server?.close?.();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

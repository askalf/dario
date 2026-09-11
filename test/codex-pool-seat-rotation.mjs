#!/usr/bin/env node
// Proxy-level proof that a 429 on ONE ChatGPT seat rotates to a healthy peer.
//
// Asked for in review of #1288, and it is the right ask: the unit test in
// test/codex-pool.mjs calls selectCodexAccount directly, so it cannot see the
// routing gate in front of it. The first version of this change cooled the
// PROVIDER on every 429 as well as the seat — and canAttempt('codex', ...)
// short-circuits on that, so the next request never reached selectCodexAccount
// to find the healthy peer. The pool looked correct in isolation and was inert
// in production: precisely the bug the change exists to remove.
//
// So the assertion here is deliberately end-to-end and about OBSERVED TRAFFIC:
// which seat's bearer token did the upstream actually see on request two.
//
// Hermetic, same shape as codex-pool-fallback-mid-flight.mjs: mkdtemp HOME with
// two codex seats, a local stub ChatGPT backend, Anthropic via fetchImpl. No
// network, no real credentials.

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

const CODEX_PORT = await freePort();
const PROXY_PORT = await freePort();
const LISTED_SLUG = 'gpt-5.6-sol';

// Which seat is currently told to 429, and every bearer the upstream saw.
const state = { rateLimit: new Set(), seen: [] };
let bravo_first = false;
const bearerAlias = (req) => {
  const auth = req.headers['authorization'] || '';
  // Tokens are `codex-at-<alias>` below, so the seat is readable off the wire —
  // the whole point is asserting which ACCOUNT served, not merely that one did.
  const m = /codex-at-([a-z0-9]+)/i.exec(auth);
  return m ? m[1] : null;
};

const codexStub = createServer((req, res) => {
  const alias = bearerAlias(req);
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    req.on('data', () => {});
    req.on('end', () => {
      state.seen.push(alias);
      if (state.rateLimit.has(alias)) {
        // A real seat-level limit: 429 with a retry-after the pool can honour.
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
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-seat-rotation-'));
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
// TWO seats. 'alpha' sorts first, so it is what the old always-first selection
// returned and what a fresh pool picks; 'bravo' is the peer that must take over.
for (const alias of ['alpha', 'bravo']) {
  await writeFile(join(tmpHome, '.dario', 'codex-accounts', `${alias}.json`), JSON.stringify({
    alias, accessToken: `codex-at-${alias}`, refreshToken: `codex-rt-${alias}`, expiresAt: SIX_HOURS,
  }));
}

const { startProxy } = await import('../dist/proxy.js');

const anthropicFetch = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // If the pool works, request two never gets here.
  return new Response(JSON.stringify({ error: { message: 'claude fallback' } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const server = await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, fetchImpl: anthropicFetch,
});

const ask = async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: LISTED_SLUG, max_tokens: 16,
      messages: [{ role: 'user', content: `rotation probe ${Math.random()}` }],
    }),
  });
  await r.text().catch(() => '');
  return r.status;
};

// Scenario order matters: cool-downs are real (retry-after 120s) and persist
// across requests, so the clean-pool cases run FIRST. An earlier draft put
// mid-flight last and it answered 400 with no seat touched — correctly, the
// pool was already fully cooled by the preceding block.

// ---------------------------------------------------------------------------
header('a healthy pool serves from the first seat');
// ---------------------------------------------------------------------------
{
  const status = await ask();
  check('request 1 succeeded', status === 200, String(status));
  check('served by alpha', state.seen.at(-1) === 'alpha', String(state.seen.at(-1)));
}

// ---------------------------------------------------------------------------
header('MID-FLIGHT: a 429 is rescued by a peer inside the SAME request');
// ---------------------------------------------------------------------------
{
  // Only alpha is limited. One client request: alpha must decline and bravo
  // must rescue it without the client ever seeing a failure.
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
header('the declined seat is now cooling — the next request skips it');
// ---------------------------------------------------------------------------
{
  state.seen.length = 0;
  const status = await ask();
  const touched = state.seen.slice();
  check('request succeeded', status === 200, String(status));
  check('alpha was not re-probed while cooling', !touched.includes('alpha'), touched.join(','));
  check('bravo served it directly, no wasted attempt', touched.length === 1 && touched[0] === 'bravo', touched.join(','));
}

// ---------------------------------------------------------------------------
header('both seats limited -> the lane cools and stops spending requests');
// ---------------------------------------------------------------------------
{
  state.rateLimit.add('bravo');
  await ask();                       // bravo declines too; now every seat cools
  state.seen.length = 0;
  await ask();
  // Nothing askable: the pool must answer without touching the upstream. This
  // is the single-seat fail-fast the provider cool-down always existed for.
  check('a fully-cooled pool spends no upstream requests', state.seen.length === 0,
    `saw ${state.seen.join(',')}`);
}

codexStub.close();
console.log(`
${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

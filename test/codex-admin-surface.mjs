#!/usr/bin/env node
// The codex engine on the admin surface. Before this, a proxy that served GPT
// all day reported none of it: /status, /accounts and /analytics never named a
// codex account, and codex requests bypassed analytics and the request log.
// An operator dashboard read "0 requests" off a busy proxy.
//
// Hermetic: a real proxy on loopback, HOME pointed at a mkdtemp'd dir holding
// one stored codex account, DARIO_CODEX_BASE_URL at a local stub. No Claude
// login, no pool, no network. Same harness as codex-route-empty-pool.mjs.

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

// Clear of 3456-3460 and the other test files' ports.
const PROXY_PORT = 38801;
const STUB_PORT = 38802;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const LISTED_SLUG = 'gpt-5.6-admin';

let failNext = false;
const stub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    if (failNext) { failNext = false; res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
      res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":5}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-admin-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
const expiresAt = Date.now() + 3_600_000;
await writeFile(
  join(tmpHome, '.dario', 'codex-accounts', 'fleet.json'),
  JSON.stringify({ alias: 'fleet', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt }),
);

const { startProxy } = await import('../dist/proxy.js');
const noNetwork = async (url) => { throw new Error(`unexpected upstream fetch: ${url}`); };
await startProxy({ port: PROXY_PORT, host: '127.0.0.1', passthrough: true, verbose: false, noLiveCapture: true, fetchImpl: noNetwork });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const getJson = async (p) => { const r = await fetch(`${BASE}${p}`); return { status: r.status, json: await r.json() }; };

header('GET /codex before any request — the stored account, no token, no upstream call');
{
  const { status, json } = await getJson('/codex');
  check('answers 200', status === 200, String(status));
  check('lists the stored alias', json.accounts?.[0]?.alias === 'fleet', JSON.stringify(json));
  check('carries expiry, not the token', json.accounts[0].expiresAt === expiresAt && !JSON.stringify(json).includes('codex-access-token'), JSON.stringify(json));
  check('needsRefresh is false an hour out', json.accounts[0].needsRefresh === false);
  check('models are the CACHE only — nothing fetched yet', Array.isArray(json.accounts[0].models) && json.accounts[0].models.length === 0, JSON.stringify(json.accounts[0].models));
  check('zero requests so far', json.requests === 0 && json.accounts[0].requestCount === 0, JSON.stringify(json));
  check('names the backend', typeof json.backend === 'string' && json.backend.length > 0);
}

header('one codex request, then the surfaces that used to be blind');
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LISTED_SLUG, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const body = await r.json();
  check('the request itself still works', r.status === 200 && body.choices?.[0]?.message?.content === 'hello', `${r.status} ${JSON.stringify(body)}`);

  const codex = (await getJson('/codex')).json;
  check('/codex counts it', codex.requests === 1 && codex.accounts[0].requestCount === 1, JSON.stringify(codex));
  check('/codex now shows the discovered models', codex.accounts[0].models.includes(LISTED_SLUG), JSON.stringify(codex.accounts[0].models));

  const an = (await getJson('/analytics')).json;
  const acct = an.perAccount?.fleet;
  check('/analytics has a perAccount row for the codex alias', !!acct, JSON.stringify(Object.keys(an.perAccount || {})));
  check('with the request counted', acct?.requests === 1, JSON.stringify(acct));
  check('and the tokens from the terminal event', acct?.inputTokens === 12 && acct?.outputTokens === 5, JSON.stringify(acct));
  check('/analytics perModel has the GPT slug', !!an.perModel?.[LISTED_SLUG], JSON.stringify(Object.keys(an.perModel || {})));
  check('the claim names the engine', JSON.stringify(an).includes('chatgpt_subscription'), 'claim missing from breakdowns');
}

header('the overage guard must NOT halt on a codex request — it is subscription billing');
{
  const h = (await getJson('/health')).json;
  check('proxy is not halted after a codex request', !/halt/i.test(JSON.stringify(h)) && (h.status !== 'halted'), JSON.stringify(h).slice(0, 200));
  const an = (await getJson('/analytics')).json;
  check('the request landed in the subscription billing bucket', an.window?.billingBucketBreakdown?.subscription === 1 && an.window?.billingBucketBreakdown?.unknown === 0, JSON.stringify(an.window?.billingBucketBreakdown));
}

header('a failing backend is recorded as a failure, not a success');
{
  failNext = true;
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `codex:${LISTED_SLUG}`, messages: [{ role: 'user', content: 'ping' }] }),
  });
  check('the client saw the upstream failure', r.status >= 400, String(r.status));
  const an = (await getJson('/analytics')).json;
  check('perAccount counted the second request', an.perAccount?.fleet?.requests === 2, JSON.stringify(an.perAccount?.fleet));
  check('the window error rate is no longer zero', (an.window?.errorRate ?? 0) > 0, JSON.stringify(an.window));
}

console.log(`\n${pass} passed, ${fail} failed`);
stub.close();
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Live-request proof for the mid-flight-429 fallback wiring bug found during
// the LIVE PRODUCTION incident on 2026-08-30.
//
// There are two structurally near-identical "no peer left, upstream said 429"
// sites in the request handler's dispatch loop. v6.0.0 wired the pool-exhausted
// fallback into only ONE of them. The other — reached by every
// NON-passthrough request, i.e. everything except a literal Claude Code CLI
// session (forge's SDK Engine included) — kept returning the raw upstream 429
// straight to the client. `dario doctor` reported failover armed and healthy
// the entire time; nothing in the process could have told the operator.
//
// #1150 (this file's sibling, pool-exhaustion-gate-wiring.mjs) is the reason
// this survived: it proves the SELECTION-time gate with `passthrough: true`,
// which never reaches the branch that was actually broken here. This file
// proves the MID-FLIGHT branch, with `passthrough` at its PRODUCTION default
// (false) — the account is genuinely selected and dispatched, THEN the
// upstream returns 429 with no peer left to retry.
//
// Hermetic: same technique as #1150 — HOME is a mkdtemp'd dir, the ChatGPT
// backend is a local stub, the Anthropic upstream is ProxyOptions.fetchImpl.
// No network.

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

const PROXY_PORT = 38831;
const CODEX_PORT = 38832;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

const LISTED_SLUG = 'gpt-5.6-sol';

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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-midflight429-'));
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

// The account IS selected (no 401 drain, unlike #1150) — every dispatch to
// the Anthropic upstream returns a genuine 429 with no rate-limit headers, the
// same shape a real subscription-exhaustion response takes.
const anthropicCalls = { total: 0 };
const fakeFetch = async (url) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  anthropicCalls.total++;
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
    status: 429, headers: { 'content-type': 'application/json' },
  });
};

// passthrough intentionally OMITTED — defaults to false, the production shape
// for everything except a literal Claude Code CLI session. #1150 sets
// `passthrough: true` on both its proxies, which is exactly why it never
// reached the branch this file exists to cover.
await startProxy({
  port: PROXY_PORT,
  host: '127.0.0.1',
  verbose: false,
  noLiveCapture: true,
  poolFallbackModel: LISTED_SLUG,
  fetchImpl: fakeFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const messages = () => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // No Claude-Code-CLI signature of any kind — an ordinary API client, the
  // shape forge's SDK Engine and every non-CC caller actually sends.
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});

header('THE LIVE-INCIDENT BUG: non-passthrough mid-flight 429 → codex, not a raw 429');
{
  const res = await messages();
  const text = await res.text();
  check('the Claude upstream was actually dispatched to (a real mid-flight 429, not a selection-time defer)',
    anthropicCalls.total === 1, `calls=${anthropicCalls.total}`);
  check('NOT the raw upstream 429 the live incident produced', res.status !== 429, `${res.status} ${text.slice(0, 200)}`);
  check('status is 200', res.status === 200, `${res.status} ${text.slice(0, 200)}`);
  check('the subscription actually served it', codexSeen.responses === 1, `responses=${codexSeen.responses}`);
  check('the answer came from the subscription', text.includes('hi from codex'), text.slice(0, 200));
  check('the substituted model is announced', res.headers.get('x-dario-pool-fallback') === LISTED_SLUG,
    String(res.headers.get('x-dario-pool-fallback')));
  check('the subscription was asked for the listed slug',
    (codexSeen.lastBody ?? '').includes(LISTED_SLUG), (codexSeen.lastBody ?? '').slice(0, 200));
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

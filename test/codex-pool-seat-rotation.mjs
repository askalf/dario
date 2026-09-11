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

// ---------------------------------------------------------------------------
header('a healthy pool serves from the first seat');
// ---------------------------------------------------------------------------
{
  await ask();
  check('request 1 was served by alpha', state.seen.at(-1) === 'alpha', String(state.seen.at(-1)));
}

// ---------------------------------------------------------------------------
header('one seat 429s -> the NEXT request lands on the healthy peer');
// ---------------------------------------------------------------------------
{
  state.rateLimit.add('alpha');
  await ask();              // alpha 429s; its cool-down is recorded
  const before = state.seen.length;
  await ask();              // must not be alpha again

  const served = state.seen.slice(before);
  check('request 3 reached the codex lane at all', served.length > 0,
    'lane went cold — provider cool-down swallowed the pool');
  check('request 3 was served by bravo, not alpha',
    served.length > 0 && served.every((a) => a === 'bravo'), served.join(','));
  check('alpha was not re-probed while cooling',
    !served.includes('alpha'), served.join(','));
}

// ---------------------------------------------------------------------------
header('both seats 429 -> the lane cools and stops spending requests');
// ---------------------------------------------------------------------------
{
  state.rateLimit.add('bravo');
  await ask();                       // bravo 429s too; now every seat is cooling
  const before = state.seen.length;
  await ask();
  // With no seat askable the pool must answer without touching the upstream —
  // the single-seat fail-fast the provider cool-down was always for.
  check('a fully-cooled pool spends no further upstream requests',
    state.seen.length === before, `saw ${state.seen.slice(before).join(',')}`);
}

codexStub.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

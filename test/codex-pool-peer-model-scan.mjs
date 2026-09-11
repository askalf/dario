#!/usr/bin/env node
// Proxy-level proof that mid-flight failover SCANS PAST a peer that cannot
// serve the model, instead of giving up on the first incompatible candidate.
//
// Asked for in review of #1288. Seats do not all list the same models — a seat
// on a different ChatGPT plan publishes a different slug set — and the peer
// scan walks them alphabetically. The first version of this change tested only
// the alphabetically-next peer: if THAT one's cached slug list lacked the
// model, it set `codexPeer = null` and abandoned the retry, leaving a usable
// later seat untouched. With no Claude fallback configured that also collapses
// `deferOnUnavailable` to false, so the declining seat's 429 went straight to
// the client while a seat that could have served it sat idle.
//
// So the assertion is about OBSERVED TRAFFIC, same as
// codex-pool-seat-rotation.mjs: which seat's bearer token did the upstream see
// after the 429. Three seats, and the middle one is the trap.
//
// Hermetic: mkdtemp HOME with three codex seats, a local stub ChatGPT backend
// that answers /models PER SEAT, Anthropic via fetchImpl. No network, no real
// credentials.

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
// The model under test, and the one the middle seat lists INSTEAD of it.
const WANTED = 'gpt-5.6-sol';
const OTHER = 'gpt-5.6-terra';

// alpha and charlie can serve WANTED; bravo — which sorts between them, so it
// is the peer the scan reaches first — can only serve OTHER.
const SEAT_MODELS = { alpha: [WANTED], bravo: [OTHER], charlie: [WANTED] };

const state = { rateLimit: new Set(), seen: [] };
const bearerAlias = (req) => {
  const auth = req.headers['authorization'] || '';
  // Tokens are `codex-at-<alias>` below, so the seat is readable off the wire.
  const m = /codex-at-([a-z]+)/i.exec(auth);
  return m ? m[1] : null;
};

const codexStub = createServer((req, res) => {
  const alias = bearerAlias(req);
  if (req.url.startsWith('/models')) {
    // Per-seat catalog: this is the whole point — heterogeneous model
    // availability across the pool is what the scan has to cope with.
    const slugs = SEAT_MODELS[alias] ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: 'list' })) }));
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
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-peer-model-scan-'));
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
for (const alias of Object.keys(SEAT_MODELS)) {
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
  // If the scan works, the request never falls through to here.
  return new Response(JSON.stringify({ error: { message: 'claude fallback' } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const server = await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, fetchImpl: anthropicFetch,
});

const ask = async (model) => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 16,
      messages: [{ role: 'user', content: `peer scan probe ${Math.random()}` }],
    }),
  });
  await r.text().catch(() => '');
  return r.status;
};

// ---------------------------------------------------------------------------
header("warm bravo's model cache so the scan has something to skip ON");
// ---------------------------------------------------------------------------
{
  // The scan reads peekCodexModelSlugs — the CACHED list, never an upstream
  // call — and an unknown list deliberately still gets a try. So bravo has to
  // have been seen once for its incompatibility to be knowable at all. A pin
  // is the cheapest way to route one request at it; production warms the same
  // cache the first time a seat serves.
  process.env.DARIO_CODEX_ACCOUNT = 'bravo';
  const status = await ask(OTHER);
  delete process.env.DARIO_CODEX_ACCOUNT;
  check('the pinned seat served its own model', status === 200, String(status));
  check('bravo was the seat touched', state.seen.at(-1) === 'bravo', String(state.seen.at(-1)));
}

// ---------------------------------------------------------------------------
header('a 429 scans PAST the incompatible peer to a seat that can serve');
// ---------------------------------------------------------------------------
{
  // alpha is limited. bravo sorts next but cannot serve WANTED; charlie can.
  // Testing only the first candidate leaves codexPeer null here, so the retry
  // never happens and charlie is never asked.
  state.rateLimit.add('alpha');
  state.seen.length = 0;
  const status = await ask(WANTED);
  const touched = state.seen.slice();

  check('the client still got a 200', status === 200, String(status));
  check('the limited seat was tried first', touched[0] === 'alpha', touched.join(','));
  check('the incompatible peer was never sent the request', !touched.includes('bravo'), touched.join(','));
  check('the compatible later seat served it', touched.at(-1) === 'charlie', touched.join(','));
  check('exactly two seats were touched in ONE request', touched.length === 2, touched.join(','));
}

codexStub.close();
console.log(`
${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

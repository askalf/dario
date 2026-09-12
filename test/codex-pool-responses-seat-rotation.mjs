#!/usr/bin/env node
// Proxy-level proof that the NATIVE /v1/responses path rotates seats too.
//
// Asked for in review of #1288, and it was the last route still outside the
// pool. #1291 added a passthrough branch for Responses clients on a
// ChatGPT-subscription model, and the first version of this change left it
// sitting OUTSIDE the retry loop with this comment:
//
//     // No seat rotation on this path: forwardResponsesToCodex is a byte
//     // passthrough with no decline contract [...] A 429 here is written to
//     // the client as the backend sent it.
//
// True as written, and the wrong answer. A 429 on that branch called no
// decline hook, so noteCodexDecline never ran, so selection handed the SAME
// rate-limited seat back on the next request, forever. A healthy peer was
// never reached — the single-seat outage this whole change exists to remove,
// surviving on the one wire shape Codex CLI actually speaks.
//
// The fix gave forwardResponsesToCodex the same decline contract
// forwardToCodex has, and moved the branch inside the loop. This file holds
// both halves of that down:
//
//   1. mid-flight — a 429 on seat one is rescued by seat two inside the SAME
//      /v1/responses request;
//   2. the cool-down is real — the declined seat is skipped by the NEXT
//      request, which is the part that was silently broken.
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

// Which seat is told to 429, every bearer the upstream saw, and every path it
// was asked on — the last one proves the request really took the native
// passthrough rather than being translated through the Messages shape.
const state = { rateLimit: new Set(), seen: [], paths: [] };
const bearerAlias = (req) => {
  const auth = req.headers['authorization'] || '';
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
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.seen.push(alias);
      state.paths.push(req.url);
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
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-responses-rotation-'));
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
  // A ChatGPT-subscription model never routes here. If it does, the test is
  // measuring the wrong branch and should fail loudly rather than pass.
  return new Response(JSON.stringify({ error: { message: 'claude should not be reached' } }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });
};

const server = await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, noLiveCapture: true,
  fetchImpl: anthropicFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch { await sleep(100); }
}

// The Codex CLI request shape: native Responses, streaming, on a
// ChatGPT-subscription model. This is what takes the passthrough branch.
const ask = async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LISTED_SLUG, stream: true, store: false,
      instructions: 'You are a coding agent.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `responses rotation probe ${Math.random()}` }] }],
    }),
  });
  await r.text().catch(() => '');
  return r.status;
};

// Cool-downs are real (retry-after 120s) and persist across requests in this
// process, so the clean-pool case runs first.

// ---------------------------------------------------------------------------
header('a native /v1/responses request takes the codex passthrough');
// ---------------------------------------------------------------------------
{
  state.seen.length = 0; state.paths.length = 0;
  const status = await ask();
  check('the client got a 200', status === 200, String(status));
  check('served by alpha', state.seen.at(-1) === 'alpha', state.seen.join(','));
  check('it went to the backend /responses endpoint, not a translated path',
    state.paths.at(-1)?.startsWith('/responses'), String(state.paths.at(-1)));
}

// ---------------------------------------------------------------------------
header('MID-FLIGHT on the NATIVE path: alpha 429s, bravo rescues it');
// ---------------------------------------------------------------------------
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
header('the 429 actually COOLED the seat — the next request skips it');
// ---------------------------------------------------------------------------
// The half that was silently broken. Before the decline contract existed, this
// request went straight back to alpha: nothing on the native path ever called
// noteCodexDecline, so selection had no idea alpha was limited.
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
header('no peer left: the backend error reaches the client as sent');
// ---------------------------------------------------------------------------
// Putting the branch inside the loop must not change what a client sees when
// nothing can serve it. With no peer there is nothing to defer to, so the
// passthrough writes the upstream response through, as it always did.
{
  state.rateLimit.add('bravo');
  state.seen.length = 0;
  const status = await ask();
  check('bravo was asked and declined', state.seen.includes('bravo'), state.seen.join(','));
  check('the client got the upstream rate-limit status', status === 429, String(status));
}

codexStub.close();
server?.close?.();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

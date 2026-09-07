#!/usr/bin/env node
// dario#1260 — an effort suffix on a CODEX model name.
//
// dario#419 let a client that cannot set `output_config.effort` choose one by
// model name (`opus-4-8:high`, Cursor-style `claude-opus-4-8-high`). It only
// ever worked on the Claude half. Probed live 2026-09-07 against the ChatGPT
// plan:
//
//     claude-sonnet-5:high   -> 200, served claude-sonnet-5
//     gpt-5.6-terra:high     -> 400 model_unroutable
//
// because routing matches the model against each provider's list BEFORE the
// suffix is stripped, so the suffixed name matched nothing at all.
//
// The two strip sites in proxy.ts skip OpenAI-shaped names ON PURPOSE: an
// openai-compat backend may serve a model whose real id ends in `-high`, and a
// blind strip there would rewrite a legitimate name against a catalog dario
// cannot see. Codex is the one provider that publishes its routable set, so
// the fix is a THIRD site, after discovery, with the guard that makes it
// decidable: strip only when the name as written matches no slug and the
// stripped name matches one. That is the same as-written-wins rule
// resolveClaudeTarget already uses for chain entries (dario#1161).
//
// Asserted at the WIRE, not at the parser — the objection that made #1161's
// first revision inadequate. Every check below reads the body the codex stub
// actually received, so deleting the propagation fails the file.
//
// Hermetic: a real proxy on loopback, HOME in a mkdtemp'd dir with one pool
// seat and one codex account, a local codex stub that records request bodies.

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

const PROXY_PORT = await freePort();
const CHAIN_PROXY_PORT = await freePort();
const CODEX_PORT = await freePort();

const LISTED_SLUG = 'gpt-5.6-sol';
// A slug whose REAL name ends in an effort word. The account lists it, so it
// must be routed exactly as written and never re-read as `gpt-test` + `high`.
// Both spellings the suffix parser accepts are covered: this one is the
// hyphen form, which is the one that can collide with a real id.
const TRAP_SLUG = 'gpt-test-high';

// ── stub ChatGPT backend: discovery + a recorded /responses SSE ────────────
const codexSeen = { models: 0, responses: 0, bodies: [] };
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    codexSeen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      models: [
        { slug: LISTED_SLUG, visibility: 'list' },
        { slug: TRAP_SLUG, visibility: 'list' },
      ],
    }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    codexSeen.responses++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { codexSeen.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { codexSeen.bodies.push(null); }
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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-effort-suffix-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
delete process.env.ANTHROPIC_UPSTREAM_API_KEY;

await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({
  alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token',
  expiresAt: Date.now() + 6 * 3_600_000,
}));

const { startProxy } = await import('../dist/proxy.js');

// Anthropic seam. Nothing here SHOULD be reached by a codex-bound request; the
// call counter is asserted so a regression that quietly routes to the pool
// instead of the subscription is caught rather than passing as "a 200".
const anthropic = { calls: 0, rateLimit: false };
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (!target.includes('/v1/messages')) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  anthropic.calls++;
  // Armed only for the fallback-chain block below: the codex end of a chain is
  // reached from the mid-flight 429 recovery, so the pool has to be genuinely
  // out of capacity for that leg to run at all.
  if (anthropic.rateLimit) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'stub 429' } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'served by the claude pool' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const common = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl: fakeFetch };
await startProxy({ ...common, port: PROXY_PORT });
// A second proxy whose FALLBACK CHAIN carries the suffix, for the other half
// of the fix: the operator-configured spelling, not the client-sent one.
await startProxy({
  ...common, port: CHAIN_PROXY_PORT,
  poolFallbackModel: `${LISTED_SLUG}:low`,
});
for (const port of [PROXY_PORT, CHAIN_PROXY_PORT]) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
}

const post = async (port, model) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
};
const lastBody = () => codexSeen.bodies[codexSeen.bodies.length - 1];

// ---------------------------------------------------------------------------
header('a suffixed codex model routes to the subscription instead of 400ing');
{
  const before = anthropic.calls;
  const r = await post(PROXY_PORT, `${LISTED_SLUG}:low`);

  // The regression this file exists for: this exact request answered
  // 400 `model_unroutable` without ever reaching an upstream.
  check('the request is not refused locally', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('...and no model_unroutable verdict is attached',
    r.headers.get('x-dario-upstream-rejection') === null,
    String(r.headers.get('x-dario-upstream-rejection')));
  check('the subscription served it, not the Claude pool',
    codexSeen.responses === 1 && anthropic.calls === before,
    `codex=${codexSeen.responses} anthropic=${anthropic.calls - before}`);

  // THE WIRE. The suffix is a dario-side spelling; the backend 400s on a slug
  // it does not list, so it must not survive into the outbound request.
  check('the OUTBOUND model is the bare slug, suffix stripped',
    lastBody()?.model === LISTED_SLUG, String(lastBody()?.model));
  check('the OUTBOUND request carries the named reasoning effort',
    lastBody()?.reasoning?.effort === 'low', JSON.stringify(lastBody()?.reasoning));
}

// ---------------------------------------------------------------------------
header('the same slug WITHOUT a suffix is untouched');
{
  const r = await post(PROXY_PORT, LISTED_SLUG);
  check('still served by the subscription', r.status === 200 && codexSeen.responses === 2,
    `${r.status} codex=${codexSeen.responses}`);
  check('the model is unchanged', lastBody()?.model === LISTED_SLUG, String(lastBody()?.model));
  // No suffix and no thinking budget means dario forces nothing and the
  // backend default applies — the behaviour every existing caller has today.
  check('no effort is forced onto a request that named none',
    lastBody()?.reasoning?.effort === undefined, JSON.stringify(lastBody()?.reasoning));
}

// ---------------------------------------------------------------------------
header('a slug that really ends in an effort word is taken as written');
{
  // The guard's whole purpose. `gpt-test-high` IS the model. Re-reading it as
  // `gpt-test` + effort `high` would route the request to a different model
  // than the client named — silently, and with a plausible-looking 200.
  const r = await post(PROXY_PORT, TRAP_SLUG);
  check('served, not mangled', r.status === 200 && codexSeen.responses === 3,
    `${r.status} codex=${codexSeen.responses}`);
  check('the OUTBOUND model is the full slug, nothing stripped off it',
    lastBody()?.model === TRAP_SLUG, String(lastBody()?.model));
  check('...and no effort was invented from its name',
    lastBody()?.reasoning?.effort === undefined, JSON.stringify(lastBody()?.reasoning));
}

// ---------------------------------------------------------------------------
header('a suffix on a model NO provider lists is still refused (#1236 intact)');
{
  // The narrowness of the fix. Stripping must not turn model_unroutable into a
  // request spent against a slug the account does not have.
  const r = await post(PROXY_PORT, 'gpt-9.9-nope:high');
  check('refused locally with 400', r.status === 400, `${r.status} ${r.text.slice(0, 160)}`);
  check('...with the machine-readable verdict',
    r.headers.get('x-dario-upstream-rejection') === 'model_unroutable',
    String(r.headers.get('x-dario-upstream-rejection')));
  check('and no upstream request was spent on it', codexSeen.responses === 3,
    `codex=${codexSeen.responses}`);
}

// ---------------------------------------------------------------------------
header('a FALLBACK CHAIN entry may carry the suffix too');
{
  // The operator's half (mirror of dario#1161 on the Claude side). Before this
  // the entry matched no slug, so it was skipped in silence and the failover
  // the operator configured simply never fired.
  const seenBefore = codexSeen.responses;
  anthropic.rateLimit = true;
  const r = await post(CHAIN_PROXY_PORT, 'claude-sonnet-5');
  anthropic.rateLimit = false;
  check('the chain entry was selected at all', codexSeen.responses === seenBefore + 1,
    `codex=${codexSeen.responses} status=${r.status}`);
  check('the substituted model is the bare slug', lastBody()?.model === LISTED_SLUG,
    String(lastBody()?.model));
  check("...at the entry's own effort, not the backend default",
    lastBody()?.reasoning?.effort === 'low', JSON.stringify(lastBody()?.reasoning));
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// dario#1236 — a model NO provider lists is refused locally with 400 and
// `x-dario-upstream-rejection: model_unroutable`, in the endpoint's own wire
// shape, without spending a pool request. Before this the Claude adapter's
// unconditional default claim forwarded `gpt-5.6-terra` (a slug the Codex
// account does not list) to api.anthropic.com verbatim, and the client got
// Anthropic's 404 `model: gpt-5.6-terra` attributed to whichever seat sent it.
//
// The refusal is narrow on purpose, and every exemption is asserted here:
// servable names in each spelling still reach the pool (canonical, family
// shorthand, `[1m]`, `claude:` prefix, dated id, operator alias); a listed
// codex slug still reaches the subscription; an OpenAI-shape name the legacy
// OPENAI_MODEL_MAP translates is still served; a `claude-*` name the catalog
// does not know is still forwarded (Anthropic's 404 is authoritative there —
// the live catalog can lag a brand-new model); and a proxy in upstream API-key
// mode or under a server-wide --model override refuses nothing.
//
// Hermetic: real proxies on loopback, HOME in a mkdtemp'd dir with one pool
// seat and one codex account, a local codex stub, fetchImpl for Anthropic.

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

// Kernel-assigned so no other process or test file can hold it (helpers/free-port.mjs).
const PROXY_PORT = await freePort();
const BYPASS_POOL_PROXY_PORT = await freePort();
const OVERRIDE_PROXY_PORT = await freePort();
const CODEX_PORT = await freePort();

const LISTED_SLUG = 'gpt-5.6-sol';
const UNLISTED_SLUG = 'gpt-5.6-terra';

// ── stub ChatGPT backend: /models discovery + /responses SSE ───────────────
const codexSeen = { models: 0, responses: 0 };
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    codexSeen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    codexSeen.responses++;
    req.on('data', () => {});
    req.on('end', () => {
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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-unroutable-'));
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
  alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000,
}));

const { startProxy } = await import('../dist/proxy.js');

// ── fake Anthropic: a catalog, a 200 for known models, Anthropic's own 404 otherwise ──
const CATALOG = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8'];
const anthropic = { calls: 0, models: [] };
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: CATALOG.map((id) => ({ id, type: 'model' })) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (!target.includes('/v1/messages')) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  anthropic.calls++;
  let model = '?';
  try {
    // dario hands fetch a Buffer (or a stream), not a string.
    const raw = typeof init?.body === 'string' ? init.body : await new Response(init?.body ?? '').text();
    model = JSON.parse(raw || '{}').model ?? '?';
  } catch { /* keep ? — the checks below report it */ }
  anthropic.models.push(model);
  const known = CATALOG.includes(model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, ''));
  if (!known) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${model}` } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: `served as ${model}` }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const common = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl: fakeFetch };
await startProxy({ ...common, port: PROXY_PORT, modelAliases: { 'my-fast': 'claude-haiku-4-5' } });
await startProxy({ ...common, port: BYPASS_POOL_PROXY_PORT, upstreamApiKey: 'sk-ant-test-key' });
await startProxy({ ...common, port: OVERRIDE_PROXY_PORT, model: 'claude-haiku-4-5' });
for (const port of [PROXY_PORT, BYPASS_POOL_PROXY_PORT, OVERRIDE_PROXY_PORT]) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
}

const post = async (port, path, model) => {
  const isOpenAI = path === '/v1/chat/completions';
  const body = isOpenAI
    ? { model, messages: [{ role: 'user', content: 'ping' }] }
    : { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* the checks report it */ }
  return { status: res.status, marker: res.headers.get('x-dario-upstream-rejection'), json, text };
};

header('refused locally: a model no provider lists, on both wire shapes');
{
  const before = { anthropic: anthropic.calls, codex: codexSeen.responses };
  const a = await post(PROXY_PORT, '/v1/messages', UNLISTED_SLUG);
  check('/v1/messages → 400', a.status === 400, `${a.status} ${a.text.slice(0, 200)}`);
  check('marker header names the verdict', a.marker === 'model_unroutable', String(a.marker));
  check('Anthropic wire shape: {type:"error", error:{type, message}}',
    a.json?.type === 'error' && a.json?.error?.type === 'invalid_request_error' && typeof a.json?.error?.message === 'string', a.text.slice(0, 200));
  check('message names the model and what was consulted',
    (a.json?.error?.message ?? '').includes(UNLISTED_SLUG) && /codex account live \(1 listed slug\)/.test(a.json?.error?.message ?? ''), a.json?.error?.message);

  const o = await post(PROXY_PORT, '/v1/chat/completions', UNLISTED_SLUG);
  check('/v1/chat/completions → 400', o.status === 400, `${o.status} ${o.text.slice(0, 200)}`);
  check('OpenAI wire shape: {error:{message, type, param:"model", code}}',
    typeof o.json?.error?.message === 'string' && o.json?.error?.param === 'model' && o.json?.error?.code === 'model_not_found', o.text.slice(0, 200));
  check('marker header on the OpenAI shape too', o.marker === 'model_unroutable', String(o.marker));

  const t = await post(PROXY_PORT, '/v1/messages', 'gtp-5.6-sol');
  check('a typo that belongs to no family is refused too', t.status === 400 && t.marker === 'model_unroutable', `${t.status} ${t.marker}`);

  check('no pool request was spent', anthropic.calls === before.anthropic, `calls ${before.anthropic} → ${anthropic.calls}`);
  check('the subscription was not asked either', codexSeen.responses === before.codex, `responses ${before.codex} → ${codexSeen.responses}`);
}

header('still served: every servable spelling reaches the pool as the right id');
{
  const cases = [
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude:opus', 'claude-opus-5'],
    // `[1m]` is a client-side label: the Claude path strips it and rides the
    // context-1m beta instead, so the pool sees the base id.
    ['claude:sonnet1m', 'claude-sonnet-5'],
    ['anthropic:claude-opus-4-8', 'claude-opus-4-8'],
    ['claude-opus-4-8-20260101', 'claude-opus-4-8-20260101'],
    ['my-fast', 'claude-haiku-4-5'],
  ];
  for (const [asked, forwarded] of cases) {
    const before = anthropic.calls;
    const r = await post(PROXY_PORT, '/v1/messages', asked);
    check(`${asked} → 200`, r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    check(`${asked} reached the pool as ${forwarded}`,
      anthropic.calls === before + 1 && anthropic.models[anthropic.models.length - 1] === forwarded,
      `calls ${before}→${anthropic.calls} last=${anthropic.models[anthropic.models.length - 1]}`);
  }
  // A bare family shorthand in the body (`opus`, no prefix) is servable by the
  // resolver, so it is NOT refused — and, as before this change, the Claude
  // path forwards it as written (only the `claude:` prefix and --model resolve
  // shorthands). That gap is pre-existing and out of scope here; this pins
  // that the refusal does not touch it either way.
  for (const asked of ['opus', 'sonnet1m']) {
    const before = anthropic.calls;
    const r = await post(PROXY_PORT, '/v1/messages', asked);
    check(`${asked} (bare shorthand) is not refused — forwarded for upstream to answer`,
      r.marker !== 'model_unroutable' && anthropic.calls === before + 1 && anthropic.models[anthropic.models.length - 1] === asked,
      `${r.status} ${r.marker} calls ${before}→${anthropic.calls} last=${anthropic.models[anthropic.models.length - 1]}`);
  }
}

header('still served: a listed codex slug, and an OpenAI-shape name the legacy map translates');
{
  const before = { anthropic: anthropic.calls, codex: codexSeen.responses };
  const c = await post(PROXY_PORT, '/v1/chat/completions', LISTED_SLUG);
  check(`${LISTED_SLUG} → 200 from the subscription`, c.status === 200 && c.text.includes('hi from codex'), `${c.status} ${c.text.slice(0, 160)}`);
  check('codex stub answered it', codexSeen.responses === before.codex + 1, `${before.codex}→${codexSeen.responses}`);
  const m = await post(PROXY_PORT, '/v1/chat/completions', 'gpt-5.4');
  check('gpt-5.4 on chat/completions → OPENAI_MODEL_MAP → the pool (200)', m.status === 200, `${m.status} ${m.text.slice(0, 160)}`);
  check('…forwarded as claude-opus-4-8', anthropic.models[anthropic.models.length - 1] === 'claude-opus-4-8', anthropic.models[anthropic.models.length - 1]);
}

header('still forwarded: a claude-* name the catalog does not know — Anthropic answers');
{
  const before = anthropic.calls;
  const r = await post(PROXY_PORT, '/v1/messages', 'claude-sonnet-6');
  check('forwarded, not refused locally', anthropic.calls === before + 1, `calls ${before}→${anthropic.calls}`);
  check('the upstream 404 comes back as the answer', r.status === 404 && r.marker !== 'model_unroutable', `${r.status} ${r.marker} ${r.text.slice(0, 120)}`);
}

header('exempt: upstream API-key mode and a server-wide --model override refuse nothing');
{
  const before = anthropic.calls;
  const k = await post(BYPASS_POOL_PROXY_PORT, '/v1/messages', UNLISTED_SLUG);
  check('api-key mode forwards the unlisted name (upstream decides)', anthropic.calls === before + 1 && k.marker !== 'model_unroutable', `calls ${before}→${anthropic.calls} ${k.status} ${k.marker}`);
  const o = await post(OVERRIDE_PROXY_PORT, '/v1/messages', UNLISTED_SLUG);
  check('--model override serves it as the override', o.status === 200 && anthropic.models[anthropic.models.length - 1] === 'claude-haiku-4-5', `${o.status} last=${anthropic.models[anthropic.models.length - 1]}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

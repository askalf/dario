#!/usr/bin/env node
// Proxy-level proof that the ChatGPT pool reads each seat's utilisation and
// places NEW conversations by it.
//
// Before this, a second ChatGPT seat served nothing until the first one
// 429'd: selection was alphabetical fill-first because the code believed the
// backend "states nothing until it 429s". It states plenty — x-codex-* on
// every Responses answer, and GET /backend-api/wham/usage for a seat nobody
// has asked yet. This file drives a real proxy against a stub backend that
// speaks both, and checks four things end to end:
//
//   1. boot: with polling on, /codex shows each seat's usage before any
//      request, read from /wham/usage (no model call);
//   2. every answer's headers update the reading /codex reports;
//   3. a NEW conversation goes to the seat with the most headroom;
//   4. a conversation already bound to a seat stays there (its prompt cache
//      lives on that account), however the readings move.
//
// Hermetic: mkdtemp HOME, two codex seats with JWT-shaped placeholder tokens,
// a local stub, the Claude upstream via fetchImpl. No network.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODEX_PORT = await freePort();
const PROXY_PORT = await freePort();
const LISTED_SLUG = 'gpt-5.6-sol';
const jwt = (alias) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ seat: alias })).toString('base64url')}.sig`;
const aliasOfAuth = (auth) => {
  const part = String(auth || '').replace(/^Bearer /, '').split('.')[1];
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).seat; } catch { return null; }
};

// What each seat reports: the stub answers /wham/usage and stamps every
// /responses answer with the seat's current x-codex-* numbers.
const used = { alpha: 70, bravo: 20 };
const state = { served: [], usageReads: [] };
const weekAhead = () => Math.floor(Date.now() / 1000) + 5 * 86_400;

const codexStub = createServer((req, res) => {
  const alias = aliasOfAuth(req.headers['authorization']);
  if (req.url.startsWith('/backend-api/codex/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url === '/backend-api/wham/usage') {
    state.usageReads.push(alias);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ plan_type: 'prolite', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: used[alias], limit_window_seconds: 604800, reset_at: weekAhead() }, secondary_window: null } }));
    return;
  }
  if (req.url.startsWith('/backend-api/codex/responses')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.served.push(alias);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-codex-primary-used-percent': String(used[alias]),
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': String(weekAhead()),
      });
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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-usage-proxy-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}/backend-api/codex`;
process.env.DARIO_CODEX_USAGE_POLL_MS = '600000'; // on for this file: boot reads each seat once
delete process.env.DARIO_CODEX_ACCOUNT;
delete process.env.DARIO_POOL_STRATEGY;

const SIX_HOURS = Date.now() + 6 * 3_600_000;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-at', refreshToken: 'claude-rt',
  expiresAt: SIX_HOURS, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
for (const alias of ['alpha', 'bravo']) {
  await writeFile(join(tmpHome, '.dario', 'codex-accounts', `${alias}.json`), JSON.stringify({
    alias, accessToken: jwt(alias), refreshToken: `codex-rt-${alias}`, expiresAt: SIX_HOURS,
  }));
}

const { startProxy } = await import('../dist/proxy.js');
const anthropicFetch = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: { message: 'claude should not be reached' } }), { status: 500, headers: { 'content-type': 'application/json' } });
};
const server = await startProxy({ port: PROXY_PORT, host: '127.0.0.1', verbose: false, passthrough: false, noLiveCapture: true, fetchImpl: anthropicFetch });
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch { await sleep(100); }
}

const codexView = async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/codex`);
  const j = await r.json();
  return Object.fromEntries(j.accounts.map((a) => [a.alias, a]));
};
const ask = async (conversation) => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LISTED_SLUG, stream: true, store: false, instructions: 'You are a coding agent.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `usage probe, conversation ${conversation}` }] }],
    }),
  });
  await r.text().catch(() => '');
  return { status: r.status, seat: state.served.at(-1) };
};

// ---------------------------------------------------------------------------
header('boot: each seat is read from /wham/usage before any request');
// ---------------------------------------------------------------------------
{
  let view = null;
  for (let i = 0; i < 30; i++) {
    view = await codexView();
    if (view.alpha?.usage && view.bravo?.usage) break;
    await sleep(100);
  }
  check('both seats were read once at boot', state.usageReads.slice().sort().join(',') === 'alpha,bravo', state.usageReads.join(','));
  check('/codex reports alpha at 70% from /wham/usage', view.alpha?.usage?.windows?.[0]?.usedPercent === 70 && view.alpha.usage.source === 'usage-endpoint', JSON.stringify(view.alpha?.usage));
  check('/codex reports bravo headroom 0.8', Math.abs((view.bravo?.usage?.headroom ?? -1) - 0.8) < 1e-9, JSON.stringify(view.bravo?.usage));
  check('no model call was spent to learn it', state.served.length === 0, state.served.join(','));
  check('the /codex payload carries no token', !/eyJhbGciOiJub25lIn0|codex-rt-/.test(JSON.stringify(view)));
}

// ---------------------------------------------------------------------------
header('placement: a new conversation goes to the seat with the most headroom');
// ---------------------------------------------------------------------------
{
  const a = await ask('one');
  check('served 200', a.status === 200, String(a.status));
  check('bravo (80% headroom) took it, not the alphabetically-first alpha (30%)', a.seat === 'bravo', a.seat);
}

// ---------------------------------------------------------------------------
header('every answer updates the reading');
// ---------------------------------------------------------------------------
{
  used.bravo = 95;
  const b = await ask('one');
  check('conversation one stays on bravo (bound)', b.seat === 'bravo', b.seat);
  const view = await codexView();
  check('/codex now shows bravo at 95%, from its last answer', view.bravo?.usage?.windows?.[0]?.usedPercent === 95 && view.bravo.usage.source === 'headers', JSON.stringify(view.bravo?.usage));
}

// ---------------------------------------------------------------------------
header('the next NEW conversation follows the new readings; the bound one does not move');
// ---------------------------------------------------------------------------
{
  const c = await ask('two');
  check('conversation two lands on alpha (30% headroom beats bravo\'s 5%)', c.seat === 'alpha', c.seat);
  const d = await ask('one');
  check('conversation one is still bravo — placement never moves a bound conversation', d.seat === 'bravo', d.seat);
}

server?.close?.();
await new Promise((r) => codexStub.close(r));
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

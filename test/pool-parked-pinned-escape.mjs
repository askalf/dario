#!/usr/bin/env node
// dario#1282 — the only way out of a parked pool, and what it costs.
//
// THE REPORT. With every seat inside a live 5h window the proxy answers 429
// locally (dario#1244 / 6.0.35) and nothing is sent upstream. An operator whose
// account has extra usage available asked how to let a request reach it, and
// read the code correctly: `POOL_PARKED` decides from the seats' own rate-limit
// verdicts BEFORE any call, while the overage-guard is reactive — it reads the
// `representative-claim` on a response that already came back. Neither knob
// unlocks the other, so `DARIO_OVERAGE_GUARD=off` does not change the parked
// answer.
//
// WHAT IS ACTUALLY TRUE. A seat pin is assigned at proxy.ts `poolAccount =
// pinnedAccount` BEFORE `parkedUntil` is consulted, so a pinned request is the
// documented escape: it goes upstream and the real status comes back. This
// file pins that down, and pins down the two consequences that make it a
// deliberate choice rather than a free probe:
//
//   1. the default guard HALTS the proxy the moment that response bills to
//      anything but the subscription — 503 for everyone after it, pinned or not
//   2. a successful pinned response UN-PARKS the seat for ordinary traffic,
//      because its snapshot replaces the rejection
//
// Both are asserted here so neither can regress into a surprise.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One proxy, two seats, both parked on a live window. `guard` picks the
 * overage-guard behaviour under test. Returns the handles the assertions need.
 */
async function scenario(guard) {
  const PORT = await freePort();
  const ADMIN_TOKEN = 'parked-pin-admin-token';
  const tmpHome = await mkdtemp(join(tmpdir(), 'dario-parked-pin-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.DARIO_ADMIN = '1';
  process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.DARIO_API_KEY;
  delete process.env.DARIO_CODEX_BASE_URL;
  delete process.env.DARIO_POOL_FALLBACK;

  await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
  const seat = (alias, token) => JSON.stringify({
    alias, accessToken: token, refreshToken: `${token}-refresh`,
    expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
    deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
  });
  await writeFile(join(tmpHome, '.dario', 'accounts', 'one.json'), seat('one', 'one-token'));
  await writeFile(join(tmpHome, '.dario', 'accounts', 'two.json'), seat('two', 'two-token'));

  const resetS = Math.floor(Date.now() / 1000) + 40 * 60;
  const state = { mode: '429', calls: [] };

  // After the pool parks, `mode` flips to '200': the stand-in for an account
  // whose extra usage absorbs the request. A locally synthesised verdict can
  // never see it; only a request that actually leaves can.
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const h = init?.headers;
    const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
    const bearer = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1])
      .replace(/^Bearer\s+/i, '');
    state.calls.push(bearer);
    if (state.mode === '200') {
      return new Response(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'served from extra usage' }],
        model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2 },
      }), { status: 200, headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-representative-claim': 'overage',
        'anthropic-organization-id': 'org-1',
      } });
    }
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }),
      { status: 429, headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': String(resetS),
        'anthropic-organization-id': 'org-1',
      } });
  };

  const log = [];
  for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

  const { startProxy } = await import('../dist/proxy.js');
  const guardOpts = guard === 'warn' ? { overageGuardBehavior: 'warn' }
    : guard === 'off' ? { overageGuardEnabled: false }
      : {};
  await startProxy({
    host: '127.0.0.1', port: PORT, passthrough: false, verbose: false,
    noLiveCapture: true, fetchImpl, ...guardOpts,
  });
  const BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

  const post = (extra = {}) => fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 16,
      messages: [{ role: 'user', content: `c ${Math.random()}` }],
    }),
  });
  const seatOne = async () =>
    (await (await fetch(`${BASE}/accounts`)).json()).accounts.find((a) => a.alias === 'one');

  // Park the pool: the first request tries both seats and both 429.
  const first = await post(); await first.text();
  return { state, post, seatOne, log, ADMIN_TOKEN, first };
}

// ── default guard: the pin gets out, and the answer costs the proxy ─────
{
  const { state, post, seatOne, ADMIN_TOKEN, first } = await scenario('default');

  header('the pool parks, and an ordinary request is answered locally');
  check('the first request 429s after trying both seats', first.status === 429 && new Set(state.calls).size === 2,
    `${first.status} / ${state.calls.join(',')}`);
  {
    const before = state.calls.length;
    const r = await post();
    const body = await r.text();
    check('ordinary request: 429', r.status === 429, r.status);
    check('ordinary request: marker pool_parked',
      r.headers.get('x-dario-upstream-rejection') === 'pool_parked', r.headers.get('x-dario-upstream-rejection'));
    check('ordinary request: nothing sent upstream', state.calls.length === before, `${state.calls.length - before}`);
    check('ordinary request: the body says so', body.includes('Nothing was sent upstream'), body.slice(0, 100));
  }

  header('a PINNED request is assigned its seat before the parked check — it goes upstream');
  state.mode = '200';
  {
    const before = state.calls.length;
    const r = await post({ 'x-dario-account': 'one', 'x-dario-admin-token': ADMIN_TOKEN });
    const body = await r.text();
    check('exactly one upstream call', state.calls.length === before + 1, `${state.calls.length - before}`);
    check('on the pinned seat', state.calls[state.calls.length - 1] === 'one-token', state.calls[state.calls.length - 1]);
    check('the client gets the REAL upstream status, not a synthesised 429', r.status === 200, r.status);
    check('and the real body', body.includes('served from extra usage'), body.slice(0, 120));
    check('no pool_parked marker on it', r.headers.get('x-dario-upstream-rejection') === null,
      r.headers.get('x-dario-upstream-rejection'));
  }

  header('consequence 1: the successful response UN-PARKS the seat');
  {
    const one = await seatOne();
    check('seat one has left `rejected`', one.status !== 'rejected', one.status);
    check('and its action is no longer wait', one.action !== 'wait', one.action);
  }

  header('consequence 2: the default guard HALTS the proxy behind it');
  {
    const before = state.calls.length;
    const r = await post();
    const body = await r.text();
    check('the next ORDINARY request is 503, not 200', r.status === 503, r.status);
    check('and it names the guard', body.includes('dario_overage_guard'), body.slice(0, 120));
    check('nothing was sent upstream for it', state.calls.length === before, `${state.calls.length - before}`);
  }
}

// ── guard disarmed: the same probe, survivable ──────────────────────────
for (const mode of ['warn', 'off']) {
  const { state, post, ADMIN_TOKEN } = await scenario(mode);
  header(`with the guard ${mode}, the pin is usable: no halt behind it`);
  state.mode = '200';
  {
    const r = await post({ 'x-dario-account': 'one', 'x-dario-admin-token': ADMIN_TOKEN });
    await r.text();
    check(`pinned request still reaches upstream (${mode})`, r.status === 200, r.status);
  }
  {
    const before = state.calls.length;
    const r = await post();
    await r.text();
    check(`the next ordinary request is NOT 503 (${mode})`, r.status !== 503, r.status);
    check(`and it reaches upstream on the un-parked seat (${mode})`,
      state.calls.length === before + 1, `${state.calls.length - before}`);
  }
}

out(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

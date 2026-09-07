#!/usr/bin/env node
// Shared pool state, end to end: two real proxies in one process, one stub
// of the refresh-lock service's pool endpoints, the same three seats.
//
// A takes a 429 on `busy` → B parks `busy` without ever calling upstream on
// it. A binds a conversation to `idle` → the same conversation on B lands on
// `idle` although B's own headroom would have picked `calm`. The service
// going away costs nothing but a log line.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';
import { startPoolStateStub } from './helpers/pool-state-stub.mjs';
import { computeStickyKey } from '../dist/pool.js';

const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-shared-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_ADMIN;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
const seat = (alias, token) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
});
for (const a of ['busy', 'calm', 'idle']) await writeFile(join(accountsDir, `${a}.json`), seat(a, `${a}-token`));

const stub = await startPoolStateStub({ token: 'shared-tok' });
process.env.DARIO_REFRESH_LOCK_URL = stub.url;
process.env.DARIO_REFRESH_LOCK_TOKEN = 'shared-tok';

const nowS = Math.floor(Date.now() / 1000);
const RESET = { 'busy-token': nowS + 37 * 60, 'calm-token': nowS + 50 * 60, 'idle-token': nowS + 60 * 60 };
const unified = (status, util5h, reset) => ({
  'content-type': 'application/json',
  'anthropic-ratelimit-unified-status': status,
  'anthropic-ratelimit-unified-5h-utilization': String(util5h),
  'anthropic-ratelimit-unified-7d-utilization': '0.10',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(reset),
});
// Each proxy gets its own upstream so the test can tell who called what, and
// so B can read `idle` busier than A does (the divergence the sticky check needs).
const makeFetch = (tag, utils) => {
  const calls = [];
  const impl = async (url, init) => {
    if (String(url).includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const h = init?.headers;
    const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
    const auth = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]);
    const bearer = auth.replace(/^Bearer\s+/i, '');
    calls.push(bearer);
    if (bearer === 'busy-token') {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), { status: 429, headers: unified('rejected', 1.04, RESET[bearer]) });
    }
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      content: [{ type: 'text', text: `PONG from ${tag}` }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: unified('allowed', utils[bearer] ?? 0.05, RESET[bearer]) });
  };
  return { impl, calls };
};
const upA = makeFetch('A', { 'calm-token': 0.30, 'idle-token': 0.05 });
const upB = makeFetch('B', { 'calm-token': 0.30, 'idle-token': 0.60 });

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

const { startProxy } = await import('../dist/proxy.js');
const PA = await freePort();
const PB = await freePort();
// A never pulls during the test (long interval): its readings stay its own.
await startProxy({ host: '127.0.0.1', port: PA, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl: upA.impl, pacingMinMs: 0, pacingJitterMs: 0, poolSharedState: true, poolSharedStateIntervalMs: 60_000 });
await startProxy({ host: '127.0.0.1', port: PB, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl: upB.impl, pacingMinMs: 0, pacingJitterMs: 0, poolSharedState: true, poolSharedStateIntervalMs: 200 });
for (const p of [PA, PB]) for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${p}/health`); break; } catch { await sleep(100); } }

const messages = (port, content) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const accounts = async (port) => (await (await fetch(`http://127.0.0.1:${port}/accounts`)).json());
const seatOf = (body, alias) => body.accounts.find((a) => a.alias === alias);

header('both instances announce shared state');
{
  const a = await accounts(PA);
  const b = await accounts(PB);
  check('A and B carry sharedState with distinct instance ids', a.sharedState?.enabled === true && b.sharedState?.enabled === true && a.sharedState.instance !== b.sharedState.instance, JSON.stringify([a.sharedState, b.sharedState]));
  check('the banner names the service', log.some((l) => /Pool shared state: on .*instance/.test(l)), log.filter((l) => l.includes('shared state')).join(' | '));
}

const A_ID = (await accounts(PA)).sharedState.instance;

header('a 429 taken on A parks the seat on B, which never calls upstream on it');
{
  for (let i = 0; i < 4 && !upA.calls.includes('busy-token'); i++) {
    const r = await messages(PA, `conversation ${i} ${Math.random()}`);
    await r.text();
  }
  check('A tried busy once and failed over', upA.calls.filter((b) => b === 'busy-token').length === 1, upA.calls.join(','));
  let busyOnB = null;
  for (let i = 0; i < 30; i++) {
    busyOnB = seatOf(await accounts(PB), 'busy');
    if (busyOnB?.status === 'rejected') break;
    await sleep(100);
  }
  check('B shows busy rejected', busyOnB?.status === 'rejected', JSON.stringify(busyOnB));
  check('B says whose reading it is', busyOnB?.readingFrom === A_ID, busyOnB?.readingFrom);
  check('B counts no 429 of its own', busyOnB?.rejectedCount === 0 && busyOnB?.requestCount === 0);
  check('B carries A\'s numbers', busyOnB?.util5h === 1.04 && busyOnB?.resetAt === RESET['busy-token'] * 1000);
  check('B never called upstream on busy', !upB.calls.includes('busy-token'));
  check('B\'s sharedState counts the adoption', (await accounts(PB)).sharedState.adopted >= 1);
  check('B logged the peer parking once', log.filter((l) => /parked by peer/.test(l)).length === 1, log.filter((l) => /parked/.test(l)).join(' | '));
}

header('a conversation bound on A lands on the same seat on B');
{
  // B reads idle busier than A does, so B's own pick for a new conversation
  // is calm; a shared binding must override that.
  let r = await messages(PB, `warm up B ${Math.random()}`); await r.text();
  const b0 = await accounts(PB);
  check('B\'s own reading of idle is the busier one', seatOf(b0, 'idle')?.util5h === 0.60 && seatOf(b0, 'idle')?.readingFrom === null, JSON.stringify(seatOf(b0, 'idle')));
  check('so B on its own would pick calm', seatOf(b0, 'calm')?.util5h === 0.30 && b0.bestAccount === 'calm', b0.bestAccount);

  const conversation = 'team standup notes for monday';
  const before = upA.calls.length;
  r = await messages(PA, conversation); await r.text();
  const boundTo = upA.calls[before];
  check('A served it on idle (its most headroom)', boundTo === 'idle-token', boundTo);
  await sleep(150);
  const key = computeStickyKey(conversation);
  check('A published the binding for this conversation', stub.sticky.get(key)?.alias === 'idle', JSON.stringify([...stub.sticky.entries()]));

  const beforeB = upB.calls.length;
  r = await messages(PB, conversation); await r.text();
  check('B looked this conversation up', stub.calls.some((c) => c.path === `/pool/sticky/${key}/get`));
  check('B served it on idle, not calm', upB.calls[beforeB] === 'idle-token', upB.calls[beforeB]);
  const b1 = await accounts(PB);
  check('B now holds the binding and counts the adoption', b1.stickyBindings >= 1 && b1.sharedState.stickyAdopted === 1, JSON.stringify(b1.sharedState));
}

header('a failover rebinding is published too');
{
  // A new conversation on A that lands on busy? busy is parked — so send one
  // that lands on calm, then confirm the bind call carried calm.
  const bindsBefore = stub.calls.filter((c) => c.path.endsWith('/bind')).length;
  const r = await messages(PA, `another conversation ${Math.random()}`); await r.text();
  await sleep(150);
  check('every new binding on A reaches the service', stub.calls.filter((c) => c.path.endsWith('/bind')).length > bindsBefore);
}

header('the service going away costs nothing but a line');
{
  stub.down();
  await sleep(450);                                   // B's interval pulls fail
  const r = await messages(PB, `during the outage ${Math.random()}`);
  await r.text();
  check('B still serves', r.status === 200, r.status);
  const b = await accounts(PB);
  check('B counts the errors and keeps its state', b.sharedState.errors > 0 && seatOf(b, 'busy')?.status === 'rejected', JSON.stringify(b.sharedState));
  check('one "unreachable" line', log.filter((l) => l.includes('pool shared state') && l.includes('unreachable')).length >= 1);
  stub.up();
  await sleep(450);
  check('and recovers on its own', log.some((l) => l.includes('reachable again')), log.filter((l) => l.includes('shared state')).join(' | '));
}

await stub.close();
out(`\npool-shared-state-proxy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

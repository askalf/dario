#!/usr/bin/env node
// dario#1244 follow-up — consumers, end to end through the real proxy.
//
// A pool shared by a team: requests name their consumer with
// `x-dario-consumer`, or dario derives one from the body's user id. Asserts
// that /analytics attributes per consumer, that the log file carries the
// name, and that `--max-concurrent-per-consumer` makes a heavy consumer wait
// while another one's request goes straight through.

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
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

const PORT = await freePort();
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-consumer-'));
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
await writeFile(join(accountsDir, 'one.json'), seat('one', 'one-token'));
await writeFile(join(accountsDir, 'two.json'), seat('two', 'two-token'));
const logFile = join(tmpHome, 'proxy.log');

// Every upstream call is held until the test releases it, so concurrency is
// observable: `inflight` counts calls that have started and not finished.
let holdMs = 0;
let inflight = 0;
let peakInflight = 0;
const started = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const auth = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]);
  inflight++; peakInflight = Math.max(peakInflight, inflight);
  started.push({ at: Date.now(), bearer: auth.replace(/^Bearer\s+/i, '') });
  if (holdMs > 0) await sleep(holdMs);
  inflight--;
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

const { startProxy } = await import('../dist/proxy.js');
await startProxy({
  host: '127.0.0.1', port: PORT, passthrough: false, verbose: true, noLiveCapture: true, fetchImpl,
  maxConcurrent: 8, maxQueued: 32, queueTimeoutMs: 10_000, maxConcurrentPerConsumer: 1, logFile,
  // No outbound pacing: the timings below measure the queue, not the pacer.
  pacingMinMs: 0, pacingJitterMs: 0,
});
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (content, headers = {}, extraBody = {}) => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }], ...extraBody }),
});
const analytics = async () => (await (await fetch(`${BASE}/analytics`)).json());

header('attribution: header, body fallback, and none');
{
  let r = await messages('hi from alice', { 'x-dario-consumer': 'alice' }); await r.text();
  check('alice served', r.status === 200);
  r = await messages('hi from alice again', { 'x-dario-consumer': 'alice' }); await r.text();
  r = await messages('hi from bob', { 'x-dario-consumer': 'bob' }); await r.text();
  // No header: a Claude Code style metadata.user_id is hashed, session dropped.
  const cc = (s) => ({ metadata: { user_id: `user_3f9a1c_account_7c1e2b3a-0000-4000-8000-000000000001_session_${s}` } });
  r = await messages('cc turn 1', {}, cc('11111111-1111-4111-8111-111111111111')); await r.text();
  r = await messages('cc turn 2', {}, cc('22222222-2222-4222-8222-222222222222')); await r.text();
  // Neither: unattributed.
  r = await messages('anonymous', {}); await r.text();

  const a = await analytics();
  check('perConsumer present', a.perConsumer && typeof a.perConsumer === 'object');
  check('alice: 2 requests, tokens summed', a.perConsumer.alice?.requests === 2 && a.perConsumer.alice?.inputTokens === 80, JSON.stringify(a.perConsumer.alice));
  check('bob: 1 request', a.perConsumer.bob?.requests === 1);
  const hashed = Object.keys(a.perConsumer).filter((k) => k.startsWith('u_'));
  check('the two Claude Code sessions are ONE hashed consumer', hashed.length === 1 && a.perConsumer[hashed[0]].requests === 2, JSON.stringify(hashed));
  check('no raw account id leaked as a key', !Object.keys(a.perConsumer).some((k) => k.includes('7c1e2b3a')));
  check('the anonymous request is in no consumer bucket', Object.values(a.perConsumer).reduce((s, c) => s + c.requests, 0) === 5);
  check('per-account totals still count everything', Object.values(a.perAccount).reduce((s, c) => s + c.requests, 0) === 6, JSON.stringify(a.perAccount));
  check('the seats a consumer landed on are listed', Array.isArray(a.perConsumer.alice.accounts) && a.perConsumer.alice.accounts.length >= 1);
  check('queue snapshot reports the cap', a.queue?.maxConcurrentPerConsumer === 1 && typeof a.queue?.consumersActive === 'number', JSON.stringify(a.queue));
}

header('the request log and the -v usage line carry the consumer');
{
  await sleep(100);
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const alice = lines.filter((l) => l.consumer === 'alice' && l.status === 200);
  check('two alice lines in the log file', alice.length === 2, JSON.stringify(lines.map((l) => l.consumer)));
  check('hashed consumer in the log file', lines.some((l) => typeof l.consumer === 'string' && l.consumer.startsWith('u_')));
  check('anonymous line has no consumer field', lines.some((l) => l.status === 200 && !('consumer' in l)));
  check('-v usage line names the consumer', log.some((l) => /usage: .* consumer=alice$/.test(l)), log.filter((l) => l.includes('usage:')).slice(-3).join(' | '));
}

header('fairness: a consumer at the cap waits while another goes straight through');
{
  holdMs = 400;
  started.length = 0;
  peakInflight = 0;
  const t0 = Date.now();
  const a1 = messages('alice long 1', { 'x-dario-consumer': 'alice' });
  await sleep(50);                                     // a1 is in flight upstream
  const a2 = messages('alice long 2', { 'x-dario-consumer': 'alice' });
  await sleep(50);                                     // a2 is queued at alice's cap
  const b1 = messages('bob quick', { 'x-dario-consumer': 'bob' });
  const [ra1, ra2, rb1] = await Promise.all([a1, a2, b1]);
  await Promise.all([ra1.text(), ra2.text(), rb1.text()]);
  check('all three served', ra1.status === 200 && ra2.status === 200 && rb1.status === 200);
  check('three upstream calls', started.length === 3, started.length);
  const [s1, s2, s3] = started.map((s) => s.at - t0).sort((x, y) => x - y);
  check('bob started while alice\'s first call was still in flight (not behind her second)', s2 - s1 < holdMs, JSON.stringify({ s1, s2, s3 }));
  check('alice\'s second call started only after her first finished', s3 - s1 >= holdMs - 20, JSON.stringify({ s1, s2, s3 }));
  check('never more than two upstream calls at once (alice 1 + bob 1)', peakInflight === 2, peakInflight);
  holdMs = 0;
}

header('an unnamed request is never capped');
{
  holdMs = 300;
  started.length = 0;
  peakInflight = 0;
  const t0 = Date.now();
  const reqs = [messages('anon 1'), messages('anon 2'), messages('anon 3')];
  const rs = await Promise.all(reqs);
  await Promise.all(rs.map((r) => r.text()));
  check('three unnamed requests ran concurrently', peakInflight === 3, peakInflight);
  check('and all finished within one hold', Date.now() - t0 < holdMs * 2, Date.now() - t0);
  holdMs = 0;
}

out(`\nconsumer-attribution-proxy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

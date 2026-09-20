#!/usr/bin/env node
/**
 * The timing split through a real proxy with a scripted upstream (dario#1341
 * follow-up): the four `x-dario-*-ms` response headers, the `timing` block on
 * `/analytics`, and the five summary families on `/metrics`.
 *
 * The upstream sleeps before answering, the governor is set to a floor a
 * back-to-back second request must trip, and the proxy runs one slot wide so
 * a parallel pair has to queue. Each wait then has to show up in its own
 * column and nowhere else — the property is that "overhead" is what is left
 * once the provider and the deliberate waits are taken out, not a bucket the
 * waits leak into.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

// stdout, not console.log: console is captured below to keep the proxy quiet.
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT_KEY = 'root-secret-for-the-timing-test';
const UPSTREAM_DELAY_MS = 150;
const PACE_MIN_MS = 400;
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-timing-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_ANALYTICS_TOKEN; delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const rateHeaders = {
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.10',
  'anthropic-ratelimit-unified-7d-utilization': '0.05',
};
const sse = (events) => new ReadableStream({
  async start(controller) {
    const enc = new TextEncoder();
    for (const [type, data] of events) {
      controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
      await sleep(20); // the body takes time the headers did not — upstreamMs must outrun ttfb
    }
    controller.close();
  },
});
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  await sleep(UPSTREAM_DELAY_MS); // the provider's time to first byte
  let stream = false;
  try { stream = JSON.parse(new TextDecoder().decode(init?.body)).stream === true; } catch { /* not json */ }
  if (stream) {
    return new Response(sse([
      ['message_start', { message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PONG' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', {}],
    ]), { status: 200, headers: { 'content-type': 'text/event-stream', ...rateHeaders } });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json', ...rateHeaders } });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const { startProxy } = await import('../dist/proxy.js');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
await startProxy({
  host: '127.0.0.1', port: PORT, verbose: false, noLiveCapture: true, fetchImpl, overageGuardEnabled: false,
  pacingMinMs: PACE_MIN_MS, pacingJitterMs: 0, maxConcurrent: 1,
});
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const post = (body) => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ROOT_KEY },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }], ...body }),
});
const ms = (r, h) => { const v = r.headers.get(h); return v === null ? null : Number(v); };
const HDR = { queue: 'x-dario-queue-ms', pacing: 'x-dario-pacing-ms', ttfb: 'x-dario-upstream-ttfb-ms', prep: 'x-dario-prep-ms' };

out('=== first request: no wait, the provider\'s ttfb on the wire ===');
{
  const r = await post({});
  check('served', r.status === 200, r.status);
  for (const h of Object.values(HDR)) check(`${h} is a non-negative integer`, /^\d+$/.test(r.headers.get(h) ?? ''), r.headers.get(h));
  check('ttfb reflects the upstream delay', ms(r, HDR.ttfb) >= UPSTREAM_DELAY_MS - 20, ms(r, HDR.ttfb));
  check('the first request is never paced', ms(r, HDR.pacing) === 0, ms(r, HDR.pacing));
  check('nothing to queue behind', ms(r, HDR.queue) === 0, ms(r, HDR.queue));
  // A sanity bound, not a budget: the first request also builds the template, and CI runs eight files at once.
  check('prep is dario\'s own work, bounded', ms(r, HDR.prep) < 10_000, ms(r, HDR.prep));
  await r.text();
}

out('=== back-to-back second request trips the pacing floor, and says so ===');
{
  const r = await post({});
  check('served', r.status === 200, r.status);
  const pacing = ms(r, HDR.pacing);
  check('pacing header carries the governor\'s sleep', pacing > 0 && pacing <= PACE_MIN_MS, pacing);
  check('…and not the queue column', ms(r, HDR.queue) === 0, ms(r, HDR.queue));
  await r.text();
}

await sleep(PACE_MIN_MS); // let the floor clear so the pair below is about the queue, not pacing

out('=== a parallel pair on one slot: the second waits, in the queue column ===');
{
  const [a, b] = await Promise.all([post({}), post({})]);
  check('both served', a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
  const waits = [ms(a, HDR.queue), ms(b, HDR.queue)].sort((x, y) => x - y);
  check('one of them queued behind the other\'s upstream time', waits[0] === 0 && waits[1] >= UPSTREAM_DELAY_MS - 30, waits);
  await Promise.all([a.text(), b.text()]);
}

out('=== a stream carries the same headers ===');
{
  const r = await post({ stream: true });
  check('served as SSE', r.status === 200 && (r.headers.get('content-type') || '').startsWith('text/event-stream'), `${r.status} ${r.headers.get('content-type')}`);
  check('ttfb on a stream', ms(r, HDR.ttfb) >= UPSTREAM_DELAY_MS - 20, ms(r, HDR.ttfb));
  const body = await r.text();
  check('…and the body still arrives whole', body.includes('message_stop'), body.slice(-80));
}
await sleep(150);

out('=== /analytics: the window carries the averaged split ===');
{
  const r = await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } });
  check('/analytics 200', r.status === 200, r.status);
  const a = await r.json();
  const t = a.window?.timing;
  check('window.timing present', t && typeof t.samples === 'number', JSON.stringify(a.window).slice(0, 300));
  check('every served request carried a split', t.samples === 5, t.samples);
  check('avg upstream ttfb reflects the delay', t.avgUpstreamTtfbMs >= UPSTREAM_DELAY_MS - 20, t.avgUpstreamTtfbMs);
  check('avg upstream ≥ avg ttfb (the stream\'s body took time)', t.avgUpstreamMs >= t.avgUpstreamTtfbMs, t);
  check('avg pacing shows the one paced request', t.avgPacingMs > 0 && t.avgPacingMs < PACE_MIN_MS, t.avgPacingMs);
  check('avg queue shows the one queued request', t.avgQueueMs > 0, t.avgQueueMs);
  check('overhead is what is left, never negative, bounded', t.avgOverheadMs >= 0 && t.avgOverheadMs < 10_000, t.avgOverheadMs);
  check('allTime carries the same block', a.allTime?.timing?.samples === 5, a.allTime?.timing);
}

out('=== /metrics: five summary families + window gauges ===');
{
  const r = await fetch(`${BASE}/metrics`, { headers: { 'x-api-key': ROOT_KEY } });
  check('/metrics 200', r.status === 200, r.status);
  const text = await r.text();
  const lines = text.split('\n');
  for (const fam of ['dario_queue_wait_ms', 'dario_pacing_wait_ms', 'dario_upstream_ttfb_ms', 'dario_upstream_latency_ms', 'dario_overhead_ms']) {
    check(`${fam} summary with quantiles, sum and count`,
      lines.includes(`# TYPE ${fam} summary`) && lines.some(l => l.startsWith(`${fam}{quantile="0.5"} `)) && lines.some(l => l.startsWith(`${fam}_sum `)) && lines.includes(`${fam}_count 5`),
      lines.filter(l => l.includes(fam)).join(' | ').slice(0, 300));
  }
  const ttfbP50 = Number(lines.find(l => l.startsWith('dario_upstream_ttfb_ms{quantile="0.5"} '))?.split(' ')[1]);
  check('ttfb p50 reflects the upstream delay', ttfbP50 >= UPSTREAM_DELAY_MS - 20, ttfbP50);
  check('window gauges for the split', lines.some(l => l.startsWith('dario_window_avg_overhead_ms{')) && lines.some(l => l.startsWith('dario_window_avg_upstream_ttfb_ms{')));
  check('every HELP has a TYPE right after it', lines.every((l, i) => !l.startsWith('# HELP') || lines[i + 1]?.startsWith('# TYPE')));
  check('no NaN, no undefined', !text.includes('NaN') && !text.includes('undefined'));
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-20).join('\n'));
process.exit(fail === 0 ? 0 : 1);

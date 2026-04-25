#!/usr/bin/env node
// Stress test for a running dario proxy. Hits Haiku with tiny prompts to
// minimize subscription burn while exercising the request path under
// concurrency. Reports latency distribution, throughput, error breakdown,
// and rate-limit utilization delta from before-vs-after.
//
// Tunables (env):
//   DARIO_TEST_URL       proxy base (default http://127.0.0.1:3456)
//   STRESS_CONCURRENCY   parallel inflight requests (default 20)
//   STRESS_TOTAL         total requests to fire (default 60)
//   STRESS_STREAMS       concurrent streaming requests (default 8)
//
// Not part of `npm test` — needs a live proxy + valid subscription.

const BASE = process.env.DARIO_TEST_URL || 'http://127.0.0.1:3456';
const CONCURRENCY = parseInt(process.env.STRESS_CONCURRENCY || '20', 10);
const TOTAL = parseInt(process.env.STRESS_TOTAL || '60', 10);
const STREAMS = parseInt(process.env.STRESS_STREAMS || '8', 10);
const MODEL = 'claude-haiku-4-5';

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function fmt(ms) { return `${ms.toFixed(0)}ms`; }

async function snapshotRateLimit() {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'authorization': 'Bearer dario' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  const out = {};
  for (const [k, v] of res.headers) {
    if (k.startsWith('anthropic-ratelimit-unified-')) {
      out[k.replace('anthropic-ratelimit-unified-', '')] = v;
    }
  }
  return out;
}

async function oneRequest(idx) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'authorization': 'Bearer dario' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: `say OK (${idx})` }],
      }),
    });
    const body = await res.json();
    const dt = performance.now() - t0;
    return { idx, ok: res.status === 200, status: res.status, dt, hasContent: !!body.content };
  } catch (err) {
    return { idx, ok: false, status: 0, dt: performance.now() - t0, error: err.message };
  }
}

async function oneStream(idx) {
  const t0 = performance.now();
  let firstByteAt = null;
  let events = 0;
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'authorization': 'Bearer dario' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        stream: true,
        messages: [{ role: 'user', content: `count to 3 (${idx})` }],
      }),
    });
    if (!res.body) return { idx, ok: false, status: res.status, dt: performance.now() - t0 };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByteAt === null) firstByteAt = performance.now();
      const chunk = decoder.decode(value);
      events += (chunk.match(/^event:/gm) || []).length;
    }
    const dt = performance.now() - t0;
    return { idx, ok: res.status === 200 && events > 0, status: res.status, dt, ttfb: firstByteAt ? firstByteAt - t0 : null, events };
  } catch (err) {
    return { idx, ok: false, status: 0, dt: performance.now() - t0, error: err.message };
  }
}

// Bounded-concurrency runner. Fires `total` requests with at most
// `concurrency` in flight; returns all results once everything settles.
async function runWithConcurrency(total, concurrency, makeRequest) {
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results.push(await makeRequest(i));
    }
  }
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  dario stress test — ${new Date().toISOString()}`);
console.log(`  proxy=${BASE}  model=${MODEL}`);
console.log(`  total=${TOTAL}  concurrency=${CONCURRENCY}  streams=${STREAMS}`);
console.log(`${'='.repeat(70)}\n`);

console.log('[1/4] Pre-stress rate-limit snapshot...');
const before = await snapshotRateLimit();
console.log(`       5h=${before['5h-utilization']}  7d=${before['7d-utilization']}  claim=${before['representative-claim']}\n`);

console.log(`[2/4] Firing ${TOTAL} non-streaming requests at concurrency ${CONCURRENCY}...`);
const t0 = performance.now();
const results = await runWithConcurrency(TOTAL, CONCURRENCY, oneRequest);
const wallMs = performance.now() - t0;

const ok = results.filter(r => r.ok);
const fail = results.filter(r => !r.ok);
const lats = ok.map(r => r.dt);

console.log(`       wall=${fmt(wallMs)}  throughput=${(TOTAL / (wallMs / 1000)).toFixed(2)} req/s`);
console.log(`       ok=${ok.length}/${TOTAL}  fail=${fail.length}`);
if (lats.length) {
  console.log(`       latency: p50=${fmt(pct(lats, 50))}  p95=${fmt(pct(lats, 95))}  p99=${fmt(pct(lats, 99))}  max=${fmt(Math.max(...lats))}`);
}
if (fail.length) {
  const codes = {};
  for (const f of fail) codes[f.status] = (codes[f.status] || 0) + 1;
  console.log(`       fail breakdown: ${JSON.stringify(codes)}`);
}
console.log();

console.log(`[3/4] Firing ${STREAMS} concurrent streaming requests...`);
const ts0 = performance.now();
const streamResults = await runWithConcurrency(STREAMS, STREAMS, oneStream);
const sWall = performance.now() - ts0;
const sOk = streamResults.filter(r => r.ok);
const sLats = sOk.map(r => r.dt);
const sTtfbs = sOk.filter(r => r.ttfb !== null).map(r => r.ttfb);
const sEvents = sOk.reduce((a, r) => a + r.events, 0);
console.log(`       wall=${fmt(sWall)}  ok=${sOk.length}/${STREAMS}  events_total=${sEvents}`);
if (sLats.length) {
  console.log(`       stream latency: p50=${fmt(pct(sLats, 50))}  p95=${fmt(pct(sLats, 95))}  max=${fmt(Math.max(...sLats))}`);
  console.log(`       ttfb:           p50=${fmt(pct(sTtfbs, 50))}  p95=${fmt(pct(sTtfbs, 95))}`);
}
console.log();

console.log('[4/4] Post-stress rate-limit snapshot...');
const after = await snapshotRateLimit();
console.log(`       5h=${after['5h-utilization']}  7d=${after['7d-utilization']}  claim=${after['representative-claim']}`);
const delta5h = parseFloat(after['5h-utilization']) - parseFloat(before['5h-utilization']);
const delta7d = parseFloat(after['7d-utilization']) - parseFloat(before['7d-utilization']);
console.log(`       delta:  5h=+${(delta5h * 100).toFixed(2)}pp  7d=+${(delta7d * 100).toFixed(2)}pp\n`);

console.log(`${'='.repeat(70)}`);
const verdict = fail.length === 0 && sOk.length === STREAMS ? 'PASS' : 'PARTIAL';
console.log(`  Verdict: ${verdict}  (${TOTAL + STREAMS} total requests, ${fail.length} failures)`);
console.log(`${'='.repeat(70)}\n`);
process.exit(fail.length === 0 && sOk.length === STREAMS ? 0 : 1);

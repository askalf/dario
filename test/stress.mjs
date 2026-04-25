#!/usr/bin/env node
// Stress test for a running dario proxy.
//
// Defaults to **Opus 4.7 + Sonnet 4.6** — the heavyweight models that
// most dario users actually drive (Haiku was the v1 default but didn't
// reflect real wire patterns: bigger system prompts, bigger output
// distributions, different rate-limit accounting). Each model gets its
// own latency distribution so a regression on one shows up immediately
// instead of being averaged away. A pre/post utilization snapshot
// captures actual subscription-window pressure.
//
// Tunables (env):
//   DARIO_TEST_URL       proxy base (default http://127.0.0.1:3456)
//   STRESS_MODELS        comma-separated aliases or model IDs
//                        (default "opus,sonnet"; aliases "opus" / "sonnet"
//                        / "haiku" map to current latest)
//   STRESS_CONCURRENCY   parallel inflight per model (default 6)
//   STRESS_TOTAL         non-stream requests per model (default 12)
//   STRESS_STREAMS       streaming requests per model (default 3)
//
// Cost notes — at the defaults (12 + 3) × 2 models × max_tokens=8 each,
// total output is ~480 tokens spread across Opus + Sonnet. Negligible
// against 5h/7d windows; the snapshot delta at the end will confirm.
//
// Not part of `npm test` — needs a live proxy + valid subscription.

const BASE = process.env.DARIO_TEST_URL || 'http://127.0.0.1:3456';
const CONCURRENCY = parseInt(process.env.STRESS_CONCURRENCY || '6', 10);
const TOTAL = parseInt(process.env.STRESS_TOTAL || '12', 10);
const STREAMS = parseInt(process.env.STRESS_STREAMS || '3', 10);

// Alias map: keep these in sync with the README and dario's own MODEL_ALIASES.
// The actual model IDs Anthropic ships under right now (April 2026) — Opus 4.7
// is the latest of the 4.x line, Sonnet 4.6 is the current daily-driver, Haiku
// 4.5 is the cheap/fast tier kept for quick smoke tests when invoked
// explicitly via STRESS_MODELS=haiku.
const MODEL_ALIASES = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5',
};
const MODELS = (process.env.STRESS_MODELS || 'opus,sonnet')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => MODEL_ALIASES[s] || s);

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function fmt(ms) { return `${ms.toFixed(0)}ms`; }

async function snapshotRateLimit() {
  // Use Haiku for the snapshot probe — it's the cheapest one-token request,
  // and we want the snapshot itself to barely register on any window.
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'authorization': 'Bearer dario' },
    body: JSON.stringify({ model: MODEL_ALIASES.haiku, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
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

async function oneRequest(model, idx) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'authorization': 'Bearer dario' },
      body: JSON.stringify({
        model,
        max_tokens: 8,
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

async function oneStream(model, idx) {
  const t0 = performance.now();
  let firstByteAt = null;
  let events = 0;
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'authorization': 'Bearer dario' },
      body: JSON.stringify({
        model,
        max_tokens: 12,
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

async function runModelStage(model) {
  console.log(`\n--- ${model} ---`);
  const t0 = performance.now();
  const nonStream = await runWithConcurrency(TOTAL, CONCURRENCY, idx => oneRequest(model, idx));
  const wallNs = performance.now() - t0;

  const okN = nonStream.filter(r => r.ok);
  const failN = nonStream.filter(r => !r.ok);
  const latsN = okN.map(r => r.dt);
  console.log(`       non-stream: ${okN.length}/${TOTAL} ok  wall=${fmt(wallNs)}  thr=${(TOTAL / (wallNs / 1000)).toFixed(2)} req/s`);
  if (latsN.length) {
    console.log(`       latency:    p50=${fmt(pct(latsN, 50))}  p95=${fmt(pct(latsN, 95))}  p99=${fmt(pct(latsN, 99))}  max=${fmt(Math.max(...latsN))}`);
  }
  if (failN.length) {
    const codes = {};
    for (const f of failN) codes[f.status] = (codes[f.status] || 0) + 1;
    console.log(`       fail breakdown: ${JSON.stringify(codes)}`);
  }

  const ts0 = performance.now();
  const streamRes = await runWithConcurrency(STREAMS, STREAMS, idx => oneStream(model, idx));
  const sWall = performance.now() - ts0;
  const okS = streamRes.filter(r => r.ok);
  const latsS = okS.map(r => r.dt);
  const ttfbS = okS.filter(r => r.ttfb !== null).map(r => r.ttfb);
  const eventsS = okS.reduce((a, r) => a + r.events, 0);
  console.log(`       streams:    ${okS.length}/${STREAMS} ok  wall=${fmt(sWall)}  events=${eventsS}`);
  if (latsS.length) {
    console.log(`       stream lat: p50=${fmt(pct(latsS, 50))}  p95=${fmt(pct(latsS, 95))}  max=${fmt(Math.max(...latsS))}`);
    console.log(`       ttfb:       p50=${fmt(pct(ttfbS, 50))}  p95=${fmt(pct(ttfbS, 95))}`);
  }

  return {
    model,
    okN: okN.length,
    failN: failN.length,
    okS: okS.length,
    failS: STREAMS - okS.length,
  };
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  dario stress test — ${new Date().toISOString()}`);
console.log(`  proxy=${BASE}`);
console.log(`  models=[${MODELS.join(', ')}]  per-model: total=${TOTAL}  concurrency=${CONCURRENCY}  streams=${STREAMS}`);
console.log(`${'='.repeat(70)}`);

console.log('\n[pre]  rate-limit snapshot...');
const before = await snapshotRateLimit();
console.log(`       5h=${before['5h-utilization']}  7d=${before['7d-utilization']}  claim=${before['representative-claim']}`);

const summaries = [];
for (const model of MODELS) {
  summaries.push(await runModelStage(model));
}

console.log('\n[post] rate-limit snapshot...');
const after = await snapshotRateLimit();
console.log(`       5h=${after['5h-utilization']}  7d=${after['7d-utilization']}  claim=${after['representative-claim']}`);
const delta5h = parseFloat(after['5h-utilization']) - parseFloat(before['5h-utilization']);
const delta7d = parseFloat(after['7d-utilization']) - parseFloat(before['7d-utilization']);
console.log(`       delta:  5h=+${(delta5h * 100).toFixed(2)}pp  7d=+${(delta7d * 100).toFixed(2)}pp`);

const totalOk = summaries.reduce((a, s) => a + s.okN + s.okS, 0);
const totalAll = summaries.reduce((a, s) => a + s.okN + s.failN + s.okS + s.failS, 0);
const verdict = totalOk === totalAll ? 'PASS' : 'PARTIAL';
console.log(`\n${'='.repeat(70)}`);
console.log(`  Verdict: ${verdict}  (${totalOk}/${totalAll} requests across ${MODELS.length} models)`);
console.log(`${'='.repeat(70)}\n`);
process.exit(totalOk === totalAll ? 0 : 1);

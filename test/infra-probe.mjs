#!/usr/bin/env node
// One-off investigation: figure out why Opus 4.7 is currently faster than
// Sonnet 4.6 through dario. Bigger model winning is unusual; either
// Anthropic moved Opus to a faster inference cluster, Sonnet 4.6 is
// throttled / under heavier load, or our 12-request sample was noise.
//
// What this probe does, per model:
//   1. 30 sequential requests (no concurrency — measures pure latency,
//      not parallel throughput) with `max_tokens=8`. Captures total
//      latency + token-budget so we can estimate per-token rate.
//   2. 10 streaming requests captures TTFT vs total — splits "how long
//      to start generating" from "how fast does it generate". An
//      infra-tier difference shows up most cleanly as TTFT, while a
//      per-token-rate difference shows up in (total - ttft) / events.
//   3. Dumps every unique response header value seen, including
//      `request-id`, `anthropic-organization-id`, `server`, anything
//      ratelimit-related, and any custom hints Anthropic added recently.
//
// Also runs Opus 4.6 + Sonnet 4.7 if available, to disentangle "is it
// Opus" vs "is it 4.7".
//
// Not committed as part of the test suite — diagnostic only.

const BASE = process.env.DARIO_TEST_URL || 'http://127.0.0.1:3456';

const MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-opus-4-6',     // for the "is it the 4.7 generation?" axis
  'claude-sonnet-4-7',   // probe — may not exist
];

const SEQUENTIAL_N = 30;
const STREAM_N = 10;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}
const fmt = ms => `${ms.toFixed(0)}ms`;

async function nonStream(model) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'authorization': 'Bearer dario',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'OK?' }],
    }),
  });
  const dt = performance.now() - t0;
  const headers = {};
  for (const [k, v] of res.headers) headers[k] = v;
  let body;
  try { body = await res.json(); } catch { body = null; }
  const usage = body?.usage || {};
  return {
    status: res.status,
    dt,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreate: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    headers,
    err: res.status !== 200 ? body : null,
  };
}

async function stream(model) {
  const t0 = performance.now();
  let firstByteAt = null;
  let firstTokenAt = null;
  let events = 0;
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'authorization': 'Bearer dario',
    },
    body: JSON.stringify({
      model,
      max_tokens: 24,
      stream: true,
      messages: [{ role: 'user', content: 'count 1 to 5' }],
    }),
  });
  if (!res.body) return { status: res.status, dt: performance.now() - t0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = performance.now();
    const chunk = decoder.decode(value);
    if (firstTokenAt === null && chunk.includes('content_block_delta')) {
      firstTokenAt = performance.now();
    }
    events += (chunk.match(/^event:/gm) || []).length;
  }
  return {
    status: res.status,
    dt: performance.now() - t0,
    ttfb: firstByteAt ? firstByteAt - t0 : null,
    ttft: firstTokenAt ? firstTokenAt - t0 : null,
    events,
  };
}

async function probe(model) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${model}`);
  console.log(`${'='.repeat(70)}`);

  // 1. Sequential non-stream
  console.log(`\n  [seq ${SEQUENTIAL_N}] sequential non-streaming requests...`);
  const seq = [];
  let modelExists = true;
  for (let i = 0; i < SEQUENTIAL_N; i++) {
    const r = await nonStream(model);
    if (r.status === 404 || r.status === 400) {
      console.log(`  → ${r.status} on first attempt: ${JSON.stringify(r.err).slice(0, 200)}`);
      console.log(`  skipping this model.`);
      modelExists = false;
      break;
    }
    if (r.status !== 200) {
      console.log(`  request ${i} failed: ${r.status} — ${JSON.stringify(r.err).slice(0, 100)}`);
      break;
    }
    seq.push(r);
  }
  if (!modelExists) return null;

  const lats = seq.map(r => r.dt);
  const inToks = seq.map(r => r.inputTokens || 0);
  const outToks = seq.map(r => r.outputTokens || 0);
  const cacheR = seq.map(r => r.cacheRead || 0);

  console.log(`       ok: ${seq.length}/${SEQUENTIAL_N}`);
  console.log(`       latency: p50=${fmt(pct(lats, 50))}  p95=${fmt(pct(lats, 95))}  p99=${fmt(pct(lats, 99))}  max=${fmt(Math.max(...lats))}  min=${fmt(Math.min(...lats))}`);
  console.log(`       tokens : in p50=${pct(inToks, 50)} (cache_read p50=${pct(cacheR, 50)})  out p50=${pct(outToks, 50)}`);

  // Look for first-vs-rest cache speedup (cold-cache cost)
  if (seq.length >= 5) {
    const first = seq[0].dt;
    const restMed = pct(seq.slice(1).map(r => r.dt), 50);
    const speedup = ((first - restMed) / first * 100).toFixed(1);
    console.log(`       cache  : first=${fmt(first)}  rest p50=${fmt(restMed)}  cold→warm Δ=${speedup}%`);
  }

  // 2. Streaming with TTFT
  console.log(`\n  [stream ${STREAM_N}] streaming requests (split TTFB / TTFT / generation)...`);
  const sm = [];
  for (let i = 0; i < STREAM_N; i++) {
    const r = await stream(model);
    if (r.status !== 200) { console.log(`  stream ${i} failed: ${r.status}`); break; }
    sm.push(r);
  }
  const ttfb = sm.filter(r => r.ttfb !== null).map(r => r.ttfb);
  const ttft = sm.filter(r => r.ttft !== null).map(r => r.ttft);
  const totals = sm.map(r => r.dt);
  console.log(`       ok: ${sm.length}/${STREAM_N}`);
  console.log(`       TTFB (first byte) : p50=${fmt(pct(ttfb, 50))}  p95=${fmt(pct(ttfb, 95))}`);
  console.log(`       TTFT (first token): p50=${fmt(pct(ttft, 50))}  p95=${fmt(pct(ttft, 95))}`);
  console.log(`       Total stream      : p50=${fmt(pct(totals, 50))}  p95=${fmt(pct(totals, 95))}`);
  // Generation phase = total − TTFT
  const genMs = sm.map(r => r.ttft && r.dt ? r.dt - r.ttft : 0).filter(x => x > 0);
  if (genMs.length) {
    console.log(`       Generation phase  : p50=${fmt(pct(genMs, 50))}  (i.e. tokens-per-second axis)`);
  }

  // 3. Header survey — dump every UNIQUE header seen + first value sample
  console.log(`\n  [headers] unique values across ${seq.length} responses:`);
  const seen = new Map();   // header → Set of values
  for (const r of seq) {
    for (const [k, v] of Object.entries(r.headers)) {
      // Skip noisy ones we know about (CORS, content-length per body, date)
      if (['date', 'content-length', 'content-type', 'access-control-allow-origin',
           'access-control-allow-methods', 'access-control-allow-headers',
           'access-control-expose-headers', 'access-control-max-age',
           'cache-control', 'connection'].includes(k)) continue;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(v);
    }
  }
  // Sort headers by interesting-ness: anthropic-* first, then alphabetic.
  const sortedKeys = [...seen.keys()].sort((a, b) => {
    const aA = a.startsWith('anthropic') || a.startsWith('x-') || a.includes('request-id');
    const bA = b.startsWith('anthropic') || b.startsWith('x-') || b.includes('request-id');
    if (aA !== bA) return aA ? -1 : 1;
    return a.localeCompare(b);
  });
  for (const k of sortedKeys) {
    const vals = [...seen.get(k)];
    if (vals.length === 1) {
      console.log(`         ${k}: ${vals[0]}`);
    } else if (vals.length <= 4) {
      console.log(`         ${k}: ${vals.length} unique  [${vals.map(v => v.slice(0, 40)).join(', ')}]`);
    } else {
      console.log(`         ${k}: ${vals.length} unique values (one per request — likely a request id)`);
    }
  }

  return {
    model,
    seqP50: pct(lats, 50),
    seqP95: pct(lats, 95),
    ttftP50: pct(ttft, 50),
    ttftP95: pct(ttft, 95),
    genP50: pct(genMs, 50),
    headerSurvey: Object.fromEntries(
      sortedKeys.map(k => {
        const vals = [...seen.get(k)];
        return [k, vals.length === 1 ? vals[0] : `${vals.length} unique`];
      })
    ),
  };
}

console.log(`\nProbe started at ${new Date().toISOString()}`);
console.log(`Proxy: ${BASE}`);

const summaries = [];
for (const m of MODELS) {
  const s = await probe(m);
  if (s) summaries.push(s);
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  CROSS-MODEL SUMMARY`);
console.log(`${'='.repeat(70)}\n`);
console.log(`  ${'model'.padEnd(28)}  ${'seq p50'.padStart(10)}  ${'seq p95'.padStart(10)}  ${'ttft p50'.padStart(10)}  ${'ttft p95'.padStart(10)}  ${'gen p50'.padStart(10)}`);
for (const s of summaries) {
  console.log(`  ${s.model.padEnd(28)}  ${fmt(s.seqP50).padStart(10)}  ${fmt(s.seqP95).padStart(10)}  ${fmt(s.ttftP50).padStart(10)}  ${fmt(s.ttftP95).padStart(10)}  ${fmt(s.genP50).padStart(10)}`);
}
console.log();

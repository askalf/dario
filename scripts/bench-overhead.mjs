#!/usr/bin/env node
/**
 * dario's own overhead, measured offline.
 *
 * A real proxy is started in-process against a fetchImpl that answers at
 * once, so the provider's time is zero and every millisecond a request takes
 * is dario's: reading the body, the template or the translation, the SSE
 * relay, the analytics row. No subscription, no network, deterministic bodies.
 *
 * Variants cover the shapes that actually differ in cost:
 *   passthrough/json    --passthrough, byte-for-byte forward, buffered reply
 *   template/json       the Claude Code template built around a client body
 *   template/sse        the same, streamed (200 deltas relayed)
 *   openai/sse          OpenAI chat shape translated both ways, streamed
 * at two body sizes: small (a few KB) and large (a Claude Code turn: a big
 * system prompt, many tools, a long history — ~150 KB).
 *
 * Reports wall latency p50/p90/p99 as the client saw it, the x-dario-prep-ms
 * header (arrival → first outbound byte), and CPU microseconds per request
 * (process.cpuUsage, so it includes the in-process client; compare variants
 * against each other, not against a wire).
 *
 *   node scripts/bench-overhead.mjs                 # human table
 *   node scripts/bench-overhead.mjs --json out.json # plus machine-readable
 *   BENCH_N=300 node scripts/bench-overhead.mjs     # more samples
 *   BENCH_ONLY=template/sse:large                   # one variant
 *
 * Not part of `npm test`. `npm run bench` runs it.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { freePort } from '../test/helpers/free-port.mjs';

const N = Number(process.env.BENCH_N || 150);
const WARMUP = Number(process.env.BENCH_WARMUP || 15);
const ONLY = process.env.BENCH_ONLY || '';
const jsonOut = (() => { const i = process.argv.indexOf('--json'); return i > 0 ? process.argv[i + 1] : null; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : NaN;

// ---- bodies ----------------------------------------------------------------
const lorem = 'The quick brown fox jumps over the lazy dog while the proxy relays every byte it is given. ';
const text = (kb) => lorem.repeat(Math.ceil((kb * 1024) / lorem.length)).slice(0, kb * 1024);
const tool = (i) => ({
  name: `tool_${i}`, description: `Tool number ${i}: ${text(1)}`,
  input_schema: { type: 'object', properties: { path: { type: 'string', description: text(0.3) }, content: { type: 'string' }, flags: { type: 'array', items: { type: 'string' } } }, required: ['path'] },
});
const history = (turns, kbEach) => {
  const out = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `turn ${i}: ${text(kbEach)}` });
    out.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${i}: ${text(kbEach / 2)}` }] });
  }
  out.push({ role: 'user', content: 'final question' });
  return out;
};
const anthropicBody = (size, stream) => size === 'small'
  ? { model: 'claude-sonnet-5', max_tokens: 256, stream, system: text(1), messages: [{ role: 'user', content: 'ping' }] }
  : { model: 'claude-sonnet-5', max_tokens: 4096, stream, system: text(24), tools: Array.from({ length: 24 }, (_, i) => tool(i)), messages: history(30, 3) };
const openaiBody = (size, stream) => {
  const a = anthropicBody(size, stream);
  return {
    model: a.model, max_tokens: a.max_tokens, stream,
    messages: [{ role: 'system', content: a.system }, ...a.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(b => b.text).join('') }))],
    ...(a.tools ? { tools: a.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
  };
};

// ---- the instant upstream ---------------------------------------------------
const rateHeaders = {
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.10',
  'anthropic-ratelimit-unified-7d-utilization': '0.05',
};
const DELTAS = 200;
const enc = new TextEncoder();
const sseFrames = (() => {
  const ev = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const frames = [ev('message_start', { message: { id: 'msg_b', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 40_000, output_tokens: 1, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })];
  for (let i = 0; i < DELTAS; i++) frames.push(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `token${i} ` } }));
  frames.push(ev('content_block_stop', { index: 0 }));
  frames.push(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: DELTAS } }));
  frames.push(ev('message_stop', {}));
  return frames;
})();
const jsonReply = JSON.stringify({
  id: 'msg_b', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'text', text: Array.from({ length: DELTAS }, (_, i) => `token${i}`).join(' ') }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 40_000, output_tokens: DELTAS, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 },
});
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  let stream = false;
  try { stream = JSON.parse(new TextDecoder().decode(init?.body)).stream === true; } catch { /* not json */ }
  if (stream) {
    const body = new ReadableStream({ pull(c) { for (const f of sseFrames) c.enqueue(f); c.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...rateHeaders } });
  }
  return new Response(jsonReply, { status: 200, headers: { 'content-type': 'application/json', ...rateHeaders } });
};

// ---- proxies -----------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-bench-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_API_KEY; delete process.env.DARIO_ANALYTICS_TOKEN; delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN; delete process.env.DARIO_KEYS; delete process.env.DARIO_LEDGER;
process.env.DARIO_LEDGER = '0';
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));
const quiet = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { quiet.push(a.map(String).join(' ')); };
const { startProxy } = await import('../dist/proxy.js');
const common = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl, overageGuardEnabled: false, pacingMinMs: 0, pacingJitterMs: 0, maxConcurrent: 64 };
const ports = { template: await freePort(), passthrough: await freePort(), direct: await freePort() };
// The floor: a bare http server answering the same bytes with no proxy in the
// way. Everything the proxies add sits above this line.
const direct = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let stream = false;
    try { stream = JSON.parse(Buffer.concat(chunks).toString('utf8')).stream === true; } catch { /* not json */ }
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of sseFrames) res.write(f);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonReply);
    }
  });
});
await new Promise((r) => direct.listen(ports.direct, '127.0.0.1', r));
await startProxy({ ...common, port: ports.template });
await startProxy({ ...common, port: ports.passthrough, passthrough: true });
for (const p of Object.values(ports)) for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${p}/health`); break; } catch { await sleep(100); } }

// ---- variants ----------------------------------------------------------------
const variants = [
  { name: 'direct/json', port: ports.direct, path: '/v1/messages', body: (s) => anthropicBody(s, false) },
  { name: 'direct/sse', port: ports.direct, path: '/v1/messages', body: (s) => anthropicBody(s, true) },
  { name: 'passthrough/json', port: ports.passthrough, path: '/v1/messages', body: (s) => anthropicBody(s, false) },
  { name: 'template/json', port: ports.template, path: '/v1/messages', body: (s) => anthropicBody(s, false) },
  { name: 'template/sse', port: ports.template, path: '/v1/messages', body: (s) => anthropicBody(s, true) },
  { name: 'openai/sse', port: ports.template, path: '/v1/chat/completions', body: (s) => openaiBody(s, true) },
];
const sizes = ['small', 'large'];

async function runOne(v, size, n) {
  const body = JSON.stringify(v.body(size));
  const wall = [], prep = [];
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    const r = await fetch(`http://127.0.0.1:${v.port}${v.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (r.status !== 200) throw new Error(`${v.name}:${size} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await r.arrayBuffer();
    wall.push(performance.now() - s);
    prep.push(Number(r.headers.get('x-dario-prep-ms') ?? 0));
  }
  const elapsed = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  wall.sort((a, b) => a - b); prep.sort((a, b) => a - b);
  return {
    variant: v.name, size, n, bodyBytes: Buffer.byteLength(body),
    wallP50: +quantile(wall, 0.5).toFixed(2), wallP90: +quantile(wall, 0.9).toFixed(2), wallP99: +quantile(wall, 0.99).toFixed(2),
    prepP50: quantile(prep, 0.5), prepP99: quantile(prep, 0.99),
    cpuUsPerReq: Math.round((cpu.user + cpu.system) / n),
    reqPerSec: +(n / (elapsed / 1000)).toFixed(1),
  };
}

const results = [];
for (const v of variants) for (const size of sizes) {
  const key = `${v.name}:${size}`;
  if (ONLY && ONLY !== key) continue;
  await runOne(v, size, WARMUP);
  results.push(await runOne(v, size, N));
}

const pad = (s, w, right = false) => { s = String(s); return right ? s.padStart(w) : s.padEnd(w); };
const hdr = ['variant', 'size', 'body', 'wall p50', 'p90', 'p99 (ms)', 'prep p50/p99', 'cpu µs/req', 'req/s'];
const rows = results.map(r => [r.variant, r.size, `${(r.bodyBytes / 1024).toFixed(0)}K`, r.wallP50, r.wallP90, r.wallP99, `${r.prepP50}/${r.prepP99}`, r.cpuUsPerReq, r.reqPerSec]);
const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
const line = (cells) => cells.map((c, i) => pad(c, widths[i], i >= 2)).join('  ');
process.stdout.write(`\ndario overhead bench — ${N} requests per cell after ${WARMUP} warm-up, instant upstream, ${DELTAS} SSE deltas, node ${process.version}\n\n`);
process.stdout.write(line(hdr) + '\n' + line(widths.map(w => '-'.repeat(w))) + '\n');
for (const r of rows) process.stdout.write(line(r) + '\n');
process.stdout.write('\n');
// dario's share: each proxy cell minus the direct cell of the same reply shape and size.
const floor = (shape, size) => results.find(r => r.variant === `direct/${shape}` && r.size === size);
process.stdout.write('dario above the direct floor (wall p50 / cpu µs per request):\n');
for (const r of results) {
  if (r.variant.startsWith('direct/')) continue;
  const f = floor(r.variant.endsWith('/sse') ? 'sse' : 'json', r.size);
  if (!f) continue;
  process.stdout.write(`  ${pad(r.variant, 18)} ${pad(r.size, 6)} +${(r.wallP50 - f.wallP50).toFixed(2)} ms   +${r.cpuUsPerReq - f.cpuUsPerReq} µs\n`);
}
process.stdout.write('\n');
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), node: process.version, n: N, deltas: DELTAS, results }, null, 2));
  process.stdout.write(`wrote ${jsonOut}\n`);
}
process.exit(0);

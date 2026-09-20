#!/usr/bin/env node
/**
 * The analytics SSE tap after the parse-only-what-you-read change (v6.9.2).
 *
 * The tap used to JSON.parse every frame of every stream to find the three
 * it reads: the message_start usage, the message_delta usage, and thinking
 * deltas. It now decides on a substring test first. Two properties: the
 * numbers it keeps are unchanged (input, cache, output, thinking tokens),
 * and a text delta that merely *mentions* those words is still relayed
 * byte-for-byte and still counted correctly.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

out('=== pure helpers ===');
{
  const { sseDataLine, analyticsFrameOfInterest } = await import('../dist/proxy.js');
  check('data line at frame start', sseDataLine('data: {"a":1}\n\n') === 'data: {"a":1}');
  check('data line after an event line', sseDataLine('event: ping\ndata: {"type":"ping"}\n\n') === 'data: {"type":"ping"}');
  check('no data line → null', sseDataLine(': keep-alive\n\n') === null && sseDataLine('event: only\n\n') === null);
  check('a line that merely contains "data: " mid-line is not the data line', sseDataLine('event: xdata: y\n\n') === null);
  check('last line without trailing newline', sseDataLine('data: tail') === 'data: tail');
  check('message_start is of interest', analyticsFrameOfInterest('data: {"type":"message_start","message":{}}'));
  check('message_delta is of interest', analyticsFrameOfInterest('data: {"type":"message_delta","usage":{"output_tokens":4}}'));
  check('a thinking delta is of interest', analyticsFrameOfInterest('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}'));
  check('a text delta is not', !analyticsFrameOfInterest('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}'));
  check('a tool-input delta is not', !analyticsFrameOfInterest('data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a"}}'));
  check('content_block_start / stop / message_stop / ping are not', ['content_block_start', 'content_block_stop', 'message_stop', 'ping'].every(t => !analyticsFrameOfInterest(`data: {"type":"${t}"}`)));
}

out('=== through a real proxy: the numbers are the same as before ===');
const ROOT_KEY = 'root-secret-for-the-tap-test';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-sse-tap-'));
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
const THINKING = 'Let me think about this carefully before answering the question at hand.'; // 72 chars → 18 tokens
const TRICKY = 'The words message_start and message_delta and thinking_delta appear in prose here.';
const events = [
  ['message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: THINKING.slice(0, 30) } }],
  ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: THINKING.slice(30) } }],
  ['content_block_stop', { index: 0 }],
  ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'PONG ' } }],
  ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: TRICKY } }],
  ['content_block_stop', { index: 1 }],
  ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 44 } }],
  ['message_stop', {}],
];
const sseText = events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const rateHeaders = {
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.10',
  'anthropic-ratelimit-unified-7d-utilization': '0.05',
};
const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Split at awkward places so frames straddle chunks — the tap's buffer has to reassemble them.
  const enc = new TextEncoder();
  const cuts = [7, 150, 151, 400, 640];
  let last = 0; const chunks = [];
  for (const c of cuts) { chunks.push(enc.encode(sseText.slice(last, c))); last = c; }
  chunks.push(enc.encode(sseText.slice(last)));
  const body = new ReadableStream({ async pull(ctl) { for (const ch of chunks) { ctl.enqueue(ch); await sleep(2); } ctl.close(); } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...rateHeaders } });
};
const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const { startProxy } = await import('../dist/proxy.js');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
await startProxy({ host: '127.0.0.1', port: PORT, verbose: false, noLiveCapture: true, fetchImpl, overageGuardEnabled: false, pacingMinMs: 0, pacingJitterMs: 0 });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ROOT_KEY },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const body = await r.text();
  check('streamed 200', r.status === 200, r.status);
  check('the tricky text delta reached the client intact', body.includes(JSON.stringify(TRICKY)), body.slice(0, 200));
  check('both thinking deltas reached the client', body.includes(JSON.stringify(THINKING.slice(30))));
  await sleep(150);
  const a = await (await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } })).json();
  const w = a.window;
  check('one request in the window', w.requests === 1, w.requests);
  check('input tokens from message_start', w.totalInputTokens === 900, w.totalInputTokens);
  check('cache read / create from message_start', w.totalCacheReadTokens === 300 && w.totalCacheCreateTokens === 50, [w.totalCacheReadTokens, w.totalCacheCreateTokens]);
  check('output tokens from message_delta', w.totalOutputTokens === 44, w.totalOutputTokens);
  check('thinking tokens ≈ chars/4 across both deltas', w.totalThinkingTokens === Math.round(THINKING.length / 4), w.totalThinkingTokens);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-20).join('\n'));
process.exit(fail === 0 ? 0 : 1);

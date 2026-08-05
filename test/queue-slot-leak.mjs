#!/usr/bin/env node
// dario#905 — request-queue slot leak on a connected-but-not-reading client.
//
// The wedge: a streaming client whose socket stays OPEN but which stops
// reading. res.write() returns false, the stream loop parks in the drain
// wait, and pre-fix that wait resolved only on res 'drain'/'close' — events
// a silent-but-alive client never fires. The upstream timeout aborted the
// upstream fetch, but nothing was awaiting the reader, so the handler's
// finally never ran and the concurrency slot leaked until process restart.
// Ten leaks = every request 504s `queue-timeout` while /health stays green.
//
// Hermetic: scripted upstream via ProxyOptions.fetchImpl (an infinite SSE
// that errors its stream on abort, like a real fetch body), API-key mode so
// no OAuth pool or network, and the injectable upstreamTimeoutMs added for
// exactly this test so the timeout → release path runs in seconds.
//
// Also locks down the #905 observability ask: /health and /analytics now
// carry the queue snapshot (active/queued/maxConcurrent/maxQueued).

import net from 'node:net';
import { startProxy } from '../dist/proxy.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stay clear of dario's 3456-3460 range and other test files' ports.
const PORT = 38773;
const BASE = `http://127.0.0.1:${PORT}`;
const UPSTREAM_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Scripted upstream.
//   - stream:true  → infinite SSE; the ReadableStream errors when the abort
//     signal fires, mirroring a real aborted fetch body.
//   - otherwise    → immediate JSON OK.
// ---------------------------------------------------------------------------
const OK_BODY = {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-5',
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};
// One well-formed SSE event, repeated forever. Small event, big chunks, so
// the client socket buffer fills fast once the client stops reading.
const SSE_EVENT = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n';
const SSE_CHUNK = new TextEncoder().encode(SSE_EVENT.repeat(300)); // ~35KB

const fakeFetch = async (url, init) => {
  const body = init?.body ? Buffer.from(init.body).toString('utf8') : '';
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* non-JSON — fine */ }
  if (parsed.stream === true) {
    const stream = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          try { controller.error(new Error('upstream aborted')); } catch { /* already closed */ }
        });
      },
      pull(controller) {
        if (init?.signal?.aborted) return;
        controller.enqueue(SSE_CHUNK);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'content-type': 'application/json' } });
};

await startProxy({
  port: PORT,
  host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key',
  noClaudeAuth: true,
  fetchImpl: fakeFetch,
  maxConcurrent: 1,       // one leaked slot = total wedge, so the leak is directly observable
  queueTimeoutMs: 1_500,  // a wedged queue surfaces as a fast 504, not a hung test
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const health = async () => (await fetch(`${BASE}/health`)).json();

// ---------------------------------------------------------------------------
header('/health and /analytics expose the queue snapshot (the #905 ask)');
{
  const h = await health();
  check('/health has queue', typeof h.queue === 'object' && h.queue !== null, JSON.stringify(h));
  check('/health queue shape', h.queue && h.queue.active === 0 && h.queue.queued === 0
    && h.queue.maxConcurrent === 1 && h.queue.maxQueued === 128, JSON.stringify(h.queue));
  const a = await (await fetch(`${BASE}/analytics`)).json();
  check('/analytics has queue', typeof a.queue === 'object' && a.queue !== null, JSON.stringify(Object.keys(a)));
  check('/analytics queue shape', a.queue && a.queue.maxConcurrent === 1
    && typeof a.queue.active === 'number' && typeof a.queue.queued === 'number', JSON.stringify(a.queue));
}

// ---------------------------------------------------------------------------
header('a connected-but-not-reading streaming client cannot leak its slot');
{
  // Client A: raw socket so we control reading. Send a streaming request,
  // take the first data event, then pause() forever — socket stays open,
  // no 'drain', no 'close'. This is the #905 wedge client.
  const reqBody = JSON.stringify({
    model: 'claude-opus-4-5', max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const sock = net.connect(PORT, '127.0.0.1');
  let sawData = false;
  await new Promise((resolve, reject) => {
    sock.on('connect', () => {
      sock.write(
        `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
        `content-type: application/json\r\nanthropic-version: 2023-06-01\r\n` +
        `content-length: ${Buffer.byteLength(reqBody)}\r\n\r\n` + reqBody,
      );
    });
    sock.once('data', () => { sawData = true; sock.pause(); resolve(); });
    sock.once('error', reject);
    setTimeout(() => reject(new Error('no response bytes within 5s')), 5_000);
  });
  check('client A got first response bytes, then stopped reading', sawData);

  // Give the proxy time to fill A's socket buffer and park in the drain wait.
  await sleep(1_000);
  let h = await health();
  check('mid-stream: slot held (queue.active === 1)', h.queue?.active === 1, JSON.stringify(h.queue));

  // Upstream timeout fires at 3s. Pre-fix: the drain wait never resolves, the
  // slot stays held forever, and every later request 504s queue-timeout.
  // Post-fix: the abort settles the wait, teardown runs, the slot releases.
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS + 5_000;
  let released = false;
  while (Date.now() < deadline) {
    h = await health();
    if (h.queue?.active === 0) { released = true; break; }
    await sleep(250);
  }
  check('slot released after upstream timeout despite silent client', released, JSON.stringify(h.queue));

  // The real victim in #905: the NEXT request. It must get a slot and a 200,
  // not a 504 queue-timeout.
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const resBody = await res.json().catch(() => ({}));
  check('follow-up request admitted and served (200, not 504 queue-timeout)', res.status === 200, `got ${res.status} ${JSON.stringify(resBody)}`);
  check('follow-up got real content', resBody?.content?.[0]?.text === 'OK');

  sock.destroy();
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

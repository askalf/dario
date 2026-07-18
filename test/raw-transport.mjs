// Unit tests for the raw HTTP/1.1 upstream transport (src/raw-transport.ts,
// dario#813 finding #2). The socket layer is injected, so we drive the full
// request-serialization + response-parse (chunked, gzip, content-length,
// streaming, abort) path under Node over node:net — no Bun/TLS round-trip
// needed. The Bun.connect JA3 + header-order-on-the-wire facts are verified
// separately (measured); this covers the framing/decode/stream correctness.

import net from 'node:net';
import zlib from 'node:zlib';
import { rawUpstreamFetch, rawTransportEnabled } from '../dist/raw-transport.js';

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { console.log(`  ✅ ${l}`); pass++; } else { console.log(`  ❌ ${l}`); fail++; } };
const header = (l) => { console.log(`\n======================================================================\n  ${l}\n======================================================================`); };

// node:net socket factory — the injectable stand-in for bunSocketFactory.
function nodeFactory(opts) {
  const sock = net.connect(opts.port, opts.host, () =>
    opts.onOpen((b) => sock.write(Buffer.from(b)), () => sock.end()));
  sock.on('data', (d) => opts.onData(new Uint8Array(d)));
  sock.on('close', () => opts.onClose());
  sock.on('error', (e) => opts.onError(e));
}

const SSE = [
  'event: message_start\ndata: {"type":"message_start"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
const httpChunk = (b) => { b = Buffer.from(b); return Buffer.concat([Buffer.from(b.length.toString(16) + '\r\n'), b, Buffer.from('\r\n')]); };

// Mock upstream: chunked SSE (optionally gzip), captures the request head.
function startSseMock({ gzip = false } = {}) {
  const state = { reqHead: null };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      state.reqHead = buf.slice(0, end).toString('latin1');
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n' + (gzip ? 'Content-Encoding: gzip\r\n' : '') + '\r\n');
      const gz = gzip ? zlib.createGzip() : null;
      const parts = [];
      const drain = () => { while (parts.length) sock.write(httpChunk(parts.shift())); };
      if (gz) {
        gz.on('data', (d2) => parts.push(d2));
        // readable 'end' fires after the LAST data event — so `parts` holds the
        // complete gzip member (incl. trailer) before we send the terminator.
        gz.on('end', () => { drain(); sock.write('0\r\n\r\n'); sock.end(); server.close(); });
      }
      let i = 0;
      const pump = () => {
        if (i < SSE.length) {
          const ev = SSE[i++];
          if (gz) { gz.write(ev); gz.flush(zlib.constants.Z_SYNC_FLUSH, () => { drain(); setTimeout(pump, 15); }); }
          else { sock.write(httpChunk(ev)); setTimeout(pump, 15); }
        } else if (gz) gz.end();
        else { sock.write('0\r\n\r\n'); sock.end(); server.close(); }
      };
      pump();
    });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, state, close: () => server.close() })));
}

// Mock upstream: fixed content-length body (error / non-stream path).
function startFixedMock({ status = 400, body = '{"error":"bad"}' } = {}) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.indexOf('\r\n\r\n') === -1) return;
      const b = Buffer.from(body);
      sock.write(`HTTP/1.1 ${status} Status\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n`);
      sock.write(b); sock.end(); server.close();
    });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, close: () => server.close() })));
}

async function readAll(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  return out;
}

const ORDERED = [
  ['X-Claude-Code-Session-Id', 'sess'],
  ['Authorization', 'Bearer x'],
  ['anthropic-beta', 'oauth-2025-04-20'],
  ['Content-Type', 'application/json'],
  ['User-Agent', 'claude-cli/2.1.214'],
  ['anthropic-version', '2023-06-01'],
];

async function main() {
  header('rawTransportEnabled — gated by env AND Bun availability');
  {
    check('unset env → false', rawTransportEnabled({}) === false);
    // Under Node (this test runner) Bun.connect is absent, so even with the
    // flag set it must be false — the caller then keeps using fetch.
    check('flag set but no Bun → false (safe fallback)', rawTransportEnabled({ DARIO_RAW_TRANSPORT: '1' }) === false);
  }

  header('chunked SSE — streaming reconstruct + header order/casing on the wire');
  {
    const mock = await startSseMock({ gzip: false });
    const resp = await rawUpstreamFetch(`http://127.0.0.1:${mock.port}/v1/messages`, { method: 'POST', headers: ORDERED, body: '{}' }, nodeFactory);
    check('status 200', resp.status === 200);
    check('content-type surfaced', /event-stream/.test(resp.headers.get('content-type') || ''));
    check('transfer-encoding stripped from surfaced headers', resp.headers.get('transfer-encoding') === null);
    const text = await readAll(resp);
    check('full SSE stream reconstructed', text.includes('message_start') && text.includes('"text":"Hi"') && text.includes('message_stop'));
    const names = mock.state.reqHead.split('\r\n').slice(1).map((l) => l.slice(0, l.indexOf(':')));
    const iSession = names.indexOf('X-Claude-Code-Session-Id');
    const iAuth = names.indexOf('Authorization');
    check('mixed-case header names preserved verbatim', iSession !== -1 && iAuth !== -1);
    check('sent header order preserved (session before auth)', iSession >= 0 && iSession < iAuth);
    check('NOT alphabetized (Accept-* would sort first under fetch)', names[0] === 'X-Claude-Code-Session-Id');
    check('no undici-injected accept-language/sec-fetch-*', !names.some((n) => /accept-language|sec-fetch/i.test(n)));
    check('Host + Content-Length synthesized at tail', names.includes('Host') && names.includes('Content-Length'));
  }

  header('gzip chunked SSE — content-encoding decoded, not surfaced');
  {
    const mock = await startSseMock({ gzip: true });
    const resp = await rawUpstreamFetch(`http://127.0.0.1:${mock.port}/v1/messages`, { method: 'POST', headers: ORDERED, body: '{}' }, nodeFactory);
    check('content-encoding stripped (body already decoded)', resp.headers.get('content-encoding') === null);
    const text = await readAll(resp);
    check('gzip SSE reconstructed', text.includes('message_start') && text.includes('"text":"Hi"') && text.includes('message_stop'));
  }

  header('content-length body — .text() on an error response');
  {
    const mock = await startFixedMock({ status: 400, body: '{"error":"bad"}' });
    const resp = await rawUpstreamFetch(`http://127.0.0.1:${mock.port}/v1/messages`, { method: 'POST', headers: ORDERED, body: '{}' }, nodeFactory);
    check('status 400 surfaced', resp.status === 400);
    check('.text() returns the full body', (await resp.text()) === '{"error":"bad"}');
  }

  header('abort — a pre-aborted signal rejects with AbortError');
  {
    const mock = await startFixedMock({ status: 200, body: '{}' });
    const ac = new AbortController(); ac.abort();
    let name = null;
    try { await rawUpstreamFetch(`http://127.0.0.1:${mock.port}/v1/messages`, { method: 'POST', headers: ORDERED, body: '{}', signal: ac.signal }, nodeFactory); }
    catch (e) { name = e.name; }
    mock.close();
    check('rejects with AbortError', name === 'AbortError');
  }

  console.log(`\n======================================================================\n  Results: ${pass} passed, ${fail} failed\n======================================================================\n`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

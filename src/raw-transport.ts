/**
 * Raw HTTP/1.1 upstream transport (dario#813, finding #2).
 *
 * `fetch()` cannot put CC's request on the wire faithfully: under Bun it
 * alphabetically SORTS request headers (destroying the captured header_order),
 * and under Node/undici it lowercases names and injects `accept-language` /
 * `sec-fetch-mode` that CC never sends. dario's `orderHeadersForOutbound`
 * machinery is therefore a no-op through `fetch` — the ordered header array it
 * builds is re-normalized by the transport before it reaches the socket.
 *
 * The fix is to bypass `fetch` and write the HTTP/1.1 request bytes ourselves
 * over `Bun.connect` — Bun's native socket API, whose TLS ClientHello is
 * byte-identical to Bun's `fetch` (same BoringSSL profile / JA3 as Claude
 * Code), while giving us full control of the request line and header block
 * (exact order + mixed case, zero transport injection). Measured: `Bun.connect`
 * and `fetch` produce the same JA3 (`d871d02c` on the test box); `node:tls`
 * does NOT (different profile), so `Bun.connect` specifically is required.
 *
 * This module returns a standard `Response`, so it is a drop-in for the
 * `fetch(targetBase, …)` upstream calls in proxy.ts — the caller consumes only
 * `.status`, `.headers`, `.text()` and `.body` (a streaming ReadableStream).
 *
 * Opt-in via `DARIO_RAW_TRANSPORT=1`; the default remains `fetch` so this
 * carries zero risk until enabled. Bun-only (needs `Bun.connect`); under Node
 * `rawTransportEnabled()` is false and the caller keeps using `fetch`.
 *
 * The socket layer is injected (`RawSocketFactory`) so the HTTP/1.1 framing,
 * chunked decode, content-encoding decode and streaming can be exercised under
 * Node's test runner over `node:net`, without a real Bun/TLS round-trip.
 *
 * Known follow-up: transport headers (Host / Content-Length, and CC's exact
 * `Connection · Host · Accept-Encoding · Content-Length` tail order) are
 * appended at the tail here rather than positioned from the template's
 * header_order. The app-header order/casing — the axis `fetch` destroyed — is
 * faithful; exact transport-tail positioning is a refinement.
 */

import zlib from 'node:zlib';
import type { Transform } from 'node:stream';

type BunConnect = (opts: {
  hostname: string;
  port: number;
  tls?: boolean | { serverName?: string; rejectUnauthorized?: boolean };
  socket: {
    open(s: BunSocket): void;
    data(s: BunSocket, d: Uint8Array): void;
    close(s: BunSocket): void;
    error(s: BunSocket, e: Error): void;
  };
}) => Promise<BunSocket>;
interface BunSocket { write(d: Uint8Array): number; end(): void; }

function bunApi(): { connect: BunConnect } | undefined {
  return (globalThis as unknown as { Bun?: { connect: BunConnect } }).Bun;
}

/** True when the raw transport can run in this process (Bun present). */
export function rawTransportAvailable(): boolean {
  return typeof bunApi()?.connect === 'function';
}

/** True when the operator opted in AND the runtime supports it. */
export function rawTransportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DARIO_RAW_TRANSPORT === '1' && rawTransportAvailable();
}

export interface RawFetchInit {
  method?: string;
  /** Ordered pair array (from orderHeadersForOutbound) or a plain record. */
  headers?: Array<[string, string]> | Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
}

/**
 * Injectable socket layer. The default (`bunSocketFactory`) opens a
 * `Bun.connect` TLS socket; tests inject a `node:net` implementation. The
 * factory calls `onOpen` with a `write`/`close` pair once connected, then
 * `onData` per inbound chunk, and `onClose`/`onError` on termination.
 */
export type RawSocketFactory = (opts: {
  host: string;
  port: number;
  tls: boolean;
  onOpen: (write: (bytes: Uint8Array) => void, close: () => void) => void;
  onData: (bytes: Uint8Array) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}) => void;

/** Default socket layer: a Bun.connect TLS (or plaintext) socket. */
export const bunSocketFactory: RawSocketFactory = (opts) => {
  const Bun = bunApi();
  if (!Bun) { opts.onError(new Error('raw transport requires Bun.connect')); return; }
  Bun.connect({
    hostname: opts.host,
    port: opts.port,
    tls: opts.tls ? { serverName: opts.host } : false,
    socket: {
      open(s) { opts.onOpen((b) => s.write(b), () => s.end()); },
      data(_s, d) { opts.onData(d); },
      close() { opts.onClose(); },
      error(_s, e) { opts.onError(e); },
    },
  }).catch((e: unknown) => opts.onError(e instanceof Error ? e : new Error(String(e))));
};

function toPairs(h: RawFetchInit['headers']): Array<[string, string]> {
  if (!h) return [];
  if (Array.isArray(h)) return h.map(([k, v]) => [k, String(v)] as [string, string]);
  return Object.entries(h).map(([k, v]) => [k, String(v)] as [string, string]);
}

/** Statuses that must not carry a response body per the fetch spec. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * `fetch`-shaped upstream call over a raw socket. Returns a `Response` whose
 * `.body` streams the decoded (chunked + content-encoding removed) upstream
 * bytes as they arrive, so the streaming SSE path in proxy.ts works unchanged.
 */
export function rawUpstreamFetch(
  url: string,
  init: RawFetchInit = {},
  socketFactory: RawSocketFactory = bunSocketFactory,
): Promise<Response> {
  const u = new URL(url);
  const isTls = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : (isTls ? 443 : 80);
  const host = u.hostname;
  const pathQ = (u.pathname || '/') + u.search;
  const method = (init.method ?? 'POST').toUpperCase();
  const bodyBuf = init.body == null
    ? Buffer.alloc(0)
    : (typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : Buffer.from(init.body));

  // Serialize headers verbatim (exact order + case). Append the transport
  // headers CC's own transport adds, if the caller didn't already include them.
  const pairs = toPairs(init.headers);
  const present = new Set(pairs.map(([k]) => k.toLowerCase()));
  const tail: Array<[string, string]> = [];
  if (!present.has('host')) tail.push(['Host', u.host]);
  if (!present.has('content-length') && !present.has('transfer-encoding')) {
    tail.push(['Content-Length', String(bodyBuf.length)]);
  }
  let head = `${method} ${pathQ} HTTP/1.1\r\n`;
  for (const [k, v] of [...pairs, ...tail]) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const reqBytes = new Uint8Array(Buffer.concat([Buffer.from(head, 'latin1'), bodyBuf]));

  return new Promise<Response>((resolve, reject) => {
    let phase: 'head' | 'body' = 'head';
    let acc: Buffer = Buffer.alloc(0);
    let status = 0;
    let statusText = '';
    const respHeaders = new Headers();
    let te = '';
    let ce = '';
    let contentLength = -1;
    let bodyRead = 0;
    let cst: 'size' | 'data' | 'crlf' = 'size';
    let crem = 0;
    let decode: Transform | null = null;
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let resolved = false;
    let bodyClosed = false;
    let bodyComplete = false;
    let closeSocket: (() => void) | undefined;

    const bodyStream = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; },
      cancel() { destroy(); },
    });

    function enqueue(b: Buffer) { if (ctrl && b.length) ctrl.enqueue(new Uint8Array(b)); }
    function endStream() { if (ctrl && !bodyClosed) { bodyClosed = true; try { ctrl.close(); } catch { /* already closed */ } } }
    function errorStream(e: unknown) { if (ctrl && !bodyClosed) { bodyClosed = true; try { ctrl.error(e); } catch { /* already closed */ } } }
    function destroy() { try { closeSocket?.(); } catch { /* socket already gone */ } }

    function setupDecode() {
      if (ce === 'gzip' || ce === 'x-gzip') decode = zlib.createGunzip();
      else if (ce === 'deflate') decode = zlib.createInflate();
      else if (ce === 'br') decode = zlib.createBrotliDecompress();
      else if (ce === 'zstd' && 'createZstdDecompress' in zlib) {
        decode = (zlib as unknown as { createZstdDecompress(): Transform }).createZstdDecompress();
      } else decode = null;
      if (decode) {
        decode.on('data', (d: Buffer) => enqueue(d));
        decode.on('end', () => endStream());
        decode.on('error', (e) => errorStream(e));
      }
    }
    function onBodyBytes(b: Buffer) { if (decode) decode.write(b); else enqueue(b); }
    // Body is logically complete (chunk terminator seen, content-length reached,
    // or connection-close EOF). Mark it BEFORE ending the decoder, whose flush
    // is async — the socket may close before the decoder emits 'end', and
    // onClose must not treat that as a truncation.
    function finishBody() { bodyComplete = true; if (decode) decode.end(); else endStream(); }

    function processChunked(): void {
      for (;;) {
        if (cst === 'size') {
          const nl = acc.indexOf('\r\n');
          if (nl === -1) return;
          const size = parseInt(acc.subarray(0, nl).toString('latin1').split(';')[0].trim(), 16);
          acc = acc.subarray(nl + 2);
          if (!Number.isFinite(size)) { errorStream(new Error('bad chunk size')); destroy(); return; }
          if (size === 0) { finishBody(); return; }
          crem = size; cst = 'data';
        } else if (cst === 'data') {
          if (acc.length < crem) { onBodyBytes(acc); crem -= acc.length; acc = Buffer.alloc(0); return; }
          onBodyBytes(acc.subarray(0, crem)); acc = acc.subarray(crem); cst = 'crlf';
        } else {
          if (acc.length < 2) return;
          acc = acc.subarray(2); cst = 'size';
        }
      }
    }

    function feed(chunk: Buffer) {
      acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
      if (phase === 'head') {
        const end = acc.indexOf('\r\n\r\n');
        if (end === -1) return;
        const lines = acc.subarray(0, end).toString('latin1').split('\r\n');
        const m = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/.exec(lines.shift() ?? '');
        if (!m) { const e = new Error('malformed status line'); if (!resolved) reject(e); destroy(); return; }
        status = Number(m[1]); statusText = m[2] ?? '';
        for (const line of lines) {
          const c = line.indexOf(':'); if (c === -1) continue;
          const name = line.slice(0, c).trim();
          const val = line.slice(c + 1).trim();
          const ln = name.toLowerCase();
          if (ln === 'transfer-encoding') { te = val.toLowerCase(); continue; }
          if (ln === 'content-encoding') { ce = val.toLowerCase(); continue; }
          if (ln === 'content-length') { contentLength = Number(val); continue; }
          // content-encoding/length/transfer-encoding are dropped from the
          // surfaced headers because we decode + de-chunk the body here, exactly
          // as fetch strips them after auto-decompression.
          respHeaders.append(name, val);
        }
        setupDecode();
        acc = acc.subarray(end + 4);
        phase = 'body';
        resolved = true;
        const hasBody = !NULL_BODY_STATUS.has(status);
        resolve(new Response(hasBody ? bodyStream : null, { status, statusText, headers: respHeaders }));
        if (!hasBody) { endStream(); return; }
      }
      if (phase === 'body') {
        if (te === 'chunked') processChunked();
        else if (contentLength >= 0) {
          const take = Math.min(acc.length, contentLength - bodyRead);
          if (take > 0) { onBodyBytes(acc.subarray(0, take)); bodyRead += take; acc = acc.subarray(take); }
          if (bodyRead >= contentLength) finishBody();
        } else if (acc.length) { onBodyBytes(acc); acc = Buffer.alloc(0); }
      }
    }

    if (init.signal) {
      if (init.signal.aborted) { reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
      init.signal.addEventListener('abort', () => {
        const e = new DOMException('The operation was aborted.', 'AbortError');
        if (!resolved) reject(e);
        errorStream(e); destroy();
      }, { once: true });
    }

    socketFactory({
      host, port, tls: isTls,
      onOpen: (write, close) => { closeSocket = close; write(reqBytes); },
      onData: (d) => feed(Buffer.from(d)),
      onClose: () => {
        if (phase !== 'body') { if (!resolved) reject(new Error('upstream closed before response headers')); return; }
        // Body already complete — the decoder's async flush (if any) will close
        // the stream via its 'end'. A socket close here is expected, not a fault.
        if (bodyComplete) return;
        // No content-length and not chunked: the close IS the end-of-body signal.
        if (te !== 'chunked' && contentLength < 0) { finishBody(); return; }
        // Otherwise a close before the terminator / declared length is a real
        // truncation — surface it as a stream error rather than silent EOF.
        errorStream(new Error('upstream closed before body completed'));
      },
      onError: (e) => { if (!resolved) reject(e); errorStream(e); },
    });
  });
}

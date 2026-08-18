// Minimal hand-rolled RESP2 client — dario's 0-runtime-deps invariant means
// no `redis`/`ioredis` package here either. Implements exactly the ~5
// commands server.mjs needs (SET with NX+PX, GET, EVAL, PTTL, AUTH) over a
// single persistent TCP connection, RESP2 wire format only (no RESP3, no
// pub/sub, no pipelining beyond natural sequential await-per-command —
// none of that complexity is needed for a lock server's request volume).
//
// RESP2 reply types this parses: simple string (+), error (-), integer (:),
// bulk string ($, including nil $-1), array (*, including nil *-1 and
// nested arrays for EVAL results). That's the complete set Redis ever
// sends for the commands below.
import { connect } from 'node:net';

const CRLF = '\r\n';

function encodeCommand(args) {
  let out = `*${args.length}${CRLF}`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}${CRLF}${s}${CRLF}`;
  }
  return out;
}

/** Parse ONE complete RESP reply from the front of `buf`, starting at
 *  `offset`. Returns {value, next} on success, or null if `buf` doesn't
 *  yet contain a complete reply (caller should wait for more data). */
function parseReply(buf, offset) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf(CRLF, offset + 1);
  if (lineEnd === -1) return null;
  const line = buf.toString('utf-8', offset + 1, lineEnd);
  const afterLine = lineEnd + 2;

  switch (type) {
    case '+': // simple string
      return { value: line, next: afterLine };
    case '-': // error
      return { value: new Error(line), next: afterLine, isError: true };
    case ':': // integer
      return { value: Number(line), next: afterLine };
    case '$': { // bulk string
      const len = Number(line);
      if (len === -1) return { value: null, next: afterLine };
      const dataEnd = afterLine + len;
      if (buf.length < dataEnd + 2) return null; // incomplete
      return { value: buf.toString('utf-8', afterLine, dataEnd), next: dataEnd + 2 };
    }
    case '*': { // array
      const count = Number(line);
      if (count === -1) return { value: null, next: afterLine };
      const items = [];
      let pos = afterLine;
      for (let i = 0; i < count; i++) {
        const r = parseReply(buf, pos);
        if (!r) return null; // incomplete — need more data
        items.push(r.value);
        pos = r.next;
      }
      return { value: items, next: pos };
    }
    default:
      throw new Error(`unexpected RESP type byte: ${type} (${JSON.stringify(line)})`);
  }
}

export class RespClient {
  constructor({ host, port, password, connectTimeoutMs = 5000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.queue = []; // pending { resolve, reject } in send order — RESP2 replies come back in order
    this.connecting = null;
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('redis connect timeout')); }, this.connectTimeoutMs);
      sock.once('connect', () => { clearTimeout(timer); this.socket = sock; this.connecting = null; resolve(); });
      sock.once('error', (e) => { clearTimeout(timer); this.connecting = null; reject(e); });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('close', () => {
        this.socket = null;
        // Fail every still-pending command rather than hang forever.
        for (const p of this.queue.splice(0)) p.reject(new Error('redis connection closed'));
      });
    });
    await this.connecting;
    if (this.password) await this.send('AUTH', this.password);
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const r = parseReply(this.buf, 0);
      if (!r) return; // wait for more data
      this.buf = this.buf.subarray(r.next);
      const pending = this.queue.shift();
      if (!pending) continue; // stray reply, nothing was waiting (shouldn't happen)
      if (r.isError) pending.reject(r.value); else pending.resolve(r.value);
    }
  }

  async send(...args) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  close() {
    if (this.socket) this.socket.end();
  }
}

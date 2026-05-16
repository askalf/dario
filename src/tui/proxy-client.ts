/**
 * Proxy HTTP client for the TUI.
 *
 * The TUI runs as its own process (`dario` with no args). It talks to
 * a separately-running `dario proxy` over HTTP on localhost. This
 * module is the thin client layer: JSON fetch + Server-Sent Events
 * subscription + a `/health` reachability probe.
 *
 * Why not use fetch(): Node 22's global fetch works fine for one-shot
 * JSON, but SSE streaming through it is awkward (the response.body
 * is a WHATWG ReadableStream that needs an extra Node-stream adapter
 * to handle line splitting cleanly across chunks). Using `node:http`
 * directly keeps the SSE flow simple and matches the streaming hot-
 * path the proxy itself uses.
 *
 * Zero deps as ever.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { URL } from 'node:url';

export interface ProxyClientOpts {
  /** Base URL of the running proxy, e.g. `http://127.0.0.1:3456`. */
  baseUrl: string;
  /** Optional API key — sent as `x-api-key` header. */
  apiKey?: string;
  /** Timeout for one-shot requests (ms). SSE subscriptions ignore this. */
  timeoutMs?: number;
}

export class ProxyClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(opts: ProxyClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  /**
   * GET a JSON endpoint. Rejects on non-2xx, network failure, JSON
   * parse error, or timeout.
   */
  async getJson<T = unknown>(path: string): Promise<T> {
    const url = new URL(this.baseUrl + path);
    return new Promise<T>((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        headers: this.headers(),
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body) as T); }
          catch (e) { reject(new Error(`JSON parse: ${(e as Error).message}`)); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`timeout after ${this.timeoutMs}ms`));
      });
      req.end();
    });
  }

  /**
   * Reachability probe — GET /health, returns parsed payload on
   * success or null on any failure. Never throws; callers use the
   * null as "proxy not running / unreachable".
   */
  async health(): Promise<HealthResponse | null> {
    try { return await this.getJson<HealthResponse>('/health'); }
    catch { return null; }
  }

  /**
   * Subscribe to /analytics/stream SSE. Calls `onMessage` for each
   * data frame (parsed as JSON). Returns a `close()` function that
   * unsubscribes — the caller MUST call this on unmount or the
   * underlying socket leaks.
   *
   * Auto-reconnect is intentionally NOT included. The Hits tab decides
   * when to retry (and how often) — pushing that policy into here would
   * couple the client to UI semantics.
   *
   * v4.1 (dario#288): the proxy emits named events alongside the default
   * 'message' event — `event: overage_halt`, `event: overage_warn`,
   * `event: overage_resume`. The `eventType` passed to `onMessage` is
   * the value of the `event:` line on the frame (or `'message'` for an
   * unlabeled / default frame). Existing consumers that pass a
   * single-arg callback continue to work unchanged.
   */
  subscribeAnalyticsStream<T = unknown>(
    onMessage: (msg: T, eventType?: string) => void,
    onError?: (err: Error) => void,
  ): () => void {
    const url = new URL(this.baseUrl + '/analytics/stream');
    let closed = false;
    let res: IncomingMessage | null = null;
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { ...this.headers(), 'Accept': 'text/event-stream' },
    }, (response) => {
      if (closed) { response.destroy(); return; }
      res = response;
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        onError?.(new Error(`HTTP ${response.statusCode}`));
        response.destroy();
        return;
      }
      response.setEncoding('utf-8');
      let buf = '';
      response.on('data', (chunk: string) => {
        if (closed) return;
        buf += chunk;
        // SSE frames are separated by a blank line. Each frame can
        // have a `data:` field (possibly across multiple `data:` lines
        // — we concatenate them with \n per the SSE spec).
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split('\n');
          const dataLines = lines
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, ''));
          if (dataLines.length === 0) continue;
          // Pull the `event:` line if present. Default is 'message' per SSE spec.
          const eventLine = lines.find(l => l.startsWith('event:'));
          const eventType = eventLine ? eventLine.slice(6).trim() : 'message';
          const payload = dataLines.join('\n');
          try {
            const parsed = JSON.parse(payload) as T;
            onMessage(parsed, eventType);
          } catch (e) {
            onError?.(new Error(`SSE parse: ${(e as Error).message}`));
          }
        }
      });
      response.on('error', (e) => { if (!closed) onError?.(e); });
      response.on('end', () => { if (!closed) onError?.(new Error('stream ended')); });
    });
    req.on('error', (e) => { if (!closed) onError?.(e); });
    // No timeout on SSE — the heartbeat keeps the connection alive.
    req.end();
    return () => {
      closed = true;
      try { req.destroy(); } catch { /* ignored */ }
      try { res?.destroy(); } catch { /* ignored */ }
    };
  }

  /**
   * Query the overage-guard state (v4.1, dario#288). Returns the current
   * halt state + configuration. Returns null on any error so the Status
   * tab can render "unknown" without crashing.
   */
  async getOverageGuard(): Promise<OverageGuardStatus | null> {
    try { return await this.getJson<OverageGuardStatus>('/admin/resume'); }
    catch { return null; }
  }

  /**
   * Clear the overage-guard halt state. POSTs /admin/resume. Returns the
   * server's response (`wasHalted` indicates whether the call actually
   * cleared a halt vs no-op'd on already-clear state).
   */
  async resume(): Promise<{ ok: boolean; wasHalted: boolean; resumedAt: string }> {
    const url = new URL(this.baseUrl + '/admin/resume');
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json', 'Content-Length': '2' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse: ${(e as Error).message}`)); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`timeout after ${this.timeoutMs}ms`));
      });
      req.write('{}');
      req.end();
    });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }
}

export interface OverageGuardStatus {
  halted: boolean;
  state: {
    since: number;
    cooldownUntil: number;
    reason: string;
    request: { timestamp: number; model: string; account: string; claim: string };
  } | null;
  config: {
    enabled: boolean;
    behavior: 'halt' | 'warn';
    cooldownMs: number;
    notifyOs: boolean;
  };
}

export interface HealthResponse {
  status: string;
  oauth: string;
  expiresIn?: string;
  requests?: number;
}

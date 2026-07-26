/**
 * Stub of the dario proxy's TUI-facing endpoints.
 *
 * Lets the TUI audit exercise the real network + SSE paths without a live
 * proxy and without touching production. Serves everything ProxyClient
 * calls: /health, /v1/models, /admin/resume (GET), /analytics, /accounts,
 * and the /analytics/stream SSE feed.
 *
 * Listens on 39456 by default — deliberately NOT 3456, so it can never
 * collide with a real `dario proxy` on the same box.
 *
 * Used by audit.mjs; also runnable standalone:
 *   node tools/tui-audit/stub-proxy.mjs
 */
import { createServer } from 'node:http';

export const DEFAULT_PORT = 39456;

const MODEL = 'claude-opus-4-5-20260101';
const ACCOUNT = 'operator@example.com';

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const record = (i, now) => ({
  timestamp: now - (20 - i) * 1000,
  account: ACCOUNT,
  model: i % 3 === 0 ? MODEL : 'claude-sonnet-5-20260115',
  inputTokens: 1000 + i * 137,
  outputTokens: 500 + i * 61,
  cacheReadTokens: i % 2 ? 2048 : 0,
  cacheCreateTokens: i % 4 ? 512 : 0,
  thinkingTokens: i % 5 ? 256 : 0,
  claim: i % 7 === 6 ? 'extra_usage' : 'subscription',
  util5h: 0.1 + (i % 9) / 10,
  util7d: 0.05 + (i % 7) / 20,
  overageUtil: 0,
  latencyMs: 300 + i * 47,
  status: i % 11 === 10 ? 500 : i % 13 === 12 ? 429 : 200,
  isStream: i % 2 === 0,
  isOpenAI: false,
});

/** Start the stub. Returns { server, port, close() }. */
export function startStub({ port = DEFAULT_PORT, halt = true } = {}) {
  const timers = new Set();

  const server = createServer((req, res) => {
    const now = Date.now();
    const path = req.url.split('?')[0];

    if (path === '/health') {
      return json(res, 200, { status: 'ok', oauth: 'healthy', expiresIn: '6h 12m', requests: 1234 });
    }
    if (path === '/v1/models') {
      return json(res, 200, { data: [
        { id: MODEL }, { id: MODEL + '[1m]' },
        { id: 'claude-sonnet-5-20260115' }, { id: 'claude-fable-5' },
        { id: 'claude-haiku-4-5-20251001' },
      ] });
    }
    if (path === '/admin/resume' && req.method === 'GET') {
      return json(res, 200, {
        halted: halt,
        state: halt ? {
          since: now - 240000, cooldownUntil: now + 1560000,
          reason: 'representative-claim=extra_usage',
          request: { timestamp: now - 240000, model: MODEL, account: ACCOUNT, claim: 'extra_usage' },
        } : null,
        config: { enabled: true, behavior: 'halt', cooldownMs: 1800000, notifyOs: true },
      });
    }
    if (path === '/analytics') {
      return json(res, 200, {
        window: {
          minutes: 60, requests: 128, totalInputTokens: 1284321, totalOutputTokens: 486210,
          totalThinkingTokens: 41200, estimatedCost: 12.4471, avgLatencyMs: 1842,
          subscriptionPercent: 94,
          billingBucketBreakdown: { subscription: 120, extra_usage: 6, api: 2 },
        },
        allTime: { requests: 98213 },
        perModel: {
          [MODEL]: { requests: 84, totalInputTokens: 901221, totalOutputTokens: 322110 },
          'claude-sonnet-5-20260115': { requests: 44, totalInputTokens: 383100, totalOutputTokens: 164100 },
        },
        utilization: { lastUtil5h: 0.62, lastUtil7d: 0.31 },
        perAccount: {
          [ACCOUNT]: { requests: 96, currentUtil5h: 0.62, currentUtil7d: 0.31, lastClaim: 'subscription' },
          'secondary@example.com': { requests: 32, currentUtil5h: 0.18, currentUtil7d: 0.09, lastClaim: 'extra_usage' },
        },
      });
    }
    if (path === '/accounts') {
      return json(res, 200, { mode: 'pool', accounts: [
        { alias: ACCOUNT, expiresInMs: 22320000, util5h: 0.62, util7d: 0.31, status: 'active' },
        { alias: 'secondary@example.com', expiresInMs: 5400000, util5h: 0.18, util7d: 0.09, status: 'active' },
        { alias: 'archive+coldstorage@example.com', expiresInMs: -1, util5h: 0, util7d: 0, status: 'expired' },
      ] });
    }
    if (path === '/analytics/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (let i = 0; i < 20; i++) res.write(`data: ${JSON.stringify(record(i, now))}\n\n`);
      if (halt) {
        res.write(`event: overage_halt\ndata: ${JSON.stringify({
          since: now - 240000,
          cooldownUntil: now + 1560000,
          request: { claim: 'extra_usage', model: MODEL, account: ACCOUNT },
        })}\n\n`);
      }
      let n = 20;
      const t = setInterval(() => {
        if (res.writableEnded) { clearInterval(t); timers.delete(t); return; }
        res.write(`data: ${JSON.stringify(record(n++, Date.now()))}\n\n`);
      }, 400);
      timers.add(t);
      req.on('close', () => { clearInterval(t); timers.delete(t); });
      return;
    }
    json(res, 404, { error: 'not found', path });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      port,
      close: () => new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
    }));
  });
}

// Standalone: `node tools/tui-audit/stub-proxy.mjs`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { port } = await startStub();
  console.log(`stub proxy on http://127.0.0.1:${port}`);
}

/**
 * Dario — API Proxy Server
 *
 * Sits between your app and the Anthropic API.
 * Transparently swaps API key auth for OAuth bearer tokens.
 *
 * Point any Anthropic SDK client at http://localhost:3456 and it just works.
 * No API key needed — your Claude subscription pays for it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getAccessToken, getStatus } from './oauth.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — generous for large prompts, prevents abuse
const ALLOWED_PATH_PREFIX = '/v1/'; // Only proxy Anthropic API paths
const LOCALHOST = '127.0.0.1';
const CORS_ORIGIN = 'http://localhost';

interface ProxyOptions {
  port?: number;
  verbose?: boolean;
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Never leak tokens in error messages
  return msg.replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]');
}

export async function startProxy(opts: ProxyOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const verbose = opts.verbose ?? false;

  // Verify auth before starting
  const status = await getStatus();
  if (!status.authenticated) {
    console.error('[dario] Not authenticated. Run `dario login` first.');
    process.exit(1);
  }

  let requestCount = 0;
  let tokenCostEstimate = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Health check
    if (req.url === '/health' || req.url === '/') {
      const s = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        oauth: s.status,
        expiresIn: s.expiresIn,
        requests: requestCount,
      }));
      return;
    }

    // Status endpoint
    if (req.url === '/status') {
      const s = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s));
      return;
    }

    // Only allow proxying to /v1/* paths — block path traversal
    const urlPath = req.url?.split('?')[0] ?? '';
    if (!urlPath.startsWith(ALLOWED_PATH_PREFIX)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden', message: `Only ${ALLOWED_PATH_PREFIX}* paths are proxied` }));
      return;
    }

    // Only allow POST (Messages API) and GET (models, etc)
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Proxy to Anthropic
    try {
      const accessToken = await getAccessToken();
      requestCount++;

      // Read request body with size limit
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalBytes += buf.length;
        if (totalBytes > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large', max: `${MAX_BODY_BYTES / 1024 / 1024}MB` }));
          return;
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);

      if (verbose) {
        console.log(`[dario] #${requestCount} ${req.method} ${req.url}`);
      }

      // Forward to Anthropic with OAuth token + required beta flag
      const targetUrl = `${ANTHROPIC_API}${req.url}`;

      // Merge any client-provided beta flags with the required oauth flag
      const clientBeta = req.headers['anthropic-beta'] as string | undefined;
      const betaFlags = new Set(['oauth-2025-04-20']);
      if (clientBeta) {
        for (const flag of clientBeta.split(',')) {
          const trimmed = flag.trim();
          if (trimmed.length > 0 && trimmed.length < 100) betaFlags.add(trimmed);
        }
      }

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': req.headers['anthropic-version'] as string || '2023-06-01',
        'anthropic-beta': [...betaFlags].join(','),
        'x-app': 'cli',
      };

      const upstream = await fetch(targetUrl, {
        method: req.method ?? 'POST',
        headers,
        body: body.length > 0 ? body : undefined,
        // @ts-expect-error — duplex needed for streaming
        duplex: 'half',
      });

      // Detect streaming from content-type (reliable) or body (fallback)
      const contentType = upstream.headers.get('content-type') ?? '';
      const isStream = contentType.includes('text/event-stream');

      // Forward response headers
      const responseHeaders: Record<string, string> = {
        'Content-Type': contentType || 'application/json',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      };

      // Forward rate limit headers
      for (const h of ['x-ratelimit-limit-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'request-id']) {
        const v = upstream.headers.get(h);
        if (v) responseHeaders[h] = v;
      }

      res.writeHead(upstream.status, responseHeaders);

      if (isStream && upstream.body) {
        // Stream SSE chunks through
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (err) {
          if (verbose) console.error('[dario] Stream error:', sanitizeError(err));
        }
        res.end();
      } else {
        // Buffer and forward
        const responseBody = await upstream.text();
        res.end(responseBody);

        // Quick token estimate for logging
        if (verbose && responseBody) {
          try {
            const parsed = JSON.parse(responseBody) as { usage?: { input_tokens?: number; output_tokens?: number } };
            if (parsed.usage) {
              const tokens = (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0);
              tokenCostEstimate += tokens;
              console.log(`[dario] #${requestCount} ${upstream.status} — ${tokens} tokens (session total: ${tokenCostEstimate})`);
            }
          } catch { /* not JSON, skip */ }
        }
      }
    } catch (err) {
      console.error('[dario] Proxy error:', sanitizeError(err));
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: sanitizeError(err) }));
    }
  });

  server.listen(port, LOCALHOST, () => {
    const oauthLine = `OAuth: ${status.status} (expires in ${status.expiresIn})`;
    console.log('');
    console.log(`  dario v1.0.0 — http://localhost:${port}`);
    console.log('');
    console.log('  Your Claude subscription is now an API.');
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log('    ANTHROPIC_API_KEY=dario');
    console.log('');
    console.log(`  ${oauthLine}`);
    console.log('');
  });

  // Periodic token refresh (every 15 minutes)
  setInterval(async () => {
    try {
      const s = await getStatus();
      if (s.status === 'expiring') {
        console.log('[dario] Token expiring, refreshing...');
        await getAccessToken(); // triggers refresh
      }
    } catch (err) {
      console.error('[dario] Background refresh error:', err instanceof Error ? err.message : err);
    }
  }, 15 * 60 * 1000);
}

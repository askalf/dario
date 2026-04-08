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

interface ProxyOptions {
  port?: number;
  verbose?: boolean;
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

    // Proxy everything else to Anthropic
    try {
      const accessToken = await getAccessToken();
      requestCount++;

      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks);

      if (verbose) {
        console.log(`[dario] #${requestCount} ${req.method} ${req.url}`);
      }

      // Forward to Anthropic with OAuth token
      const targetUrl = `${ANTHROPIC_API}${req.url}`;
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };

      // Pass through relevant headers
      if (req.headers['anthropic-beta']) {
        headers['anthropic-beta'] = req.headers['anthropic-beta'] as string;
      }

      const upstream = await fetch(targetUrl, {
        method: req.method ?? 'POST',
        headers,
        body: body.length > 0 ? body : undefined,
        // @ts-expect-error — duplex needed for streaming
        duplex: 'half',
      });

      // Check if streaming
      const isStream = req.url?.includes('stream=true') ||
        (body.length > 0 && body.toString().includes('"stream":true') || body.toString().includes('"stream": true'));

      // Forward response headers
      const responseHeaders: Record<string, string> = {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
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
          if (verbose) console.error('[dario] Stream error:', err);
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
      console.error('[dario] Proxy error:', err instanceof Error ? err.message : err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: err instanceof Error ? err.message : 'Unknown' }));
    }
  });

  // Handle CORS preflight
  server.on('request', (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
      });
      res.end();
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║                                                  ║');
    console.log(`  ║   dario proxy running on http://localhost:${port}   ║`);
    console.log('  ║                                                  ║');
    console.log('  ║   Your Claude subscription is now an API.        ║');
    console.log('  ║                                                  ║');
    console.log('  ║   Point any Anthropic SDK at this URL:           ║');
    console.log(`  ║   ANTHROPIC_BASE_URL=http://localhost:${port}      ║`);
    console.log('  ║   ANTHROPIC_API_KEY=dario                        ║');
    console.log('  ║                                                  ║');
    console.log(`  ║   OAuth: ${status.status} (expires in ${status.expiresIn})      `);
    console.log('  ║                                                  ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
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

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
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { arch, platform, version as nodeVersion } from 'node:process';
import { getAccessToken, getStatus } from './oauth.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — generous for large prompts, prevents abuse
const UPSTREAM_TIMEOUT_MS = 300_000; // 5 min — matches Anthropic SDK default
const LOCALHOST = '127.0.0.1';
const CORS_ORIGIN = 'http://localhost';

// Detect installed Claude Code version at startup
function detectClaudeVersion(): string {
  try {
    const out = execSync('claude --version', { timeout: 5000, stdio: 'pipe' }).toString().trim();
    const match = out.match(/^([\d.]+)/);
    return match?.[1] ?? '2.1.96';
  } catch {
    return '2.1.96';
  }
}

function getOsName(): string {
  const p = platform;
  if (p === 'win32') return 'Windows';
  if (p === 'darwin') return 'MacOS';
  return 'Linux';
}

// Persistent session ID per proxy lifetime (like Claude Code does per session)
const SESSION_ID = randomUUID();

// Detect @anthropic-ai/sdk version from installed package
function detectSdkVersion(): string {
  try {
    const pkg = require('@anthropic-ai/sdk/package.json') as { version?: string };
    return pkg.version ?? '0.81.0';
  } catch {
    return '0.81.0';
  }
}

// Model shortcuts — users can pass short names
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5',
};

interface ProxyOptions {
  port?: number;
  verbose?: boolean;
  model?: string;  // Override model in all requests
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

  const cliVersion = detectClaudeVersion();
  const sdkVersion = detectSdkVersion();
  const modelOverride = opts.model ? (MODEL_ALIASES[opts.model] ?? opts.model) : null;
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

    // Allowlisted API paths — only these are proxied (prevents SSRF)
    const rawPath = req.url?.split('?')[0] ?? '';
    const allowedPaths: Record<string, string> = {
      '/v1/messages': `${ANTHROPIC_API}/v1/messages`,
      '/v1/models': `${ANTHROPIC_API}/v1/models`,
      '/v1/complete': `${ANTHROPIC_API}/v1/complete`,
    };
    const targetBase = allowedPaths[rawPath];
    if (!targetBase) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden', message: 'Path not allowed' }));
      return;
    }

    // Only allow POST (Messages API) and GET (models)
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Proxy to Anthropic
    try {
      const accessToken = await getAccessToken();

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

      // Override model in request body if --model flag was set
      let finalBody: Buffer | undefined = body.length > 0 ? body : undefined;
      if (modelOverride && body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          parsed.model = modelOverride;
          finalBody = Buffer.from(JSON.stringify(parsed));
        } catch { /* not JSON, send as-is */ }
      }

      if (verbose) {
        const modelInfo = modelOverride ? ` (model: ${modelOverride})` : '';
        console.log(`[dario] #${requestCount} ${req.method} ${req.url}${modelInfo}`);
      }

      // Build target URL from allowlist (no user input in URL construction)
      const targetUrl = targetBase;

      // Merge any client-provided beta flags with the required oauth flag
      const clientBeta = req.headers['anthropic-beta'] as string | undefined;
      const betaFlags = new Set([
        'oauth-2025-04-20',
        'interleaved-thinking-2025-05-14',
        'prompt-caching-scope-2026-01-05',
        'claude-code-20250219',
      ]);
      if (clientBeta) {
        for (const flag of clientBeta.split(',')) {
          const trimmed = flag.trim();
          if (trimmed.length > 0 && trimmed.length < 100) betaFlags.add(trimmed);
        }
      }

      const headers: Record<string, string> = {
        'accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': req.headers['anthropic-version'] as string || '2023-06-01',
        'anthropic-beta': [...betaFlags].join(','),
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': `claude-cli/${cliVersion} (external, cli)`,
        'x-app': 'cli',
        'x-claude-code-session-id': SESSION_ID,
        'x-client-request-id': randomUUID(),
        'x-stainless-arch': arch,
        'x-stainless-lang': 'js',
        'x-stainless-os': getOsName(),
        'x-stainless-package-version': sdkVersion,
        'x-stainless-retry-count': '0',
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': nodeVersion,
        'x-stainless-timeout': '600',
      };

      const upstream = await fetch(targetUrl, {
        method: req.method ?? 'POST',
        headers,
        body: finalBody ? new Uint8Array(finalBody) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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

      requestCount++;
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
      // Log full error server-side, return generic message to client
      console.error('[dario] Proxy error:', sanitizeError(err));
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: 'Failed to reach upstream API' }));
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[dario] Port ${port} is already in use. Is another dario proxy running?`);
    } else {
      console.error(`[dario] Server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, LOCALHOST, () => {
    const oauthLine = `OAuth: ${status.status} (expires in ${status.expiresIn})`;
    const modelLine = modelOverride ? `Model: ${modelOverride} (all requests)` : 'Model: passthrough (client decides)';
    console.log('');
    console.log(`  dario — http://localhost:${port}`);
    console.log('');
    console.log('  Your Claude subscription is now an API.');
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log('    ANTHROPIC_API_KEY=dario');
    console.log('');
    console.log(`  ${oauthLine}`);
    console.log(`  ${modelLine}`);
    console.log('');
  });

  // Periodic token refresh (every 15 minutes)
  const refreshInterval = setInterval(async () => {
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

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[dario] Shutting down...');
    clearInterval(refreshInterval);
    server.close(() => process.exit(0));
    // Force exit after 5s if connections don't close
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

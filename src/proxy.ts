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

// OpenAI model name → Anthropic model name
const OPENAI_MODEL_MAP: Record<string, string> = {
  'gpt-4.1': 'claude-opus-4-6',
  'gpt-4.1-mini': 'claude-sonnet-4-6',
  'gpt-4.1-nano': 'claude-haiku-4-5',
  'gpt-4o': 'claude-opus-4-6',
  'gpt-4o-mini': 'claude-haiku-4-5',
  'gpt-4-turbo': 'claude-opus-4-6',
  'gpt-4': 'claude-opus-4-6',
  'gpt-3.5-turbo': 'claude-haiku-4-5',
  'o3': 'claude-opus-4-6',
  'o3-mini': 'claude-sonnet-4-6',
  'o4-mini': 'claude-sonnet-4-6',
  'o1': 'claude-opus-4-6',
  'o1-mini': 'claude-sonnet-4-6',
  'o1-pro': 'claude-opus-4-6',
};

/**
 * Translate OpenAI chat completion request → Anthropic Messages request.
 */
function openaiToAnthropic(body: Record<string, unknown>, modelOverride: string | null): Record<string, unknown> {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return body;

  // Extract system messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  // Map model name
  const requestModel = String(body.model || '');
  const model = modelOverride || OPENAI_MODEL_MAP[requestModel] || requestModel;

  const result: Record<string, unknown> = {
    model,
    messages: nonSystemMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
  };

  if (systemMessages.length > 0) {
    result.system = systemMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  }

  if (body.stream) result.stream = true;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  return result;
}

/**
 * Translate Anthropic Messages response → OpenAI chat completion response.
 */
function anthropicToOpenai(body: Record<string, unknown>): Record<string, unknown> {
  const content = body.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.find(c => c.type === 'text')?.text ?? '';
  const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    id: `chatcmpl-${(body.id as string || '').replace('msg_', '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: body.stop_reason === 'end_turn' ? 'stop' : body.stop_reason === 'max_tokens' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

/**
 * Translate Anthropic SSE stream → OpenAI SSE stream.
 */
function translateStreamChunk(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const json = line.slice(6).trim();
  if (json === '[DONE]') return 'data: [DONE]\n\n';

  try {
    const event = JSON.parse(json) as Record<string, unknown>;

    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        return `data: ${JSON.stringify({
          id: 'chatcmpl-dario',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude',
          choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
        })}\n\n`;
      }
    }

    if (event.type === 'message_stop') {
      return `data: ${JSON.stringify({
        id: 'chatcmpl-dario',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'claude',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`;
    }
  } catch { /* skip unparseable */ }
  return null;
}

/**
 * OpenAI-compatible models list.
 */
function openaiModelsList(): Record<string, unknown> {
  const models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
  return {
    object: 'list',
    data: models.map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'anthropic',
    })),
  };
}

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

    // Strip query parameters for endpoint matching
    const urlPath = req.url?.split('?')[0] ?? '';

    // Health check
    if (urlPath === '/health' || urlPath === '/') {
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
    if (urlPath === '/status') {
      const s = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s));
      return;
    }

    // OpenAI-compatible models list
    if (urlPath === '/v1/models' && req.method === 'GET') {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS_ORIGIN });
      res.end(JSON.stringify(openaiModelsList()));
      return;
    }

    // Detect OpenAI-format requests
    const isOpenAI = urlPath === '/v1/chat/completions';

    // Allowlisted API paths — only these are proxied (prevents SSRF)
    const allowedPaths: Record<string, string> = {
      '/v1/messages': `${ANTHROPIC_API}/v1/messages`,
      '/v1/complete': `${ANTHROPIC_API}/v1/complete`,
    };
    const targetBase = isOpenAI ? `${ANTHROPIC_API}/v1/messages` : allowedPaths[urlPath];
    if (!targetBase) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden', message: 'Path not allowed' }));
      return;
    }

    // Only allow POST (Messages/Chat API) and GET (models)
    if (req.method !== 'POST') {
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

      // Translate OpenAI → Anthropic format if needed
      let finalBody: Buffer | undefined = body.length > 0 ? body : undefined;
      if (isOpenAI && body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          const translated = openaiToAnthropic(parsed, modelOverride);
          finalBody = Buffer.from(JSON.stringify(translated));
        } catch { /* not JSON, send as-is */ }
      } else if (modelOverride && body.length > 0) {
        // Override model in request body if --model flag was set
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
        'anthropic-client-platform': 'cli',
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

      // Forward rate limit headers (including unified subscription headers)
      for (const [key, value] of upstream.headers.entries()) {
        if (key.startsWith('x-ratelimit') || key.startsWith('anthropic-ratelimit') || key === 'request-id') {
          responseHeaders[key] = value;
        }
      }

      requestCount++;
      res.writeHead(upstream.status, responseHeaders);

      if (isStream && upstream.body) {
        // Stream SSE chunks through
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (isOpenAI) {
              // Translate Anthropic SSE → OpenAI SSE
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                const translated = translateStreamChunk(line);
                if (translated) res.write(translated);
              }
            } else {
              res.write(value);
            }
          }
          // Flush remaining buffer
          if (isOpenAI && buffer.trim()) {
            const translated = translateStreamChunk(buffer);
            if (translated) res.write(translated);
          }
        } catch (err) {
          if (verbose) console.error('[dario] Stream error:', sanitizeError(err));
        }
        res.end();
      } else {
        // Buffer and forward
        const responseBody = await upstream.text();

        if (isOpenAI && upstream.status >= 200 && upstream.status < 300) {
          // Translate Anthropic response → OpenAI format
          try {
            const parsed = JSON.parse(responseBody) as Record<string, unknown>;
            res.end(JSON.stringify(anthropicToOpenai(parsed)));
          } catch {
            res.end(responseBody);
          }
        } else {
          res.end(responseBody);
        }

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

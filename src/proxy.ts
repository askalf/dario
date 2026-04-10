import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { arch, platform, version as nodeVersion } from 'node:process';
import { getAccessToken, getStatus } from './oauth.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — generous for large prompts, prevents abuse
const UPSTREAM_TIMEOUT_MS = 300_000; // 5 min — matches Anthropic SDK default
const BODY_READ_TIMEOUT_MS = 30_000; // 30s — prevents slow-loris on body reads
const MAX_CONCURRENT = 10; // Max concurrent upstream requests
const LOCALHOST = '127.0.0.1';

// Simple semaphore for concurrency control
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return; }
    return new Promise(resolve => { this.queue.push(() => { this.active++; resolve(); }); });
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Detect installed Claude Code binary at startup
function detectClaudeVersion(): string {
  try {
    const out = execSync('claude --version', { timeout: 5000, stdio: 'pipe' }).toString().trim();
    const match = out.match(/^([\d.]+)/);
    return match?.[1] ?? '2.1.96';
  } catch {
    return '2.1.96';
  }
}

let cliAvailable = false;
function detectCliAvailable(): boolean {
  try {
    execSync('claude --version', { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Convert a non-streaming Messages API response to SSE event stream. */
function jsonToSse(jsonBody: string): string {
  try {
    const msg = JSON.parse(jsonBody) as Record<string, unknown>;
    const events: string[] = [];
    // message_start
    events.push(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...msg, content: [], stop_reason: null } })}\n\n`);
    // content blocks
    const content = msg.content as Array<{ type: string; text?: string; thinking?: string }> | undefined;
    if (content) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        events.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: block.type, ...(block.type === 'text' ? { text: '' } : { thinking: '' }) } })}\n\n`);
        if (block.type === 'text' && block.text) {
          events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } })}\n\n`);
        } else if (block.type === 'thinking' && block.thinking) {
          events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: block.thinking } })}\n\n`);
        }
        events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n\n`);
      }
    }
    // message_stop
    events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    return events.join('');
  } catch {
    return '';
  }
}

const SESSION_ID = randomUUID();
const OS_NAME = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'MacOS' : 'Linux';

// Claude Code device identity — required for Max plan billing classification.
// Without metadata.user_id, Anthropic classifies requests as third-party and
// routes them to Extra Usage billing instead of the Max plan allocation.
function loadClaudeIdentity(): { deviceId: string; accountUuid: string } {
  const paths = [
    join(homedir(), '.claude.json'),              // Windows / Linux / macOS (live config)
    join(homedir(), '.claude', '.claude.json'),    // Alternative location
    join(homedir(), '.claude', 'claude.json'),
  ];
  // Also check backup files as fallback
  try {
    const backupDir = join(homedir(), '.claude', 'backups');
    const files = require('fs').readdirSync(backupDir) as string[];
    const backups = files
      .filter((f: string) => f.startsWith('.claude.json.backup.'))
      .sort()
      .reverse();
    for (const b of backups) paths.push(join(backupDir, b));
  } catch { /* no backups dir */ }

  for (const p of paths) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (data.userID) {
        // accountUuid lives inside oauthAccount, not at root
        const accountUuid = data.oauthAccount?.accountUuid ?? data.accountUuid ?? '';
        return { deviceId: data.userID, accountUuid };
      }
    } catch { /* try next */ }
  }
  return { deviceId: '', accountUuid: '' };
}

// Model shortcuts — users can pass short names
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'opus1m': 'claude-opus-4-6[1m]',
  'sonnet': 'claude-sonnet-4-6',
  'sonnet1m': 'claude-sonnet-4-6[1m]',
  'haiku': 'claude-haiku-4-5',
};

// Beta prefixes that require Extra Usage to be ENABLED on the account.
// context-management and prompt-caching-scope are safe — billing is determined
// solely by the OAuth token's subscription type, not by beta flags.
// Only extended-cache-ttl actually requires Extra Usage availability.
const BILLABLE_BETA_PREFIXES = [
  'extended-cache-ttl-',   // Extended cache TTLs — requires Extra Usage enabled
];

/** Filter out billable betas from client-provided beta header. */
function filterBillableBetas(betas: string): string {
  return betas.split(',').map(b => b.trim()).filter(b =>
    b.length > 0 && !BILLABLE_BETA_PREFIXES.some(p => b.startsWith(p))
  ).join(',');
}

// Orchestration tags injected by agents (Aider, Cursor, OpenCode, etc.)
// that confuse Claude when passed through. Strip before forwarding.
const ORCHESTRATION_TAG_NAMES = [
  'system-reminder', 'env', 'system_information', 'current_working_directory',
  'operating_system', 'default_shell', 'home_directory', 'task_metadata',
  'tool_exec', 'tool_output', 'skill_content', 'skill_files',
  'directories', 'available_skills', 'thinking',
];
const ORCHESTRATION_PATTERNS = ORCHESTRATION_TAG_NAMES.flatMap(tag => [
  new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
  new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'),
]);

/** Strip orchestration wrapper tags from message content. */
function sanitizeContent(text: string): string {
  let result = text;
  for (const pattern of ORCHESTRATION_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** Strip orchestration tags from all messages in a request body. */
function sanitizeMessages(body: Record<string, unknown>): void {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      msg.content = sanitizeContent(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block && 'text' in block && typeof (block as { text: string }).text === 'string') {
          (block as { text: string }).text = sanitizeContent((block as { text: string }).text);
        }
      }
    }
  }
}

// Token anomaly detection — warns on suspicious patterns before billing surprises
interface TokenSnapshot { inputTokens: number; outputTokens: number; cacheRead: number; }
let lastTokenSnapshot: TokenSnapshot | null = null;

function checkTokenAnomalies(usage: Record<string, number>, requestId: string): void {
  const current: TokenSnapshot = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
  if (lastTokenSnapshot && lastTokenSnapshot.inputTokens > 0) {
    const growth = (current.inputTokens - lastTokenSnapshot.inputTokens) / lastTokenSnapshot.inputTokens;
    if (growth > 0.6) {
      const pct = Math.round(growth * 100);
      console.warn(`[dario] TOKEN WARN ${requestId}: Input grew ${pct}% (${lastTokenSnapshot.inputTokens} → ${current.inputTokens}). Possible full replay.`);
    }
    if (current.outputTokens > lastTokenSnapshot.outputTokens * 2 && current.outputTokens > 2000) {
      console.warn(`[dario] TOKEN WARN ${requestId}: Output explosion ${current.outputTokens} tokens (${Math.round(current.outputTokens / lastTokenSnapshot.outputTokens)}x previous).`);
    }
  }
  lastTokenSnapshot = current;
}

// Extended context fallback — cooldown after 1M context failure
let extendedContextUnavailableAt = 0;
const EXTENDED_CONTEXT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// OpenAI model names → Anthropic (fallback if client sends GPT names)
const OPENAI_MODEL_MAP: Record<string, string> = {
  'gpt-5.4': 'claude-opus-4-6',
  'gpt-5.4-mini': 'claude-sonnet-4-6',
  'gpt-5.4-nano': 'claude-haiku-4-5',
  'gpt-5.3': 'claude-opus-4-6',
  'gpt-4': 'claude-opus-4-6',
  'gpt-3.5-turbo': 'claude-haiku-4-5',
};

/** Translate OpenAI chat completion request → Anthropic Messages request. */
function openaiToAnthropic(body: Record<string, unknown>, modelOverride: string | null): Record<string, unknown> {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return body;
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  const model = modelOverride || OPENAI_MODEL_MAP[String(body.model || '')] || String(body.model || 'claude-opus-4-6');
  const result: Record<string, unknown> = {
    model,
    messages: nonSystemMessages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
  };
  if (systemMessages.length > 0) result.system = systemMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  if (body.stream) result.stream = true;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return result;
}

/** Translate Anthropic Messages response → OpenAI chat completion response. */
function anthropicToOpenai(body: Record<string, unknown>): Record<string, unknown> {
  const text = (body.content as Array<{ type: string; text?: string }> | undefined)?.find(c => c.type === 'text')?.text ?? '';
  const u = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    id: `chatcmpl-${(body.id as string || '').replace('msg_', '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: body.stop_reason === 'end_turn' ? 'stop' : 'length' }],
    usage: { prompt_tokens: u?.input_tokens ?? 0, completion_tokens: u?.output_tokens ?? 0, total_tokens: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) },
  };
}

/** Translate Anthropic SSE → OpenAI SSE. */
// Track tool call state across stream chunks
let _streamToolIndex = 0;
let _streamToolId = '';

function translateStreamChunk(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const json = line.slice(6).trim();
  if (json === '[DONE]') return 'data: [DONE]\n\n';
  try {
    const e = JSON.parse(json) as Record<string, unknown>;
    const ts = Math.floor(Date.now() / 1000);

    if (e.type === 'content_block_start') {
      const block = e.content_block as { type: string; id?: string; name?: string } | undefined;
      if (block?.type === 'tool_use' && block.name) {
        _streamToolId = block.id ?? `call_${_streamToolIndex}`;
        return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { tool_calls: [{ index: _streamToolIndex, id: _streamToolId, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] })}\n\n`;
      }
    }

    if (e.type === 'content_block_delta') {
      const d = e.delta as { type: string; text?: string; partial_json?: string } | undefined;
      if (d?.type === 'text_delta' && d.text)
        return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] })}\n\n`;
      if (d?.type === 'input_json_delta' && d.partial_json)
        return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { tool_calls: [{ index: _streamToolIndex, function: { arguments: d.partial_json } }] }, finish_reason: null }] })}\n\n`;
    }

    if (e.type === 'content_block_stop') {
      if (_streamToolId) {
        _streamToolIndex++;
        _streamToolId = '';
      }
      return null;
    }

    if (e.type === 'message_stop') {
      _streamToolIndex = 0;
      _streamToolId = '';
      return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    }
  } catch {}
  return null;
}

const OPENAI_MODELS_LIST = { object: 'list', data: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'].map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'anthropic' })) };

interface ProxyOptions {
  port?: number;
  verbose?: boolean;
  model?: string;  // Override model in all requests
  cliBackend?: boolean;  // Use claude CLI as backend instead of direct API
}

export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Never leak tokens, JWTs, or bearer values in error messages
  return msg
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

/**
 * CLI Backend: route requests through `claude --print` instead of direct API.
 * This bypasses rate limiting because Claude Code's binary has priority routing.
 */
async function handleViaCli(
  body: Buffer,
  model: string | null,
  verbose: boolean,
): Promise<{ status: number; body: string; contentType: string }> {
  try {
    const parsed = JSON.parse(body.toString()) as {
      messages?: Array<{ role: string; content: string }>;
      model?: string;
      max_tokens?: number;
      system?: string;
      stream?: boolean;
    };

    // Extract the last user message as the prompt
    const messages = parsed.messages ?? [];
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) {
      return { status: 400, body: JSON.stringify({ error: 'No user message' }), contentType: 'application/json' };
    }

    const rawModel = model ?? parsed.model ?? 'claude-opus-4-6';
    // Validate model name — only allow alphanumeric, hyphens, dots, underscores
    const effectiveModel = /^[a-zA-Z0-9._-]+$/.test(rawModel) ? rawModel : 'claude-opus-4-6';
    const prompt = typeof lastUser.content === 'string'
      ? lastUser.content
      : JSON.stringify(lastUser.content);

    // Build claude --print command
    const args = ['--print', '--model', effectiveModel];

    // Build system prompt from messages context
    let systemPrompt = parsed.system ?? '';
    // Include conversation history as context
    const history = messages.slice(0, -1);
    if (history.length > 0) {
      const historyText = history.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
      systemPrompt = systemPrompt ? `${systemPrompt}\n\nConversation history:\n${historyText}` : `Conversation history:\n${historyText}`;
    }
    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    if (verbose) {
      console.log(`[dario:cli] model=${effectiveModel} prompt=${prompt.substring(0, 60)}...`);
    }

    // Spawn claude --print
    return new Promise((resolve) => {
      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300_000,
      });

      let stdout = '';
      let stderr = '';
      const MAX_CLI_OUTPUT = 5_000_000; // 5MB cap per stream — prevents OOM from runaway CLI
      child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_CLI_OUTPUT) stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_CLI_OUTPUT) stderr += d.toString(); });

      child.stdin.write(prompt);
      child.stdin.end();

      child.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) {
          resolve({
            status: 502,
            body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: sanitizeError(stderr.substring(0, 200)) || 'CLI backend failed' } }),
            contentType: 'application/json',
          });
          return;
        }

        // Build a proper Messages API response
        const text = stdout.trim();
        const estimatedTokens = Math.ceil(text.length / 4);
        const response = {
          id: `msg_${randomUUID().replace(/-/g, '').substring(0, 24)}`,
          type: 'message',
          role: 'assistant',
          model: effectiveModel,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: Math.ceil(prompt.length / 4),
            output_tokens: estimatedTokens,
          },
        };
        resolve({ status: 200, body: JSON.stringify(response), contentType: 'application/json' });
      });

      child.on('error', (err) => {
        resolve({
          status: 502,
          body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Claude CLI not found. Install Claude Code first.' } }),
          contentType: 'application/json',
        });
      });
    });
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request body' } }),
      contentType: 'application/json',
    };
  }
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
  cliAvailable = detectCliAvailable();
  const modelOverride = opts.model ? (MODEL_ALIASES[opts.model] ?? opts.model) : null;
  const identity = loadClaudeIdentity();
  if (identity.deviceId) {
    console.log('  Device identity: detected');
  } else {
    console.warn('[dario] WARNING: No Claude Code device identity found. Requests may be billed as Extra Usage.');
    console.warn('[dario] Run Claude Code at least once to generate ~/.claude/.claude.json');
  }

  // Pre-build static headers (only auth, version, beta, request-id change per request)
  const staticHeaders: Record<string, string> = {
    'accept': 'application/json',
    'Content-Type': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-client-platform': 'cli',
    'user-agent': `claude-cli/${cliVersion} (external, cli)`,
    'x-app': 'cli',
    'x-claude-code-session-id': SESSION_ID,
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': OS_NAME,
    'x-stainless-package-version': '0.81.0',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': nodeVersion,
    'x-stainless-timeout': '600',
  };
  const useCli = opts.cliBackend ?? false;
  let requestCount = 0;
  const semaphore = new Semaphore(MAX_CONCURRENT);

  // Optional proxy authentication — pre-encode key buffer for performance
  const apiKey = process.env.DARIO_API_KEY;
  const apiKeyBuf = apiKey ? Buffer.from(apiKey) : null;
  const corsOrigin = `http://localhost:${port}`;

  // Security headers for all responses
  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };

  // Pre-serialize static responses
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '86400',
    ...SECURITY_HEADERS,
  };
  const JSON_HEADERS = { 'Content-Type': 'application/json', ...SECURITY_HEADERS };
  const MODELS_JSON = JSON.stringify(OPENAI_MODELS_LIST);
  const ERR_UNAUTH = JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' });
  const ERR_FORBIDDEN = JSON.stringify({ error: 'Forbidden', message: 'Path not allowed' });
  const ERR_METHOD = JSON.stringify({ error: 'Method not allowed' });

  function checkAuth(req: IncomingMessage): boolean {
    if (!apiKeyBuf) return true;
    const provided = (req.headers['x-api-key'] as string)
      || (req.headers.authorization as string)?.replace(/^Bearer\s+/i, '');
    if (!provided) return false;
    const providedBuf = Buffer.from(provided);
    if (providedBuf.length !== apiKeyBuf.length) return false;
    return timingSafeEqual(providedBuf, apiKeyBuf);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

    // Strip query parameters for endpoint matching
    const urlPath = req.url?.split('?')[0] ?? '';

    // Health check
    if (urlPath === '/health' || urlPath === '/') {
      const s = await getStatus();
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({
        status: 'ok',
        oauth: s.status,
        expiresIn: s.expiresIn,
        requests: requestCount,
      }));
      return;
    }

    if (!checkAuth(req)) { res.writeHead(401, JSON_HEADERS); res.end(ERR_UNAUTH); return; }

    // Status endpoint
    if (urlPath === '/status') {
      const s = await getStatus();
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(s));
      return;
    }

    if (urlPath === '/v1/models' && req.method === 'GET') { requestCount++; res.writeHead(200, { ...JSON_HEADERS, 'Access-Control-Allow-Origin': corsOrigin }); res.end(MODELS_JSON); return; }

    // Detect OpenAI-format requests
    const isOpenAI = urlPath === '/v1/chat/completions';

    // Allowlisted API paths — only these are proxied (prevents SSRF)
    // ?beta=true matches native Claude Code behavior for billing classification
    const allowedPaths: Record<string, string> = {
      '/v1/messages': `${ANTHROPIC_API}/v1/messages?beta=true`,
      '/v1/complete': `${ANTHROPIC_API}/v1/complete`,
    };
    const targetBase = isOpenAI ? `${ANTHROPIC_API}/v1/messages?beta=true` : allowedPaths[urlPath];
    if (!targetBase) { res.writeHead(403, JSON_HEADERS); res.end(ERR_FORBIDDEN); return; }
    if (req.method !== 'POST') { res.writeHead(405, JSON_HEADERS); res.end(ERR_METHOD); return; }

    // Proxy to Anthropic (with concurrency control)
    await semaphore.acquire();
    try {
      const accessToken = await getAccessToken();

      // Read request body with size limit and timeout (prevents slow-loris)
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const bodyTimeout = setTimeout(() => { req.destroy(); }, BODY_READ_TIMEOUT_MS);
      try {
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalBytes += buf.length;
          if (totalBytes > MAX_BODY_BYTES) {
            clearTimeout(bodyTimeout);
            res.writeHead(413, JSON_HEADERS);
            res.end(JSON.stringify({ error: 'Request body too large', max: `${MAX_BODY_BYTES / 1024 / 1024}MB` }));
            return;
          }
          chunks.push(buf);
        }
      } finally {
        clearTimeout(bodyTimeout);
      }
      const body = Buffer.concat(chunks);

      // CLI backend mode: route through claude --print (works for both Anthropic and OpenAI endpoints)
      if (useCli && req.method === 'POST' && body.length > 0) {
        let cliBody = body;
        // Translate OpenAI format before passing to CLI
        if (isOpenAI) {
          try {
            const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
            cliBody = Buffer.from(JSON.stringify(openaiToAnthropic(parsed, modelOverride)));
          } catch { /* send as-is */ }
        }
        const cliResult = await handleViaCli(cliBody, modelOverride, verbose);
        requestCount++;
        // Translate CLI response back to OpenAI format if needed
        if (isOpenAI && cliResult.status >= 200 && cliResult.status < 300) {
          try {
            const parsed = JSON.parse(cliResult.body) as Record<string, unknown>;
            cliResult.body = JSON.stringify(anthropicToOpenai(parsed));
          } catch { /* send as-is */ }
        }
        res.writeHead(cliResult.status, {
          'Content-Type': cliResult.contentType,
          'Access-Control-Allow-Origin': corsOrigin,
          ...SECURITY_HEADERS,
        });
        res.end(cliResult.body);
        return;
      }

      // Parse body once, apply OpenAI translation, model override, and sanitization
      let finalBody: Buffer | undefined = body.length > 0 ? body : undefined;
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          // Strip orchestration tags from messages (Aider, Cursor, etc.)
          sanitizeMessages(parsed);
          // Handle 1M context: strip [1m] suffix if in cooldown
          if (modelOverride?.includes('[1m]') && extendedContextUnavailableAt > 0 && Date.now() - extendedContextUnavailableAt < EXTENDED_CONTEXT_COOLDOWN_MS) {
            parsed.model = (modelOverride as string).replace('[1m]', '');
          }
          const result = isOpenAI ? openaiToAnthropic(parsed, modelOverride) : (modelOverride ? { ...parsed, model: modelOverride } : parsed);
          const r = result as Record<string, unknown>;
          // Inject device identity metadata for session tracking
          if (identity.deviceId) {
            r.metadata = {
              user_id: JSON.stringify({
                device_id: identity.deviceId,
                account_uuid: identity.accountUuid,
                session_id: SESSION_ID,
              }),
            };
          }
          // Enable adaptive thinking for models that support it (Opus/Sonnet 4.6+)
          // Haiku 4.5 does not support thinking at all
          const modelName = ((r.model as string) || '').toLowerCase();
          const supportsThinking = !modelName.includes('haiku');
          if (supportsThinking && !r.thinking) {
            r.thinking = { type: 'adaptive' };
            // Ensure max_tokens is reasonable for thinking models
            const clientMax = (r.max_tokens as number) || 8192;
            r.max_tokens = Math.max(clientMax, 16000);
          }
          // Request priority capacity when available
          if (!r.service_tier) {
            r.service_tier = 'auto';
          }
          // Enable context management (matches Claude Code default)
          // Requires thinking to be enabled — skip for models without thinking support (e.g. Haiku)
          if (supportsThinking && !r.context_management) {
            r.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
          }
          // Inject Claude Code billing header into system prompt.
          // Anthropic uses this to route requests through priority rate limiting
          // instead of the general API quota. Without it, Opus/Sonnet get 429
          // when overall utilization is high, even though model-specific limits
          // have headroom. The CLI binary embeds this in its system prompt.
          const billingTag = `x-anthropic-billing-header: cc_version=${cliVersion}; cc_entrypoint=cli; cch=98638;`;
          if (typeof r.system === 'string') {
            if (!r.system.includes('x-anthropic-billing-header:')) {
              r.system = billingTag + '\n' + r.system;
            }
          } else if (Array.isArray(r.system)) {
            const hasTag = (r.system as Array<{ text?: string }>).some(
              b => typeof b.text === 'string' && b.text.includes('x-anthropic-billing-header:'),
            );
            if (!hasTag) {
              (r.system as unknown[]).unshift({ type: 'text', text: billingTag });
            }
          } else {
            r.system = billingTag;
          }
          finalBody = Buffer.from(JSON.stringify(r));
        } catch { /* not JSON, send as-is */ }
      }

      if (verbose) {
        const modelInfo = modelOverride ? ` (model: ${modelOverride})` : '';
        console.log(`[dario] #${requestCount} ${req.method} ${urlPath}${modelInfo}`);
      }

      // Beta defaults — matches native Claude Code v2.1.98 headers exactly.
      // Billing classification is determined by the OAuth token alone, not beta flags.
      // context-management and prompt-caching-scope are safe for all subscription types.
      const clientBeta = req.headers['anthropic-beta'] as string | undefined;
      let beta = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,effort-2025-11-24';
      if (clientBeta) {
        const filtered = filterBillableBetas(clientBeta);
        if (filtered) beta += ',' + filtered;
      }

      const headers: Record<string, string> = {
        ...staticHeaders,
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-version': req.headers['anthropic-version'] as string || '2023-06-01',
        'anthropic-beta': beta,
        'x-client-request-id': randomUUID(),
      };

      const upstream = await fetch(targetBase, {
        method: req.method ?? 'POST',
        headers,
        body: finalBody ? new Uint8Array(finalBody) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      // Auto-fallback: if API returns 429 and CLI is available, retry through CLI binary.
      // The CLI gets priority routing from Anthropic's server — a separate rate limit pool
      // that continues working when the direct API quota is exhausted for expensive models.
      if (upstream.status === 429 && cliAvailable && !useCli) {
        // Drain the upstream response
        await upstream.text().catch(() => {});
        if (verbose) console.log(`[dario] #${requestCount} 429 from API — falling back to CLI`);

        // Determine if the client requested streaming
        let clientWantsStream = false;
        if (body.length > 0) {
          try {
            const p = JSON.parse(body.toString()) as { stream?: boolean };
            clientWantsStream = !!p.stream;
          } catch {}
        }

        const cliResult = await handleViaCli(body, modelOverride, verbose);
        requestCount++;

        if (cliResult.status >= 200 && cliResult.status < 300) {
          if (isOpenAI) {
            // Translate to OpenAI format
            try {
              const parsed = JSON.parse(cliResult.body) as Record<string, unknown>;
              cliResult.body = JSON.stringify(anthropicToOpenai(parsed));
            } catch {}
          }

          if (clientWantsStream && !isOpenAI) {
            // Client requested SSE streaming — convert CLI JSON to SSE events
            const sseData = jsonToSse(cliResult.body);
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Access-Control-Allow-Origin': corsOrigin,
              ...SECURITY_HEADERS,
            });
            res.end(sseData);
          } else if (clientWantsStream && isOpenAI) {
            // OpenAI streaming — convert Anthropic JSON to OpenAI SSE
            try {
              const parsed = JSON.parse(cliResult.body) as Record<string, unknown>;
              const text = (parsed.content as Array<{ type: string; text?: string }> | undefined)?.find(c => c.type === 'text')?.text ?? '';
              const ts = Math.floor(Date.now() / 1000);
              let sseData = `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
              sseData += `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Access-Control-Allow-Origin': corsOrigin,
                ...SECURITY_HEADERS,
              });
              res.end(sseData);
            } catch {
              res.writeHead(cliResult.status, { 'Content-Type': cliResult.contentType, 'Access-Control-Allow-Origin': corsOrigin, ...SECURITY_HEADERS });
              res.end(cliResult.body);
            }
          } else {
            res.writeHead(cliResult.status, { 'Content-Type': cliResult.contentType, 'Access-Control-Allow-Origin': corsOrigin, ...SECURITY_HEADERS });
            res.end(cliResult.body);
          }
        } else {
          // CLI also failed — return the CLI error
          res.writeHead(cliResult.status, { 'Content-Type': cliResult.contentType, 'Access-Control-Allow-Origin': corsOrigin, ...SECURITY_HEADERS });
          res.end(cliResult.body);
        }
        return;
      }

      // Detect streaming from content-type (reliable) or body (fallback)
      const contentType = upstream.headers.get('content-type') ?? '';
      const isStream = contentType.includes('text/event-stream');

      // Forward response headers
      const responseHeaders: Record<string, string> = {
        'Content-Type': contentType || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
        ...SECURITY_HEADERS,
      };

      // Forward rate limit headers (including unified subscription headers)
      for (const [key, value] of upstream.headers.entries()) {
        if (key.startsWith('x-ratelimit') || key.startsWith('anthropic-ratelimit') || key === 'request-id') {
          responseHeaders[key] = value;
        }
      }

      requestCount++;

      // Log billing classification on first request or in verbose mode
      const billingClaim = upstream.headers.get('anthropic-ratelimit-unified-representative-claim');
      const overageUtil = upstream.headers.get('anthropic-ratelimit-unified-overage-utilization');
      if (requestCount === 1 || verbose) {
        if (billingClaim) {
          const overagePct = overageUtil ? `${Math.round(parseFloat(overageUtil) * 100)}%` : '?';
          console.log(`[dario] #${requestCount} billing: ${billingClaim} (overage: ${overagePct})`);
        }
      }

      res.writeHead(upstream.status, responseHeaders);

      if (isStream && upstream.body) {
        // Stream SSE chunks through
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
          let buffer = '';
          const MAX_LINE_LENGTH = 1_000_000; // 1MB max per SSE line
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (isOpenAI) {
              // Translate Anthropic SSE → OpenAI SSE
              buffer += decoder.decode(value, { stream: true });
              // Guard against unbounded buffer growth
              if (buffer.length > MAX_LINE_LENGTH) {
                buffer = buffer.slice(-MAX_LINE_LENGTH);
              }
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

        // Check for extended context failure — cooldown to avoid repeated failures
        if (upstream.status === 400 && responseBody.includes('extra_usage') && modelOverride?.includes('[1m]')) {
          extendedContextUnavailableAt = Date.now();
          console.warn('[dario] 1M context requires Extra Usage — falling back to standard context for 1 hour');
        }

        // Token anomaly detection on non-streaming responses
        if (upstream.status >= 200 && upstream.status < 300) {
          try {
            const parsed = JSON.parse(responseBody) as Record<string, unknown>;
            const usage = parsed.usage as Record<string, number> | undefined;
            if (usage) checkTokenAnomalies(usage, responseHeaders['request-id'] ?? '');
          } catch { /* ignore parse errors */ }
        }

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

        if (verbose) console.log(`[dario] #${requestCount} ${upstream.status}`);
      }
    } catch (err) {
      // Log full error server-side, return generic message to client
      console.error('[dario] Proxy error:', sanitizeError(err));
      res.writeHead(502, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Proxy error', message: 'Failed to reach upstream API' }));
    } finally {
      semaphore.release();
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
    const oauthLine = useCli ? 'Backend: Claude CLI (bypasses rate limits)' : `OAuth: ${status.status} (expires in ${status.expiresIn})`;
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

  // Session presence heartbeat — registers this proxy as an active Claude Code session
  // Claude Code sends this every 5 seconds; the server uses it for priority routing
  const clientId = randomUUID();
  const connectedAt = new Date().toISOString();
  let lastPresencePulse = 0;

  const presenceInterval = setInterval(async () => {
    const now = Date.now();
    if (now - lastPresencePulse < 5000) return;
    lastPresencePulse = now;
    try {
      const token = await getAccessToken();
      const presenceUrl = `${ANTHROPIC_API}/v1/code/sessions/${SESSION_ID}/client/presence`;
      await fetch(presenceUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-client-platform': 'cli',
        },
        body: JSON.stringify({ client_id: clientId, connected_at: connectedAt }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch { /* presence is best-effort */ }
  }, 5000);

  // Periodic token refresh (every 15 minutes)
  const refreshInterval = setInterval(async () => {
    try {
      const s = await getStatus();
      if (s.status === 'expiring' || s.status === 'expired') {
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
    clearInterval(presenceInterval);
    clearInterval(refreshInterval);
    server.close(() => process.exit(0));
    // Force exit after 5s if connections don't close
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

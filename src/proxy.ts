import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { arch, platform } from 'node:process';
import { getAccessToken, getStatus } from './oauth.js';
import { buildCCRequest, reverseMapResponse, createStreamingReverseMapper, orderHeadersForOutbound, CC_TEMPLATE, type ToolMapping, type RequestContext } from './cc-template.js';
import { describeTemplate, detectDrift, checkCCCompat } from './live-fingerprint.js';
import { AccountPool, computeStickyKey, parseRateLimits, type PoolAccount } from './pool.js';
import { Analytics, billingBucketFromClaim } from './analytics.js';
import { loadAllAccounts, loadAccount, refreshAccountToken } from './accounts.js';
import {
  GroupLender,
  importGroupPublicKey,
  decodeBorrowEnvelope,
  parseBorrowToken,
  type ExportedGroupKey,
} from './sealed-pool.js';
import { getOpenAIBackend, isOpenAIModel, forwardToOpenAI, type BackendCredentials } from './openai-backend.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — generous for large prompts, prevents abuse
const UPSTREAM_TIMEOUT_MS = 300_000; // 5 min — matches Anthropic SDK default
const BODY_READ_TIMEOUT_MS = 30_000; // 30s — prevents slow-loris on body reads
const MAX_CONCURRENT = 10; // Max concurrent upstream requests
const DEFAULT_HOST = '127.0.0.1';

// A host is "loopback" if it's one of the well-known localhost literals.
// Used to decide whether to warn at startup about binding to a reachable
// interface — binding anywhere else means other machines can reach the
// proxy and should only be done with DARIO_API_KEY set.
function isLoopbackHost(host: string): boolean {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  return host.startsWith('127.');
}

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

// Billing tag hash seed — matches Claude Code's value
const BILLING_SEED = '59cf53e54c78';

// Compute per-request build tag:
// SHA-256(seed + chars[4,7,20] of user message + version).slice(0,3)
function computeBuildTag(userMessage: string, version: string): string {
  const chars = [4, 7, 20].map(i => userMessage[i] || '0').join('');
  return createHash('sha256').update(`${BILLING_SEED}${chars}${version}`).digest('hex').slice(0, 3);
}

// Per-request cch: random 5-char hex value each request (Claude Code does the same).
function computeCch(): string {
  return randomBytes(3).toString('hex').slice(0, 5);
}

// Detect installed Claude Code version for the build-tag computation.
// Falls back to a known-good version if claude isn't on PATH.
function detectCliVersion(): string {
  try {
    const out = execSync('claude --version', { timeout: 5000, stdio: 'pipe' }).toString().trim();
    return out.match(/^([\d]+\.[\d]+\.[\d]+)/)?.[1] ?? '2.1.100';
  } catch {
    return '2.1.100';
  }
}

/** Extract first user message text from a request body for billing tag computation. */
function extractFirstUserMessage(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (!messages) return '';
  const userMsg = messages.find(m => m.role === 'user');
  if (!userMsg) return '';
  if (typeof userMsg.content === 'string') return userMsg.content;
  if (Array.isArray(userMsg.content)) {
    const textBlock = (userMsg.content as Array<{ type?: string; text?: string }>).find(b => b.type === 'text');
    return textBlock?.text ?? '';
  }
  return '';
}

// Session ID behavior (single-account mode):
//   v3.18 rotated per request — which was itself a fingerprint. Real CC
//   rotates roughly once per conversation, not per call. A user who has
//   distinct session-ids for every request looks nothing like a CC user.
//
//   v3.19 keeps the id stable through a conversation window and rotates
//   only after an idle gap long enough to credibly indicate a new
//   conversation. Pool mode still uses the per-account identity.sessionId
//   (stable across the account's lifetime).
//
//   v3.28 generalises the single hardcoded 15-min window into a tunable
//   registry (see src/session-rotation.ts) with optional jitter, max-age,
//   and per-client keying. SESSION_ID below is kept only as a mirror of
//   the default single-account session so out-of-band consumers (presence
//   ping, diagnostic logs) can read the most recent id without going
//   through the registry. It's refreshed after every dispatch-path call
//   that assigns a new id.
let SESSION_ID: string = randomUUID();
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
    const files = readdirSync(backupDir) as string[];
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

// Provider prefix in the `model` field — `<provider>:<model>`. Forces
// routing regardless of model-name regex. Only recognized prefixes are
// parsed, so ollama-style `llama3:8b` (without a recognized prefix)
// passes through untouched and reaches the configured openai-compat
// backend as-is.
const PROVIDER_PREFIXES: Record<string, 'openai' | 'claude'> = {
  openai: 'openai',
  openrouter: 'openai',
  groq: 'openai',
  compat: 'openai',
  local: 'openai',
  claude: 'claude',
  anthropic: 'claude',
};

export function parseProviderPrefix(model: string): { provider: 'openai' | 'claude'; model: string } | null {
  const idx = model.indexOf(':');
  if (idx <= 0) return null;
  const prefix = model.slice(0, idx).toLowerCase();
  const provider = PROVIDER_PREFIXES[prefix];
  if (!provider) return null;
  const stripped = model.slice(idx + 1);
  if (!stripped) return null;
  return { provider, model: stripped };
}

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
  'directories', 'thinking',
  'agent_persona', 'agent_context', 'tool_context', 'persona', 'tool_call',
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

/**
 * Scrub non-Claude-Code fields and normalize field ordering.
 * Real Claude Code never sends these fields. Their presence is a fingerprint.
 * JSON field order is also detectable — Claude Code always sends fields in a
 * specific order. We rebuild the object to match.
 */

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
  host?: string;  // Bind address (default: 127.0.0.1)
  verbose?: boolean;
  verboseBodies?: boolean; // Dump redacted request bodies on every request (dario#40 -vv / DARIO_LOG_BODIES=1)
  model?: string;  // Override model in all requests
  passthrough?: boolean;  // Thin proxy — OAuth swap only, no injection
  preserveTools?: boolean;  // Keep client tool schemas (for agents with custom tools)
  hybridTools?: boolean;    // Remap to CC tools but inject request-context fields on return (#33)
  noAutoDetect?: boolean;   // Disable text-tool-client auto-detection (dario#40, ringge — keep CC fingerprint)
  strictTls?: boolean;      // Refuse to start if not running under Bun (v3.23, direction #3)
  pacingMinMs?: number;     // Minimum ms between requests (v3.24, direction #6 — default 500)
  pacingJitterMs?: number;  // Max uniform-random jitter added on top of pacingMinMs (v3.24 — default 0)
  drainOnClose?: boolean;   // Keep draining upstream after client disconnects (v3.25, direction #5 — default off)
  sessionIdleRotateMs?: number;    // Idle ms before session-id rotates (v3.28, direction #1 — default 15min)
  sessionRotateJitterMs?: number;  // Uniform jitter on idle threshold (v3.28 — default 0)
  sessionMaxAgeMs?: number;        // Hard cap on session-id lifetime (v3.28 — default off)
  sessionPerClient?: boolean;      // Key sessions by x-session-id/x-client-session-id header (v3.28 — default off)
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
 * Two-lane auth: DARIO_API_KEY (x-api-key / Authorization: Bearer) for
 * normal clients, and MUX_COORD_SECRET (X-Mux-Coord-Secret) for the mux
 * gateway forwarding a verified sealed borrow. If neither is configured
 * the request is allowed (loopback-only default). Exported for tests.
 */
export function authenticateRequest(
  headers: IncomingMessage['headers'],
  apiKeyBuf: Buffer | null,
  mcsBuf: Buffer | null,
): boolean {
  if (!apiKeyBuf && !mcsBuf) return true;
  if (mcsBuf) {
    const raw = headers['x-mux-coord-secret'];
    const provided = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
    if (provided) {
      const providedBuf = Buffer.from(provided);
      if (providedBuf.length === mcsBuf.length && timingSafeEqual(providedBuf, mcsBuf)) return true;
    }
  }
  if (apiKeyBuf) {
    const provided = (headers['x-api-key'] as string)
      || (headers.authorization as string)?.replace(/^Bearer\s+/i, '');
    if (provided) {
      const providedBuf = Buffer.from(provided);
      if (providedBuf.length === apiKeyBuf.length && timingSafeEqual(providedBuf, apiKeyBuf)) return true;
    }
  }
  return false;
}

/**
 * Enrich Anthropic's unhelpful 429 "Error" body with rate limit details from headers.
 */
function enrich429(body: string, headers: Headers): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error as Record<string, unknown> | undefined;
    if (err && (err.message === 'Error' || !err.message)) {
      const claim = headers.get('anthropic-ratelimit-unified-representative-claim') || 'unknown';
      const status = headers.get('anthropic-ratelimit-unified-status') || 'rejected';
      const util5h = headers.get('anthropic-ratelimit-unified-5h-utilization');
      const util7d = headers.get('anthropic-ratelimit-unified-7d-utilization');
      const reset = headers.get('anthropic-ratelimit-unified-reset');
      const parts = [`Rate limited (${status}). Limiting window: ${claim}`];
      if (util5h) parts.push(`5h utilization: ${Math.round(parseFloat(util5h) * 100)}%`);
      if (util7d) parts.push(`7d utilization: ${Math.round(parseFloat(util7d) * 100)}%`);
      if (reset) {
        const resetDate = new Date(parseInt(reset) * 1000);
        const mins = Math.max(0, Math.round((resetDate.getTime() - Date.now()) / 60000));
        parts.push(`resets in ${mins}m`);
      }
      err.message = parts.join('. ');
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}


export async function startProxy(opts: ProxyOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? process.env.DARIO_HOST ?? DEFAULT_HOST;
  const verbose = opts.verbose ?? false;
  const passthrough = opts.passthrough ?? false;

  // TLS-fingerprint axis (v3.23, direction #3). Proxy mode terminates TLS
  // to api.anthropic.com from this process; if we're not on Bun, the
  // ClientHello that reaches Anthropic is Node's OpenSSL shape, not CC's
  // Bun/BoringSSL shape. `--strict-tls` turns this silent divergence into
  // a startup refusal. Doctor + the always-on banner below surface the
  // same information without aborting, for users who know they're fine
  // (API-key billing, single-call invocations, shim-mode-elsewhere, etc.).
  const { detectRuntimeFingerprint } = await import('./runtime-fingerprint.js');
  const runtimeFp = detectRuntimeFingerprint();
  if (opts.strictTls && runtimeFp.status !== 'bun-match') {
    console.error(`[dario] --strict-tls: ${runtimeFp.detail}`);
    if (runtimeFp.hint) console.error(`[dario]   → ${runtimeFp.hint}`);
    console.error('[dario] refusing to start proxy mode. Omit --strict-tls to run anyway.');
    process.exit(1);
  }
  // Text-tool-protocol client families that have already logged a
  // "detected → auto-enabling preserve-tools" banner this session.
  // Set once on first sighting per family so the startup log stays
  // short even under heavy traffic. dario#40.
  const detectedClientsLogged = new Set<string>();
  // Body-dump mode: set via --verbose=2 / -vv or DARIO_LOG_BODIES=1.
  // When on, every request emits a redacted JSON body to stderr so
  // operators can see exactly what dario forwards upstream. Default
  // -v stays quiet because bodies can carry file content and tool
  // output. Reported in dario#40 by @ringge.
  const verboseBodies = Boolean(opts.verboseBodies) || process.env.DARIO_LOG_BODIES === '1';

  // Multi-provider backends (v3.6.0+). Loaded once at startup; the CLI
  // `dario backend add openai --key=…` writes to ~/.dario/backends/.
  // Routing: a GPT-family model arriving on /v1/chat/completions is
  // dispatched to the openai-compat backend when one is configured,
  // otherwise it falls through to the existing Claude-side handling
  // (which used to map gpt-* names to Claude equivalents).
  let openaiBackend: BackendCredentials | null = await getOpenAIBackend();
  if (openaiBackend) {
    console.log(`  OpenAI-compat backend: ${openaiBackend.name} → ${openaiBackend.baseUrl}`);
  }

  // Multi-account pool — activated when ~/.dario/accounts/ has 2+ entries.
  // Single-account dario keeps its existing code path unchanged.
  const accountsList = await loadAllAccounts();
  const pool = accountsList.length >= 2 ? new AccountPool() : null;
  const analytics = pool ? new Analytics() : null;

  // Sealed-sender overflow pool — activated when ~/.dario/group.json exists.
  // Config format: { "groupId": "<name>", "publicKey": { n, e, modulusBytes } }
  // where publicKey is the GroupAdmin's exported RSA public key. Lender runs
  // in addition to normal pool mode — borrow requests go through a separate
  // /v1/pool/borrow endpoint and are verified via the admin-signed token.
  let groupLender: GroupLender | null = null;
  try {
    const groupConfigPath = join(homedir(), '.dario', 'group.json');
    const rawGroup = readFileSync(groupConfigPath, 'utf-8');
    const parsed = JSON.parse(rawGroup) as { groupId?: string; publicKey?: ExportedGroupKey };
    if (parsed?.groupId && parsed.publicKey?.n && parsed.publicKey?.e && parsed.publicKey?.modulusBytes) {
      const pub = importGroupPublicKey(parsed.publicKey);
      groupLender = new GroupLender(parsed.groupId, pub);
      console.log(`  Sealed-sender pool: group "${parsed.groupId}" loaded (${pub.modulusBytes * 8}-bit key)`);
    }
  } catch (err) {
    // Group config is optional — silent fallthrough if missing. Log parse
    // errors explicitly so a broken config doesn't fail silently.
    const e = err as NodeJS.ErrnoException;
    if (e.code && e.code !== 'ENOENT') {
      console.warn(`[dario] group.json present but unusable: ${e.message}`);
    }
  }
  let status: Awaited<ReturnType<typeof getStatus>>;
  if (pool) {
    for (const acc of accountsList) {
      pool.add(acc.alias, {
        accessToken: acc.accessToken,
        refreshToken: acc.refreshToken,
        expiresAt: acc.expiresAt,
        deviceId: acc.deviceId,
        accountUuid: acc.accountUuid,
      });
    }
    console.log(`  Pool mode: ${accountsList.length} accounts loaded`);
    // Background refresh — keep every account's token fresh without blocking requests
    const refreshInterval = setInterval(async () => {
      for (const acc of pool.all()) {
        if (acc.expiresAt < Date.now() + 45 * 60 * 1000) {
          try {
            const saved = await loadAccount(acc.alias);
            if (!saved) continue;
            const refreshed = await refreshAccountToken(saved);
            pool.updateTokens(acc.alias, refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt);
          } catch (err) {
            console.error(`[dario] Background refresh failed for ${acc.alias}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }, 15 * 60 * 1000);
    refreshInterval.unref();
    // Pool mode doesn't check single-account status — compute a placeholder
    // for the startup banner using the pool's earliest expiry.
    const earliest = Math.min(...pool.all().map(a => a.expiresAt));
    const msLeft = Math.max(0, earliest - Date.now());
    status = {
      authenticated: true,
      status: 'healthy',
      expiresAt: earliest,
      expiresIn: `${Math.floor(msLeft / 3600000)}h ${Math.floor((msLeft % 3600000) / 60000)}m`,
    };
  } else {
    // Single-account mode — existing auth check
    status = await getStatus();
    if (!status.authenticated) {
      console.error('[dario] Not authenticated. Run `dario login` first.');
      process.exit(1);
    }
  }

  const cliVersion = detectCliVersion();
  // Parse --model once at startup. Supports `<provider>:<model>` to force
  // a backend for every request (e.g. `--model=openai:gpt-4o`). Back-compat:
  // bare names like `opus` resolve via MODEL_ALIASES.
  const modelPrefix = opts.model ? parseProviderPrefix(opts.model) : null;
  const cliModelRaw = modelPrefix ? modelPrefix.model : opts.model;
  const cliProviderOverride: 'openai' | 'claude' | null = modelPrefix ? modelPrefix.provider : null;
  const modelOverride = cliModelRaw ? (MODEL_ALIASES[cliModelRaw] ?? cliModelRaw) : null;
  const identity = loadClaudeIdentity();
  if (identity.deviceId) {
    console.log('  Device identity: detected');
  } else {
    console.warn('[dario] WARNING: No Claude Code device identity found. Requests may be billed as Extra Usage.');
    console.warn('[dario] Run Claude Code at least once to generate ~/.claude/.claude.json');
  }

  // Pre-build static headers — matches the set a real Claude Code client sends.
  const staticHeaders: Record<string, string> = passthrough ? {
    'accept': 'application/json',
    'Content-Type': 'application/json',
  } : {
    'accept': 'application/json',
    'Content-Type': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'user-agent': `claude-cli/${cliVersion} (external, cli)`,
    'x-app': 'cli',
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': OS_NAME,
    'x-stainless-package-version': '0.81.0',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    // Claude Code runs on Bun which reports v24.3.0 as Node compat version
    'x-stainless-runtime-version': 'v24.3.0',
  };
  // Overlay captured header values from the live template (schema v2). This
  // replaces the hardcoded stainless/user-agent constants with whatever CC
  // actually emitted on the capture, so a CC release that nudges any of those
  // values gets reflected automatically on the next template refresh.
  // Excludes auth + body-framing + session-scoped keys by construction (see
  // extractStaticHeaderValues in live-fingerprint.ts). No-op when the loaded
  // template predates v2 or the bundled snapshot is in use.
  //
  // `x-api-key` is filtered defensively here too — pre-v3.19.2 captures still
  // carry `x-api-key: sk-dario-fingerprint-capture` from the MITM spawn env.
  // Replaying that placeholder alongside a real OAuth Bearer triggers a
  // "invalid x-api-key" 401 on some account tiers as of 2026-04-17 (dario#42).
  // The capture filter was updated in v3.19.2 to stop storing it, but the
  // per-request skip below lets existing caches self-heal without a refresh.
  if (!passthrough && CC_TEMPLATE.header_values) {
    for (const [k, v] of Object.entries(CC_TEMPLATE.header_values)) {
      if (k.toLowerCase() === 'x-api-key') continue;
      staticHeaders[k] = v;
    }
  }
  let requestCount = 0;
  const semaphore = new Semaphore(MAX_CONCURRENT);

  // Cache context-1m beta availability. Set false once per account (or process
  // in single-account mode) after the first "long context" rejection, so we
  // skip sending context-1m on every subsequent request instead of paying the
  // round-trip + retry cost each time. Keyed by account alias; `__default__`
  // is the single-account slot. Reported by @boeingchoco in dario#36 — the
  // retry loop was firing on every POST with hybrid-tools + OC.
  const context1mUnavailable = new Set<string>();
  // Per-account cache of anthropic-beta flags the upstream has rejected as
  // "Unexpected value(s)". The live-captured template lifts whatever CC emits
  // verbatim — including flags gated to higher-tier accounts (e.g.
  // `afk-mode-2026-01-31` is rejected on Max 5x as of 2026-04-17). On the
  // first rejection we parse the flag out of the error message, strip it,
  // retry once, and cache it so subsequent requests on the same account don't
  // re-pay the 400 round-trip. Keyed by account alias (pool) or `__default__`.
  const unavailableBetas = new Map<string, Set<string>>();
  const ACCOUNT_KEY_SINGLE = '__default__';

  // Beta flag set — sourced from the live template when the capture recorded
  // one (schema v2+), else falls back to the v2.1.104 bundled default. Same
  // fallback string shim/runtime.cjs uses (kept in sync so proxy and shim
  // never diverge on the wire). Computed once per proxy because it's a
  // function of the loaded template, not of the request.
  const BETA_FALLBACK = 'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,effort-2025-11-24';
  let betaBase = CC_TEMPLATE.anthropic_beta || BETA_FALLBACK;
  // `oauth-2025-04-20` is CC's OAuth-enablement beta flag. It is NOT present in
  // the live-captured beta set because dario's fingerprint capture spawns CC
  // with a placeholder `ANTHROPIC_API_KEY`, and CC only appends the oauth beta
  // when it's actually using an OAuth bearer token. The proxy always uses
  // OAuth upstream, so the flag is required — force it in if the captured
  // template didn't carry it. As of 2026-04-17 some account tiers (Max 20x,
  // Pro) return `authentication_error: invalid x-api-key` without this flag
  // even when a valid Bearer is sent (dario#42).
  if (!passthrough && !betaBase.split(',').includes('oauth-2025-04-20')) {
    betaBase = betaBase ? `${betaBase},oauth-2025-04-20` : 'oauth-2025-04-20';
  }
  const betaWithoutContext1m = betaBase.split(',').filter((t) => t !== 'context-1m-2025-08-07').join(',');

  // Rate governor — floor + optional jitter between requests. A hardcoded
  // 500ms floor keeps the default behavior identical to v3.23; `--pace-min`
  // and `--pace-jitter` let callers tune the distribution. Pure calc lives
  // in src/pacing.ts so the edge cases are unit-tested without timers.
  const { computePacingDelay, resolvePacingConfig } = await import('./pacing.js');
  let lastRequestTime = 0;
  const pacingCfg = resolvePacingConfig({
    minGapMs: opts.pacingMinMs,
    jitterMs: opts.pacingJitterMs,
  });
  if (verbose) {
    console.log(`[dario] pacing: min=${pacingCfg.minGapMs}ms jitter=${pacingCfg.jitterMs}ms`);
  }

  // Stream-consumption replay (v3.25, direction #5). When on, a client
  // disconnect no longer aborts the upstream fetch — we keep consuming
  // the SSE so Anthropic sees a CC-shaped read-to-EOF pattern. See
  // src/stream-drain.ts for the rationale + tradeoff.
  const { decideOnClientClose, resolveDrainOnClose } = await import('./stream-drain.js');
  const drainOnClose = resolveDrainOnClose(opts.drainOnClose);
  if (verbose) {
    console.log(`[dario] drain-on-close: ${drainOnClose ? 'enabled' : 'disabled'}`);
  }

  // Session-ID lifecycle (v3.28, direction #1). Replaces the v3.27 hardcoded
  // 15-minute idle window with a tunable registry: idle threshold, jitter on
  // that threshold, optional hard max-age, and optional per-client keying.
  // Defaults preserve v3.27 behavior exactly. See src/session-rotation.ts.
  const { SessionRegistry, resolveSessionRotationConfig } = await import('./session-rotation.js');
  const sessionCfg = resolveSessionRotationConfig({
    idleRotateMs: opts.sessionIdleRotateMs,
    jitterMs: opts.sessionRotateJitterMs,
    maxAgeMs: opts.sessionMaxAgeMs,
    perClient: opts.sessionPerClient,
  });
  const sessionRegistry = new SessionRegistry(sessionCfg, () => randomUUID());
  if (verbose) {
    const maxAge = sessionCfg.maxAgeMs !== undefined ? `${sessionCfg.maxAgeMs}ms` : 'off';
    console.log(`[dario] session: idle=${sessionCfg.idleRotateMs}ms jitter=${sessionCfg.jitterMs}ms maxAge=${maxAge} perClient=${sessionCfg.perClient}`);
  }

  // Optional proxy authentication — pre-encode key buffer for performance
  const apiKey = process.env.DARIO_API_KEY;
  const apiKeyBuf = apiKey ? Buffer.from(apiKey) : null;
  // Mux coord-secret — the shared secret mux uses when forwarding sealed
  // borrow requests to this dario acting as a lender endpoint. A request
  // carrying a matching X-Mux-Coord-Secret header is authenticated without
  // needing DARIO_API_KEY. The sealed-sender envelope has already been
  // verified upstream, so the coord secret is the one-hop auth between
  // the mux gateway and this instance.
  const mcs = process.env.MUX_COORD_SECRET;
  const mcsBuf = mcs ? Buffer.from(mcs) : null;
  // CORS origin defaults to the localhost URL the proxy is served at. Users
  // binding to a non-loopback address (e.g. a Tailscale interface) can
  // override via DARIO_CORS_ORIGIN — otherwise browser-based clients hitting
  // dario over the mesh will be blocked by their browser's CORS check.
  const corsOrigin = process.env.DARIO_CORS_ORIGIN || `http://localhost:${port}`;

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-mux-coord-secret',
    'Access-Control-Max-Age': '86400',
    ...SECURITY_HEADERS,
  };
  const JSON_HEADERS = { 'Content-Type': 'application/json', ...SECURITY_HEADERS };
  const MODELS_JSON = JSON.stringify(OPENAI_MODELS_LIST);
  const ERR_UNAUTH = JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' });
  const ERR_FORBIDDEN = JSON.stringify({ error: 'Forbidden', message: 'Path not allowed. Supported paths: POST /v1/messages, POST /v1/chat/completions, GET /v1/models' });
  const ERR_METHOD = JSON.stringify({ error: 'Method not allowed' });

  function checkAuth(req: IncomingMessage): boolean {
    return authenticateRequest(req.headers, apiKeyBuf, mcsBuf);
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

    // Sealed-sender borrow endpoint — runs BEFORE the API-key auth check
    // because the admin-signed group token IS the authentication. Anyone
    // who presents a valid unused token can borrow capacity from this
    // instance's pool without also holding the local dario API key.
    // See src/sealed-pool.ts for the protocol.
    if (urlPath === '/v1/pool/borrow' && req.method === 'POST') {
      if (!groupLender) {
        res.writeHead(503, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'sealed-sender pool not configured on this instance' }));
        return;
      }
      if (!pool) {
        res.writeHead(503, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'pool mode required for sealed-sender borrows' }));
        return;
      }

      // Read body with the same limits as normal /v1/messages.
      const bChunks: Buffer[] = [];
      let bBytes = 0;
      const bTimeout = setTimeout(() => { req.destroy(); }, BODY_READ_TIMEOUT_MS);
      try {
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          bBytes += buf.length;
          if (bBytes > MAX_BODY_BYTES) {
            clearTimeout(bTimeout);
            res.writeHead(413, JSON_HEADERS);
            res.end(JSON.stringify({ error: 'Request body too large' }));
            return;
          }
          bChunks.push(buf);
        }
      } finally {
        clearTimeout(bTimeout);
      }

      const envelope = decodeBorrowEnvelope(Buffer.concat(bChunks).toString('utf-8'));
      if (!envelope) {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'malformed borrow envelope' }));
        return;
      }
      // Envelope shape guard — envelope.request is `unknown` on the wire.
      // We stringify it and forward to Anthropic under the lender's identity,
      // so a borrower could otherwise waste the lender's rate-limit slot with
      // a body Anthropic will reject. Minimum: must be a plain object with
      // `model` (string) and `messages` (array). Anthropic validates the rest.
      const br = envelope.request;
      if (
        !br || typeof br !== 'object' || Array.isArray(br) ||
        typeof (br as Record<string, unknown>).model !== 'string' ||
        !Array.isArray((br as Record<string, unknown>).messages)
      ) {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'envelope.request must be an Anthropic /v1/messages body' }));
        return;
      }
      if (envelope.groupId !== groupLender.groupId) {
        res.writeHead(403, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'unknown_group', expected: groupLender.groupId }));
        return;
      }
      const borrowTok = parseBorrowToken(envelope);
      if (!borrowTok) {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'malformed token' }));
        return;
      }
      const accept = groupLender.acceptBorrow(borrowTok.token, borrowTok.signature);
      if (!accept.ok) {
        res.writeHead(403, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'borrow_rejected', reason: accept.reason }));
        return;
      }

      // Token validated. Forward the embedded /v1/messages request to
      // Anthropic using the lender's normal pool. This path is minimal:
      // no streaming parser, no reverse tool mapping, no 429 failover.
      // It's enough to demonstrate sealed-sender end-to-end; the full
      // feature-parity wire-up with the main /v1/messages path is a
      // separate change (requires threading a pre-read body through
      // the existing handler).
      const lenderAccount = pool.select();
      if (!lenderAccount) {
        res.writeHead(503, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'lender pool exhausted' }));
        return;
      }

      try {
        const upstream = await fetch(`${ANTHROPIC_API}/v1/messages?beta=true`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'authorization': `Bearer ${lenderAccount.accessToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code-20250219',
          },
          body: JSON.stringify(envelope.request),
        });
        const snapshot = parseRateLimits(upstream.headers);
        pool.updateRateLimits(lenderAccount.alias, snapshot);

        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'Access-Control-Allow-Origin': corsOrigin,
          ...SECURITY_HEADERS,
        });
        res.end(body);
        if (verbose) {
          console.log(`[dario] borrow: group=${envelope.groupId} → ${lenderAccount.alias} (${upstream.status}, ${body.length}B)`);
        }
      } catch (err) {
        res.writeHead(502, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'upstream_error', message: (err as Error).message }));
      }
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

    // Pool status endpoint — shows loaded accounts, headroom, and the
    // account that would be selected next. Read-only; mutation flows through
    // the `dario accounts` CLI, not HTTP.
    if (urlPath === '/accounts' && req.method === 'GET') {
      if (!pool) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ mode: 'single-account', accounts: 0 }));
        return;
      }
      const accounts = pool.all().map(a => ({
        alias: a.alias,
        util5h: a.rateLimit.util5h,
        util7d: a.rateLimit.util7d,
        claim: a.rateLimit.claim,
        status: a.rateLimit.status,
        requestCount: a.requestCount,
        expiresInMs: Math.max(0, a.expiresAt - Date.now()),
      }));
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({
        mode: 'pool',
        ...pool.status(),
        stickyBindings: pool.stickyCount(),
        sealedSender: groupLender ? {
          groupId: groupLender.groupId,
          seenTokens: groupLender.seenCount(),
        } : null,
        accounts,
      }));
      return;
    }

    // Analytics endpoint — request history + burn-rate summary (pool mode only).
    if (urlPath === '/analytics' && req.method === 'GET') {
      if (!analytics) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ mode: 'single-account', note: 'Analytics are only collected in pool mode.' }));
        return;
      }
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(analytics.summary()));
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
    // Hoisted so the finally block can clean up whatever was set.
    let upstreamTimeout: ReturnType<typeof setTimeout> | null = null;
    let onClientClose: (() => void) | null = null;
    let upstreamAbortReason: 'timeout' | 'client_closed' | 'sse_overflow' | null = null;
    try {
      // Pool mode: select an account by headroom. Single-account mode:
      // fall through to getAccessToken() exactly as before. Request-path
      // 429 failover (retry with the next-best account before returning a
      // rate-limit error to the client) lands in v3.5.1 — this release
      // ships the pool scaffolding and headroom-aware selection across
      // requests, not within a single 429 retry.
      let poolAccount: PoolAccount | null = null;
      let accessToken: string;
      if (pool) {
        poolAccount = pool.select();
        if (!poolAccount) {
          res.writeHead(503, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'No accounts available in pool' }));
          return;
        }
        accessToken = poolAccount.accessToken;
      } else {
        accessToken = await getAccessToken();
      }

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
      let body = Buffer.concat(chunks);

      // Provider prefix (v3.10.0). If the body's model field is `<provider>:<model>`
      // with a recognized prefix, strip the prefix and force routing regardless of
      // regex. CLI-level `--model=<provider>:<name>` applies the same override
      // server-wide. Rewrites the body in place once so both code paths below
      // see the stripped model name.
      let forcedProvider: 'openai' | 'claude' | null = cliProviderOverride;
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          const rawModel = (parsed.model as string | undefined) ?? '';
          const prefix = parseProviderPrefix(rawModel);
          if (prefix) {
            forcedProvider = prefix.provider;
            parsed.model = prefix.model;
            body = Buffer.from(JSON.stringify(parsed));
            if (verbose) {
              console.log(`[dario] provider prefix: ${rawModel} → ${prefix.provider} backend with model ${prefix.model}`);
            }
          } else if (cliProviderOverride === 'openai' && cliModelRaw) {
            // --model=openai:<name> forces the openai backend and replaces
            // the model name server-wide. Body gets rewritten so the openai
            // route below sees the CLI-chosen model.
            parsed.model = cliModelRaw;
            body = Buffer.from(JSON.stringify(parsed));
          }
        } catch { /* not JSON — fall through */ }
      }

      // Multi-provider routing (v3.6.0+). When an OpenAI-compat backend is
      // configured and the request is on /v1/chat/completions with a
      // GPT-family model (or a forced `openai:` prefix), forward it straight
      // through to the backend instead of running it through the Claude
      // template path. Requests on /v1/messages or with Claude-family models
      // fall through to existing behavior.
      if (openaiBackend && isOpenAI && forcedProvider !== 'claude' && body.length > 0) {
        try {
          const peek = JSON.parse(body.toString()) as { model?: string };
          const rawModel = (peek.model || '').toString();
          if (rawModel && (forcedProvider === 'openai' || isOpenAIModel(rawModel))) {
            if (verbose) {
              console.log(`[dario] #${requestCount} ${req.method} ${urlPath} (model: ${rawModel}) → openai backend`);
            }
            requestCount++;
            await forwardToOpenAI(
              req, res, body, openaiBackend, corsOrigin, SECURITY_HEADERS,
              UPSTREAM_TIMEOUT_MS, verbose,
            );
            return;
          }
        } catch { /* not JSON — fall through to existing path */ }
      }

      // Parse body once, apply OpenAI translation, model override, and sanitization
      let finalBody: Buffer | undefined = body.length > 0 ? body : undefined;
      let ccToolMap: Map<string, ToolMapping> | null = null;
      let requestModel = '';
      // Session stickiness key — hash of the first user message in this
      // conversation. Populated inside the template-replay block below
      // after the first user message is extracted for the build tag, then
      // used to rebind the sticky slot on in-request 429 failover and on
      // the eventual request bookkeeping. Null when body isn't JSON, when
      // there's no user message, or when we're in passthrough mode (the
      // fingerprint work doesn't run, so there's no point biasing account
      // selection toward one we already paid cache cost on — passthrough
      // users aren't doing template replay anyway).
      let stickyKey: string | null = null;
      // Outbound session id resolved once — either inside the template build
      // (so body metadata matches) or below for passthrough (no body build).
      let preBodySessionId: string | undefined;
      // Request context for hybrid-mode field injection (#33). Built once
      // per request from incoming headers so the reverse mapper can fill
      // client-declared fields like `sessionId` that CC's schema doesn't
      // carry. Undefined when hybridTools is off — the reverse path then
      // skips injection entirely.
      const reqCtx: RequestContext | undefined = opts.hybridTools ? {
        sessionId: (req.headers['x-session-id'] as string | undefined)
          ?? (req.headers['x-client-session-id'] as string | undefined)
          ?? SESSION_ID,
        requestId: (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        channelId: req.headers['x-channel-id'] as string | undefined,
        userId: req.headers['x-user-id'] as string | undefined,
        timestamp: new Date().toISOString(),
      } : undefined;
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          // Strip orchestration tags from messages (Aider, Cursor, etc.)
          sanitizeMessages(parsed);
          const result = isOpenAI ? openaiToAnthropic(parsed, modelOverride) : (modelOverride ? { ...parsed, model: modelOverride } : parsed);
          const r = result as Record<string, unknown>;
          requestModel = (r.model as string || '').toLowerCase();
          // In passthrough mode, skip all Claude-specific injection — OAuth swap only
          if (!passthrough) {
            // ── Template replay: replace the entire request with a CC template ──
            // Instead of transforming signals one by one, we build a new request
            // from CC's exact template and inject only the conversation content.
            // The upstream sees a genuine CC request structure.

            const userMsg = extractFirstUserMessage(r);
            const buildTag = computeBuildTag(userMsg, cliVersion);
            const cch = computeCch();
            const fullVersion = `${cliVersion}.${buildTag}`;
            const billingTag = `x-anthropic-billing-header: cc_version=${fullVersion}; cc_entrypoint=cli; cch=${cch};`;
            const CACHE_1H = { type: 'ephemeral' as const, ttl: '1h' as const };

            // Session stickiness: rebind the pre-selected pool account to
            // whatever the sticky-key resolver picks. If this is a new
            // conversation the key binds to the current best account
            // (no-op swap in most cases). If this is a follow-up turn of
            // an existing conversation the key resolves to the account
            // that already has the Anthropic prompt cache warmed for it.
            // Rotating off mid-session costs cache-create on every turn.
            stickyKey = computeStickyKey(userMsg);
            if (pool && stickyKey) {
              const preferred = pool.selectSticky(stickyKey);
              if (preferred && preferred.alias !== poolAccount?.alias) {
                poolAccount = preferred;
                accessToken = preferred.accessToken;
                if (verbose) {
                  console.log(`[dario] #${requestCount} sticky: bind ${stickyKey} → ${preferred.alias}`);
                }
              }
            }

            // Resolve the outbound session id before the body build so the
            // metadata.session_id in the CC body and the x-claude-code-session-id
            // header both use the same value. v3.27 consulted SESSION_ID twice
            // with rotation between the reads, so on rotation events body and
            // header disagreed — harmless for plain operation but a fingerprint
            // in its own right.
            if (poolAccount) {
              preBodySessionId = poolAccount.identity.sessionId;
            } else {
              const clientKey = (req.headers['x-session-id'] as string | undefined)
                ?? (req.headers['x-client-session-id'] as string | undefined);
              const assigned = sessionRegistry.getOrCreate(clientKey, Date.now());
              preBodySessionId = assigned.sessionId;
              SESSION_ID = assigned.sessionId;
              if (verbose && assigned.rotated && assigned.reason !== 'rotate-new') {
                console.log(`[dario] #${requestCount} session: rotate (${assigned.reason})`);
              }
            }
            const bodyIdentity = poolAccount
              ? poolAccount.identity
              : { deviceId: identity.deviceId, accountUuid: identity.accountUuid, sessionId: preBodySessionId };
            const { body: ccBody, toolMap, detectedClient } = buildCCRequest(
              r, billingTag, CACHE_1H,
              bodyIdentity,
              {
                preserveTools: opts.preserveTools ?? false,
                hybridTools: opts.hybridTools ?? false,
                noAutoDetect: opts.noAutoDetect ?? false,
              },
            );

            // Log the auto-preserve-tools switch once per text-tool
            // client family. Skip when the operator already opted into
            // --preserve-tools or --hybrid-tools — they know what they
            // picked and don't need a "hey, we heuristically agree"
            // line on every new client seen. dario#40.
            if (
              detectedClient
              && !opts.preserveTools
              && !opts.hybridTools
              && !detectedClientsLogged.has(detectedClient)
            ) {
              detectedClientsLogged.add(detectedClient);
              console.log(`[dario] detected ${detectedClient}-style text-tool protocol — auto-enabling preserve-tools for this client (pass --hybrid-tools to override, --preserve-tools to silence)`);
            }

            // Store tool map for response reverse-mapping
            ccToolMap = toolMap;

            // Replace request body entirely with CC template
            for (const key of Object.keys(r)) delete r[key];
            Object.assign(r, ccBody);
          }
          finalBody = Buffer.from(JSON.stringify(r));
        } catch { /* not JSON, send as-is */ }
      }

      if (verbose) {
        const modelInfo = modelOverride ? ` (model: ${modelOverride})` : '';
        console.log(`[dario] #${requestCount} ${req.method} ${urlPath}${modelInfo}`);
      }

      // Body dump — -vv / DARIO_LOG_BODIES=1. Runs on the outbound
      // body after the template build so operators see what actually
      // lands on the wire. sanitizeError's redaction strips bearer
      // tokens, sk-ant-* keys, and JWT triples in case any leaked
      // into the body (e.g. user pasted a curl). 8KB cap because the
      // CC system prompt alone is 25KB and dumping it every request
      // buries the useful content. dario#40.
      if (verboseBodies && finalBody) {
        const rendered = finalBody.toString('utf8');
        const capped = rendered.length > 8192
          ? rendered.slice(0, 8192) + `\n[...truncated ${rendered.length - 8192} bytes]`
          : rendered;
        console.log(`[dario] #${requestCount} request body:\n${sanitizeError(capped)}`);
      }

      // Beta headers
      const clientBeta = req.headers['anthropic-beta'] as string | undefined;
      let beta: string;
      if (passthrough) {
        // Passthrough: only add oauth beta, forward client betas as-is
        beta = 'oauth-2025-04-20';
        if (clientBeta) beta += ',' + clientBeta;
      } else {
        // Beta set sourced from the live template (schema v2). Bundled
        // snapshots predating v3.19 leave anthropic_beta undefined, so fall
        // back to the v2.1.104 flag set — matches shim/runtime.cjs's fallback.
        // context-1m requires Extra Usage — if it 400s, we auto-retry without
        // it, and cache the rejection so subsequent requests on this account
        // skip context-1m entirely (dario#36).
        const acctKey = poolAccount?.alias ?? ACCOUNT_KEY_SINGLE;
        const skipContext1m = context1mUnavailable.has(acctKey);
        beta = skipContext1m ? betaWithoutContext1m : betaBase;
        if (clientBeta) {
          const baseSet = new Set(beta.split(','));
          const filtered = filterBillableBetas(clientBeta)
            .split(',').filter(b => b.length > 0 && !baseSet.has(b)).join(',');
          if (filtered) beta += ',' + filtered;
        }
        // Strip any beta flags the upstream has previously rejected on this
        // account so we don't re-pay the 400 round-trip (dario#42 afk-mode
        // fallout: captured templates carry tier-gated flags whose availability
        // we only learn at request time).
        const rejectedSet = unavailableBetas.get(acctKey);
        if (rejectedSet && rejectedSet.size > 0) {
          beta = beta.split(',').filter((t) => t.length > 0 && !rejectedSet.has(t)).join(',');
        }
      }

      // Rate governor — prevent inhuman request cadence. See src/pacing.ts
      // for the pure delay calculator (floor + uniform jitter).
      const pacingDelay = computePacingDelay(Date.now(), lastRequestTime, pacingCfg);
      if (pacingDelay > 0) {
        await new Promise(r => setTimeout(r, pacingDelay));
      }
      lastRequestTime = Date.now();

      // Session ID: pool mode uses the per-account identity.sessionId (stable
      // per account). Single-account mode delegates to the session registry
      // (src/session-rotation.ts) which applies the configured idle / jitter /
      // max-age / per-client policy. Resolution happens earlier, at body-build
      // time, so the CC body's metadata.session_id and the outbound
      // x-claude-code-session-id header always agree. preBodySessionId holds
      // the template-build value; in passthrough mode (no template build)
      // the registry is consulted here instead.
      let outboundSessionId: string;
      if (poolAccount) {
        outboundSessionId = poolAccount.identity.sessionId;
      } else if (preBodySessionId !== undefined) {
        outboundSessionId = preBodySessionId;
      } else {
        const clientKey = (req.headers['x-session-id'] as string | undefined)
          ?? (req.headers['x-client-session-id'] as string | undefined);
        const assigned = sessionRegistry.getOrCreate(clientKey, Date.now());
        outboundSessionId = assigned.sessionId;
        SESSION_ID = assigned.sessionId;
        if (verbose && assigned.rotated && assigned.reason !== 'rotate-new') {
          console.log(`[dario] #${requestCount} session: rotate (${assigned.reason})`);
        }
      }

      const headers: Record<string, string> = {
        ...staticHeaders,
        'Authorization': `Bearer ${accessToken}`,
        'x-claude-code-session-id': outboundSessionId,
        'anthropic-version': passthrough ? (req.headers['anthropic-version'] as string || '2023-06-01') : '2023-06-01',
        'anthropic-beta': beta,
        'x-client-request-id': randomUUID(),
        // CC sends 600 on first request per session. With rotation, every request is "first"
        'x-stainless-timeout': '600',
      };

      // Client-disconnect abort: if the client drops the connection before
      // we've finished sending the response, we default to aborting the
      // upstream fetch so Anthropic stops generating (and billing) a
      // response nobody will read. With `--drain-on-close` set, we
      // instead keep the reader spinning to consume the full SSE — see
      // src/stream-drain.ts for the fingerprint rationale. The 5-minute
      // upstream timeout shares the same controller, so a hung upstream
      // still gets cut off regardless of drain mode.
      const upstreamAbort = new AbortController();
      let clientDisconnected = false;
      upstreamTimeout = setTimeout(() => {
        if (!upstreamAbort.signal.aborted) {
          upstreamAbortReason = 'timeout';
          upstreamAbort.abort();
        }
      }, UPSTREAM_TIMEOUT_MS);
      onClientClose = () => {
        const action = decideOnClientClose(
          res.writableEnded,
          upstreamAbort.signal.aborted,
          drainOnClose,
        );
        if (action === 'abort') {
          upstreamAbortReason = 'client_closed';
          upstreamAbort.abort();
        } else if (action === 'drain') {
          clientDisconnected = true;
          if (verbose) console.log(`[dario] #${requestCount} client disconnected — draining upstream to EOF`);
        }
        // noop: either res is already ended (normal teardown) or upstream
        // is already aborted for another reason.
      };
      req.on('close', onClientClose);

      const startTime = Date.now();
      // Tracks which accounts we've already tried this request — used by the
      // inside-request 429 failover loop to avoid re-hitting exhausted accounts.
      const triedAliases = new Set<string>();
      if (poolAccount) triedAliases.add(poolAccount.alias);

      let upstream!: Response;
      let peekedBody: string | null = null;

      // Inside-request 429 failover loop (v3.8.0). On a 429, pool mode tries
      // the next-best account before surfacing the error to the client.
      // Bounded to pool.size iterations; breaks immediately on any non-429.
      dispatchLoop: while (true) {
        // Reorder outbound headers to match CC's captured header sequence
        // when the live template recorded one. No-op on bundled-only installs.
        // Skipped in passthrough mode — passthrough means "don't shape the
        // request to look like CC," and reordering is a form of shaping.
        const outboundHeaders = passthrough ? headers : orderHeadersForOutbound(headers);
        upstream = await fetch(targetBase, {
          method: req.method ?? 'POST',
          headers: outboundHeaders,
          body: finalBody ? new Uint8Array(finalBody) : undefined,
          signal: upstreamAbort.signal,
        });

        // Pool mode: capture rate-limit snapshot from the response. parseRateLimits
        // returns status='rejected' on 429, which makes the next `select()` call
        // route traffic away from this account until it resets.
        if (pool && poolAccount) {
          const snapshot = parseRateLimits(upstream.headers);
          if (upstream.status === 429) {
            pool.markRejected(poolAccount.alias, snapshot);
          } else {
            pool.updateRateLimits(poolAccount.alias, snapshot);
          }
        }

      // Auto-retry without context-1m if it triggers a long-context billing error.
      // Anthropic returns this as either 400 ("long context beta is not yet available
      // for this subscription") or 429 ("Extra usage is required for long context
      // requests") depending on the endpoint — we handle both.
      //
      // Note: `upstream.text()` consumes the body, so once we peek we MUST
      // handle the response here (can't fall through to the normal forwarder).
      peekedBody = null;
      if ((upstream.status === 400 || upstream.status === 429) && !passthrough) {
        peekedBody = await upstream.text().catch(() => '');
        const isLongContextError = peekedBody.includes('long context')
          || peekedBody.includes('Extra usage is required')
          || peekedBody.includes('long_context');
        // Detect "Unexpected value(s) `flag-name` for the `anthropic-beta` header"
        // — the upstream's way of saying this account tier doesn't have the
        // flag. Parse out the offending tokens (there can be more than one),
        // cache them, strip, and retry.
        const betaRejectedFlags: string[] = [];
        if (upstream.status === 400 && peekedBody.includes('anthropic-beta')) {
          const re = /Unexpected value\(s\)\s+((?:`[^`]+`(?:\s*,\s*)?)+)\s+for the `anthropic-beta` header/;
          const m = peekedBody.match(re);
          if (m) {
            for (const tok of m[1].matchAll(/`([^`]+)`/g)) betaRejectedFlags.push(tok[1]);
          }
        }
        if (betaRejectedFlags.length > 0) {
          const acctKey = poolAccount?.alias ?? ACCOUNT_KEY_SINGLE;
          let set = unavailableBetas.get(acctKey);
          if (!set) { set = new Set(); unavailableBetas.set(acctKey, set); }
          const newFlags: string[] = [];
          for (const f of betaRejectedFlags) { if (!set.has(f)) { set.add(f); newFlags.push(f); } }
          if (verbose && newFlags.length > 0) console.log(`[dario] #${requestCount} anthropic-beta rejected (${newFlags.join(',')}) — retrying without (cached for session)`);
          const reducedBeta = beta.split(',').filter((t) => t.length > 0 && !set!.has(t)).join(',');
          const retryHeaders = { ...headers, 'anthropic-beta': reducedBeta };
          const retry = await fetch(targetBase, {
            method: req.method ?? 'POST',
            headers: passthrough ? retryHeaders : orderHeadersForOutbound(retryHeaders),
            body: finalBody ? new Uint8Array(finalBody) : undefined,
            signal: upstreamAbort.signal,
          });
          upstream = retry;
          peekedBody = null;
          if (pool && poolAccount) {
            const retrySnapshot = parseRateLimits(upstream.headers);
            if (upstream.status === 429) {
              pool.markRejected(poolAccount.alias, retrySnapshot);
            } else {
              pool.updateRateLimits(poolAccount.alias, retrySnapshot);
            }
          }
        } else if (isLongContextError) {
          // Cache the rejection so future requests on this account skip
          // context-1m up front instead of re-paying the 400/429 round-trip.
          const acctKey = poolAccount?.alias ?? ACCOUNT_KEY_SINGLE;
          const firstRejection = !context1mUnavailable.has(acctKey);
          context1mUnavailable.add(acctKey);
          if (verbose && firstRejection) console.log(`[dario] #${requestCount} context-1m rejected (${upstream.status}) — retrying without it (cached for session)`);
          // Rebuild via array filter instead of string replace so the output
          // is byte-identical to a request that started without context-1m
          // (skipContext1m path above). A deterministic string-replace would
          // leave the retry indistinguishable on content but divergent on
          // whitespace/structure if betaBase ever gains non-context-1m tokens
          // at the same position — keep the two paths funneled through one filter.
          const reducedBeta = beta.split(',').filter((t) => t !== 'context-1m-2025-08-07').join(',');
          const retryHeaders = { ...headers, 'anthropic-beta': reducedBeta };
          const retry = await fetch(targetBase, {
            method: req.method ?? 'POST',
            headers: passthrough ? retryHeaders : orderHeadersForOutbound(retryHeaders),
            body: finalBody ? new Uint8Array(finalBody) : undefined,
            signal: upstreamAbort.signal,
          });
          // Use the retry response from here on — peeked body is now stale
          upstream = retry;
          peekedBody = null;
          // Pool mode: re-capture after the context-1m retry as the snapshot may have changed.
          if (pool && poolAccount) {
            const retrySnapshot = parseRateLimits(upstream.headers);
            if (upstream.status === 429) {
              pool.markRejected(poolAccount.alias, retrySnapshot);
            } else {
              pool.updateRateLimits(poolAccount.alias, retrySnapshot);
            }
          }
        } else if (upstream.status === 429) {
          // Not a context-1m issue — try pool failover before surfacing to client
          if (pool && poolAccount) {
            const nextAccount = pool.selectExcluding(triedAliases);
            if (nextAccount) {
              triedAliases.add(nextAccount.alias);
              poolAccount = nextAccount;
              accessToken = nextAccount.accessToken;
              headers['Authorization'] = `Bearer ${accessToken}`;
              headers['x-claude-code-session-id'] = nextAccount.identity.sessionId;
              pool.rebindSticky(stickyKey, nextAccount.alias);
              peekedBody = null;
              continue dispatchLoop;
            }
          }
          const enriched = enrich429(peekedBody, upstream.headers);
          const responseHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': corsOrigin,
            ...SECURITY_HEADERS,
          };
          for (const [key, value] of upstream.headers.entries()) {
            if (key.startsWith('x-ratelimit') || key.startsWith('anthropic-ratelimit') || key === 'request-id') {
              responseHeaders[key] = value;
            }
          }
          requestCount++;
          if (analytics && poolAccount) {
            analytics.record({
              timestamp: Date.now(), account: poolAccount.alias, model: requestModel,
              inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
              claim: poolAccount.rateLimit.claim, util5h: poolAccount.rateLimit.util5h,
              util7d: poolAccount.rateLimit.util7d, overageUtil: poolAccount.rateLimit.overageUtil,
              latencyMs: Date.now() - startTime, status: 429, isStream: false, isOpenAI,
            });
          }
          res.writeHead(429, responseHeaders);
          res.end(enriched);
          return;
        } else if (upstream.status === 400) {
          // Non-long-context 400 — forward upstream error directly.
          // The body is already consumed, so we write it straight out.
          const responseHeaders: Record<string, string> = {
            'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
            'Access-Control-Allow-Origin': corsOrigin,
            ...SECURITY_HEADERS,
          };
          for (const [key, value] of upstream.headers.entries()) {
            if (key === 'request-id') responseHeaders[key] = value;
          }
          requestCount++;
          res.writeHead(400, responseHeaders);
          res.end(peekedBody);
          return;
        }
      }

      // Enrich 429 errors with rate limit details from headers (Anthropic only returns "Error")
      if (upstream.status === 429) {
        // Try pool failover before surfacing to client
        if (pool && poolAccount) {
          const nextAccount = pool.selectExcluding(triedAliases);
          if (nextAccount) {
            triedAliases.add(nextAccount.alias);
            poolAccount = nextAccount;
            accessToken = nextAccount.accessToken;
            headers['Authorization'] = `Bearer ${accessToken}`;
            headers['x-claude-code-session-id'] = nextAccount.identity.sessionId;
            pool.rebindSticky(stickyKey, nextAccount.alias);
            continue dispatchLoop;
          }
        }
        const errBody = await upstream.text().catch(() => '');
        const enriched = enrich429(errBody, upstream.headers);
        const responseHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin,
          ...SECURITY_HEADERS,
        };
        for (const [key, value] of upstream.headers.entries()) {
          if (key.startsWith('x-ratelimit') || key.startsWith('anthropic-ratelimit') || key === 'request-id') {
            responseHeaders[key] = value;
          }
        }
        requestCount++;
        if (analytics && poolAccount) {
          analytics.record({
            timestamp: Date.now(), account: poolAccount.alias, model: requestModel,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
            claim: poolAccount.rateLimit.claim, util5h: poolAccount.rateLimit.util5h,
            util7d: poolAccount.rateLimit.util7d, overageUtil: poolAccount.rateLimit.overageUtil,
            latencyMs: Date.now() - startTime, status: 429, isStream: false, isOpenAI,
          });
        }
        res.writeHead(429, responseHeaders);
        res.end(enriched);
        return;
      }

      // Non-429 — exit dispatch loop and forward the response to client.
      break;
      } // end dispatchLoop: while (true)

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

      // Log billing classification on first request or in verbose mode.
      //
      // Anthropic is inconsistent about returning rate-limit headers:
      // - Non-200 responses (429, 500, early aborts) often omit them entirely.
      // - The overage-utilization header is omitted when there is no overage
      //   bucket configured or when the subscription claim covers the request
      //   — in that case "overage" is effectively 0%, not unknown.
      // Pre-fix we logged `overage: ?` on every five_hour request that had no
      // overage configured, which looked like a broken parser (see #37 log
      // dump). Fix: treat missing overage header as 0% when the claim is
      // five_hour / five_hour_fallback (the subscription covered it), and fall
      // back to `n/a` in the genuinely-unknown case.
      const billingClaim = upstream.headers.get('anthropic-ratelimit-unified-representative-claim');
      const overageUtil = upstream.headers.get('anthropic-ratelimit-unified-overage-utilization');
      if (requestCount === 1 || verbose) {
        if (billingClaim) {
          let overagePct: string;
          if (overageUtil !== null) {
            overagePct = `${Math.round(parseFloat(overageUtil) * 100)}%`;
          } else if (billingClaim === 'five_hour' || billingClaim === 'five_hour_fallback') {
            overagePct = '0%';
          } else {
            overagePct = 'n/a';
          }
          // Show the derived billing bucket as the headline, with the raw
          // claim value in parens so power users still see the header as-is.
          // See #34 — users want "am I actually on subscription?" answered
          // at a glance instead of having to memorize that `five_hour` means
          // "yes, subscription."
          const bucket = billingBucketFromClaim(billingClaim);
          console.log(`[dario] #${requestCount} billing: ${bucket} (${billingClaim}, overage: ${overagePct})`);
        } else if (verbose) {
          console.log(`[dario] #${requestCount} billing: headers absent (status=${upstream.status})`);
        }
      }

      res.writeHead(upstream.status, responseHeaders);

      if (isStream && upstream.body) {
        // Analytics accumulators for streaming responses — filled by parsing
        // message_start / message_delta SSE events as they flow through.
        let streamInputTokens = 0;
        let streamOutputTokens = 0;
        let streamCacheReadTokens = 0;
        let streamCacheCreateTokens = 0;
        const analyticsDecoder = (analytics && poolAccount) ? new TextDecoder() : null;
        let analyticsBuffer = '';

        // Stream SSE chunks through
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        // Stateful streaming reverse-mapper for tool_use blocks. Buffers
        // input_json_delta chunks per content block and emits a single
        // synthetic delta with the translated parameter shape on
        // content_block_stop. Issue #29 fix lives here for the streaming
        // path; the non-streaming reverseMapResponse covers buffered
        // responses below.
        const streamMapper = ccToolMap && !isOpenAI
          ? createStreamingReverseMapper(ccToolMap, reqCtx)
          : null;
        // Gated writer — a no-op once the downstream client has gone away
        // in drain-on-close mode. The read loop keeps consuming so the
        // upstream sees a full-length read; writes to a closed socket are
        // suppressed to avoid EPIPE/warnings and pointless work.
        const writeToClient = (chunk: Uint8Array | string) => {
          if (!clientDisconnected) res.write(chunk);
        };
        try {
          let buffer = '';
          const MAX_LINE_LENGTH = 1_000_000; // 1MB max per SSE line
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Parse SSE events for analytics regardless of routing branch
            if (analyticsDecoder && value) {
              analyticsBuffer += analyticsDecoder.decode(value, { stream: true });
              const parts = analyticsBuffer.split('\n\n');
              analyticsBuffer = parts.pop() ?? '';
              for (const part of parts) {
                const dataLine = part.split('\n').find(l => l.startsWith('data: '));
                if (!dataLine) continue;
                try {
                  const e = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
                  if (e.type === 'message_start') {
                    const u = (e.message as { usage?: Record<string, number> } | undefined)?.usage;
                    if (u) {
                      streamInputTokens = u.input_tokens ?? 0;
                      streamCacheReadTokens = u.cache_read_input_tokens ?? 0;
                      streamCacheCreateTokens = u.cache_creation_input_tokens ?? 0;
                    }
                  } else if (e.type === 'message_delta') {
                    const u = (e as { usage?: Record<string, number> }).usage;
                    if (u?.output_tokens) streamOutputTokens = u.output_tokens;
                  }
                } catch { /* ignore malformed SSE events */ }
              }
            }

            if (isOpenAI) {
              // Translate Anthropic SSE → OpenAI SSE
              buffer += decoder.decode(value, { stream: true });
              // Reject oversized SSE lines instead of silently truncating.
              // Truncation hid protocol bugs (a runaway upstream event would
              // stream indefinitely with the tail rewritten each chunk) and
              // guaranteed a malformed JSON parse at the client. Since we've
              // already sent 200 and an SSE content-type, the cleanest exit
              // is an error event in OpenAI shape + [DONE] sentinel + abort.
              if (buffer.length > MAX_LINE_LENGTH) {
                if (verbose) console.warn(`[dario] #${requestCount} SSE line exceeded ${MAX_LINE_LENGTH}B — aborting stream`);
                const errPayload = JSON.stringify({
                  error: {
                    message: `Upstream SSE line exceeded ${MAX_LINE_LENGTH} bytes`,
                    type: 'upstream_protocol_error',
                  },
                });
                writeToClient(`data: ${errPayload}\n\n`);
                writeToClient('data: [DONE]\n\n');
                upstreamAbortReason = 'sse_overflow';
                upstreamAbort.abort();
                break;
              }
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                const translated = translateStreamChunk(line);
                if (translated) writeToClient(translated);
              }
            } else if (streamMapper) {
              const out = streamMapper.feed(value);
              if (out.length > 0) writeToClient(out);
            } else {
              writeToClient(value);
            }
          }
          // Flush remaining buffer
          if (isOpenAI && buffer.trim()) {
            const translated = translateStreamChunk(buffer);
            if (translated) writeToClient(translated);
          }
          if (streamMapper) {
            const tail = streamMapper.end();
            if (tail.length > 0) writeToClient(tail);
          }
        } catch (err) {
          if (verbose) console.error('[dario] Stream error:', sanitizeError(err));
        }
        res.end();
        if (analytics && poolAccount) {
          analytics.record({
            timestamp: Date.now(), account: poolAccount.alias, model: requestModel,
            inputTokens: streamInputTokens, outputTokens: streamOutputTokens,
            cacheReadTokens: streamCacheReadTokens, cacheCreateTokens: streamCacheCreateTokens,
            thinkingTokens: 0,
            claim: poolAccount.rateLimit.claim, util5h: poolAccount.rateLimit.util5h,
            util7d: poolAccount.rateLimit.util7d, overageUtil: poolAccount.rateLimit.overageUtil,
            latencyMs: Date.now() - startTime, status: upstream.status, isStream: true, isOpenAI,
          });
        }
      } else {
        // Buffer and forward
        let responseBody = await upstream.text();

        // Reverse tool name mapping so client sees original names
        if (ccToolMap) responseBody = reverseMapResponse(responseBody, ccToolMap, reqCtx);

        if (isOpenAI && upstream.status >= 200 && upstream.status < 300) {
          try {
            const parsed = JSON.parse(responseBody) as Record<string, unknown>;
            res.end(JSON.stringify(anthropicToOpenai(parsed)));
          } catch {
            res.end(responseBody);
          }
        } else {
          res.end(responseBody);
        }

        if (analytics && poolAccount) {
          try {
            const parsed = JSON.parse(responseBody) as Record<string, unknown>;
            const usage = Analytics.parseUsage(parsed);
            analytics.record({
              timestamp: Date.now(), account: poolAccount.alias,
              model: usage.model || requestModel,
              inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens, cacheCreateTokens: usage.cacheCreateTokens,
              thinkingTokens: usage.thinkingTokens,
              claim: poolAccount.rateLimit.claim, util5h: poolAccount.rateLimit.util5h,
              util7d: poolAccount.rateLimit.util7d, overageUtil: poolAccount.rateLimit.overageUtil,
              latencyMs: Date.now() - startTime, status: upstream.status, isStream: false, isOpenAI,
            });
          } catch { /* don't let analytics errors break responses */ }
        }

        if (verbose) console.log(`[dario] #${requestCount} ${upstream.status}`);
      }
    } catch (err) {
      // Differentiate the three failure modes so each gets the right
      // response (and so we don't spam logs when clients simply drop).
      if (upstreamAbortReason === 'client_closed') {
        if (verbose) console.log(`[dario] #${requestCount} aborted (client disconnected)`);
      } else if (upstreamAbortReason === 'timeout') {
        console.error(`[dario] #${requestCount} upstream timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`);
        if (!res.headersSent) {
          res.writeHead(504, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Upstream timeout', message: `Anthropic did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s` }));
        } else if (!res.writableEnded) {
          res.end();
        }
      } else {
        // Log full error server-side, return generic message to client
        console.error('[dario] Proxy error:', sanitizeError(err));
        if (!res.headersSent) {
          res.writeHead(502, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Proxy error', message: 'Failed to reach upstream API' }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } finally {
      // Always clean up the upstream-abort plumbing if it was set up. The
      // setup happens after the body-read phase, so on fast-path errors
      // (413, body read timeout) these may still be null — guard accordingly.
      if (upstreamTimeout !== null) clearTimeout(upstreamTimeout);
      if (onClientClose !== null) req.off('close', onClientClose);
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

  // One-line template summary so users can tell at a glance whether they
  // booted on a fresh live capture or a stale bundled fallback.
  console.log(`[dario] template: ${describeTemplate(CC_TEMPLATE)}`);

  // Drift check: compare captured CC version to the installed binary. If
  // they differ, force the background refresh to bypass TTL so the next
  // startup picks up the new capture. Drifted caches still serve the
  // current request — the shape is usually compatible — but we flag it.
  const drift = detectDrift(CC_TEMPLATE);
  if (drift.drifted) {
    console.log(`[dario] ⚠  template drift: ${drift.message}`);
  }

  // Compat check: is the installed CC inside the range this dario
  // release has been tested against? Only log when non-OK so the happy
  // path stays quiet. `unknown` (no CC on PATH) is also quiet — bundled
  // template will serve.
  const compat = checkCCCompat();
  if (compat.status === 'below-min' || compat.status === 'untested-above') {
    console.log(`[dario] ⚠  CC compat: ${compat.message}`);
  }

  // TLS-fingerprint banner (v3.23). Proxy mode terminates TLS from this
  // process, so the Bun-vs-Node runtime choice is actually on the wire.
  // Silence via DARIO_QUIET_TLS=1 for known-fine environments.
  if (runtimeFp.status !== 'bun-match' && process.env.DARIO_QUIET_TLS !== '1') {
    console.log(`[dario] ⚠  TLS fingerprint: ${runtimeFp.detail}`);
    if (runtimeFp.hint) console.log(`[dario]    → ${runtimeFp.hint}`);
    console.log('[dario]    (silence with DARIO_QUIET_TLS=1, or use --strict-tls to hard-fail)');
  }

  // Kick off a live fingerprint refresh in the background. Re-captures the
  // user's own CC binary request shape and updates ~/.dario/cc-template.live.json
  // for the next startup. No-op if CC isn't installed or the cache is fresh.
  // Never blocks proxy startup; never throws.
  void import('./live-fingerprint.js').then(({ refreshLiveFingerprintAsync }) =>
    refreshLiveFingerprintAsync({ silent: false, force: drift.drifted }).catch(() => { /* noop */ }),
  );

  server.listen(port, host, () => {
    const modeLine = passthrough
      ? 'Mode: passthrough (OAuth swap only, no injection)'
      : `OAuth: ${status.status} (expires in ${status.expiresIn})`;
    const modelLine = modelOverride ? `Model: ${modelOverride} (all requests)` : 'Model: passthrough (client decides)';
    // Display URL uses `localhost` for loopback binds and the literal host
    // for exposed binds, so the printed URL is the one a client would
    // actually use to reach the proxy.
    const displayHost = isLoopbackHost(host) ? 'localhost' : host;
    console.log('');
    console.log(`  dario — http://${displayHost}:${port}`);
    console.log('');
    console.log('  Your Claude subscription is now an API.');
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://${displayHost}:${port}`);
    console.log('    ANTHROPIC_API_KEY=dario');
    console.log('');
    console.log(`  ${modeLine}`);
    console.log(`  ${modelLine}`);
    if (!isLoopbackHost(host)) {
      console.log('');
      console.log(`  ⚠  Bound to ${host} — reachable from other machines on the network.`);
      if (!apiKey && !mcs) {
        console.log('     No auth configured. Any host that can reach this port can proxy');
        console.log('     requests through your OAuth subscription. Set DARIO_API_KEY (for');
        console.log('     normal clients) or MUX_COORD_SECRET (for mux lender mode) before');
        console.log('     exposing dario beyond loopback.');
      } else {
        const lanes = [];
        if (apiKey) lanes.push('x-api-key / Authorization (DARIO_API_KEY)');
        if (mcs) lanes.push('X-Mux-Coord-Secret (MUX_COORD_SECRET — mux lender mode)');
        console.log(`     Auth required — accepted credentials: ${lanes.join(' or ')}.`);
      }
    }
    console.log('');
  });

  // Session presence heartbeat — keeps the OAuth session marked active
  // (matches the ~5s cadence of a real Claude Code session).
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

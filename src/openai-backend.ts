/**
 * OpenAI-compatible backend.
 *
 * When `dario backend add openai --key=sk-...` has been run, requests to
 * `/v1/chat/completions` with a GPT-style model name are forwarded to the
 * configured OpenAI-compat endpoint instead of being routed through the
 * Claude template path. The Claude backend is unchanged.
 *
 * The `--base-url` flag is accepted so the same command works for any
 * OpenAI-compatible provider (OpenAI, OpenRouter, Groq, LiteLLM, a local
 * Ollama exposing OpenAI compat, etc.). Only one openai-compat backend can
 * be active at a time in v3.6.0; multi-backend-per-provider routing lands
 * in a follow-up release.
 */
import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { upstreamDeadline } from './upstream-deadline.js';

const DARIO_DIR = join(homedir(), '.dario');
const BACKENDS_DIR = join(DARIO_DIR, 'backends');

export const MINIMAX_MODELS = ['MiniMax-M3.1-Flash', 'MiniMax-M3'] as const;

/** Presets use the existing single OpenAI-compatible backend slot. */
export function defaultBackendBaseUrl(name: string): string {
  if (name.toLowerCase() === 'minimax') return 'https://api.minimax.io/v1';
  if (name.toLowerCase() === 'minimax-cn') return 'https://api.minimax.cn/v1';
  return 'https://api.openai.com/v1';
}

/** Only direct endpoints imply a MiniMax catalog; custom gateways stay explicit. */
export function isMiniMaxBackend(backend: BackendCredentials | null): boolean {
  return backend?.provider === 'openai' &&
    ['https://api.minimax.io/v1', 'https://api.minimax.cn/v1', 'https://api.minimaxi.com/v1'].includes(backend.baseUrl.replace(/\/$/, ''));
}

/**
 * Normalize a caller-supplied backend name into a filesystem-safe leaf.
 * Strips any directory component and rejects names outside the allowed
 * charset. Defense in depth — CLI input is already constrained.
 */
function safeBackendPath(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const leaf = basename(name);
  if (leaf !== name) return null;
  if (leaf === '.' || leaf === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/.test(leaf)) return null;
  return join(BACKENDS_DIR, `${leaf}.json`);
}

export interface BackendCredentials {
  provider: string;      // "openai"
  name: string;          // "openai", "groq", "openrouter", etc.
  apiKey: string;
  baseUrl: string;       // "https://api.openai.com/v1"
}

async function ensureDir(): Promise<void> {
  await mkdir(BACKENDS_DIR, { recursive: true, mode: 0o700 });
}

export async function listBackends(): Promise<BackendCredentials[]> {
  try {
    await ensureDir();
    const files = await readdir(BACKENDS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const results: BackendCredentials[] = [];
    for (const f of jsonFiles) {
      try {
        const raw = await readFile(join(BACKENDS_DIR, f), 'utf-8');
        results.push(JSON.parse(raw) as BackendCredentials);
      } catch { /* skip unreadable */ }
    }
    return results;
  } catch {
    return [];
  }
}

export async function saveBackend(creds: BackendCredentials): Promise<void> {
  const path = safeBackendPath(creds.name);
  if (!path) throw new Error(`invalid backend name: ${creds.name}`);
  await ensureDir();
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function removeBackend(name: string): Promise<boolean> {
  const path = safeBackendPath(name);
  if (!path) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** Get the first openai-compat backend (v3.6.0 supports exactly one). */
export async function getOpenAIBackend(): Promise<BackendCredentials | null> {
  const all = await listBackends();
  return all.find(b => b.provider === 'openai') ?? null;
}

// Model names that should route to the OpenAI backend when one is configured.
// Deliberately narrow — OpenAI and reasoning-series only. Custom GPT-shaped
// names from other providers (llama-*, mixtral-*) don't match by default;
// users pass them through as-is on the OpenAI-compat endpoint and they'll
// reach the configured baseUrl, which is correct for OpenRouter/Groq/etc.
const OPENAI_MODEL_PATTERNS = [
  /^gpt-/i,
  /^o1-/i,
  /^o3-/i,
  /^o4-/i,
  /^chatgpt-/i,
  /^text-davinci/i,
  /^text-embedding-/i,
];

export function isOpenAIModel(model: string): boolean {
  return OPENAI_MODEL_PATTERNS.some(p => p.test(model));
}

/**
 * Forward a client request to the configured OpenAI-compat backend.
 * Pass-through: the client is already speaking OpenAI format, we just swap
 * the API key and the target URL. No template, no identity, no scrubbing.
 */
export async function forwardToOpenAI(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  backend: BackendCredentials,
  corsOrigin: string,
  securityHeaders: Record<string, string>,
  upstreamTimeoutMs: number,
  verbose: boolean,
): Promise<void> {
  const target = `${backend.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const clientBeta = req.headers['anthropic-beta'];

  // Headers: drop anything Anthropic-specific, keep only the essentials
  // OpenAI-compat endpoints care about. Streaming is driven by the body, not
  // a header, so we don't need to parse it here.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${backend.apiKey}`,
    'Accept': req.headers.accept?.toString() ?? 'application/json',
  };
  // Some openai-compat providers (OpenRouter) want their own custom headers
  // for attribution. If the client sent an x-title or http-referer, forward
  // those through so the upstream provider sees them.
  for (const h of ['x-title', 'http-referer', 'x-openrouter-app']) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  // Drop Anthropic-specific headers entirely
  void clientBeta;

  const abort = new AbortController();
  // Caps the wait until headers, then the gap between chunks of a 2xx body.
  const timeout = upstreamDeadline(upstreamTimeoutMs, () => abort.abort());

  try {
    if (verbose) {
      console.log(`[dario] → openai backend: ${target}`);
    }
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
      signal: abort.signal,
    });

    const respHeaders: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
      ...securityHeaders,
    };
    // Forward rate-limit + request-id headers from the upstream
    for (const [key, value] of upstream.headers.entries()) {
      if (
        key.startsWith('x-ratelimit') ||
        key.startsWith('openai-') ||
        key === 'request-id' ||
        key === 'x-request-id'
      ) {
        respHeaders[key] = value;
      }
    }

    res.writeHead(upstream.status, respHeaders);

    if (upstream.body) {
      if (upstream.ok) timeout.streaming();
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          timeout.touch();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
  } catch (err) {
    timeout.clear();
    // Log error details server-side only. Responding with err.message
    // exposes internal stack / path / module information (CodeQL
    // js/stack-trace-exposure). The client gets a generic 502.
    const detail = err instanceof Error ? err.message : String(err);
    if (verbose) console.error(`[dario] openai backend (${backend.name}) error: ${detail}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...securityHeaders });
      res.end(JSON.stringify({
        error: 'Upstream OpenAI-compat backend error',
        backend: backend.name,
      }));
    } else {
      try { res.end(); } catch { /* already closed */ }
    }
    return;
  } finally {
    timeout.clear();
  }
}

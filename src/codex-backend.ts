/**
 * Codex backend — request path for the "altman" engine (dario#1009/#1010).
 *
 * The ChatGPT subscription is NOT an api.openai.com API key: it can't be used
 * with `Authorization: Bearer sk-…` against the public API. OpenAI's own `codex`
 * CLI sends the OAuth access_token as a bearer to the ChatGPT Codex backend's
 * Responses endpoint, with the workspace id from the id_token as a header.
 * Mirrored from the CLI source rather than guessed:
 *
 *   base URL   codex-rs/model-provider-info/src/lib.rs
 *              `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`
 *              (used as the default base_url whenever auth_mode is Chatgpt)
 *   wire api   same file, `WireApi::Responses` — "the Responses API exposed by
 *              OpenAI at /v1/responses", i.e. `${base}/responses`
 *   headers    codex-rs/model-provider/src/bearer_auth_provider.rs
 *              `Authorization: Bearer <access_token>` + `ChatGPT-Account-ID: <id>`
 *   account id codex-rs/login/src/token_data.rs — id_token claim
 *              `https://api.openai.com/auth`.chatgpt_account_id
 *
 * dario's inbound is OpenAI chat/completions — what any OpenAI-compatible
 * client speaks — so this module owns the chat/completions ⇄ Responses
 * translation in both directions, including SSE.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CodexAccountCredentials } from './codex-accounts.js';

export const CODEX_BACKEND_BASE_URL =
  process.env.DARIO_CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';

/** Originator string the codex CLI identifies itself with. */
const CODEX_ORIGINATOR = 'codex_cli_rs';

/**
 * Client version sent on the model-discovery call. The backend REQUIRES the
 * `client_version` query parameter and rejects the request without it; the
 * value tracks a released codex CLI. Bump it when the backend starts gating on
 * a newer one — it is a constant precisely so that stays a one-line change.
 */
export const CODEX_CLIENT_VERSION = process.env.DARIO_CODEX_CLIENT_VERSION || '0.152.0';

/**
 * Which models a subscription may use is decided by the backend, not by us, and
 * the set moves (it is per-account, and changes as new slugs ship). Hardcoded
 * name patterns do not work: `gpt-5-codex`, `codex-*`, `gpt-5`, `gpt-5.1`, `o3`
 * and `gpt-4.1` all 400 with "The '<model>' model is not supported when using
 * Codex with a <plan> account". So the routable set is DISCOVERED — GET
 * `${base}/models?client_version=…` with the account's own headers, keeping the
 * entries the backend marks visible.
 *
 * Cached per process because it gates routing on every request; a stale entry
 * costs at most one upstream 400, and the TTL is short.
 */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
/** Failures cache too, briefly, so an outage isn't one fetch per request. */
const MODEL_CACHE_ERROR_TTL_MS = 60 * 1000;

interface ModelCacheEntry {
  slugs: readonly string[];
  fetchedAt: number;
  ttlMs: number;
}

const modelCache = new Map<string, ModelCacheEntry>();

/** Test seam — drop the discovery cache. */
export function clearCodexModelCache(): void {
  modelCache.clear();
}

interface CodexModelsResponse {
  models?: Array<{ slug?: string; id?: string; visibility?: string }>;
  data?: Array<{ slug?: string; id?: string; visibility?: string }>;
}

/**
 * Slugs the backend lists for this account. `visibility` separates models meant
 * for a picker ("list") from internal ones ("hide" — e.g. `gpt-reserve`,
 * `codex-auto-review`); only listed ones are routable and advertisable.
 * Throws on a non-2xx or unparseable response; getCodexModelSlugs absorbs it.
 */
export async function fetchCodexModels(
  creds: CodexAccountCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly string[]> {
  const base = CODEX_BACKEND_BASE_URL.replace(/\/$/, '');
  const target = `${base}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const headers = buildCodexHeaders(creds);
  // Discovery is JSON, not SSE — the shared header builder asks for a stream.
  headers['Accept'] = 'application/json';
  const res = await fetchImpl(target, { method: 'GET', headers });
  if (!res.ok) throw new Error(`codex /models ${res.status}`);
  const parsed = (await res.json()) as CodexModelsResponse;
  const entries = parsed.models ?? parsed.data ?? [];
  const slugs: string[] = [];
  for (const m of entries) {
    const slug = m?.slug ?? m?.id;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    // Absent visibility counts as listed: a backend that stops sending the
    // field should degrade to "offer everything", not to "offer nothing".
    if (m.visibility != null && m.visibility !== 'list') continue;
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Cached {@link fetchCodexModels}, keyed by account alias. Never throws — an
 * unreachable backend yields the last known set, or an empty one, which means
 * "route nothing here by name". An explicit `codex:`/`chatgpt:` prefix still
 * routes, so discovery being down never makes the engine unusable.
 */
export async function getCodexModelSlugs(
  creds: CodexAccountCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly string[]> {
  const hit = modelCache.get(creds.alias);
  if (hit && Date.now() - hit.fetchedAt < hit.ttlMs) return hit.slugs;
  try {
    const slugs = await fetchCodexModels(creds, fetchImpl);
    modelCache.set(creds.alias, { slugs, fetchedAt: Date.now(), ttlMs: MODEL_CACHE_TTL_MS });
    return slugs;
  } catch {
    const slugs = hit?.slugs ?? [];
    modelCache.set(creds.alias, { slugs, fetchedAt: Date.now(), ttlMs: MODEL_CACHE_ERROR_TTL_MS });
    return slugs;
  }
}

/**
 * Whether a request naming `model` should be served from the subscription: the
 * name matches a discovered slug. Pure, with the slugs injected, so routing is
 * testable without network — and checked BEFORE openai-backend's
 * `isOpenAIModel` (the codex adapter has the higher priority), so a discovered
 * `gpt-5.5` reaches the subscription while a plain `gpt-4o` still reaches a
 * configured API-key backend.
 */
export function isCodexModel(model: string, slugs: readonly string[]): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return slugs.some(s => s.toLowerCase() === m);
}

/**
 * Pull `chatgpt_account_id` out of the id_token's `https://api.openai.com/auth`
 * claim. Payload only — this is reading our own token for a routing header, not
 * validating a token, so there's nothing to verify a signature against here.
 * Null when the token is absent/malformed/claimless; the caller then omits the
 * header, which is what the CLI does for accounts without a workspace.
 */
export function extractChatGPTAccountId(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as
      Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

type ChatMessage = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };

/** One `input` item for the Responses API. */
type ResponsesInputItem = Record<string, unknown>;

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const p = part as { type?: string; text?: string };
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Translate an OpenAI chat/completions request body into a Responses request.
 *
 * - system messages collapse into `instructions` (Responses has no system role)
 * - assistant `tool_calls` become `function_call` items, `role: "tool"` replies
 *   become `function_call_output` items, keyed by the same call_id
 * - tools lose the `{type:'function', function:{…}}` nesting; Responses takes
 *   name/description/parameters flat on the tool
 * - `store: false` because dario is a proxy: nothing here is a ChatGPT thread
 *   the user would expect to find in their history
 */
export function chatCompletionsToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body.messages as ChatMessage[] | undefined) ?? [];
  const instructions = messages
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => messageContentToText(m.content))
    .filter(t => t.length > 0)
    .join('\n\n');

  const input: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;

    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: messageContentToText(m.content),
      });
      continue;
    }

    if (m.role === 'assistant') {
      const text = messageContentToText(m.content);
      if (text.length > 0) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      const calls = m.tool_calls as
        | Array<{ id?: string; function?: { name?: string; arguments?: string } }>
        | undefined;
      for (const c of calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: c.id ?? '',
          name: c.function?.name ?? '',
          arguments: c.function?.arguments ?? '{}',
        });
      }
      continue;
    }

    input.push({ role: 'user', content: [{ type: 'input_text', text: messageContentToText(m.content) }] });
  }

  const out: Record<string, unknown> = {
    model: String(body.model ?? ''),
    input,
    store: false,
    stream: true,
  };
  if (instructions.length > 0) out.instructions = instructions;

  const tools = body.tools as
    | Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>
    | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    out.tools = tools.map(t => ({
      type: 'function',
      name: t.function?.name ?? '',
      description: t.function?.description,
      parameters: t.function?.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (body.tool_choice != null) out.tool_choice = body.tool_choice;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.max_tokens != null || body.max_completion_tokens != null) {
    out.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  }
  if (body.reasoning_effort != null) out.reasoning = { effort: body.reasoning_effort };

  return out;
}

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  args: string;
}

/**
 * Stateful per-request translator: Responses SSE in, chat/completions out.
 *
 * `chunk()` returns the chat.completion.chunk SSE line to write back (null when
 * the upstream event has no chat-shape equivalent — reasoning summaries,
 * progress events). It also accumulates, so `complete()` can hand back a single
 * non-streaming `chat.completion` body. dario always asks the Codex backend for
 * a stream and collapses it here when the client didn't want one; that keeps one
 * upstream code path instead of two.
 *
 * One translator per request — never module-global — for the same reason
 * createOpenAIStreamTranslator is per-call (#642-audit: interleaved streams
 * corrupting shared tool-call indices).
 */
export function createResponsesTranslator(model: string) {
  const created = Math.floor(Date.now() / 1000);
  let id = 'chatcmpl-dario';
  let text = '';
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
  const toolCalls = new Map<string, ToolCallAccumulator>();
  let nextToolIndex = 0;
  let roleSent = false;

  const frame = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  /**
   * Prefix the role-only opening frame the first time we emit anything.
   *
   * The reference OpenAI stream always opens with
   * `delta: {"role":"assistant","content":""}` before any content, and SDK
   * accumulators (openai-node's ChatCompletionStream, and every harness built
   * on it — Cursor, Continue, Aider) use that frame to OPEN the assistant
   * message. Without it the assembled message has no role, which reads fine in
   * a terminal and then fails when the harness sends that history back.
   * Emitted at `response.created` in the normal case; the flag makes every
   * other branch safe too, so a stream that somehow starts with a text delta
   * still cannot put content on the wire before the role.
   */
  const opened = (rest: string): string => {
    if (roleSent) return rest;
    roleSent = true;
    return frame({ role: 'assistant', content: '' }, null) + rest;
  };

  return {
    /** Feed one raw SSE line. Returns the line to forward, or null. */
    chunk(line: string): string | null {
      if (!line.startsWith('data: ')) return null;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') return null;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
      const type = String(e.type ?? '');

      if (type === 'response.created') {
        const r = e.response as { id?: string } | undefined;
        if (r?.id) id = `chatcmpl-${r.id.replace(/^resp_/, '')}`;
        return opened('');
      }

      if (type === 'response.output_text.delta') {
        const d = typeof e.delta === 'string' ? e.delta : '';
        if (!d) return null;
        text += d;
        return opened(frame({ content: d }, null));
      }

      if (type === 'response.output_item.added') {
        const item = e.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined;
        if (item?.type !== 'function_call') return null;
        const key = item.id ?? item.call_id ?? `item_${nextToolIndex}`;
        const acc: ToolCallAccumulator = {
          index: nextToolIndex++,
          id: item.call_id ?? key,
          name: item.name ?? '',
          args: '',
        };
        toolCalls.set(key, acc);
        return opened(
          frame(
            { tool_calls: [{ index: acc.index, id: acc.id, type: 'function', function: { name: acc.name, arguments: '' } }] },
            null,
          ),
        );
      }

      if (type === 'response.function_call_arguments.delta') {
        const key = String(e.item_id ?? '');
        const acc = toolCalls.get(key) ?? [...toolCalls.values()].at(-1);
        const d = typeof e.delta === 'string' ? e.delta : '';
        if (!acc || !d) return null;
        acc.args += d;
        return opened(frame({ tool_calls: [{ index: acc.index, function: { arguments: d } }] }, null));
      }

      if (type === 'response.completed' || type === 'response.incomplete') {
        const r = e.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
        const u = r?.usage;
        if (u) {
          usage = {
            prompt_tokens: u.input_tokens ?? 0,
            completion_tokens: u.output_tokens ?? 0,
            total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          };
        }
        return opened(`${frame({}, toolCalls.size > 0 ? 'tool_calls' : 'stop')}data: [DONE]\n\n`);
      }

      return null;
    },

    /** Everything seen so far, as one non-streaming chat.completion body. */
    complete(): Record<string, unknown> {
      const calls = [...toolCalls.values()].sort((a, b) => a.index - b.index);
      const message: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (calls.length > 0) {
        message.tool_calls = calls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        }));
      }
      return {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

export function buildCodexHeaders(creds: CodexAccountCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${creds.accessToken}`,
    'originator': CODEX_ORIGINATOR,
    'OpenAI-Beta': 'responses=experimental',
  };
  const accountId = extractChatGPTAccountId(creds.idToken);
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  return headers;
}

/**
 * Serve a /v1/chat/completions request from a stored Codex account.
 *
 * `fetchImpl` is injectable so the translation and header construction are
 * testable without network (test/codex-backend.mjs), matching the pattern
 * test/codex-oauth.mjs already uses.
 */
export async function forwardToCodex(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  creds: CodexAccountCredentials,
  corsOrigin: string,
  securityHeaders: Record<string, string>,
  upstreamTimeoutMs: number,
  verbose: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  void req;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders });
    res.end(JSON.stringify({ error: 'Codex backend requires a JSON chat/completions body' }));
    return;
  }

  const clientWantsStream = parsed.stream === true;
  const model = String(parsed.model ?? '');
  const upstreamBody = chatCompletionsToResponses(parsed);
  const target = `${CODEX_BACKEND_BASE_URL.replace(/\/$/, '')}/responses`;

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), upstreamTimeoutMs);

  try {
    if (verbose) console.log(`[dario] → codex backend: ${target} (model: ${model})`);
    const upstream = await fetchImpl(target, {
      method: 'POST',
      headers: buildCodexHeaders(creds),
      body: JSON.stringify(upstreamBody),
      signal: abort.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      if (verbose) console.error(`[dario] codex backend ${upstream.status}: ${detail.slice(0, 300)}`);
      res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...securityHeaders });
      res.end(JSON.stringify({
        error: 'Upstream Codex backend error',
        status: upstream.status,
        account: creds.alias,
      }));
      return;
    }

    const translator = createResponsesTranslator(model);

    if (clientWantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': corsOrigin,
        ...securityHeaders,
      });
    }

    let buffered = '';
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          // SSE frames are newline-delimited; keep the trailing partial line.
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            const out = translator.chunk(line);
            if (out && clientWantsStream) res.write(out);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (buffered.length > 0) {
        const out = translator.chunk(buffered);
        if (out && clientWantsStream) res.write(out);
      }
    }

    if (clientWantsStream) {
      res.end();
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
        ...securityHeaders,
      });
      res.end(JSON.stringify(translator.complete()));
    }
  } catch (err) {
    // Detail stays server-side (CodeQL js/stack-trace-exposure), same as
    // forwardToOpenAI.
    const detail = err instanceof Error ? err.message : String(err);
    if (verbose) console.error(`[dario] codex backend (${creds.alias}) error: ${detail}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...securityHeaders });
      res.end(JSON.stringify({ error: 'Upstream Codex backend error', account: creds.alias }));
    } else {
      try { res.end(); } catch { /* already closed */ }
    }
  } finally {
    clearTimeout(timeout);
  }
}

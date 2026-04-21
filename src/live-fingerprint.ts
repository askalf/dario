/**
 * Live fingerprint extraction.
 *
 * At dario startup, spawn the user's actual `claude` binary against a
 * loopback MITM endpoint, capture the outbound /v1/messages request, and
 * use the captured system prompt / tools / agent identity as the template
 * replay source — instead of shipping a stale snapshot in
 * `cc-template-data.json`.
 *
 * The bundled snapshot remains as a fallback for users without CC installed
 * or when live capture fails. Template replay auto-heals on CC updates
 * without any user action.
 *
 * Security: the MITM endpoint only accepts connections from 127.0.0.1 and
 * only runs long enough to capture a single request. CC's OAuth token
 * never leaves the machine — we send CC to a loopback URL that CC itself
 * trusts because we set ANTHROPIC_BASE_URL in the child's environment.
 *
 * --------------------------------------------------------------------
 * "Hide in the population" roadmap (v3.13 → ?)
 * --------------------------------------------------------------------
 *
 * The fingerprint pipeline has historically cared about one axis: what
 * goes INSIDE the /v1/messages body (agent identity, system prompt, tool
 * list). That's only one fingerprint vector. Anthropic can (and likely
 * does) look at several others:
 *
 *   1. Header ORDER. Node's http module emits headers in alphabetical
 *      order via setHeader(). Undici preserves insertion order. Real CC
 *      uses undici with a specific insertion pattern. If dario sends
 *      headers in a different order than CC, the difference is trivially
 *      observable on the server side via the raw header array.
 *      → Captured as `header_order` below. Outbound proxy paths should
 *        use the captured order when rebuilding fetch() headers.
 *
 *   2. TLS ClientHello (JA3 / JA4 fingerprint). The cipher list, elliptic
 *      curves, extension order, and ALPN negotiation are determined by
 *      the TLS library, and Node's TLS (OpenSSL) produces a distinctive
 *      fingerprint that differs from any browser or from curl. Real CC
 *      running on top of Node has the Node JA3 — so we already match,
 *      provided both run on the same Node major. A cross-runtime worry
 *      surfaces when Anthropic ships Bun- or bundled-binary CC: at that
 *      point Node-dario and Bun-CC would JA-differ.
 *      → Mitigation: detect Bun-compiled CC, fall back to shim mode
 *        (which patches fetch INSIDE the CC process, inheriting CC's
 *        own TLS stack for free).
 *
 *   3. HTTP/2 frame ordering + SETTINGS parameters. Similar to TLS, this
 *      is controlled by the HTTP library. Node and undici produce a
 *      consistent H2 fingerprint. Matches as long as both ends run the
 *      same library.
 *
 *   4. Request timing distribution. Real CC sends requests with jitter
 *      driven by user typing, tool-call sequencing, and internal retry
 *      logic. Dario-through-a-client sends requests with jitter driven
 *      by WHATEVER client is on the other end (OpenClaw, Hermes, curl).
 *      That distribution differs from CC's. Anthropic could pattern-match
 *      "no inter-request jitter" as a fingerprint for automated usage.
 *      → Deferred. Adds latency for debatable gain. Analytics already
 *        tracks per-request timing — could drive a replay distribution
 *        later.
 *
 *   5. sessionId rotation cadence. CC rotates its internal session id
 *      on a specific cadence (observed: roughly once per conversation
 *      start, not per-request). Dario today uses a static session id
 *      from loadClaudeIdentity. A proxy that kept rotating sessionId
 *      randomly would stand out; a proxy that never rotates also stands
 *      out. Matching CC's cadence requires observing CC over a longer
 *      period than a single capture session.
 *      → Deferred. Requires a longer-running capture mode.
 *
 *   6. Request body field ordering. JSON is unordered, but the wire
 *      serialization IS ordered. Real CC uses a specific field order
 *      for /v1/messages (e.g., `model` before `messages` before
 *      `system` before `tools`). A proxy that serializes in a different
 *      order leaks its origin.
 *      → Worth matching. Cheap to implement — the template capture
 *        already produces a body we can walk to recover field order.
 *        Deferred to a follow-up.
 *
 * The concrete v3.13 move is (1): capture header_order and make it
 * available on the template so the outbound proxy paths can reproduce
 * it. Everything else is documented here as a roadmap so the next
 * contributor — or dario maintainer six months from now — can pick up
 * the right piece without re-deriving the threat model.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Cache-file schema version. Bump when `TemplateData` gains a required
 * field or changes shape in a way that would make older caches produce
 * wrong behavior if loaded verbatim. Mismatched caches are rejected at
 * load time so the fallback + next background refresh write a fresh one.
 */
export const CURRENT_SCHEMA_VERSION = 3;

export interface TemplateData {
  _version: string;
  _captured: string;
  _source?: 'bundled' | 'live';
  _schemaVersion?: number;
  agent_identity: string;
  system_prompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_names: string[];
  /**
   * The exact order CC emitted HTTP headers in when it hit the capture
   * endpoint. Lowercased. Populated only from live captures — bundled
   * snapshots leave this undefined and callers fall back to their own
   * default order. Used by outbound proxy paths to reproduce CC's
   * header ordering instead of Node's alphabetical default.
   */
  header_order?: string[];
  /**
   * The `anthropic-beta` flag set CC sent on the captured request, verbatim.
   * Schema v2 (v3.19). Previously the proxy path hardcoded this — bumping
   * CC's beta list required a dario release. Now the shim and proxy both
   * replay whatever the live capture recorded. Falls back to
   * `'claude-code-20250219'` when undefined (bundled snapshots, older caches).
   */
  anthropic_beta?: string;
  /**
   * Selected static headers CC sent on the captured request. Scoped to
   * fingerprint-relevant keys — values that CC sets identically on every
   * request and that don't change per session (user-agent, anthropic-version,
   * x-app, x-stainless-*). Excludes auth (authorization), body-framing
   * (content-type, content-length, host), and session-scoped identifiers
   * (x-claude-code-session-id, x-client-request-id). Schema v2.
   */
  header_values?: Record<string, string>;
  /**
   * Top-level JSON key order from the captured /v1/messages body, in the
   * order CC emitted them. JSON is unordered as a type but the wire
   * serialization IS ordered — every field in the body is a potential
   * fingerprint if the order differs from CC's. Schema v3 (v3.22).
   *
   * Previously the proxy hardcoded the order as a comment in buildCCRequest;
   * replaying from the live capture means bumping CC's field order (or
   * adding a new field like `output_config`) no longer requires a dario
   * release. Falls back to the hardcoded build order when undefined.
   */
  body_field_order?: string[];
  /**
   * The newest installed-CC version this template snapshot has been verified
   * against. Present only on bundled snapshots (set by scripts/capture-and-bake.mjs
   * at bake time); absent on live captures (the live `_version` is already
   * the installed CC's version by construction). When a user runs a dario
   * release whose bundled fallback is meaningfully older than their installed
   * CC and live capture fails, loadTemplate warns using this field so the
   * operator knows they're on a stale shape. dario#76.
   */
  _supportedMaxTested?: string;
}

const LIVE_CACHE = join(homedir(), '.dario', 'cc-template.live.json');
const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // re-extract once a day

/**
 * Load the template synchronously. Prefers the live cache (fresh capture
 * from the user's own CC install) and falls back to the bundled snapshot.
 *
 * This is intentionally sync and fast — it runs at module init on every
 * dario request handler. The actual capture is async and runs in the
 * background via refreshLiveFingerprintAsync(); its results are written
 * to the cache file and picked up on the next dario startup.
 */
export function loadTemplate(_options?: { silent?: boolean }): TemplateData {
  const cached = readLiveCache();
  if (cached) {
    const age = Date.now() - new Date(cached._captured).getTime();
    if (age < LIVE_TTL_MS) {
      return cached;
    }
    // Stale cache — still better than bundled if bundled is older.
    // We return the stale live cache and let the background refresh
    // update it for next startup.
    return cached;
  }
  return loadBundledTemplate(_options);
}

/**
 * Kick off a background live fingerprint capture. Safe to call on every
 * dario proxy startup — no-ops if CC isn't installed, if the cache is
 * already fresh, or if another refresh is in flight. Never throws.
 *
 * Result is written to ~/.dario/cc-template.live.json and picked up on
 * the next dario startup (cc-template.ts loads the cache synchronously
 * at module init).
 */
export async function refreshLiveFingerprintAsync(options?: {
  force?: boolean;
  silent?: boolean;
  timeoutMs?: number;
}): Promise<TemplateData | null> {
  const silent = options?.silent ?? false;
  const log = (msg: string) => { if (!silent) console.log(`[dario] ${msg}`); };

  if (!options?.force) {
    const cached = readLiveCache();
    if (cached) {
      const age = Date.now() - new Date(cached._captured).getTime();
      if (age < LIVE_TTL_MS) return cached;
    }
  }

  if (!findClaudeBinary()) return null;

  try {
    const live = await captureLiveTemplateAsync(options?.timeoutMs ?? 10_000);
    if (!live) {
      log('live fingerprint refresh: capture returned null (CC did not send a /v1/messages request within the timeout)');
      return null;
    }
    writeLiveCache(live);
    log(`live fingerprint refreshed from CC ${live._version}`);
    return live;
  } catch (err) {
    log(`live fingerprint refresh failed: ${(err as Error).message}`);
    return null;
  }
}

function loadBundledTemplate(options?: { silent?: boolean }): TemplateData {
  const data: TemplateData = JSON.parse(
    readFileSync(join(__dirname, 'cc-template-data.json'), 'utf-8'),
  );
  data._source = 'bundled';

  // Bundled-snapshot-level drift warning. If the user's installed CC is
  // newer than the version the bundled snapshot was verified against, the
  // proxy will still run — but the operator should know they're on a shape
  // that wasn't tested against their CC. The --strict-template / -no-live-
  // capture flags (dario#77) are the fail-closed knobs; this is the soft
  // warn that precedes them. dario#76.
  if (!options?.silent && data._supportedMaxTested) {
    try {
      const installedCCVersion = probeInstalledCCVersion();
      if (installedCCVersion && compareVersions(installedCCVersion, data._supportedMaxTested) > 0) {
        console.log(
          `[dario] ⚠  bundled template was last verified against CC v${data._supportedMaxTested} but installed CC is v${installedCCVersion}. ` +
          `Background refresh will attempt a live capture; if that fails, fingerprint-sensitive fields may be stale.`
        );
      }
    } catch {
      // probeInstalledCCVersion can throw in sandboxed environments; the
      // bundled template is still valid, so swallow and continue.
    }
  }

  return data;
}

function readLiveCache(): TemplateData | null {
  if (!existsSync(LIVE_CACHE)) return null;
  let raw: string;
  try {
    raw = readFileSync(LIVE_CACHE, 'utf-8');
  } catch {
    return null;
  }

  let parsed: TemplateData;
  try {
    parsed = JSON.parse(raw) as TemplateData;
  } catch (err) {
    // Unparseable JSON — typically a crash or power-loss mid-write on a
    // pre-v3.17 dario that still used a non-atomic writer. Quarantine
    // the bad file so the next refresh can write a clean one, and log
    // loudly so the user doesn't silently sit on a broken cache forever.
    quarantineCorruptCache(`unparseable JSON (${(err as Error).message})`);
    return null;
  }

  if (!parsed || !parsed.system_prompt || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    quarantineCorruptCache('missing required fields (system_prompt / tools)');
    return null;
  }

  // Schema version mismatch is NOT corruption — it's an expected event on
  // dario upgrade or downgrade. Skip the cache silently; the background
  // refresh will rewrite it in the new shape.
  if (parsed._schemaVersion !== CURRENT_SCHEMA_VERSION) return null;

  parsed._source = 'live';
  return parsed;
}

/**
 * Rename a corrupt cache file aside to `.corrupt-<ISO>` so the next
 * refresh writes a fresh cache without first having to overwrite a bad
 * file. Keeping the original as-is would also work, but quarantining
 * makes it clearer in `ls ~/.dario` that the file was rejected, and
 * preserves the contents for post-mortem in case a user files an issue.
 */
function quarantineCorruptCache(reason: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${LIVE_CACHE}.corrupt-${stamp}`;
    renameSync(LIVE_CACHE, aside);
    console.error(`[dario] ⚠  live template cache rejected: ${reason}. Quarantined to ${aside}. Next background refresh will re-capture.`);
  } catch (err) {
    // If the rename itself fails, leave the file in place — a subsequent
    // refresh will overwrite it atomically. Log so the state is visible.
    console.error(`[dario] ⚠  live template cache rejected: ${reason}. (quarantine rename failed: ${(err as Error).message})`);
  }
}

/**
 * Atomic JSON write: dump to a sibling `.tmp` file, then rename over the
 * target path. A crash or Ctrl+C between writes never leaves a half-
 * written file where `JSON.parse` would throw on next read. Uses a pid-
 * qualified tmp name so concurrent dario processes don't stomp on each
 * other's partial writes. Exposed for tests via `_atomicWriteJsonForTest`.
 */
function atomicWriteJson(targetPath: string, data: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, targetPath);
  } catch (err) {
    // Clean up the stray tmp if the rename failed; swallow its own
    // unlink error — nothing useful to do with it.
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw err;
  }
}

/** Test-only surface for `atomicWriteJson`. Production code uses `writeLiveCache`. */
export function _atomicWriteJsonForTest(targetPath: string, data: unknown): void {
  atomicWriteJson(targetPath, data);
}

function writeLiveCache(data: TemplateData): void {
  atomicWriteJson(LIVE_CACHE, data);
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /**
   * The flat [k1, v1, k2, v2, ...] array exactly as Node exposes it via
   * req.rawHeaders. Preserves insertion order and duplicates, which the
   * flattened `headers` map does not. Used to recover CC's header order.
   */
  rawHeaders: string[];
  body: Record<string, unknown>;
}

/**
 * Run a loopback MITM server on a random port, spawn CC with
 * ANTHROPIC_BASE_URL pointed at it, wait for one request, respond with a
 * minimal valid SSE stream, and return the captured request.
 *
 * Returns null on timeout or spawn failure. Does not throw.
 */
export async function captureLiveTemplateAsync(timeoutMs: number = 10_000): Promise<TemplateData | null> {
  const captured = await runCapture(timeoutMs);
  if (!captured) return null;
  return extractTemplate(captured);
}

async function runCapture(timeoutMs: number): Promise<CapturedRequest | null> {
  return new Promise((resolve) => {
    let captured: CapturedRequest | null = null;
    let settled = false;
    const settle = (result: CapturedRequest | null) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* noop */ }
      try { child?.kill('SIGTERM'); } catch { /* noop */ }
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle /v1/messages — everything else gets a 404 so CC doesn't
      // accidentally think /v1/models is live.
      if (!req.url?.includes('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const body = raw ? JSON.parse(raw) : {};
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(',');
          }
          captured = {
            method: req.method ?? 'POST',
            path: req.url ?? '/v1/messages',
            headers,
            rawHeaders: Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [],
            body,
          };
        } catch {
          // Captured body was not JSON — leave captured null, respond anyway.
        }

        // Send a minimal valid SSE stream so CC doesn't hang retrying.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0',
          'anthropic-ratelimit-unified-7d-utilization': '0',
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 18000),
        });
        const sse = [
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_live_capture',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ].join('');
        res.end(sse);

        // Give CC a beat to read the response before we kill it.
        setTimeout(() => settle(captured), 500);
      });
    });

    server.on('error', () => settle(null));

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        settle(null);
        return;
      }
      const url = `http://127.0.0.1:${address.port}`;

      // Spawn CC with ANTHROPIC_BASE_URL pointed at our MITM.
      const claudeBin = findClaudeBinary();
      if (!claudeBin) {
        settle(null);
        return;
      }

      // Node 20+ won't spawn `.cmd`/`.bat` without `shell: true` (CVE-2024-27980).
      // `useShell` triggers cmd.exe on Windows — reject overrides that carry
      // shell metacharacters before the spawn, same guard as probeInstalledCCVersion.
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin);
      if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(claudeBin)) {
        settle(null);
        return;
      }

      try {
        child = spawn(claudeBin, ['--print', '-p', 'hi'], {
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: url,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-dario-fingerprint-capture',
            // Prevent CC from launching its own interactive UI or OAuth flow.
            CLAUDE_NONINTERACTIVE: '1',
          },
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
          shell: useShell,
        });
        child.on('error', () => settle(null));
        child.on('exit', () => {
          // Give the server a brief moment to finish reading the body in case
          // exit and request-end race.
          setTimeout(() => settle(captured), 200);
        });
      } catch {
        settle(null);
        return;
      }
    });

    let child: ReturnType<typeof spawn> | undefined;

    // Hard timeout.
    setTimeout(() => settle(captured), timeoutMs);
  });
}

/**
 * Locate the installed `claude` binary and its version. Thin public
 * wrapper over `findClaudeBinary` + `probeInstalledCCVersion` — the
 * doctor CLI and external callers use this to report install state
 * without reaching into module-private helpers.
 */
export function findInstalledCC(): { path: string | null; version: string | null } {
  const path = findClaudeBinary();
  const version = path ? probeInstalledCCVersion() : null;
  return { path, version };
}

function findClaudeBinary(): string | null {
  // Honor an explicit override first — useful for tests and for users on
  // non-standard installs.
  if (process.env.DARIO_CLAUDE_BIN) return process.env.DARIO_CLAUDE_BIN;

  // Try the obvious name. On Windows spawn resolves `.cmd` shims
  // automatically when shell:true, but we don't want shell:true for
  // safety. The `where` / `which` probe handles Windows via PATHEXT.
  const candidates = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];
  for (const name of candidates) {
    if (existsOnPath(name)) return name;
  }
  return null;
}

function existsOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter(Boolean);
  for (const d of dirs) {
    try {
      if (existsSync(join(d, name))) return true;
    } catch { /* noop */ }
  }
  return false;
}

/**
 * Given a captured /v1/messages request body, pull out the fields that
 * matter for template replay: agent identity, system prompt, tool list,
 * and CC version (from the billing header or user-agent).
 */
export function extractTemplate(captured: CapturedRequest): TemplateData | null {
  const body = captured.body;
  const systemBlocks = body.system;
  if (!Array.isArray(systemBlocks) || systemBlocks.length < 2) return null;

  // CC's system is a 3-block structure:
  //   [0] billing tag (no cache_control, tiny)
  //   [1] agent identity ("You are Claude Code..."), cache_control 1h
  //   [2] system prompt (~25KB), cache_control 1h
  // Billing tag is per-request — we never cache it. Identity + prompt are
  // what we want.
  const agentIdentity = pickTextBlock(systemBlocks[1]);
  const systemPrompt = pickTextBlock(systemBlocks[2]);
  if (!agentIdentity || !systemPrompt) return null;

  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>)
        .filter((t) => typeof t.name === 'string')
        .map((t) => ({
          name: t.name as string,
          description: t.description ?? '',
          input_schema: t.input_schema ?? {},
        }))
    : [];
  if (tools.length === 0) return null;

  const version = extractCCVersion(captured.headers) ?? 'unknown';
  const headerOrder = extractHeaderOrder(captured.rawHeaders);
  const anthropicBeta = captured.headers['anthropic-beta'];
  const headerValues = extractStaticHeaderValues(captured.headers);
  // Top-level body key order — JSON is unordered semantically, but the
  // wire serialization has order. Captured from Object.keys on the parsed
  // body, which preserves insertion order (ES2015+).
  const bodyFieldOrder = extractBodyFieldOrder(captured.body);

  return {
    _version: version,
    _captured: new Date().toISOString(),
    _source: 'live',
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    agent_identity: agentIdentity,
    system_prompt: systemPrompt,
    tools,
    tool_names: tools.map((t) => t.name),
    header_order: headerOrder,
    anthropic_beta: typeof anthropicBeta === 'string' ? anthropicBeta : undefined,
    header_values: Object.keys(headerValues).length > 0 ? headerValues : undefined,
    body_field_order: bodyFieldOrder,
  };
}

/**
 * Capture the top-level key order of a parsed body. Returns undefined when
 * the object is empty or not an object, so the reorder helper in
 * cc-template.ts falls back to its hardcoded build order.
 */
function extractBodyFieldOrder(body: Record<string, unknown> | undefined): string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const keys = Object.keys(body);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Pick header values from the captured request that CC would set identically
 * on every outbound call. The replayer overlays these on top of whatever the
 * caller supplied, so anything session-scoped, auth-bearing, or computed by
 * the HTTP stack itself must be excluded.
 */
const STATIC_HEADER_EXCLUDE = new Set<string>([
  // Auth — never replay across identities
  'authorization',
  // x-api-key is a CAPTURE ARTIFACT (dario#42). During capture we spawn CC
  // with ANTHROPIC_API_KEY=sk-dario-fingerprint-capture pointing at a loopback
  // MITM, so CC emits `x-api-key: sk-dario-fingerprint-capture`. Replaying
  // that placeholder upstream alongside the real OAuth Bearer used to be a
  // no-op because Anthropic ignored x-api-key when Authorization was present;
  // as of 2026-04-17 some account tiers now 401 with "invalid x-api-key" when
  // both are sent. Never capture it.
  'x-api-key',
  // Body-framing — computed per request
  'content-type', 'content-length', 'transfer-encoding',
  // Host / connection — managed by the HTTP stack
  'host', 'connection', 'keep-alive', 'accept-encoding',
  // Session / request identifiers — rotate per call
  'x-claude-code-session-id', 'x-client-request-id', 'x-request-id',
  // Beta flag is captured separately
  'anthropic-beta',
  // Billing tag — rebuilt per request from cc_version
  'x-anthropic-billing-header',
]);

function extractStaticHeaderValues(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (STATIC_HEADER_EXCLUDE.has(lk)) continue;
    if (typeof v !== 'string') continue;
    out[lk] = v;
  }
  return out;
}

// ============================================================
//  Drift detection + startup diagnostics (v3.17)
// ============================================================

let _installedVersionProbe: { value: string | null; cached: boolean } = { value: null, cached: false };

/**
 * Sync-probe `claude --version` and return the parsed version string, e.g.
 * `"2.1.104"`. Memoized per-process — the binary is invoked at most once,
 * subsequent calls return the cached result. Returns `null` if the binary
 * isn't on PATH, or the probe failed / timed out, or the output didn't
 * match the expected format.
 *
 * Used by `detectDrift` to compare the installed CC against the version
 * recorded in the cache at capture time.
 */
export function probeInstalledCCVersion(): string | null {
  if (_installedVersionProbe.cached) return _installedVersionProbe.value;
  const value = probeInstalledCCVersionUncached();
  _installedVersionProbe = { value, cached: true };
  return value;
}

function probeInstalledCCVersionUncached(): string | null {
  const bin = findClaudeBinary();
  if (!bin) return null;
  try {
    // Node 20+ refuses to spawn `.cmd`/`.bat` via execFile without
    // explicit `shell: true` (CVE-2024-27980 hardening). On Windows,
    // npm-installed CLIs commonly live behind a `.cmd` shim — detect
    // that and opt into the shell path.
    //
    // `bin` is normally from findClaudeBinary's fixed allow-list, but
    // DARIO_CLAUDE_BIN lets users override it. If that override reaches
    // the shell path, cmd.exe interprets its contents — so reject any
    // override that carries shell metacharacters before we spawn.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(bin)) {
      return null;
    }
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: useShell,
    });
    // `claude --version` currently prints e.g. `1.0.79 (Claude Code)` or
    // `claude-cli 2.1.104`. Accept anything that contains a dotted numeric
    // version — the first match wins.
    const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Format how old a captured timestamp is, human-readable. `_captured` is
 * an ISO string written by `extractTemplate` or the bundled snapshot.
 * Falls back to `"unknown age"` if the timestamp doesn't parse.
 */
export function formatCaptureAge(capturedIso: string, now: number = Date.now()): string {
  const t = Date.parse(capturedIso);
  if (!Number.isFinite(t)) return 'unknown age';
  const ageMs = Math.max(0, now - t);
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * One-line human summary of the active template — what source, which CC
 * version captured it, and how old that capture is. Proxy and shim
 * startup log this so users can tell at a glance whether they're on a
 * fresh live capture or a stale bundled fallback.
 */
export function describeTemplate(t: TemplateData): string {
  const source = t._source ?? 'bundled';
  const age = formatCaptureAge(t._captured);
  return `${source} capture, CC v${t._version} (${age} old)`;
}

export interface DriftResult {
  /** True when we can confirm the cache is from a different CC version than the one currently installed. */
  drifted: boolean;
  cachedVersion: string;
  /** null when the probe couldn't run (no CC on PATH, timeout, parse fail). */
  installedVersion: string | null;
  /** Reason string — safe to log as-is. */
  message: string;
}

/**
 * Compare the loaded template's captured CC version against the version
 * reported by `claude --version` on the current machine. Drifted caches
 * are still usable — the shape is probably compatible — but the proxy
 * should force-refresh ASAP so the next startup is back in sync.
 *
 * @param installedOverride test-only injection for unit tests; production
 *   callers pass nothing and the real binary probe runs.
 */
export function detectDrift(t: TemplateData, installedOverride?: string | null): DriftResult {
  const installed = installedOverride !== undefined ? installedOverride : probeInstalledCCVersion();
  const cachedVersion = t._version;
  if (installed === null) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: null,
      message: 'installed CC version not probed (binary not on PATH or probe failed)',
    };
  }
  if (installed === cachedVersion) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: installed,
      message: `cache matches installed CC (v${installed})`,
    };
  }
  return {
    drifted: true,
    cachedVersion,
    installedVersion: installed,
    message: `cache is from CC v${cachedVersion} but installed CC is v${installed} — background refresh will re-capture`,
  };
}

/**
 * Reset the memoized `claude --version` probe. Test-only — production
 * code should never need to clear the cache since the installed binary
 * doesn't change mid-process.
 */
export function _resetInstalledVersionProbeForTest(): void {
  _installedVersionProbe = { value: null, cached: false };
}

// ============================================================
//  CC version compat matrix (v3.17)
// ============================================================

/**
 * The CC version range the current dario release has been exercised
 * against. Update `maxTested` every time we validate against a new CC
 * (ideally as part of the release checklist — the e2e test against the
 * user's own CC is the ground-truth signal).
 *
 * - `min`: below this, dario's extractor hasn't been validated; proxy
 *   will still run but may mis-parse CC's request body.
 * - `maxTested`: the newest CC version the current dario release has
 *   been exercised against. Above this, dario is *likely* fine (CC's
 *   request shape evolves slowly) but it's explicitly untested, so
 *   users get a soft warn and we get a signal to refresh the bundled
 *   snapshot + rerun e2e.
 */
export const SUPPORTED_CC_RANGE = {
  min: '1.0.0',
  maxTested: '2.1.116',
} as const;

/**
 * Compare two dotted-numeric version strings. Returns negative if `a<b`,
 * zero if equal, positive if `a>b`. Handles suffixes like `-beta.1` or
 * `.dev` by comparing the numeric prefix first and treating anything
 * after as a tiebreaker (strings compared lexicographically; absence of
 * suffix beats presence, matching semver's "release > prerelease").
 *
 * Intentionally minimal — dario's "zero runtime deps" policy rules out
 * pulling `semver`. CC versions are well-formed `M.m.p[-suffix]` so we
 * don't need the full spec.
 */
export function compareVersions(a: string, b: string): number {
  const splitPrefixSuffix = (v: string): { parts: number[]; suffix: string } => {
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(v);
    if (!m) return { parts: [0], suffix: v };
    const parts = m[1].split('.').map((s) => parseInt(s, 10));
    return { parts, suffix: m[2] ?? '' };
  };
  const A = splitPrefixSuffix(a);
  const B = splitPrefixSuffix(b);
  const len = Math.max(A.parts.length, B.parts.length);
  for (let i = 0; i < len; i++) {
    const ai = A.parts[i] ?? 0;
    const bi = B.parts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  // Numeric prefix equal — compare suffix. Empty suffix beats non-empty
  // (release > prerelease). Otherwise lexicographic.
  if (A.suffix === B.suffix) return 0;
  if (A.suffix === '') return 1;
  if (B.suffix === '') return -1;
  return A.suffix < B.suffix ? -1 : 1;
}

export type CompatStatus = 'ok' | 'untested-above' | 'below-min' | 'unknown';

export interface CompatResult {
  status: CompatStatus;
  installedVersion: string | null;
  range: { min: string; maxTested: string };
  message: string;
}

/**
 * Check whether the installed CC version sits inside the supported range.
 * Called at startup by the proxy; the result drives whether we emit a
 * compatibility warning to the user.
 *
 * `unknown` is not a failure — it just means we couldn't probe (no CC on
 * PATH, timeout, parse miss). Dario still runs on bundled template.
 *
 * @param installedOverride test-only injection; production callers pass nothing.
 */
export function checkCCCompat(installedOverride?: string | null): CompatResult {
  const installed = installedOverride !== undefined ? installedOverride : probeInstalledCCVersion();
  const range = { min: SUPPORTED_CC_RANGE.min, maxTested: SUPPORTED_CC_RANGE.maxTested };
  if (installed === null) {
    return {
      status: 'unknown',
      installedVersion: null,
      range,
      message: 'installed CC version not probed — compatibility unchecked',
    };
  }
  if (compareVersions(installed, range.min) < 0) {
    return {
      status: 'below-min',
      installedVersion: installed,
      range,
      message: `installed CC v${installed} is older than the minimum dario supports (v${range.min}); extractor may mis-parse requests — upgrade CC`,
    };
  }
  if (compareVersions(installed, range.maxTested) > 0) {
    return {
      status: 'untested-above',
      installedVersion: installed,
      range,
      message: `installed CC v${installed} is newer than dario's last tested version (v${range.maxTested}); usually fine, but untested`,
    };
  }
  return {
    status: 'ok',
    installedVersion: installed,
    range,
    message: `installed CC v${installed} is within the tested range (v${range.min} – v${range.maxTested})`,
  };
}

/**
 * Walk rawHeaders (flat [k1, v1, k2, v2, ...] array) and return the
 * header names in insertion order, lowercased, de-duplicated. If the
 * raw array is empty or unusable, returns undefined so the caller
 * falls back to default ordering.
 */
function extractHeaderOrder(rawHeaders: string[]): string[] | undefined {
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return undefined;
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (typeof name !== 'string') continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    order.push(lower);
  }
  return order.length > 0 ? order : undefined;
}

function pickTextBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as { type?: string; text?: string };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return null;
}

function extractCCVersion(headers: Record<string, string>): string | null {
  // Preferred: x-anthropic-billing-header carries cc_version=X.Y.Z
  const billing = headers['x-anthropic-billing-header'];
  if (billing) {
    const m = /cc_version=([\w.\-]+)/.exec(billing);
    if (m) return m[1];
  }
  // Fallback: user-agent often carries claude-cli/X.Y.Z
  const ua = headers['user-agent'];
  if (ua) {
    const m = /claude-cli\/([\w.\-]+)/.exec(ua);
    if (m) return m[1];
  }
  return null;
}

/**
 * Test hook: given a captured request object (from a mocked server or a
 * synthetic fixture), run it through the same extraction path. Exposed so
 * test/live-fingerprint.mjs doesn't need to spawn a real process.
 */
export function _extractTemplateForTest(captured: CapturedRequest): TemplateData | null {
  return extractTemplate(captured);
}

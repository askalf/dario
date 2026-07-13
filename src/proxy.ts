import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setDefaultResultOrder } from 'node:dns';
import { arch, platform } from 'node:process';
import { getAccessToken, getStatus } from './oauth.js';
import { buildHealthResponse, derivePoolStatus, shouldDiscloseHealthInternals } from './health-response.js';
import { darioVersion } from './version.js';
import { buildCCRequest, applyCcPromptCaching, parseEffortSuffix, reverseMapResponse, createStreamingReverseMapper, orderHeadersForOutbound, isMcpToolName, CC_TEMPLATE, CC_CACHE_CONTROL, type ToolMapping, type RequestContext, type EffortValue } from './cc-template.js';
import { stampCch, hasCchSeed } from './cch.js';
import { describeTemplate, detectDrift, checkCCCompat } from './live-fingerprint.js';
import { AccountPool, computeStickyKey, parseRateLimits, modelFamily, isInAuthCooldown, authCooldownMs, reconcilePoolAccounts, type PoolAccount } from './pool.js';
import { Analytics, billingBucketFromClaim, SUBSCRIPTION_CLAIMS, type RequestRecord } from './analytics.js';
import { OverageGuard, buildHaltErrorBody, type HaltState } from './overage-guard.js';
import { notify as osNotify } from './notify.js';
import { loadAllAccounts, loadAccount, refreshAccountToken, resyncLoginFromCredentialsIfStale, ensureLoginCredentialsInPool } from './accounts.js';
import { handleAdminRequest, type AdminAccountLive, type AdminAuditEvent } from './admin-api.js';
import { createTokenBucket } from './rate-limit.js';
import { getOpenAIBackend, isOpenAIModel, forwardToOpenAI, type BackendCredentials } from './openai-backend.js';
import { RequestQueue, QueueFullError, QueueTimeoutError, DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_QUEUED, DEFAULT_QUEUE_TIMEOUT_MS } from './request-queue.js';
import { redactSecrets } from './redact.js';
import { BAKED_BASE_MODELS, withLongContextVariants, buildOpenAIModelsList, getModelCatalog, getCachedBases, resolveAliasAgainst, prewarmModelCatalog, retryModelCatalogNow, isSuspendedModel, type CatalogDeps } from './model-catalog.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — generous for large prompts, prevents abuse
const UPSTREAM_TIMEOUT_MS = 300_000; // 5 min — matches Anthropic SDK default
const BODY_READ_TIMEOUT_MS = 30_000; // 30s — prevents slow-loris on body reads
const DEFAULT_HOST = '127.0.0.1';

// A host is "loopback" if it's one of the well-known localhost literals.
// Used to decide whether to warn at startup about binding to a reachable
// interface — binding anywhere else means other machines can reach the
// proxy and should only be done with DARIO_API_KEY set.
function isLoopbackHost(host: string): boolean {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  return host.startsWith('127.');
}

// A socket peer address is loopback if it is 127.0.0.0/8 or ::1, including the
// IPv4-mapped-IPv6 form Node reports on dual-stack sockets (`::ffff:127.0.0.1`).
// Distinct from isLoopbackHost (which classifies a bind-address string): this
// classifies an inbound connection's peer for the /health disclosure gate (#642).
function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return v4 === '127.0.0.1' || v4.startsWith('127.');
}

// Concurrency control: see src/request-queue.ts for the bounded queue
// (replaced the v3.30.x-and-earlier simple unbounded semaphore in dario#80).

// Deterministic constant used to seed the cc_version build suffix
// (computeVersionSuffix). Arbitrary — its only job is to make the suffix stable.
const BILLING_SEED = '59cf53e54c78';

// The `.<suffix>` on cc_version (e.g. `2.1.199.ef3`). This suffix is not a
// function of the user message — it tracks the request's system context, so it
// is stable for a given configuration and changes only when that context does.
// dario's old `chars[4,7,20]`-of-user-message hash was wrong on both counts:
// wrong input, and per-request-varying. We emit instead a STABLE, plausible
// 3-hex derived from the loaded template — one stable value per config, which
// changes only when the template does (a rebake). Memoized — the inputs don't
// change within a process.
let _versionSuffixCache: { key: string; value: string } | null = null;
function computeVersionSuffix(version: string): string {
  if (_versionSuffixCache && _versionSuffixCache.key === version) return _versionSuffixCache.value;
  const sys = (CC_TEMPLATE as { system_prompt?: string }).system_prompt ?? '';
  const value = createHash('sha256').update(`${BILLING_SEED}${version}${sys}`).digest('hex').slice(0, 3);
  _versionSuffixCache = { key: version, value };
  return value;
}

// Per-request cch PLACEHOLDER. Claude Code's cch is a deterministic xxHash64
// over a projection of the request body (see src/cch.ts, dario#528). We can
// only compute the real value once the final body is assembled, so we seed the
// billing tag with a random 5-hex token here and overwrite it in place with the
// deterministic value at serialize time (the `stampCch` call near the
// JSON.stringify of the outbound body).
//
// This placeholder is only emitted for versions we hold a calibrated seed for
// — see buildBillingTag / hasCchSeed. Versions without a seed omit the cch
// token entirely: current Claude Code sends no cch, so omitting is the correct
// match. Operators can force the random path on every seeded request with
// DARIO_CCH=random.
function computeCch(): string {
  return randomBytes(3).toString('hex').slice(0, 5);
}

/**
 * Assemble the `x-anthropic-billing-header` system-block text, following
 * Claude Code's format:
 *   with cch:    `…; cc_entrypoint=sdk-cli; cch=<5hex>;`   (older releases)
 *   without cch: `…; cc_entrypoint=sdk-cli;`               (current releases)
 *
 * `cch` is passed in rather than generated here so this stays a pure, testable
 * string builder: the caller gates on hasCchSeed(cliVersion) and passes
 * computeCch() (a placeholder stampCch later overwrites with the deterministic
 * value) when a seed exists, or null when it doesn't. Passing null omits the
 * token — never emit a cch we can't produce correctly, and never emit one
 * current Claude Code doesn't send. The cc_version build suffix is stable per
 * config (computeVersionSuffix), independent of the request. Exported for tests.
 */
export function buildBillingTag(cliVersion: string, cch: string | null): string {
  const fullVersion = `${cliVersion}.${computeVersionSuffix(cliVersion)}`;
  const base = `x-anthropic-billing-header: cc_version=${fullVersion}; cc_entrypoint=sdk-cli;`;
  return cch === null ? base : `${base} cch=${cch};`;
}

// Detect installed Claude Code version for the build-tag computation.
// Falls back to the bundled template's captured version when claude isn't
// on PATH (the common container case) — previously this fell back to a
// hardcoded '2.1.100', which made the billing tag claim cc_version=2.1.100
// while the replayed user-agent said 2.1.16x/17x: an internally
// INCONSISTENT version pair, itself a fingerprint anomaly. The template
// `_version` always exists on schema-v2 bundles; '2.1.100' remains only as
// the absolute last resort for pre-v2 snapshots.
function detectCliVersion(): string {
  const templateVersion = (CC_TEMPLATE as { _version?: string })._version || '2.1.100';
  try {
    const out = execSync('claude --version', { timeout: 5000, stdio: 'pipe' }).toString().trim();
    return out.match(/^([\d]+\.[\d]+\.[\d]+)/)?.[1] ?? templateVersion;
  } catch {
    return templateVersion;
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

// Session ID behavior:
//   v3.18 rotated per request — which was itself a fingerprint. Real CC
//   rotates roughly once per conversation, not per call. A user who has
//   distinct session-ids for every request looks nothing like a CC user.
//
//   v3.19 keeps the id stable through a conversation window and rotates
//   only after an idle gap long enough to credibly indicate a new
//   conversation.
//
//   v3.28 generalises the single hardcoded 15-min window into a tunable
//   registry (see src/session-rotation.ts) with optional jitter, max-age,
//   and per-client keying.
//
//   v5.0 (pool-as-primitive) makes this registry the ONE session-id
//   mechanism: it's keyed by the selected pool account so each account keeps
//   its own idle/jitter/max-age lifecycle, seeded with the account's minted
//   identity.sessionId so an account's first request is byte-identical to the
//   pre-v5 stable id. SESSION_ID below is kept only as a mirror of the most
//   recently assigned id so out-of-band consumers (presence ping, diagnostic
//   logs) can read it without going through the registry. It's refreshed
//   after every dispatch-path call that assigns a new id.
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

// Model shortcuts — users can pass short names. Family shorthands
// (`opus`, `opus1m`, …) resolve DYNAMICALLY against the model catalog in
// resolveClaudeAlias — this static map is the offline fallback plus the
// deliberate legacy version pins (`opus47`/`opus46`), which never float.
const MODEL_ALIASES: Record<string, string> = {
  'fable': 'claude-fable-5',
  'fable1m': 'claude-fable-5[1m]',
  'opus': 'claude-opus-4-8',
  'opus47': 'claude-opus-4-7',
  'opus46': 'claude-opus-4-6',
  'opus1m': 'claude-opus-4-8[1m]',
  'sonnet': 'claude-sonnet-5',
  'sonnet46': 'claude-sonnet-4-6',
  'sonnet1m': 'claude-sonnet-5[1m]',
  'haiku': 'claude-haiku-4-5',
};

/**
 * Resolve a Claude-side model name through the family-alias rules if it's a
 * short alias (`opus`/`sonnet`/`haiku`/etc.), otherwise pass through
 * unchanged.
 *
 * Family shorthands resolve against the live model catalog: `<family>` is
 * the newest base of that family, and `<family>1m` DERIVES from that same
 * base + `[1m]` — one rule for every family, so the pair can't drift apart
 * (pre-catalog, #389 bumped `opus` to 4-8 while `opus1m` silently stayed on
 * 4-7). Before the first catalog fetch the baked set produces the same
 * answers as the static map; the map stays as the last-resort fallback.
 *
 * Used at request time on the provider-prefix path so `claude:opus` arrives
 * upstream as a full model id rather than the bare `opus` (which Anthropic
 * 400's). Critical for Cursor BYOK setups (dario#190) where users have to
 * pick a colon-prefixed model name to dodge Cursor's built-in `claude-*`
 * name collision — which means the natural shorthand is `claude:opus`, and
 * that needs to Just Work.
 */
export function resolveClaudeAlias(model: string): string {
  return resolveAliasAgainst(model, getCachedBases()) ?? MODEL_ALIASES[model] ?? model;
}

/**
 * Pick the per-request model override under a forced `--model`.
 *
 * A forced `--model` normally rewrites the model on *every* request. But
 * Claude Code dispatches its throwaway sub-agent (Explore/Task) turns on the
 * cheap Haiku tier, so forcing a frontier model silently upgrades those
 * sub-agents too — quietly multiplying cost. When `--fast-model` is set, a
 * Haiku-tier inbound request routes there instead, keeping sub-agents cheap
 * while the main conversation stays on `--model`.
 *
 * No-op unless `fastModelOverride` is set: with it null, this returns
 * `modelOverride` for every request (the pre-existing behavior), so the
 * change is inert until the operator opts in.
 */
export function selectModelOverride(
  incomingModel: string,
  modelOverride: string | null,
  fastModelOverride: string | null,
): string | null {
  if (fastModelOverride && /haiku/i.test(incomingModel)) return fastModelOverride;
  return modelOverride;
}

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

/**
 * Fable-5 (2026-06) — real CC appends `fallback-credit-2026-06-01` to the
 * beta set on fable requests ONLY (live captures 2026-06-09, CC v2.1.170:
 * the fable request carries it, the opus request does not). Subscription
 * traffic on fable WITHOUT it is soft-refused upstream — every request
 * returns 200 with `stop_reason: "refusal"` and empty content, while the
 * same request on opus/sonnet answers normally. Mirror CC exactly: append
 * for the fable family, leave every other family's set untouched.
 * Exported for tests.
 */
export const FABLE_FALLBACK_CREDIT_BETA = 'fallback-credit-2026-06-01';
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';
export const MID_CONVERSATION_SYSTEM_BETA = 'mid-conversation-system-2026-04-07';
export const EFFORT_BETA = 'effort-2025-11-24';
export const AFK_MODE_BETA = 'afk-mode-2026-01-31';
export const ADVISOR_TOOL_BETA = 'advisor-tool-2026-03-01';
export const CLAUDE_CODE_BETA = 'claude-code-20250219';

/**
 * Insert `flag` immediately before the first `anchor`, deduped. If `flag` is
 * already present the list is returned unchanged; if `anchor` is absent `flag`
 * is appended at the tail. Used to place model-conditional betas at the exact
 * position real CC emits them, rather than always appending.
 */
function insertBetaBefore(flags: string[], flag: string, anchor: string): string[] {
  if (flags.includes(flag)) return flags;
  const i = flags.indexOf(anchor);
  return i < 0 ? [...flags, flag] : [...flags.slice(0, i), flag, ...flags.slice(i)];
}

/** As insertBetaBefore, but places `flag` immediately AFTER the first `anchor`. */
function insertBetaAfter(flags: string[], flag: string, anchor: string): string[] {
  if (flags.includes(flag)) return flags;
  const i = flags.indexOf(anchor);
  return i < 0 ? [...flags, flag] : [...flags.slice(0, i + 1), flag, ...flags.slice(i + 1)];
}

/**
 * Move an already-present `flag` to immediately before the first `anchor`.
 * No-op when either is absent. Used for haiku, where CC emits
 * claude-code-20250219 mid-list rather than first.
 */
function moveBetaBefore(flags: string[], flag: string, anchor: string): string[] {
  if (!flags.includes(flag)) return flags;
  const without = flags.filter((f) => f !== flag);
  const i = without.indexOf(anchor);
  return i < 0 ? flags : [...without.slice(0, i), flag, ...without.slice(i)];
}

/**
 * Model-conditional anthropic-beta set for current Claude Code. `base` is the
 * opus/sonnet order (TEMPLATE.anthropic_beta); each family is a transform of
 * it, ORDER included:
 *
 *   opus-4-8    = base                                    (unchanged)
 *   sonnet-5    = base                                    (== opus — wire-drift
 *                 live capture, CC 2.1.204: mid-conversation-system included)
 *   sonnet-4-x  = base − {mid-conversation-system}        (CC 2.1.201 dropped it
 *                 from sonnet 4.6; 2.1.199 sonnet == opus and still kept it — #667)
 *   haiku-4-5   = base − {mid-conversation-system, effort, afk-mode}, and
 *                 claude-code-20250219 MOVED to position 5 (before advisor-tool)
 *   fable-5     = base + fallback-credit-2026-06-01 inserted BEFORE afk-mode
 *
 * `[1m]`-labelled models additionally carry context-1m-2025-08-07 at POSITION 2
 * (immediately after claude-code-20250219), not appended at the tail. CC does
 * NOT send it for plain models. `skipContext1m` (dario#36) suppresses it when
 * the account's long-context billing was rejected.
 *
 * afk-mode-2026-01-31 is remote-config controlled and can flip within a Claude
 * Code version, so its presence is a property of `base` (the loaded template),
 * not of this function — the template refresh keeps it current. haiku drops it
 * regardless. The per-family shape here is correct whether or not the base
 * carries afk-mode: the anchor-relative inserts/moves degrade gracefully
 * (append / no-op) when an anchor is absent.
 *
 * Removing a beta can never provoke an upstream 400 (the runtime rejection
 * cache only ever needs to ADD strips), so the haiku omissions are safe; the
 * position adjustments keep the per-family order correct.
 */
export function betaForModel(base: string, model: string | null | undefined, skipContext1m = false): string {
  const m = (model ?? '').toLowerCase();
  let flags = base.split(',').map((s) => s.trim()).filter(Boolean);

  if (m.includes('haiku')) {
    const drop = new Set([MID_CONVERSATION_SYSTEM_BETA, EFFORT_BETA, AFK_MODE_BETA]);
    flags = flags.filter((f) => !drop.has(f));
    flags = moveBetaBefore(flags, CLAUDE_CODE_BETA, ADVISOR_TOOL_BETA);
  } else if (/sonnet-4/.test(m)) {
    // CC 2.1.201 dropped mid-conversation-system from SONNET 4.6's beta set
    // (2.1.199 sonnet == opus and still carried it — live capture #667).
    // Scoped to the sonnet-4 line: Sonnet 5 carries it again — the wire-drift
    // runner's live capture on CC 2.1.204 shows sonnet-5's set equal to opus's.
    flags = flags.filter((f) => f !== MID_CONVERSATION_SYSTEM_BETA);
  } else if (m.includes('fable')) {
    flags = insertBetaBefore(flags, FABLE_FALLBACK_CREDIT_BETA, AFK_MODE_BETA);
  }
  // opus + unknown families keep the base set unchanged.

  if (/\[1m\]$/.test(m) && !skipContext1m) {
    flags = insertBetaAfter(flags, CONTEXT_1M_BETA, CLAUDE_CODE_BETA);
  }

  return flags.join(',');
}

/**
 * Strip a trailing `[1m]` long-context tag from a model id. The tag is a
 * client-side label: real CC sends the BASE id + `context-1m-2025-08-07`
 * beta on the wire (live capture 2026-06-09, CC v2.1.170) — the literal
 * `X[1m]` id 404s upstream on every family. Case-insensitive, only at the
 * very end of the id. Exported for tests.
 */
export function stripContext1mTag(model: string): string {
  if (typeof model !== 'string') return model;
  return model.replace(/\[1m\]$/i, '');
}

/**
 * Parse upstream's effort-capability rejection:
 *
 *   400 {"type":"invalid_request_error","message":"This model does not
 *        support effort level 'max'. Supported levels: high, low, medium."}
 *
 * Observed live 2026-06-10 on `claude-opus-4-5-20251101` — the autodetected
 * catalog exposes models that predate the newer effort tiers, and a pinned
 * DARIO_EFFORT (the box pins `max`) hard-400s on them. Returns the rejected
 * level plus the model's supported set, or null when the body is some other
 * 400. NOTE: fable's effort intolerance is different in kind — a SOFT
 * refusal (200 + stop_reason:"refusal"), invisible to this machinery — and
 * stays handled by its measured clamp in resolveEffort.
 * Exported for tests.
 */
export function parseEffortRejection(body: string): { rejected: string; supported: string[] } | null {
  const m = body.match(/does not support effort level '([^']+)'\.?\s*Supported levels:\s*([a-z,\s]+)/i);
  if (!m) return null;
  const supported = m[2]!.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  return supported.length > 0 ? { rejected: m[1]!, supported } : null;
}

/**
 * Detect upstream's HARD effort rejection — a model with NO output_config.effort
 * support at all (it predates the parameter), distinct from the SOFT level
 * rejection parsed by parseEffortRejection:
 *
 *   400 {"type":"invalid_request_error","message":"This model does not
 *        support the effort parameter."}
 *
 * Observed live 2026-06-16 on claude-opus-4-1-20250805 and
 * claude-sonnet-4-5-20250929 — the autodetected catalog exposes pre-effort
 * models, and the box's DARIO_EFFORT=max pin hard-400s them. There is no
 * supported tier to clamp to here, so effort must be STRIPPED — modelled as
 * an EMPTY supported set in effortSupportByModel. Exported for tests.
 */
export function isEffortParamUnsupported(body: string): boolean {
  return /does not support the effort parameter/i.test(body);
}

/**
 * Pick the strongest effort level a model says it supports. Preference is
 * descending capability — the caller asked for more than the model can do,
 * so degrade as little as possible. Exported for tests.
 */
export const EFFORT_PREFERENCE: readonly string[] = ['xhigh', 'max', 'high', 'medium', 'low'];
export function bestSupportedEffort(supported: readonly string[]): string {
  for (const e of EFFORT_PREFERENCE) if (supported.includes(e)) return e;
  return supported[0] ?? 'high';
}

/**
 * Parse upstream's max_tokens-cap rejection:
 *
 *   400 {"type":"invalid_request_error","message":"max_tokens: 64000 > 32000,
 *        which is the maximum allowed number of output tokens for
 *        claude-opus-4-1-20250805."}
 *
 * Observed live 2026-06-16 — dario pins DEFAULT_MAX_TOKENS (64000, CC 2.1.143's
 * wire default), but the autodetected catalog exposes older models with a lower
 * per-model output cap (e.g. opus-4-1: 32000). Returns the model's cap (the
 * clamp target) or null for any other 400. Same learn-once-and-cache shape as
 * parseEffortRejection. Exported for tests.
 */
export function parseMaxTokensRejection(body: string): number | null {
  const m = body.match(/max_tokens:\s*\d+\s*>\s*(\d+),?\s*which is the maximum allowed/i);
  if (!m) return null;
  const cap = Number(m[1]);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Resolve an inbound API path to its upstream target + forwarding mode.
 * Allowlist semantics — anything unlisted is 403'd (prevents SSRF through
 * the OAuth-bearing proxy).
 *
 * `thin: true` marks endpoints forwarded WITHOUT template injection —
 * OAuth swap + model-id normalization only. `/v1/messages/count_tokens`
 * is thin because the endpoint counts the CLIENT's own prompt: bolting on
 * CC's system/tools/effort would distort the count (and `output_config`
 * is not a count_tokens request field). `?beta=true` stays a /v1/messages
 * affordance (billing classification) — not appended for count_tokens.
 * Exported for tests.
 */
export function resolveProxyTarget(urlPath: string, isOpenAI: boolean): { target: string; thin: boolean } | null {
  if (isOpenAI) return { target: `${ANTHROPIC_API}/v1/messages?beta=true`, thin: false };
  const allowed: Record<string, { target: string; thin: boolean }> = {
    '/v1/messages': { target: `${ANTHROPIC_API}/v1/messages?beta=true`, thin: false },
    '/v1/messages/count_tokens': { target: `${ANTHROPIC_API}/v1/messages/count_tokens`, thin: true },
    '/v1/complete': { target: `${ANTHROPIC_API}/v1/complete`, thin: false },
  };
  return allowed[urlPath] ?? null;
}

// Orchestration tags injected by agents (Aider, Cursor, OpenCode, etc.)
// that confuse Claude when passed through. Strip before forwarding.
export const ORCHESTRATION_TAG_NAMES = [
  'system-reminder', 'env', 'system_information', 'current_working_directory',
  'operating_system', 'default_shell', 'home_directory', 'task_metadata',
  'directories', 'thinking',
  'agent_persona', 'agent_context', 'tool_context', 'persona', 'tool_call',
];

/**
 * Build the regex list that actually strips orchestration tags.
 *
 * `preserveTags` selects which tags to KEEP in the outbound body.
 *   undefined       → strip every tag in ORCHESTRATION_TAG_NAMES (default)
 *   Set(['*'])      → preserve all tags (strip none)
 *   Set(['thinking']) → strip everything except `<thinking>...</thinking>`
 *
 * Each tag produces two patterns — the wrapper form (`<tag>...</tag>`) and
 * the self-closing form (`<tag ... />`) — so callers that emit either shape
 * get the same treatment.
 *
 * dario#78 (Gemini review push-back).
 */
export function buildOrchestrationPatterns(preserveTags?: Set<string>): RegExp[] {
  if (preserveTags?.has('*')) return [];
  const effective = preserveTags
    ? ORCHESTRATION_TAG_NAMES.filter(tag => !preserveTags.has(tag))
    : ORCHESTRATION_TAG_NAMES;
  return effective.flatMap(tag => [
    new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
    new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'),
  ]);
}

const ORCHESTRATION_PATTERNS_DEFAULT = buildOrchestrationPatterns();

/** Strip orchestration wrapper tags from message content. */
function sanitizeContent(text: string, patterns: RegExp[]): string {
  let result = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// Memoize the compiled preserve-tag pattern set by Set reference (#642-audit):
// opts.preserveOrchestrationTags is a single Set instance passed on every
// request, so recompile the ~28 patterns once instead of per request. The
// default (no-preserve) path already uses the precompiled constant.
let _orchPreserveKey: Set<string> | undefined;
let _orchPatterns: RegExp[] | undefined;
function orchestrationPatternsFor(preserveTags?: Set<string>): RegExp[] {
  if (preserveTags === undefined) return ORCHESTRATION_PATTERNS_DEFAULT;
  if (preserveTags !== _orchPreserveKey) {
    _orchPreserveKey = preserveTags;
    _orchPatterns = buildOrchestrationPatterns(preserveTags);
  }
  return _orchPatterns!;
}

/**
 * Strip orchestration tags from all messages in a request body.
 *
 * Pass `preserveTags` (a Set of tag names, or `Set(['*'])` for all) to
 * opt any tag out of the scrub. dario#78.
 */
export function sanitizeMessages(body: Record<string, unknown>, preserveTags?: Set<string>): void {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return;
  const patterns = orchestrationPatternsFor(preserveTags);
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      msg.content = sanitizeContent(msg.content, patterns);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block && 'text' in block && typeof (block as { text: string }).text === 'string') {
          (block as { text: string }).text = sanitizeContent((block as { text: string }).text, patterns);
        }
      }
      // Drop text blocks that became empty after orchestration-tag scrubbing.
      // CC v2.1.112 and some client wrappers split per-reminder system-reminders
      // into separate content blocks; scrubbing leaves each as {type:'text',text:''}
      // which Anthropic rejects with "text content blocks must be non-empty"
      // (dario#54). Keep non-text blocks (tool_result, tool_use, image) intact.
      msg.content = (msg.content as Array<Record<string, unknown>>).filter(b => {
        if (typeof b !== 'object' || b === null) return false;
        if ((b as { type?: string }).type === 'text' && (b as { text?: string }).text === '') return false;
        return true;
      });
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
  'gpt-5.4': 'claude-opus-4-8',
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

/**
 * Translate Anthropic SSE → OpenAI SSE. Returns a stateful per-CALL closure so
 * concurrent /v1/chat/completions streams don't share tool-call index/id state
 * (#642-audit: the previous module-global counters cross-contaminated
 * interleaved streams and emitted malformed tool_calls deltas). One translator
 * per request, mirroring createStreamingReverseMapper.
 */
export function createOpenAIStreamTranslator(): (line: string) => string | null {
  let toolIndex = 0;
  let toolId = '';
  return function translateStreamChunk(line: string): string | null {
    if (!line.startsWith('data: ')) return null;
    const json = line.slice(6).trim();
    if (json === '[DONE]') return 'data: [DONE]\n\n';
    try {
      const e = JSON.parse(json) as Record<string, unknown>;
      const ts = Math.floor(Date.now() / 1000);

      if (e.type === 'content_block_start') {
        const block = e.content_block as { type: string; id?: string; name?: string } | undefined;
        if (block?.type === 'tool_use' && block.name) {
          toolId = block.id ?? `call_${toolIndex}`;
          return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, id: toolId, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] })}\n\n`;
        }
      }

      if (e.type === 'content_block_delta') {
        const d = e.delta as { type: string; text?: string; partial_json?: string } | undefined;
        if (d?.type === 'text_delta' && d.text)
          return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] })}\n\n`;
        if (d?.type === 'input_json_delta' && d.partial_json)
          return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: d.partial_json } }] }, finish_reason: null }] })}\n\n`;
      }

      if (e.type === 'content_block_stop') {
        if (toolId) {
          toolIndex++;
          toolId = '';
        }
        return null;
      }

      if (e.type === 'message_stop') {
        toolIndex = 0;
        toolId = '';
        return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: ts, model: 'claude', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
      }
    } catch {}
    return null;
  };
}

// Baked /v1/models payload — what the proxy advertises before (or without)
// a successful upstream catalog fetch. The live route serves the
// autodetected catalog (model-catalog.ts); `[1m]` variants are GENERATED by
// the one shared long-context rule, never hand-listed per model.
export const OPENAI_MODELS_LIST = buildOpenAIModelsList(withLongContextVariants(BAKED_BASE_MODELS));

/**
 * Whether dario must have a Claude login to start. False (an empty pool is
 * expected, not a fatal "run dario login") for the modes that serve requests
 * without the Claude OAuth pool: admin-bootstrap, upstream-api-key, and
 * --no-claude-auth. Pure so the startup gate is unit-testable.
 */
export function requiresClaudeLogin(
  poolSize: number,
  adminEnabled: boolean,
  hasUpstreamApiKey: boolean,
  noClaudeAuth: boolean,
): boolean {
  return poolSize === 0 && !adminEnabled && !hasUpstreamApiKey && !noClaudeAuth;
}

interface ProxyOptions {
  port?: number;
  host?: string;  // Bind address (default: 127.0.0.1)
  verbose?: boolean;
  verboseBodies?: boolean; // Dump redacted request bodies on every request (dario#40 -vv / DARIO_LOG_BODIES=1)
  model?: string;  // Override model in all requests
  fastModel?: string;  // Route Haiku-tier (CC sub-agent) requests here instead of `model` — keeps forced-model sub-agents cheap. No effect unless set.
  noClaudeAuth?: boolean;  // Don't load or refresh the Claude OAuth pool — for OpenAI-only proxies. Stops dario rotating a shared refresh token out from under an interactive Claude Code on the same machine. Claude-bound requests then get a clean unauthenticated error.
  passthrough?: boolean;  // Thin proxy — OAuth swap only, no injection
  preserveTools?: boolean;  // Keep client tool schemas (for agents with custom tools)
  hybridTools?: boolean;    // Remap to CC tools but inject request-context fields on return (#33)
  /**
   * Merge mode: send CC's canonical tools first, append client tools after
   * (deduped by name). Mutually exclusive with preserveTools and hybridTools
   * — proxy startup enforces the mutex. Experimental: Anthropic's billing
   * classifier may treat the appended tail as a divergence from CC's wire
   * shape and flip routing. Verify locally with `--verbose` and watch the
   * billing-bucket line on the first 1-2 requests before relying on it.
   */
  mergeTools?: boolean;
  noAutoDetect?: boolean;   // Disable text-tool-client auto-detection (dario#40, ringge — keep CC fingerprint)
  strictTls?: boolean;      // Refuse to start if not running under Bun (v3.23, direction #3)
  pacingMinMs?: number;     // Minimum ms between requests (v3.24, direction #6 — default 500)
  pacingJitterMs?: number;  // Max uniform-random jitter added on top of pacingMinMs (v3.24 — default 0)
  // Behavioral smoothing extension (post-response think time + session-start
  // jitter). All defaults 0 = off — opt-in. Closes the temporal/behavioral
  // axis that wire-fidelity work doesn't touch: response-length-correlated
  // read time and per-session opening latency, both present in real CC
  // traffic and absent in machine-paced agent loops.
  thinkTimeBaseMs?: number;       // Constant ms added to every think-time sample
  thinkTimePerTokenMs?: number;   // Additional ms per output token of the previous response
  thinkTimeJitterMs?: number;     // Max uniform-random jitter added on top
  thinkTimeMaxMs?: number;        // Upper bound on think time (default 30000)
  sessionStartMinMs?: number;     // Floor on session-start delay
  sessionStartJitterMs?: number;  // Max uniform-random jitter on session-start delay
  // Single-knob behavioral preset (default off). When set, the resolvers
  // for pacing / think-time / session-start fall through to non-zero
  // stealth defaults instead of 0, simulating real-CC inter-arrival
  // statistics. Explicit per-knob flags and env vars still win.
  stealth?: boolean;
  drainOnClose?: boolean;   // Keep draining upstream after client disconnects (v3.25, direction #5 — default off)
  sessionIdleRotateMs?: number;    // Idle ms before session-id rotates (v3.28, direction #1 — default 15min)
  sessionRotateJitterMs?: number;  // Uniform jitter on idle threshold (v3.28 — default 0)
  sessionMaxAgeMs?: number;        // Hard cap on session-id lifetime (v3.28 — default off)
  sessionPerClient?: boolean;      // Key sessions by x-session-id/x-client-session-id header (v3.28 — default off)
  /**
   * Opt specific orchestration tags out of the scrub. Undefined = strip all
   * (default, v3.30 and earlier behaviour). Set(['*']) = preserve all.
   * Set(['thinking','env']) = strip everything except those two. dario#78.
   */
  preserveOrchestrationTags?: Set<string>;
  /**
   * Skip the background live-fingerprint refresh entirely. Use the bundled
   * snapshot even when a live capture would have been possible. For
   * air-gapped / reproducible-build / CI-harness operators who want no
   * subprocess capture of the installed CC binary. dario#77.
   */
  noLiveCapture?: boolean;
  /**
   * Fail-closed mode for the template. If the loaded template is the
   * bundled snapshot (live capture has never been run or failed), or if
   * it's a live cache that drifts from the installed CC, refuse to start
   * rather than silently serve the stale shape. Same philosophy as
   * --strict-tls. dario#77.
   */
  strictTemplate?: boolean;
  /** Max concurrent in-flight requests. Default 10. dario#80. */
  maxConcurrent?: number;
  /** Max requests buffered waiting for a concurrency slot. Default 128. dario#80. */
  maxQueued?: number;
  /** Max ms a queued request waits before it times out with 504. Default 60000. dario#80. */
  queueTimeoutMs?: number;
  /**
   * Override the outbound `output_config.effort` value on non-haiku
   * requests. Default (undefined) pins `'high'`, matching CC 2.1.116's
   * wire value. `'client'` passes through whatever the client sent (or
   * falls back to `'high'` if the client didn't include an output_config).
   * dario#87.
   */
  effort?: EffortValue;
  /**
   * Override the outbound `max_tokens` value. Default (undefined) pins
   * `32000` — CC 2.1.116's wire default, below Anthropic's per-model
   * limits. A number pins a specific value. `'client'` passes through
   * whatever the client requested (up to Anthropic's per-model ceiling
   * on the server side). Hermes (and other agents) request up to 128k
   * for Opus and 64k for Sonnet; the default 32k pin silently truncates
   * their output capacity. dario#88 (Hermes compat).
   */
  maxTokens?: number | 'client';
  /**
   * Append-only request log file. One JSON line per completed request,
   * with secrets scrubbed via redactSecrets. Useful for backgrounded
   * proxies where stdout is unobserved — `verbose` only helps when you
   * can watch the foreground. Off by default; opt in with `--log-file`
   * or `DARIO_LOG_FILE`. Write errors are swallowed (never crash the
   * request path on a log mishap). dario#XYZ.
   */
  logFile?: string;
  /**
   * Beta flags to ALWAYS forward upstream regardless of CC's captured
   * set or the client's anthropic-beta header. Operator declaration
   * that "I know I want these survived through dario's substitution."
   * Bypasses `filterBillableBetas`; still respects the per-account
   * rejected-beta cache (so a flag the upstream 400's gets dropped on
   * the retry rather than re-sent forever). dario passthrough-betas.
   *
   * Sourced from `--passthrough-betas=name1,name2` or
   * DARIO_PASSTHROUGH_BETAS. Empty / undefined leaves current behavior
   * unchanged. Surfaced at startup so operators can see exactly which
   * flags are pinned-on; surfaced again per request when one of the
   * pinned flags has been rejected and is therefore being dropped.
   */
  passthroughBetas?: string[];
  /**
   * CC body fields to NOT inject into outbound requests. Allowed values:
   * `thinking`, `context_management`, `output_config`. Sourced from
   * `--skip-fields=name1,name2` or `DARIO_SKIP_FIELDS`. Used when an
   * upstream model 400s on a CC-shaped body field with "Extra inputs are
   * not permitted" (observed 2026-05-18 with a non-CC SDK client routed
   * through dario to claude-sonnet-4-6 — `context_management` rejected
   * despite the beta header). Skipping a field leaves all other CC
   * fingerprinting intact (headers, beta flags, metadata, OAuth identity),
   * so Max billing pool routing is unchanged.
   */
  skipFields?: string[];
  /**
   * When set, an inbound client body's `thinking` field (e.g.
   * `{type:"enabled", budget_tokens:N}` or `{type:"adaptive"}`) is passed
   * through to the upstream INSTEAD of dario's default CC-style
   * `{type:"adaptive"}`. SDK clients hitting dario can therefore explicitly
   * enable extended thinking with their own budget, rather than being
   * locked to CC's default adaptive shape.
   *
   * Side effect: when honored, dario also suppresses its
   * `context_management.clear_thinking_*` edit — that edit is tuned for
   * `type:"adaptive"` and pairing it with `type:"enabled"` 400s upstream.
   * The client takes responsibility for the request shape as a whole.
   *
   * No effect on Haiku (which skips thinking by construction) or when the
   * client doesn't supply a `thinking` field. CC clients are unaffected.
   *
   * Env: DARIO_HONOR_CLIENT_THINKING=1.
   */
  honorClientThinking?: boolean;
  /**
   * When set, the client body's `output_config.format` (Anthropic's native
   * structured-output JSON schema) is carried through to the upstream instead
   * of being dropped during the CC rebuild. dario rebuilds `output_config`
   * from the CC template (effort only), so structured-output clients — e.g.
   * the Vercel AI SDK's `generateObject` — otherwise get unconstrained prose
   * that fails their strict schema parse.
   *
   * Independent of skipFields: that opts out dario's INJECTED fields, while
   * this preserves the caller's own schema constraint. The constraint is
   * enforced upstream during decoding, so it holds regardless of the injected
   * CC identity or thinking shape. Verified on claude-sonnet-4-6 that
   * subscription (five_hour) routing is unchanged — headers, beta flags,
   * metadata, and OAuth identity are untouched.
   *
   * Env: DARIO_PRESERVE_OUTPUT_FORMAT=1.
   */
  preserveOutputFormat?: boolean;
  /**
   * System-prompt mode for the Claude backend. Empirically validated as
   * unfingerprinted by the billing classifier in docs/research/system-prompt-classifier-study.md.
   *
   *   - undefined / 'verbatim' — CC's prompt unchanged (default).
   *   - 'partial' — strip behavioral constraints (Tone-and-style, Text-output,
   *     scope/verbosity/comment bullets in Doing-tasks). Recovers ~1.2-2.8x
   *     output capability on open-ended work; leaves IMPORTANT: refusal
   *     reminders and tool descriptions intact.
   *   - 'aggressive' — partial + remove prompt-level RLHF restatements and
   *     the Executing-actions-with-care section. Adds <3% over partial; RLHF
   *     refusals on harmful content are unaffected (alignment is in the weights).
   *   - any other string — used as the literal system prompt text. The CLI
   *     resolves --system-prompt=<file path> to the file's contents up front
   *     so the runtime path stays filesystem-pure.
   *
   * Sourced from `--system-prompt=<value>` or DARIO_SYSTEM_PROMPT.
   */
  systemPrompt?: string;
  /**
   * Upstream auth override: forward to api.anthropic.com using `x-api-key:
   * <this>` (the per-token API pool) instead of the Pro/Max OAuth bearer.
   * When set, OAuth/getAccessToken and the account pool are bypassed entirely
   * — dario becomes a thin per-token Anthropic proxy. Default (unset) keeps
   * the subscription-OAuth behavior. Used by the self-hosted compat workflow so
   * it can route the suite THROUGH dario on the per-token pool — required
   * because compat runs dario in --passthrough (non-CC-shaped) and the Max OAuth
   * pool rejects non-CC traffic outright ("429 Rate limited (rejected)"), not a
   * rate cap. Sourced from ANTHROPIC_UPSTREAM_API_KEY (env-only — never
   * a CLI flag, so the key never lands in `ps`/argv).
   */
  upstreamApiKey?: string;
  /**
   * Overage-guard — halt the proxy on the first response that bills to
   * anything other than the subscription pool (`overage`, `api`, or a new
   * credit/SDK bucket — the 2026-06-15 split). Subscribers should never see
   * a single non-subscription hit during normal operation; one means
   * something is wrong (wire-shape drift, classifier change, account
   * misconfig) and continuing to forward bleeds against per-token billing.
   * Auto-disabled in upstream-API-key passthrough mode (see proxy setup).
   *
   * Default: enabled, halt behavior, 30-min cooldown, OS-notify on.
   * See dario#288.
   */
  overageGuardEnabled?: boolean;
  overageGuardBehavior?: 'halt' | 'warn';
  overageGuardCooldownMs?: number;
  overageGuardNotifyOs?: boolean;
}

/**
 * One JSON-ND record per completed request. Field set kept narrow to
 * stay grep-friendly and avoid leaking content. No request bodies, no
 * tool args, no headers — those still go through `--verbose-bodies` /
 * DARIO_LOG_BODIES (which has its own opt-in and is foreground-only).
 */
export interface ProxyLogEntry {
  ts: string;
  req: number;
  method: string;
  path: string;
  model?: string;
  status?: number;
  latency_ms?: number;
  in_tokens?: number;
  out_tokens?: number;
  cache_read?: number;
  cache_create?: number;
  claim?: string;
  bucket?: string;
  account?: string;
  client?: string;        // detected client family ('arnie', 'cline', 'unknown-non-cc', ...)
  preserve_tools?: boolean;
  stream?: boolean;
  reject?: string;        // reason if rejected before upstream (auth, queue-full, ...)
  error?: string;         // sanitized error message if request failed
  event?: string;         // non-request event, e.g. 'admin.login_complete' (#599 audit)
}

/**
 * Append a JSON-ND line to the proxy log file. No-op when stream is
 * null (logFile not configured). Errors are swallowed — log writes
 * must never break the request path.
 */
export function writeLogLine(stream: WriteStream | null, entry: ProxyLogEntry): void {
  if (!stream) return;
  try {
    stream.write(redactSecrets(JSON.stringify(entry)) + '\n');
  } catch {
    // ignore — log mishaps must never affect requests
  }
}

export function sanitizeError(err: unknown): string {
  // Pattern set lives in src/redact.ts so OAuth call sites can run the
  // same redaction directly on response-body strings without importing
  // proxy (which imports oauth — would circle).
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * API-key auth via DARIO_API_KEY (x-api-key or Authorization: Bearer).
 * If unset, requests are allowed (loopback-only default). Exported for tests.
 */
export function authenticateRequest(
  headers: IncomingMessage['headers'],
  apiKeyBuf: Buffer | null,
): boolean {
  if (!apiKeyBuf) return true;
  const provided = (headers['x-api-key'] as string)
    || (headers.authorization as string)?.replace(/^Bearer\s+/i, '');
  if (provided) {
    const providedBuf = Buffer.from(provided);
    if (providedBuf.length === apiKeyBuf.length && timingSafeEqual(providedBuf, apiKeyBuf)) return true;
  }
  return false;
}

/**
 * Describe WHY authenticateRequest rejected, for operator-facing logs only.
 * Header names only — never the value, since a mistyped key could be the
 * user's real credential for some other provider. Pure over inputs (dario#97).
 */
export function describeAuthReject(
  headers: IncomingMessage['headers'],
): string {
  const seenKeyHeader = headers['x-api-key'] !== undefined;
  const seenAuthHeader = headers['authorization'] !== undefined;
  if (!seenKeyHeader && !seenAuthHeader) return 'no x-api-key or Authorization header';
  if (seenKeyHeader && !seenAuthHeader) return 'x-api-key present but value mismatch';
  if (!seenKeyHeader && seenAuthHeader) return 'Authorization present but value mismatch';
  return 'both headers present but neither value matches';
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


/**
 * Build the upstream auth header for the request to api.anthropic.com.
 * `upstreamApiKey` set → per-token API pool (`x-api-key`); otherwise the
 * Pro/Max OAuth bearer. Pure + exported for unit testing.
 */
export function upstreamAuthHeaders(upstreamApiKey: string, accessToken: string): Record<string, string> {
  return upstreamApiKey
    ? { 'x-api-key': upstreamApiKey }
    : { 'Authorization': `Bearer ${accessToken}` };
}

/**
 * Resolve the startup auth outcome when the pool is empty and there's a
 * `dario login` credentials.json to fall back on — refreshing an expired-but-
 * refreshable access token before giving up.
 *
 * The classic single-account startup used to read getStatus() once and, on any
 * un-authenticated result, log "Not authenticated" and process.exit(1) WITHOUT
 * attempting a refresh. Because Docker restarts the container, that turned a
 * routine access-token expiry into a CRASH LOOP whenever the container was
 * (re)started while the access token was expired — even when the refresh token
 * was still valid and a single refresh would have recovered cleanly (dario
 * outage-hardening gap #1, 2026-07-02).
 *
 * getAccessToken() refreshes an expired-but-refreshable token on demand, but it
 * SWALLOWS a failed refresh (returns the stale token, throwing only when there
 * are no credentials at all), so its success/throw can't gate the exit. Instead:
 * when the initial status is un-authenticated but merely 'expired' with a live
 * refresh token, attempt the refresh via getAccessToken() and then RE-READ
 * getStatus() — its `authenticated` flag is the authority on whether we
 * actually recovered. A dead / invalid_grant refresh token leaves status
 * un-authenticated on the re-read, so the caller still exit(1)s with the same
 * message (no infinite loop). 'none' (no credentials) and 'broken' (refresh
 * already known-dead) skip the doomed attempt entirely. Pure + injectable for
 * unit testing.
 */
export async function resolveSingleAccountStartupStatus(
  deps: { getStatus: typeof getStatus; getAccessToken: typeof getAccessToken } = {
    getStatus,
    getAccessToken,
  },
): Promise<Awaited<ReturnType<typeof getStatus>>> {
  let status = await deps.getStatus();
  if (status.authenticated) return status;
  // Only an expired token with a live, non-broken refresh token is worth a
  // refresh attempt. canRefresh already encodes "has refresh token && !broken".
  if (status.status === 'expired' && status.canRefresh) {
    console.error('[dario] Access token expired at startup — attempting refresh before giving up…');
    try {
      await deps.getAccessToken(); // refreshes an expired-but-refreshable token in place
    } catch {
      // getAccessToken only throws when there are no credentials at all; a
      // failed refresh is swallowed there. The re-read below is authoritative.
    }
    // saveCredentials() updated the on-disk tokens + in-memory cache on a
    // successful refresh, so this reflects the post-refresh reality.
    status = await deps.getStatus();
    if (status.authenticated) {
      console.error('[dario] Token refresh succeeded at startup — continuing.');
    }
  }
  return status;
}

export async function startProxy(opts: ProxyOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? process.env.DARIO_HOST ?? DEFAULT_HOST;
  const verbose = opts.verbose ?? false;
  const passthrough = opts.passthrough ?? false;
  // Upstream auth override: a per-token API key forwards to the standard API
  // pool via `x-api-key`, bypassing OAuth/Max + the account pool entirely.
  // Env-only so the key never lands in `ps`/argv. Default (empty) = OAuth/Max.
  const upstreamApiKey = (opts.upstreamApiKey ?? process.env.ANTHROPIC_UPSTREAM_API_KEY ?? '').trim();
  if (upstreamApiKey) console.error('[dario] upstream auth: per-token API key (x-api-key) — OAuth/Max + account pool bypassed');

  // DNS result order — prefer IPv4 for the Anthropic upstream by default.
  // api.anthropic.com publishes both A and AAAA records. In a container with
  // no IPv6 egress (e.g. a default Docker bridge network), Node's `verbatim`
  // order tries the AAAA address first → ENETUNREACH/hang → every upstream
  // fetch times out ("Proxy error: The operation timed out") and the proxy is
  // effectively dead while /health still returns 200. Defaulting to ipv4first
  // makes Node resolve to the reachable A record (IPv4 to api.anthropic.com is
  // universally routable). Override with DARIO_DNS_RESULT_ORDER=verbatim or
  // ipv6first on IPv6-only / dual-stack hosts. (Node built-in fetch/undici
  // honors dns.setDefaultResultOrder.)
  const dnsOrder = (process.env.DARIO_DNS_RESULT_ORDER ?? 'ipv4first').trim();
  if (dnsOrder === 'ipv4first' || dnsOrder === 'ipv6first' || dnsOrder === 'verbatim') {
    try {
      setDefaultResultOrder(dnsOrder);
      if (verbose) console.error(`[dario] dns result order: ${dnsOrder}`);
    } catch (e) {
      console.error(`[dario] could not set dns result order (${dnsOrder}): ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.error(`[dario] ignoring invalid DARIO_DNS_RESULT_ORDER='${dnsOrder}' (use ipv4first | ipv6first | verbatim)`);
  }

  // TLS-fingerprint axis (v3.23, direction #3). Proxy mode terminates TLS
  // to api.anthropic.com from this process; if we're not on Bun, the
  // ClientHello that reaches Anthropic is Node's OpenSSL shape, not CC's
  // Bun/BoringSSL shape. `--strict-tls` turns this silent divergence into
  // a startup refusal. Doctor + the always-on banner below surface the
  // same information without aborting, for users who know they're fine
  // (API-key billing, single-call invocations, etc.).
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
  // Per-(client, mapping-mode) keys for which we've already emitted a
  // tool-substitution warn line. Same de-dup contract as
  // detectedClientsLogged so mixed-traffic proxies don't spam.
  const toolSubLogged = new Set<string>();
  // Same de-dup contract for the verbose-only MCP-passthrough note.
  const mcpPassthroughLogged = new Set<string>();
  // One-shot log for the genuine-CC byte-faithful passthrough path.
  let ccPassthroughLogged = false;
  // Body-dump mode: set via --verbose=2 / -vv or DARIO_LOG_BODIES=1.
  // When on, every request emits a redacted JSON body to stderr so
  // operators can see exactly what dario forwards upstream. Default
  // -v stays quiet because bodies can carry file content and tool
  // output. Reported in dario#40 by @ringge.
  const verboseBodies = Boolean(opts.verboseBodies) || process.env.DARIO_LOG_BODIES === '1';

  // Operator-declared beta passthrough set. Sourced from CLI flag or env;
  // both are CSV strings of beta-flag names. Trimmed, deduped, empty
  // entries dropped. Stays a Set for fast membership checks in the per-
  // request beta build below.
  const passthroughBetas = new Set<string>(
    [
      ...(opts.passthroughBetas ?? []),
      ...((process.env.DARIO_PASSTHROUGH_BETAS ?? '').split(',')),
    ]
    .map((b) => b.trim())
    .filter((b) => b.length > 0),
  );
  if (passthroughBetas.size > 0) {
    console.log(`  Beta passthrough: ${[...passthroughBetas].sort().join(', ')} (always forwarded; per-account rejection cache still applies)`);
  }

  // CC body fields to suppress. Allowed values: thinking, context_management,
  // output_config. Anything else is silently ignored after a warn (so a typo
  // doesn't quietly disable nothing). See ProxyOptions.skipFields.
  const ALLOWED_SKIP_FIELDS = new Set(['thinking', 'context_management', 'output_config']);
  const skipFields = new Set<string>();
  for (const raw of [
    ...(opts.skipFields ?? []),
    ...((process.env.DARIO_SKIP_FIELDS ?? '').split(',')),
  ]) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!ALLOWED_SKIP_FIELDS.has(trimmed)) {
      console.warn(`[dario] WARNING: --skip-fields value ${JSON.stringify(trimmed)} is not recognized; ignoring. Allowed: ${[...ALLOWED_SKIP_FIELDS].join(', ')}.`);
      continue;
    }
    skipFields.add(trimmed);
  }
  if (skipFields.size > 0) {
    console.log(`  Skip CC body fields: ${[...skipFields].sort().join(', ')} (omitted from outbound non-haiku requests; headers and metadata unchanged)`);
  }

  // Tool-routing mode mutex. preserve / hybrid / merge each shape the
  // outbound `tools` array differently; combining two would mean two
  // different bodies. Refuse to start with a clear error rather than
  // silently dropping a flag.
  const toolModes = [
    opts.preserveTools ? 'preserve-tools' : null,
    opts.hybridTools ? 'hybrid-tools' : null,
    opts.mergeTools ? 'merge-tools' : null,
  ].filter((m): m is string => m !== null);
  if (toolModes.length > 1) {
    console.error(`[dario] tool-routing flags are mutually exclusive — pick one: ${toolModes.join(', ')}.`);
    process.exit(1);
  }
  if (opts.mergeTools) {
    // Loud notice — this mode is experimental and operators need to
    // verify their billing classification before relying on it. The
    // wire-shape "tools[]" axis still has CC's array as a prefix, but
    // the suffix is operator-supplied custom shapes. Anthropic's
    // classifier may flip routing on the difference.
    console.log('  Tool routing: merge (CC tools + client custom tools, deduped)');
    console.log('  ⚠  EXPERIMENTAL: validate billing-bucket behavior on the first 1-2 requests with --verbose');
  }

  // Append-only structured request log. One JSON-ND line per completed
  // request — secrets scrubbed via redactSecrets, no bodies. Off by
  // default; opt in with `--log-file <path>` or DARIO_LOG_FILE. See the
  // ProxyLogEntry interface for fields. Useful for backgrounded proxies
  // where stdout is unobserved (`verbose` only helps in foreground).
  // Errors during open are reported once and downgrade to no-op so a
  // log mishap never blocks the proxy from booting.
  const logFilePath = opts.logFile || process.env.DARIO_LOG_FILE || null;
  let logFileStream: WriteStream | null = null;
  if (logFilePath) {
    try {
      logFileStream = createWriteStream(logFilePath, { flags: 'a' });
      logFileStream.on('error', (err) => {
        console.error(`[dario] log-file write error: ${err.message} (logging disabled)`);
        logFileStream = null;
      });
      console.log(`  Request log: ${logFilePath}`);
    } catch (err) {
      console.error(`[dario] log-file open failed: ${err instanceof Error ? err.message : err} (continuing without)`);
      logFileStream = null;
    }
  }

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

  // Pool-as-primitive (v5.0). The account pool is the one credential model:
  // a plain `dario login` is a pool of one under the reserved `login` alias,
  // and a pool of many is the same path with more members. There is no
  // separate single-account code path.
  //
  // Back-fill the login credentials into accounts/login.json unconditionally
  // (pre-v5 this ran only on the first `dario accounts add` or under admin
  // mode) so the request path is always the pool. No-op when accounts/ already
  // has entries or no login credentials are reachable — see
  // ensureLoginCredentialsInPool.
  try { await ensureLoginCredentialsInPool(); } catch { /* non-fatal — pool may start empty (admin bootstrap / api-key mode) */ }

  // Re-sync the back-filled `login` snapshot if credentials.json refreshed out
  // of band — e.g. a `dario refresh`/`dario status` in another process rotated
  // the shared token lineage (dario#235). Runs after the back-fill so a freshly
  // created login.json is seen as in-sync rather than triggering a redundant
  // rewrite.
  const resyncResult = await resyncLoginFromCredentialsIfStale();
  if (resyncResult === 'resynced') {
    console.log('[dario] re-synced pool `login` account from current credentials.json (was stale; dario#235)');
  }

  // Admin mode (#599) manages the pool over HTTP: it may legitimately start
  // with zero accounts and returns a clean 503 until one is added via
  // POST /admin/login/*, taking effect with no restart (see onAccountsChanged).
  const adminEnabled = process.env.DARIO_ADMIN === '1';
  const accountsList = await loadAllAccounts();
  const pool = new AccountPool();
  // Per-model rate-limit bucket families seen during this proxy run. First-
  // sight is logged once when verbose so a new Anthropic bucket (e.g. an
  // eventual `7d_opus`) doesn't slip past unnoticed. Pure observability —
  // routing already handles unknown families generically.
  const seenPerModelBuckets = new Set<string>();
  // v4 promotion: analytics is always-on so the TUI's Analytics + Hits
  // tabs work for every install. Pre-v4 this was `pool ? new Analytics()
  // : null` — that gated the /analytics endpoint, but burn-rate /
  // per-request visibility is useful for a pool of one too.
  const analytics = new Analytics();

  // Overage-guard (v4.1, dario#288). Resolved from opts with built-in
  // defaults (enabled=true, behavior='halt', cooldown=30min, notifyOs=true)
  // so an opts-less proxy still gets protection. The notifier is wired
  // separately below once notify.ts is loaded.
  //
  // Disabled in upstream-API-key passthrough mode: there the operator
  // explicitly opted into the per-token API pool, so responses legitimately
  // bill as `api`. The guard now halts on ANY non-subscription claim (incl.
  // `api`), so leaving it on would false-halt the whole passthrough path
  // (e.g. the self-hosted compat workflow). The subscription-protection
  // premise doesn't apply when there's no subscription to protect.
  const overageGuard = new OverageGuard({
    enabled: (opts.overageGuardEnabled ?? true) && !upstreamApiKey,
    behavior: opts.overageGuardBehavior ?? 'halt',
    cooldownMs: opts.overageGuardCooldownMs ?? 30 * 60 * 1000,
    notifyOs: opts.overageGuardNotifyOs ?? true,
    notifier: osNotify,
  });
  overageGuard.attach(analytics);
  // Surface halt + resume to the foreground startup banner so an
  // operator running `dario proxy` directly sees the event even without
  // a TUI attached. -v / --verbose is not required — this is loud by
  // design.
  overageGuard.on('halt', (state: HaltState) => {
    console.error(`[dario] OVERAGE-GUARD HALTED: ${state.request.model} on account=${state.request.account} returned representative-claim=${state.request.claim} at ${new Date(state.request.timestamp).toISOString()}. Returning 503 to new requests until \`dario resume\` or cooldown expires (${new Date(state.cooldownUntil).toISOString()}). See dario#288.`);
  });
  overageGuard.on('warn', (state: HaltState) => {
    console.error(`[dario] OVERAGE-GUARD WARN: ${state.request.model} on account=${state.request.account} returned representative-claim=${state.request.claim} at ${new Date(state.request.timestamp).toISOString()}. Behavior=warn — proxy continuing to forward; investigate before bill bleeds. See dario#288.`);
  });
  overageGuard.on('resume', (info: { reason: 'manual' | 'cooldown' }) => {
    console.error(`[dario] overage-guard resumed (${info.reason}). Normal request handling restored.`);
  });

  let status: Awaited<ReturnType<typeof getStatus>>;
  // --no-claude-auth: don't populate the Claude OAuth pool. An empty pool makes
  // the background refresh a no-op, so dario never touches (and never rotates)
  // the shared Claude refresh token — the fix for a local OpenAI-only proxy
  // logging out an interactive Claude Code on the same machine (dario#737 class,
  // locally). OpenAI-compat requests use their own backend key, unaffected.
  if (opts.noClaudeAuth) {
    console.error('[dario] --no-claude-auth: Claude OAuth pool NOT loaded — serving OpenAI-compatible backends only; the Claude refresh token is never touched. Claude-bound requests return an unauthenticated error.');
  } else {
    for (const acc of accountsList) {
      pool.add(acc.alias, {
        accessToken: acc.accessToken,
        refreshToken: acc.refreshToken,
        expiresAt: acc.expiresAt,
        deviceId: acc.deviceId,
        accountUuid: acc.accountUuid,
      });
    }
  }
  // Background refresh — keep every account's token fresh without blocking requests
  const refreshInterval = setInterval(async () => {
    if (opts.noClaudeAuth) return; // never touch the Claude token in OpenAI-only mode
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

  // Auth gate. The pool is the one credential model, so "authenticated" means
  // the pool has at least one account. An empty pool is legitimate only for:
  //   - admin bootstrap (#599): starts empty, returns a clean 503 until an
  //     account is added over the admin API;
  //   - upstream-api-key mode: OAuth + pool are bypassed, requests carry
  //     x-api-key, so an empty pool is expected.
  // Otherwise an empty pool means the login back-fill found no credentials —
  // the user hasn't logged in. Preserve the single-account self-heal there: a
  // dead-but-refreshable token (a container restarted right after a normal
  // expiry, gap #1) is refreshed, then back-filled so the recovered login
  // becomes the pool-of-one it should be — rather than crash-looping on exit(1).
  if (requiresClaudeLogin(pool.size, adminEnabled, !!upstreamApiKey, opts.noClaudeAuth ?? false)) {
    const single = await resolveSingleAccountStartupStatus();
    if (!single.authenticated) {
      console.error('[dario] Not authenticated. Run `dario login` first.');
      process.exit(1);
    }
    const recovered = await ensureLoginCredentialsInPool();
    if (recovered) {
      const acc = await loadAccount(recovered);
      if (acc) {
        pool.add(acc.alias, {
          accessToken: acc.accessToken,
          refreshToken: acc.refreshToken,
          expiresAt: acc.expiresAt,
          deviceId: acc.deviceId,
          accountUuid: acc.accountUuid,
        });
      }
    }
  }

  if (pool.size === 0) {
    // Reached only under admin bootstrap or api-key mode (the not-authenticated
    // case exited above). Report the empty pool plainly instead of
    // Math.min([]) === Infinity.
    if (adminEnabled) {
      console.warn('[dario] Starting with no accounts (admin mode). Add one via POST /admin/login/start; LLM requests return 503 until then.');
    }
    status = {
      authenticated: false,
      status: 'none',
      expiresAt: 0,
      expiresIn: upstreamApiKey ? 'api-key mode' : 'no accounts yet',
    };
  } else {
    const earliest = Math.min(...pool.all().map(a => a.expiresAt));
    const msLeft = Math.max(0, earliest - Date.now());
    status = {
      authenticated: true,
      status: 'healthy',
      expiresAt: earliest,
      expiresIn: `${Math.floor(msLeft / 3600000)}h ${Math.floor((msLeft % 3600000) / 60000)}m`,
    };
  }

  const cliVersion = detectCliVersion();
  // Parse --model once at startup. Supports `<provider>:<model>` to force
  // a backend for every request (e.g. `--model=openai:gpt-4o`). Back-compat:
  // bare names like `opus` resolve via MODEL_ALIASES.
  const modelPrefix = opts.model ? parseProviderPrefix(opts.model) : null;
  const cliModelRaw = modelPrefix ? modelPrefix.model : opts.model;
  const cliProviderOverride: 'openai' | 'claude' | null = modelPrefix ? modelPrefix.provider : null;
  const modelOverride = cliModelRaw ? resolveClaudeAlias(cliModelRaw) : null;
  // --fast-model: the model that Haiku-tier (Claude Code sub-agent) requests
  // route to instead of the forced `--model`, so sub-agents stay cheap. Parsed
  // like --model (alias + optional provider prefix). Null = disabled.
  const fastModelPrefix = opts.fastModel ? parseProviderPrefix(opts.fastModel) : null;
  const fastModelRaw = fastModelPrefix ? fastModelPrefix.model : opts.fastModel;
  const fastModelOverride = fastModelRaw ? resolveClaudeAlias(fastModelRaw) : null;
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
  const queue = new RequestQueue({
    maxConcurrent: opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    maxQueued: opts.maxQueued ?? DEFAULT_MAX_QUEUED,
    queueTimeoutMs: opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
  });

  // Cache context-1m beta availability. Set false once per account after the
  // first "long context" rejection, so we skip sending context-1m on every
  // subsequent request instead of paying the round-trip + retry cost each time.
  // Keyed by pool-account alias; `ACCOUNT_KEY_APIKEY` is the slot used in
  // upstream-api-key mode (no pool account). Reported by @boeingchoco in
  // dario#36 — the retry loop was firing on every POST with hybrid-tools + OC.
  const context1mUnavailable = new Set<string>();
  // Per-account cache of anthropic-beta flags the upstream has rejected as
  // "Unexpected value(s)". The live-captured template lifts whatever CC emits
  // verbatim — including flags gated to higher-tier accounts (e.g.
  // `afk-mode-2026-01-31` is rejected on Max 5x as of 2026-04-17). On the
  // first rejection we parse the flag out of the error message, strip it,
  // retry once, and cache it so subsequent requests on the same account don't
  // re-pay the 400 round-trip. Keyed by pool-account alias.
  const unavailableBetas = new Map<string, Set<string>>();
  // Synthetic account key for upstream-api-key mode — the one request path with
  // no pool account (v5.0: every OAuth request has a pool account, so this is
  // the sole `poolAccount?.alias ?? …` fallback that survives). Keys the
  // per-account caches and the analytics `account` field for api-key traffic.
  const ACCOUNT_KEY_APIKEY = '__apikey__';
  // Per-model effort capability cache — same pay-the-round-trip-once pattern
  // as context1mUnavailable, but keyed by WIRE MODEL id: effort support is a
  // model property, not an account property. Populated from upstream's
  // "does not support effort level" 400 (see parseEffortRejection); consulted
  // up front at body-build time so capped models never re-pay the rejection.
  const effortSupportByModel = new Map<string, string[]>();
  // Per-model max_tokens cap cache — same pay-the-round-trip-once shape as
  // effortSupportByModel. Populated from upstream's "max_tokens: X > Y, which
  // is the maximum allowed" 400 (see parseMaxTokensRejection); consulted up
  // front so older models capped below dario's DEFAULT_MAX_TOKENS pin never
  // re-pay the rejection.
  const maxTokensCapByModel = new Map<string, number>();

  // Beta flag set — sourced from the live template when the capture recorded
  // one (schema v2+), else falls back to the v2.1.104 bundled default.
  // Computed once per proxy because it's a function of the loaded template,
  // not of the request.
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
  const {
    computePacingDelay,
    resolvePacingConfig,
    computeThinkTimeDelay,
    resolveThinkTimeConfig,
    computeSessionStartDelay,
    resolveSessionStartConfig,
  } = await import('./pacing.js');
  let lastRequestTime = 0;
  // Behavioral smoothing state: when the last response *completed* and
  // how many output tokens it had. Used by computeThinkTimeDelay to
  // model human read-time before the next request. Distinct from
  // lastRequestTime (which tracks when the last request *started* and
  // feeds the inter-request floor).
  let lastResponseTime = 0;
  let lastResponseTokens = 0;
  // --stealth toggles the behavioral-stealth preset across all three
  // pacing layers (pace, think-time, session-start). When on, each
  // resolver's zero-default flips to its stealth preset; explicit flags
  // and env vars still win.
  const stealth = Boolean(opts.stealth);
  const pacingCfg = resolvePacingConfig({
    minGapMs: opts.pacingMinMs,
    jitterMs: opts.pacingJitterMs,
    stealth,
  });
  const thinkTimeCfg = resolveThinkTimeConfig({
    baseMs: opts.thinkTimeBaseMs,
    perTokenMs: opts.thinkTimePerTokenMs,
    jitterMs: opts.thinkTimeJitterMs,
    maxMs: opts.thinkTimeMaxMs,
    stealth,
  });
  const sessionStartCfg = resolveSessionStartConfig({
    minMs: opts.sessionStartMinMs,
    jitterMs: opts.sessionStartJitterMs,
    stealth,
  });
  const thinkTimeEnabled = thinkTimeCfg.baseMs > 0 || thinkTimeCfg.perTokenMs > 0 || thinkTimeCfg.jitterMs > 0;
  const sessionStartEnabled = sessionStartCfg.minMs > 0 || sessionStartCfg.jitterMs > 0;
  if (verbose) {
    if (stealth) console.log('[dario] stealth: behavioral-stealth preset active (pace+think+session-start defaults non-zero)');
    console.log(`[dario] pacing: min=${pacingCfg.minGapMs}ms jitter=${pacingCfg.jitterMs}ms`);
    if (thinkTimeEnabled) {
      console.log(`[dario] think-time: base=${thinkTimeCfg.baseMs}ms perToken=${thinkTimeCfg.perTokenMs}ms jitter=${thinkTimeCfg.jitterMs}ms max=${thinkTimeCfg.maxMs}ms`);
    }
    if (sessionStartEnabled) {
      console.log(`[dario] session-start: min=${sessionStartCfg.minMs}ms jitter=${sessionStartCfg.jitterMs}ms`);
    }
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
  // The one session-id mechanism (v5.0). Pre-v5 the proxy forked: single-account
  // rotated its outbound session id via this registry, while pool accounts each
  // carried a stable identity.sessionId for the proxy's lifetime. Now that a
  // plain `dario login` is a pool of one, both collapse here: the session id is
  // resolved through the registry keyed by the selected account's alias (so each
  // account keeps its own idle/jitter/max-age lifecycle), seeded with that
  // account's minted identity.sessionId. The seed makes an account's FIRST
  // request byte-identical to pre-v5 (the minted id), and only idle/age rotation
  // mints a fresh one — so a pool of one rotates exactly as the old single path
  // did, and busy multi-account pools keep their per-account ids until they idle.
  // `account === null` is upstream-api-key mode; it keys on ACCOUNT_KEY_APIKEY.
  const resolveOutboundSession = (account: PoolAccount | null, clientKey: string | undefined) =>
    sessionRegistry.getOrCreate(
      account?.alias ?? ACCOUNT_KEY_APIKEY,
      clientKey,
      Date.now(),
      account?.identity.sessionId,
    );

  // Optional proxy authentication — pre-encode key buffer for performance
  const apiKey = process.env.DARIO_API_KEY;
  const apiKeyBuf = apiKey ? Buffer.from(apiKey) : null;

  // Admin API (#599) — opt-in headless account management at /admin/*. Off
  // unless DARIO_ADMIN=1. Auth is ALWAYS required (even on loopback) because
  // these endpoints add/remove OAuth accounts: the admin token is
  // DARIO_ADMIN_TOKEN, falling back to DARIO_API_KEY. Enabled-but-tokenless
  // fails closed (403) so account control is never left open on loopback.
  // adminEnabled is resolved once up top (it gates pool activation). Reuse it.
  const adminToken = process.env.DARIO_ADMIN_TOKEN || process.env.DARIO_API_KEY || '';
  const adminTokenBuf = adminToken ? Buffer.from(adminToken) : null;
  if (adminEnabled) {
    console.log(`[dario] admin API enabled at /admin/* (token ${adminTokenBuf ? 'configured' : 'MISSING — endpoints return 403 until DARIO_ADMIN_TOKEN is set'})`);
    // Hardening (#642): the admin API adds/removes OAuth accounts. When it
    // shares DARIO_API_KEY (which is embedded in every client config) instead
    // of a distinct DARIO_ADMIN_TOKEN, every client that can proxy can also
    // control the account pool. Non-fatal for back-compat, but warn loudly.
    if (adminTokenBuf && !process.env.DARIO_ADMIN_TOKEN) {
      console.warn('[dario] WARNING: admin API is using DARIO_API_KEY as its token (no DARIO_ADMIN_TOKEN set).');
      console.warn('[dario] every client holding the proxy key can add/remove accounts. Set a distinct DARIO_ADMIN_TOKEN.');
    }
  }
  // Admin rate limiting (#620). Two token buckets, created once per proxy:
  // failed auth (brute-force / broken-client throttle) and mutations. Global,
  // not per-IP — the surface is loopback-default so remoteAddress collapses to
  // 127.0.0.1 (and behind a tunnel it's the tunnel address), making a single
  // bucket per category simpler and sufficient. Disable with
  // DARIO_ADMIN_RATE_LIMIT=off. Defaults are generous for a human operator +
  // scripts and only bite runaway callers.
  const adminRateLimitOff = /^(off|0|false)$/i.test(process.env.DARIO_ADMIN_RATE_LIMIT ?? '');
  const adminAuthBucket = createTokenBucket(10, 0.5);     // 10 burst, then 1 / 2s
  const adminMutationBucket = createTokenBucket(30, 1);   // 30 burst, then 1 / 1s
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
    // *-wildcard covers custom headers in non-credentialed mode, except
    // Authorization, which is a CORS non-wildcard request-header name.
    'Access-Control-Allow-Headers': '*, Authorization',
    'Access-Control-Max-Age': '86400',
    ...SECURITY_HEADERS,
  };
  const JSON_HEADERS = { 'Content-Type': 'application/json', ...SECURITY_HEADERS };
  // Pool-derived status for /status + /health (#636). The pool is the one
  // credential model, so status is computed from its accounts' expiry +
  // cool-down — a login-less pool (admin bootstrap / api-key mode) reports
  // truthfully instead of the pre-v5 single-account getStatus() reading a
  // credentials.json that may not exist (which broke docker healthchecks and
  // made the TUI claim the proxy was down).
  async function currentStatus() {
    const now = Date.now();
    return derivePoolStatus(
      pool.all().map((a) => ({ expiresAt: a.expiresAt, inAuthCooldown: isInAuthCooldown(a, now) })),
      now,
      adminEnabled,
    );
  }

  // Model catalog wiring — /v1/models serves the upstream-autodetected set,
  // authenticated the same way the request path is (per-token API key when
  // ANTHROPIC_UPSTREAM_API_KEY is set, OAuth bearer otherwise — from the pool
  // when pool mode is active, so a login-less setup doesn't fail the fetch
  // with a misleading "Run `dario login` first" (#636)). Prewarmed so the
  // first client call is answered from cache; every failure path inside
  // getModelCatalog falls back to the baked list, so the route always 200s.
  const catalogDeps: CatalogDeps = {
    upstreamApiKey: upstreamApiKey || undefined,
    getToken: async () => {
      const now = Date.now();
      const accounts = pool.all();
      if (accounts.length === 0) {
        throw new Error(
          adminEnabled
            ? 'pool has no accounts yet — add one via POST /admin/login/start'
            : 'pool has no accounts yet — run `dario login` (or `dario accounts add <alias>`)',
        );
      }
      const usable = accounts.filter((a) => !isInAuthCooldown(a, now) && a.expiresAt > now);
      return (usable[0] ?? accounts[0]).accessToken;
    },
    log: verbose ? (m: string) => console.log(m) : undefined,
  };
  if (pool.size === 0) {
    // Empty admin pool: skip the prewarm instead of logging a guaranteed
    // failure at startup. The catalog refetches when the first account is
    // hot-added (onAccountsChanged below).
    console.log('[dario] model catalog: no accounts yet — serving baked list until one is added');
  } else {
    prewarmModelCatalog(catalogDeps);
  }
  const ERR_UNAUTH = JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' });
  const ERR_FORBIDDEN = JSON.stringify({ error: 'Forbidden', message: 'Path not allowed. Supported paths: POST /v1/messages, POST /v1/messages/count_tokens, POST /v1/chat/completions, GET /v1/models' });
  const ERR_METHOD = JSON.stringify({ error: 'Method not allowed' });

  function checkAuth(req: IncomingMessage): boolean {
    return authenticateRequest(req.headers, apiKeyBuf);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

    // Strip query parameters for endpoint matching
    const urlPath = req.url?.split('?')[0] ?? '';

    // Health check
    //
    // Returns HTTP 503 when OAuth is in a state that will cause every upstream
    // call to fail: refresh has failed N consecutive times ('broken'), or the
    // access token is expired with no usable refresh path. Docker healthchecks
    // and dependent services (`depends_on: service_healthy`) need this to
    // react instead of cheerfully passing while every /v1/messages 401s.
    if (urlPath === '/health' || urlPath === '/') {
      const s = await currentStatus();
      // Disclose OAuth internals only to trusted callers (#642). This used to
      // key on the presence of the client-suppliable `cf-ray` header and failed
      // OPEN — a direct non-tunnel caller omits it and got the full internal
      // view. Now: authenticated, OR bare loopback that did not arrive via CF.
      const includeInternal = shouldDiscloseHealthInternals({
        authenticated: authenticateRequest(req.headers, apiKeyBuf),
        loopback: isLoopbackAddr(req.socket?.remoteAddress),
        viaCfRay: req.headers['cf-ray'] !== undefined,
      });
      const { httpStatus, body } = buildHealthResponse(
        { ...s, version: darioVersion() },
        requestCount,
        includeInternal,
      );
      res.writeHead(httpStatus, JSON_HEADERS);
      res.end(JSON.stringify(body));
      return;
    }

    // Admin API (#599) — self-authenticating with the admin token, mounted
    // BEFORE the DARIO_API_KEY gate so it requires its own token even on
    // loopback (where the proxy key is otherwise optional). handleAdminRequest
    // only acts on its own routes (/admin/login/*, /admin/accounts) and returns
    // false otherwise, so the pre-existing /admin/resume + the key gate below
    // still apply unchanged.
    if (adminEnabled && urlPath.startsWith('/admin/')) {
      const handled = await handleAdminRequest(req, res, urlPath, {
        adminTokenBuf,
        onAccountsChanged: async () => {
          // Hot-reload the live pool from disk so accounts added / removed via
          // the admin API take effect immediately — no proxy restart (#599).
          // Awaited by handleAdminRequest before it responds, so the account is
          // already routable by the time the client sees the 200.
          try {
            const size = reconcilePoolAccounts(pool, await loadAllAccounts());
            if (verbose) console.log(`[dario] admin: pool hot-reloaded — ${size} account${size === 1 ? '' : 's'}`);
            // The startup prewarm was skipped (or failed) while the pool was
            // empty; now that a bearer exists, refetch past the failed-fetch
            // backoff so /v1/models upgrades from the baked list without
            // waiting out the retry window (#636).
            if (size > 0) retryModelCatalogNow(catalogDeps);
          } catch (err) {
            console.error(`[dario] admin: pool hot-reload failed: ${err instanceof Error ? err.message : err}`);
          }
        },
        // Live per-account status so GET /admin/accounts reports headroom, not
        // just persisted metadata — the same snapshot GET /accounts exposes.
        poolStatus: () => {
          const snapNow = Date.now();
          const snap = new Map<string, AdminAccountLive>();
          for (const a of pool.all()) {
            snap.set(a.alias, {
              util5h: a.rateLimit.util5h,
              util7d: a.rateLimit.util7d,
              claim: a.rateLimit.claim,
              status: isInAuthCooldown(a, snapNow) ? 'auth-cooldown' : a.rateLimit.status,
              requestCount: a.requestCount,
            });
          }
          return snap;
        },
        // Audit trail for admin activity. Console always (headless operators
        // read container stdout; the JSON log file is opt-in), plus a structured
        // line when --log-file / DARIO_LOG_FILE is set.
        audit: (e: AdminAuditEvent) => {
          const detail = e.detail ? ` detail=${e.detail}` : '';
          const line = `[dario] admin-audit: ${e.action} alias=${e.alias ?? '-'} ok=${e.ok} status=${e.status} from=${e.remote ?? '-'}${detail}`;
          if (e.ok) console.log(line); else console.warn(line);
          writeLogLine(logFileStream, {
            ts: new Date().toISOString(),
            req: 0,
            method: req.method ?? '',
            path: urlPath,
            status: e.status,
            event: `admin.${e.action}`,
            account: e.alias,
            reject: e.ok ? undefined : 'admin-auth',
          });
        },
        // Token-bucket gate (#620). 0 = allowed (token consumed); >0 = throttled,
        // the ms to wait. Off switch short-circuits to always-allowed.
        rateLimit: (category: 'auth' | 'mutation'): number => {
          if (adminRateLimitOff) return 0;
          const bucket = category === 'auth' ? adminAuthBucket : adminMutationBucket;
          return bucket.tryRemove() ? 0 : bucket.retryAfterMs();
        },
      });
      if (handled) return;
    }

    if (!checkAuth(req)) {
      if (verbose) {
        // Silent auth rejects are hard to diagnose when a client's config
        // doesn't quite match what dario expects (dario#97). Emit a
        // one-line reject log under -v so operators see auth misfires.
        console.error(`[dario] #${requestCount} 401 rejected (DARIO_API_KEY mismatch): ${describeAuthReject(req.headers)}`);
      }
      writeLogLine(logFileStream, {
        ts: new Date().toISOString(), req: requestCount,
        method: req.method ?? '', path: urlPath, status: 401, reject: 'auth',
      });
      res.writeHead(401, JSON_HEADERS);
      res.end(ERR_UNAUTH);
      return;
    }

    // Status endpoint
    if (urlPath === '/status') {
      const s = await currentStatus();
      // Version for auto-update checks (#640) — /status is key-gated (loopback
      // or DARIO_API_KEY), so no public-disclosure concern like /health has.
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ version: darioVersion(), ...s }));
      return;
    }

    // Pool status endpoint — shows loaded accounts, headroom, and the
    // account that would be selected next. Read-only; mutation flows through
    // the `dario accounts` CLI, not HTTP.
    if (urlPath === '/accounts' && req.method === 'GET') {
      const now = Date.now();
      const accounts = pool.all().map(a => {
        const inCooldown = isInAuthCooldown(a, now);
        const cooldownMs = inCooldown && a.lastAuthFailureAt
          ? Math.max(0, authCooldownMs(a.consecutiveAuthFailures) - (now - a.lastAuthFailureAt))
          : 0;
        return {
          alias: a.alias,
          util5h: a.rateLimit.util5h,
          util7d: a.rateLimit.util7d,
          claim: a.rateLimit.claim,
          status: inCooldown ? 'auth-cooldown' : a.rateLimit.status,
          requestCount: a.requestCount,
          expiresInMs: Math.max(0, a.expiresAt - now),
          ...(inCooldown
            ? {
                lastAuthFailureAt: a.lastAuthFailureAt,
                consecutiveAuthFailures: a.consecutiveAuthFailures,
                cooldownMs,
              }
            : {}),
        };
      });
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({
        mode: 'pool',
        ...pool.status(),
        stickyBindings: pool.stickyCount(),
        accounts,
      }));
      return;
    }

    // Analytics endpoint — rolling-window summary + burn-rate snapshot.
    // Always-on as of v4 (pre-v4 this was gated to pool mode).
    if (urlPath === '/analytics' && req.method === 'GET') {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(analytics.summary()));
      return;
    }

    // Analytics live stream — SSE of new RequestRecord JSON, one event
    // per record as it lands. Drives the v4 TUI's Hits tab. Sends a
    // backlog of the most-recent 50 records on connect so a freshly-
    // attached subscriber sees state immediately, then live-tails.
    //
    // Auth: same as /analytics — no auth by default; the proxy listens on
    // loopback. DARIO_API_KEY users get rejected by the earlier auth gate
    // up the handler chain.
    //
    // Disconnect handling: the 'close' event on `req` removes our
    // listener from the Analytics EventEmitter so we don't leak.
    if (urlPath === '/analytics/stream' && req.method === 'GET') {
      // SECURITY_HEADERS sets Cache-Control: no-store; SSE wants
      // no-cache, no-transform. Spread SECURITY_HEADERS first then
      // override the cache directive — order matters since spread
      // overlap is last-wins in JS.
      const sseHeaders: Record<string, string> = {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // disable any proxy buffering
        'Access-Control-Allow-Origin': corsOrigin,
      };
      res.writeHead(200, sseHeaders);
      // Backlog: replay recent records so a TUI attaching mid-session
      // sees something. 50 is a soft default; lots of room to send more
      // since this is one-time on connect.
      for (const past of analytics.recent(50)) {
        res.write(`data: ${JSON.stringify(past)}\n\n`);
      }
      // Backlog the current halt state if any — a TUI attaching mid-halt
      // needs to see the banner immediately without waiting for the
      // next overage hit (which won't come, because the proxy is halted).
      const haltedNow = overageGuard.state();
      if (haltedNow) {
        res.write(`event: overage_halt\ndata: ${JSON.stringify(haltedNow)}\n\n`);
      }
      // Live tail — request records on default 'message' event, halt /
      // warn / resume on named events so the TUI can route on event type
      // without changing the existing record shape.
      const onRecord = (r: RequestRecord) => {
        // Use try/catch so a broken socket (peer hung up between events)
        // doesn't crash the request hot-path — Analytics already wraps
        // its emit in try/catch but the .write itself can also throw.
        try { res.write(`data: ${JSON.stringify(r)}\n\n`); } catch { /* ignored */ }
      };
      const onHalt = (state: HaltState) => {
        try { res.write(`event: overage_halt\ndata: ${JSON.stringify(state)}\n\n`); } catch { /* ignored */ }
      };
      const onWarn = (state: HaltState) => {
        try { res.write(`event: overage_warn\ndata: ${JSON.stringify(state)}\n\n`); } catch { /* ignored */ }
      };
      const onResume = (info: { reason: string; previousSince: number }) => {
        try { res.write(`event: overage_resume\ndata: ${JSON.stringify(info)}\n\n`); } catch { /* ignored */ }
      };
      analytics.on('record', onRecord);
      overageGuard.on('halt', onHalt);
      overageGuard.on('warn', onWarn);
      overageGuard.on('resume', onResume);
      // Heartbeat every 25s — SSE comments are ignored by clients but
      // keep middle-boxes (CDNs, dev-proxies) from closing the pipe.
      const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* ignored */ }
      }, 25_000);
      heartbeat.unref?.();
      req.on('close', () => {
        analytics.off('record', onRecord);
        overageGuard.off('halt', onHalt);
        overageGuard.off('warn', onWarn);
        overageGuard.off('resume', onResume);
        clearInterval(heartbeat);
      });
      return;
    }

    // POST /admin/resume — clear overage-guard halt state (v4.1, dario#288).
    // Idempotent: returns 200 with `wasHalted: false` if the proxy is
    // already running normally. Auth gating is the same as every other
    // endpoint (loopback-bind by default; DARIO_API_KEY needed for
    // non-loopback). GET returns the current state for read-only queries.
    if (urlPath === '/admin/resume' && req.method === 'GET') {
      const state = overageGuard.state();
      res.writeHead(200, { ...JSON_HEADERS, 'Access-Control-Allow-Origin': corsOrigin });
      res.end(JSON.stringify({
        halted: state !== null,
        state,
        config: overageGuard.config(),
      }));
      return;
    }
    if (urlPath === '/admin/resume' && req.method === 'POST') {
      const wasHalted = overageGuard.state() !== null;
      overageGuard.clear('manual');
      res.writeHead(200, { ...JSON_HEADERS, 'Access-Control-Allow-Origin': corsOrigin });
      res.end(JSON.stringify({
        ok: true,
        wasHalted,
        resumedAt: new Date().toISOString(),
      }));
      return;
    }

    if (urlPath === '/v1/models' && req.method === 'GET') {
      requestCount++;
      // Upstream-autodetected catalog (TTL-cached, baked fallback — never
      // throws). [1m] variants come from the shared long-context rule, so
      // every family advertises its 1M form the same way.
      const catalog = await getModelCatalog(catalogDeps);
      const body = JSON.stringify(buildOpenAIModelsList(withLongContextVariants(catalog.bases)));
      res.writeHead(200, { ...JSON_HEADERS, 'Access-Control-Allow-Origin': corsOrigin });
      res.end(body);
      return;
    }

    // Detect OpenAI-format requests
    const isOpenAI = urlPath === '/v1/chat/completions';

    // Allowlisted API paths — only these are proxied (prevents SSRF).
    // count_tokens forwards thin (no template injection) — see resolveProxyTarget.
    const route = resolveProxyTarget(urlPath, isOpenAI);
    if (!route) { res.writeHead(403, JSON_HEADERS); res.end(ERR_FORBIDDEN); return; }
    const targetBase = route.target;
    const isCountTokens = route.thin;
    if (req.method !== 'POST') { res.writeHead(405, JSON_HEADERS); res.end(ERR_METHOD); return; }

    // Overage-guard halt check (v4.1, dario#288). Subscribers should never
    // see a single `representative-claim: overage` response during normal
    // operation; one means traffic is being reclassified to per-token
    // billing. Block upstream forwarding with a 503 + Anthropic-shaped
    // error body until the user runs `dario resume` or the cooldown
    // auto-expires. Health / status / analytics / admin endpoints above
    // bypass this check intentionally — the TUI needs them to surface
    // the halt and the user needs /admin/resume to clear it.
    if (overageGuard.isHalted()) {
      requestCount++;
      const state = overageGuard.state()!;
      writeLogLine(logFileStream, {
        ts: new Date().toISOString(), req: requestCount,
        method: req.method ?? '', path: urlPath, status: 503, reject: 'overage-halt',
      });
      res.writeHead(503, { ...JSON_HEADERS, 'Access-Control-Allow-Origin': corsOrigin });
      res.end(JSON.stringify(buildHaltErrorBody(state)));
      return;
    }

    // Proxy to Anthropic (with concurrency control). The bounded queue
    // replaces the v3.30.x-and-earlier unbounded semaphore — dario#80. A
    // queue-full condition returns an explicit 429 with a `"queue-full"`
    // marker in the body; a queue-timeout returns 504 with `"queue-timeout"`.
    try {
      await queue.acquire();
    } catch (err) {
      if (err instanceof QueueFullError) {
        writeLogLine(logFileStream, {
          ts: new Date().toISOString(), req: requestCount,
          method: req.method ?? '', path: urlPath, status: 429, reject: 'queue-full',
        });
        res.writeHead(429, JSON_HEADERS);
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `dario queue full — ${queue.maxConcurrent} concurrent + ${queue.maxQueued} queued already in flight. Tune --max-concurrent / --max-queued, or reduce client-side concurrency. (dario#80)`,
          },
        }));
        return;
      }
      if (err instanceof QueueTimeoutError) {
        writeLogLine(logFileStream, {
          ts: new Date().toISOString(), req: requestCount,
          method: req.method ?? '', path: urlPath, status: 504, reject: 'queue-timeout',
        });
        res.writeHead(504, JSON_HEADERS);
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'timeout_error',
            message: `dario queue timeout — request waited longer than ${queue.queueTimeoutMs}ms for a concurrency slot. Tune --queue-timeout, or reduce client-side concurrency. (dario#80)`,
          },
        }));
        return;
      }
      throw err;
    }
    // Hoisted so the finally block can clean up whatever was set.
    let upstreamTimeout: ReturnType<typeof setTimeout> | null = null;
    let onClientClose: (() => void) | null = null;
    type UpstreamAbortReason = 'timeout' | 'client_closed' | 'sse_overflow' | null;
    let upstreamAbortReason = null as UpstreamAbortReason;
    // Hoisted so the catch can include them in the request log line. The
    // body-parsing block below assigns these once the request is parsed;
    // before that point they remain at their initial values, which is
    // also exactly what we want to log on early-failure paths.
    let requestModel = '';
    let detectedClientForLog: string | undefined;
    let preserveToolsEffective: boolean = Boolean(opts.preserveTools);
    try {
      // Select an account by headroom (v5.0: the pool is the one credential
      // model, so every OAuth request selects from it — a plain `dario login`
      // is a pool of one). Upstream-api-key mode is the sole path with no pool
      // account. Inside-request 429/auth failover retries the next-best account
      // before surfacing an error to the client (see the dispatch loop below).
      let poolAccount: PoolAccount | null = null;
      let accessToken: string;
      if (upstreamApiKey) {
        // Per-token API-key mode: no OAuth, no pool selection. `poolAccount`
        // stays null, so every pool-failover retry below is skipped; the
        // x-api-key is set on the outbound headers instead of a Bearer.
        accessToken = '';
      } else {
        // Pool is the one credential model (v5.0): a plain `dario login` is a
        // pool of one, so every OAuth request selects from the pool.
        poolAccount = pool.select();
        if (!poolAccount) {
          // Two distinct empty-selection cases (#599): the pool has no accounts
          // at all (headless admin bootstrap — nothing added yet), vs. it has
          // accounts but all are rate-limited / in auth cool-down. Give each a
          // truthful, actionable message so a headless operator isn't told
          // "rate-limited" when they simply haven't added an account.
          res.writeHead(503, JSON_HEADERS);
          res.end(JSON.stringify(
            pool.size === 0
              ? {
                  error: 'No account configured',
                  message: adminEnabled
                    ? 'dario is running in admin mode with no account yet. Add one via POST /admin/login/start, then retry.'
                    : 'No accounts available. Run `dario login`, or add accounts with `dario accounts add`.',
                }
              : {
                  error: 'No accounts available in pool',
                  message: 'all accounts are rate-limited or in auth cool-down; retry shortly',
                },
          ));
          return;
        }
        accessToken = poolAccount.accessToken;
      }
      // Client-side session key (constant per request) for the rotation registry
      // — consulted at body-build, at the outbound header, and on each mid-request
      // failover rewrite so all three agree on the selected account's session.
      const clientSessionKey = (req.headers['x-session-id'] as string | undefined)
        ?? (req.headers['x-client-session-id'] as string | undefined);

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
      //
      // MODEL_ALIASES resolution (v3.36): on the claude/anthropic prefix path,
      // resolve short names (`opus`/`sonnet`/`haiku`) to canonical Anthropic
      // model IDs at request time. Without this, `claude:opus` would forward
      // `model: "opus"` upstream and Anthropic 400's it. The CLI parser
      // (--model=opus) already does this at startup; the request-time path
      // didn't until now. Important for the Cursor BYOK workaround in
      // dario#190 where users have to use a colon-prefix to dodge Cursor's
      // built-in `claude-*` name collision (Cursor reroutes any name it
      // recognizes through its own Anthropic gateway, bypassing localhost).
      let forcedProvider: 'openai' | 'claude' | null = cliProviderOverride;
      let requestEffort: EffortValue | undefined; // dario#419 — per-request effort parsed from a model-name suffix (model:high / model-high)
      // Parsed body, shared between the provider-prefix detection below and the
      // template-build block further down so the same bytes are not JSON.parsed
      // twice per request (#642-audit). Mutations in the prefix block re-serialize
      // `body` FROM this object, so it always represents the current body.
      let parsedBody: Record<string, unknown> | null = null;
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          parsedBody = parsed;
          const rawModel = (parsed.model as string | undefined) ?? '';
          const prefix = parseProviderPrefix(rawModel);
          if (prefix) {
            forcedProvider = prefix.provider;
            // dario#419 — optional effort suffix (model:high / model-high). Claude
            // path ONLY: OpenAI backends keep their own -high/-low suffixes, so we
            // strip it before the alias lookup only when routing to the subscription.
            let providerModel = prefix.model;
            if (prefix.provider === 'claude') {
              const eff = parseEffortSuffix(providerModel);
              if (eff.effort) { requestEffort = eff.effort; providerModel = eff.model; }
            }
            const resolvedModel = prefix.provider === 'claude'
              ? resolveClaudeAlias(providerModel)
              : providerModel;
            parsed.model = resolvedModel;
            body = Buffer.from(JSON.stringify(parsed));
            if (verbose) {
              const aliasNote = resolvedModel !== providerModel ? ` (alias: ${providerModel} → ${resolvedModel})` : '';
              const effNote = requestEffort ? ` (effort: ${requestEffort})` : '';
              console.log(`[dario] provider prefix: ${rawModel} → ${prefix.provider} backend with model ${resolvedModel}${aliasNote}${effNote}`);
            }
          } else if (cliProviderOverride === 'openai' && cliModelRaw) {
            // --model=openai:<name> forces the openai backend and replaces
            // the model name server-wide. Body gets rewritten so the openai
            // route below sees the CLI-chosen model.
            parsed.model = cliModelRaw;
            body = Buffer.from(JSON.stringify(parsed));
          } else if (!isOpenAIModel(rawModel) && forcedProvider !== 'openai') {
            // dario#419 — bare Claude model name carrying an effort suffix with no
            // provider prefix (e.g. Cursor's `claude-opus-4-8-high`). OpenAI-bound
            // models are excluded so their own suffixes pass through untouched.
            const eff = parseEffortSuffix(rawModel);
            if (eff.effort) {
              requestEffort = eff.effort;
              parsed.model = eff.model;
              body = Buffer.from(JSON.stringify(parsed));
              if (verbose) console.log(`[dario] effort suffix: ${rawModel} → model ${eff.model} (effort: ${eff.effort})`);
            }
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
      // requestModel / detectedClientForLog / preserveToolsEffective are
      // declared at the outer try-scope above so the catch block can
      // include them in the request log line.
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
          // Reuse the object parsed for provider-prefix detection above — the same
          // bytes, so re-parsing is wasted work on large bodies (#642-audit). Falls
          // back to a fresh parse when the earlier block didn't run (e.g. the body
          // was not JSON, or an OpenAI-backend reroute skipped it).
          const parsed = parsedBody ?? (JSON.parse(body.toString()) as Record<string, unknown>);
          // Strip orchestration tags from messages (Aider, Cursor, etc.)
          sanitizeMessages(parsed, opts.preserveOrchestrationTags);
          // Tier-aware routing: under a forced --model, a Haiku-tier sub-agent
          // request routes to --fast-model (when set) instead of the forced
          // model, so CC's cheap sub-agents aren't silently upgraded. Inert
          // when --fast-model is unset (effectiveOverride === modelOverride).
          const incomingModel = typeof (parsed as { model?: unknown }).model === 'string' ? (parsed as { model: string }).model : '';
          const effectiveOverride = selectModelOverride(incomingModel, modelOverride, fastModelOverride);
          const result = isOpenAI ? openaiToAnthropic(parsed, effectiveOverride) : (effectiveOverride ? { ...parsed, model: effectiveOverride } : parsed);
          const r = result as Record<string, unknown>;
          requestModel = (r.model as string || '').toLowerCase();
          // Suspended-model guard. Empty by default (Fable 5 returned globally
          // 2026-07-01, so nothing is suspended out of the box). Operators can
          // still suspend a family via DARIO_SUSPENDED_MODELS — e.g. a model
          // that 404s upstream — and this rejects any spelling of it up front
          // with an actionable error, before the template build / account lease
          // / forwarding, so there's nothing to unwind.
          if (requestModel && isSuspendedModel(requestModel)) {
            if (verbose) console.log(`[dario] suspended model rejected: ${requestModel} (${urlPath})`);
            res.writeHead(404, JSON_HEADERS);
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'not_found_error',
                message: `Model "${requestModel}" is suspended in this dario instance via DARIO_SUSPENDED_MODELS. Use claude-opus-4-8 or claude-sonnet-4-6 instead, or clear that family from DARIO_SUSPENDED_MODELS to re-enable it.`,
              },
            }));
            return;
          }
          // In passthrough mode, skip all Claude-specific injection — OAuth swap only.
          // count_tokens also forwards thin (see resolveProxyTarget) — the endpoint
          // counts the CLIENT's own prompt, so template injection would distort it.
          if (!passthrough && !isCountTokens) {
            // ── Template replay: replace the entire request with a CC template ──
            // Instead of transforming signals one by one, we build a new request
            // from CC's exact template and inject only the conversation content.
            // The upstream sees a genuine CC request structure.

            const userMsg = extractFirstUserMessage(r);
            // Emit a cch token only for versions we hold a calibrated seed for
            // (stampCch overwrites this placeholder with the deterministic value
            // at serialize time). Uncalibrated versions omit cch, matching
            // current Claude Code, which sends none. dario#528.
            const cch = hasCchSeed(cliVersion) ? computeCch() : null;
            const billingTag = buildBillingTag(cliVersion, cch);
            // Plain 5m ephemeral, matching real CC (see CC_CACHE_CONTROL / dario#678).
            const CACHE_EPHEMERAL = CC_CACHE_CONTROL;

            // Session stickiness: rebind the pre-selected pool account to
            // whatever the sticky-key resolver picks. If this is a new
            // conversation the key binds to the current best account
            // (no-op swap in most cases). If this is a follow-up turn of
            // an existing conversation the key resolves to the account
            // that already has the Anthropic prompt cache warmed for it.
            // Rotating off mid-session costs cache-create on every turn.
            stickyKey = computeStickyKey(userMsg);
            if (stickyKey) {
              const preferred = pool.selectSticky(stickyKey, modelFamily(requestModel));
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
            // in its own right. One mechanism now (v5.0): the rotation registry
            // keyed by the selected account (see resolveOutboundSession).
            {
              const assigned = resolveOutboundSession(poolAccount, clientSessionKey);
              preBodySessionId = assigned.sessionId;
              SESSION_ID = assigned.sessionId;
              if (verbose && assigned.rotated && assigned.reason !== 'rotate-new') {
                console.log(`[dario] #${requestCount} session: rotate (${assigned.reason})${poolAccount ? ` [${poolAccount.alias}]` : ''}`);
              }
            }
            // deviceId/accountUuid come from the selected account (or the local
            // Claude identity in api-key mode); sessionId is the registry value
            // resolved just above so body and header agree.
            const idSource = poolAccount ? poolAccount.identity : identity;
            const bodyIdentity = { deviceId: idSource.deviceId, accountUuid: idSource.accountUuid, sessionId: preBodySessionId };
            const { body: ccBody, toolMap, detectedClient, unmappedTools, genuineCC } = buildCCRequest(
              r, billingTag, CACHE_EPHEMERAL,
              bodyIdentity,
              {
                preserveTools: opts.preserveTools ?? false,
                hybridTools: opts.hybridTools ?? false,
                mergeTools: opts.mergeTools ?? false,
                noAutoDetect: opts.noAutoDetect ?? false,
                effort: requestEffort ?? opts.effort,
                maxTokens: opts.maxTokens,
                systemPrompt: opts.systemPrompt,
                skipFields,
                honorClientThinking: opts.honorClientThinking ?? false,
                preserveOutputFormat: opts.preserveOutputFormat ?? false,
              },
            );
            // Prompt-cache the tools + conversation prefix (the system prompt
            // is already cached in ccBody's system blocks). Mirrors CC's cache
            // breakpoints so a long session doesn't re-bill them as fresh input
            // every turn and burn the Max 5h/7d window — the cause of the
            // "sessions wall in minutes through dario but not CC" report.
            // Opt-out: DARIO_SKIP_FIELDS=prompt_cache.
            if (!skipFields?.has('prompt_cache')) {
              applyCcPromptCaching(ccBody, CACHE_EPHEMERAL);
            }
            detectedClientForLog = detectedClient;
            // genuineCC → the client's own tool schemas went out verbatim, so
            // the response path must not rewrite tool names either.
            preserveToolsEffective = Boolean(opts.preserveTools)
              || Boolean(genuineCC)
              || (Boolean(detectedClient) && !opts.hybridTools && !opts.mergeTools);

            if (genuineCC && !ccPassthroughLogged) {
              ccPassthroughLogged = true;
              console.log('[dario] genuine Claude Code client — system + tools forwarded verbatim (byte-faithful passthrough)');
            }

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

            // Surface tool substitution. When a non-CC client routes
            // tools we don't have in TOOL_MAP and neither auto-detect
            // nor an explicit flag flipped us into preserve-tools, the
            // unmapped tools get distributed onto CC fallback slots —
            // the model upstream sees "Glob"/"Read"/etc. and the
            // client's own tool surface is silently rewritten on the
            // response path. That rewrite is correct for
            // schema-compatible cases but invisible to operators who
            // didn't expect it. One-line warn the first time we see a
            // non-empty unmapped set per (client family, mapping mode)
            // — same de-dupe key shape as the auto-detect line so a
            // mixed-traffic proxy doesn't spam.
            const subKey = `${detectedClient ?? 'unknown'}:${preserveToolsEffective ? 'preserve' : 'remap'}`;
            if (
              unmappedTools.length > 0
              && !preserveToolsEffective
              && !toolSubLogged.has(subKey)
            ) {
              toolSubLogged.add(subKey);
              const totalTools = (Array.isArray(r.tools) ? r.tools.length : 0);
              const sample = unmappedTools.slice(0, 5).join(', ');
              const more = unmappedTools.length > 5 ? `, +${unmappedTools.length - 5} more` : '';
              console.log(`[dario] tool substitution: ${unmappedTools.length}/${totalTools} client tool${unmappedTools.length === 1 ? '' : 's'} not in TOOL_MAP — remapped onto CC fallback slots (${sample}${more}). Pass --preserve-tools to forward your schemas verbatim instead.`);
            }

            // MCP tools (mcp__<server>__<tool>) forward verbatim in default
            // mode — real CC advertises session-attached MCP schemas as-is,
            // so this is passthrough, not substitution. Verbose-only note so
            // operators can confirm their MCP surface survived; same de-dupe
            // as the substitution warn.
            if (verbose && !preserveToolsEffective && !mcpPassthroughLogged.has(subKey)) {
              const mcpCount = Array.isArray(r.tools)
                ? (r.tools as Array<{ name?: unknown }>).filter((t) => isMcpToolName(t?.name)).length
                : 0;
              if (mcpCount > 0) {
                mcpPassthroughLogged.add(subKey);
                console.log(`[dario] ${mcpCount} MCP tool${mcpCount === 1 ? '' : 's'} (mcp__*) forwarded verbatim alongside CC's native set`);
              }
            }

            // Store tool map for response reverse-mapping
            ccToolMap = toolMap;

            // Replace request body entirely with CC template
            for (const key of Object.keys(r)) delete r[key];
            Object.assign(r, ccBody);

            // `X[1m]` is a client-side LABEL, never a valid wire id — real CC
            // sends the BASE model id plus the `context-1m-2025-08-07` beta
            // (live capture 2026-06-09, CC v2.1.170 with --model
            // 'claude-fable-5[1m]': wire model was 'claude-fable-5').
            // Forwarding the literal `[1m]` id upstream 404s ("model: …[1m]"
            // not_found) on every family. Strip it here; the context-1m beta
            // is already in the template beta set (and the existing
            // long-context billing auto-retry still governs accounts that
            // can't use it). requestModel keeps the [1m] form so model-aware
            // logic (family buckets, fable beta/effort) sees the user intent.
            r.model = stripContext1mTag(r.model as string);
          } else if (isCountTokens && typeof r.model === 'string') {
            // Thin count_tokens forward still normalizes the model id —
            // the literal `[1m]` label 404s upstream here exactly as it
            // does on /v1/messages.
            r.model = stripContext1mTag(r.model);
          }
          // Effort capability clamp — when a prior request taught us this
          // model's supported effort set (autodetected catalogs expose
          // models that predate newer tiers), rewrite output_config.effort
          // up front instead of re-paying the 400 round-trip. In-place value
          // mutation: field order (a fingerprint surface) is untouched.
          if (typeof r.model === 'string') {
            const supportedEfforts = effortSupportByModel.get(r.model);
            const oc = r.output_config as { effort?: unknown } | undefined;
            if (supportedEfforts && oc && typeof oc.effort === 'string' && !supportedEfforts.includes(oc.effort)) {
              if (supportedEfforts.length === 0) {
                // HARD rejection learned — this model has no effort support at
                // all; strip the field (no tier to clamp to). See the retry
                // branch below + isEffortParamUnsupported.
                delete oc.effort;
                if (Object.keys(oc).length === 0) delete r.output_config;
              } else {
                oc.effort = bestSupportedEffort(supportedEfforts);
              }
            }
            // max_tokens cap clamp — when a prior request taught us this model's
            // per-model output cap (older models cap below dario's
            // DEFAULT_MAX_TOKENS pin), clamp up front instead of re-paying the
            // 400. In-place value mutation: field order (a fingerprint) is kept.
            const maxTokensCap = maxTokensCapByModel.get(r.model);
            if (maxTokensCap !== undefined && typeof r.max_tokens === 'number' && r.max_tokens > maxTokensCap) {
              r.max_tokens = maxTokensCap;
            }
          }
          // dario#528: overwrite the random cch placeholder with the real
          // deterministic value for Claude Code versions whose seed we've
          // reverse-engineered. stampCch hashes a projection of THIS final body
          // (so it must run after every mutation above) and replaces the cch
          // anchored to the billing tag — never a cch quoted in conversation
          // content. No-op for uncalibrated versions — but those also carry no
          // cch token to begin with (buildBillingTag omits it without a seed,
          // matching current Claude Code), so there is nothing to stamp and
          // nothing stale is shipped. Only the template-replay path is stamped —
          // passthrough / count_tokens forward the client's body (and its own
          // cch) verbatim. Reversible kill-switch: DARIO_CCH=random.
          let outboundText = JSON.stringify(r);
          if (!passthrough && !isCountTokens && process.env.DARIO_CCH !== 'random') {
            outboundText = stampCch(outboundText, cliVersion);
          }
          finalBody = Buffer.from(outboundText);
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
      if (passthrough || isCountTokens) {
        // Passthrough (and thin count_tokens): only add oauth beta,
        // forward client betas as-is — no template beta set.
        beta = 'oauth-2025-04-20';
        if (clientBeta) beta += ',' + clientBeta;
      } else {
        // Beta set sourced from the live template (schema v2). Bundled
        // snapshots predating v3.19 leave anthropic_beta undefined, so fall
        // back to the v2.1.104 flag set.
        // context-1m requires Extra Usage — if it 400s, we auto-retry without
        // it, and cache the rejection so subsequent requests on this account
        // skip context-1m entirely (dario#36).
        const acctKey = poolAccount?.alias ?? ACCOUNT_KEY_APIKEY;
        const skipContext1m = context1mUnavailable.has(acctKey);
        // Model-conditional betas (fable fallback-credit; [1m] context-1m),
        // mirroring real CC — see betaForModel. betaWithoutContext1m still
        // strips a base-set context-1m for legacy bundles that carry it.
        beta = betaForModel(skipContext1m ? betaWithoutContext1m : betaBase, requestModel, skipContext1m);
        if (clientBeta) {
          const baseSet = new Set(beta.split(','));
          const filtered = filterBillableBetas(clientBeta)
            .split(',').filter(b => b.length > 0 && !baseSet.has(b)).join(',');
          if (filtered) beta += ',' + filtered;
        }
        // Operator-pinned passthrough betas. Always forwarded — bypasses
        // the billable-beta filter, bypasses the "not in client's
        // request" gate. The per-account rejection cache below still
        // applies, so a pinned flag the upstream 400's gets dropped on
        // the retry rather than re-sent forever (the cache survives the
        // operator's pin because the upstream's no is final until a
        // tier change resets it).
        if (passthroughBetas.size > 0) {
          const baseSet = new Set(beta.split(','));
          const toAdd = [...passthroughBetas].filter((b) => !baseSet.has(b));
          if (toAdd.length > 0) beta += ',' + toAdd.join(',');
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
      // for the pure delay calculators. Three layers, all defaults preserve
      // v3.37.20 behaviour:
      //   1. pacingDelay      — floor on inter-request distance (always on,
      //                         500ms default since v3.24).
      //   2. thinkTimeDelay   — post-response read-time, proportional to
      //                         the previous response's output tokens.
      //                         Opt-in via --think-time-* flags.
      //   3. sessionStartDelay — one-shot startup latency on the first
      //                          request of a session (lastResponseTime===0).
      //                          Opt-in via --session-start-* flags.
      // We take the max because each layer enforces an independent floor
      // — waiting longer satisfies all of them, so we never need to sum.
      const nowForPacing = Date.now();
      const pacingDelay = computePacingDelay(nowForPacing, lastRequestTime, pacingCfg);
      const thinkDelay = thinkTimeEnabled
        ? computeThinkTimeDelay(nowForPacing, lastResponseTime, lastResponseTokens, thinkTimeCfg)
        : 0;
      const sessionStartDelay = (sessionStartEnabled && lastResponseTime === 0 && lastRequestTime === 0)
        ? computeSessionStartDelay(sessionStartCfg)
        : 0;
      const totalDelay = Math.max(pacingDelay, thinkDelay, sessionStartDelay);
      if (totalDelay > 0) {
        await new Promise(r => setTimeout(r, totalDelay));
      }
      lastRequestTime = Date.now();

      // Session ID: resolved through the rotation registry keyed by the selected
      // account (src/session-rotation.ts), applying the configured idle / jitter
      // / max-age / per-client policy. The template-build path resolves it
      // earlier so the CC body's metadata.session_id and this outbound
      // x-claude-code-session-id header agree; preBodySessionId holds that value.
      // In passthrough mode (no template build) preBodySessionId is unset, so
      // the registry is consulted here instead.
      let outboundSessionId: string;
      if (preBodySessionId !== undefined) {
        outboundSessionId = preBodySessionId;
      } else {
        const assigned = resolveOutboundSession(poolAccount, clientSessionKey);
        outboundSessionId = assigned.sessionId;
        SESSION_ID = assigned.sessionId;
        if (verbose && assigned.rotated && assigned.reason !== 'rotate-new') {
          console.log(`[dario] #${requestCount} session: rotate (${assigned.reason})${poolAccount ? ` [${poolAccount.alias}]` : ''}`);
        }
      }

      const headers: Record<string, string> = {
        ...staticHeaders,
        ...upstreamAuthHeaders(upstreamApiKey, accessToken),
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
        if (poolAccount) {
          const snapshot = parseRateLimits(upstream.headers);
          if (upstream.status === 429) {
            pool.markRejected(poolAccount.alias, snapshot);
          } else {
            pool.updateRateLimits(poolAccount.alias, snapshot);
          }
          // First-sight detector for per-model rate-limit buckets. Anthropic
          // ships these unannounced — e.g. `7d_sonnet-utilization` appeared
          // around 2026-04-25 — and verbose-mode users want a heads-up the
          // first time a new family shows up so they can decide whether to
          // bump dario's expectations. Pure logging; the routing path
          // already handles arbitrary family keys (see pool.computeHeadroom).
          for (const family of Object.keys(snapshot.perModel7d)) {
            if (!seenPerModelBuckets.has(family)) {
              seenPerModelBuckets.add(family);
              if (verbose) {
                console.log(`[dario] new per-model rate-limit bucket observed: 7d_${family} (util=${snapshot.perModel7d[family]?.toFixed(2)})`);
              }
            }
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
          const acctKey = poolAccount?.alias ?? ACCOUNT_KEY_APIKEY;
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
          if (poolAccount) {
            const retrySnapshot = parseRateLimits(upstream.headers);
            if (upstream.status === 429) {
              pool.markRejected(poolAccount.alias, retrySnapshot);
            } else {
              pool.updateRateLimits(poolAccount.alias, retrySnapshot);
            }
          }
        } else if (upstream.status === 400 && parseEffortRejection(peekedBody) && finalBody) {
          // Effort-capability rejection — the model predates the requested
          // effort tier (e.g. opus-4-5 + a DARIO_EFFORT=max pin; surfaced by
          // the autodetected catalog). Clamp output_config.effort to the
          // strongest level the error says the model supports, retry once,
          // and cache the supported set per model so the up-front clamp
          // handles every later request without the round-trip.
          const rejection = parseEffortRejection(peekedBody)!;
          const clamped = bestSupportedEffort(rejection.supported);
          let retried = false;
          try {
            const rb = JSON.parse(finalBody.toString('utf8')) as Record<string, unknown>;
            const wireModel = typeof rb.model === 'string' ? rb.model : '';
            const oc = rb.output_config as { effort?: unknown } | undefined;
            if (wireModel && oc && typeof oc.effort === 'string') {
              const firstRejection = !effortSupportByModel.has(wireModel);
              effortSupportByModel.set(wireModel, rejection.supported);
              if (verbose && firstRejection) console.log(`[dario] #${requestCount} effort '${rejection.rejected}' rejected by ${wireModel} — retrying with '${clamped}' (supported set cached per model)`);
              oc.effort = clamped; // in-place value mutation — field order untouched
              finalBody = Buffer.from(JSON.stringify(rb));
              const retry = await fetch(targetBase, {
                method: req.method ?? 'POST',
                headers: passthrough ? headers : orderHeadersForOutbound(headers),
                body: new Uint8Array(finalBody),
                signal: upstreamAbort.signal,
              });
              upstream = retry;
              peekedBody = null;
              retried = true;
              if (poolAccount) {
                const retrySnapshot = parseRateLimits(upstream.headers);
                if (upstream.status === 429) {
                  pool.markRejected(poolAccount.alias, retrySnapshot);
                } else {
                  pool.updateRateLimits(poolAccount.alias, retrySnapshot);
                }
              }
            }
          } catch { /* body not JSON — forward the original 400 below */ }
          if (!retried) {
            // Couldn't rebuild the body (no output_config.effort / not JSON)
            // — the upstream body is already consumed, so forward it here;
            // the chain's terminal 400 branch won't run for us.
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
        } else if (upstream.status === 400 && isEffortParamUnsupported(peekedBody) && finalBody) {
          // HARD effort rejection — this model has no output_config.effort
          // support at all (it predates the parameter; e.g. opus-4-1 /
          // sonnet-4-5 surfaced by the autodetected catalog under the box's
          // DARIO_EFFORT=max pin). Unlike the SOFT level rejection above there
          // is no supported tier to clamp to, so STRIP the field, retry once,
          // and cache an EMPTY supported set per model so the up-front consult
          // strips it on every later request without re-paying the round-trip.
          let retried = false;
          try {
            const rb = JSON.parse(finalBody.toString('utf8')) as Record<string, unknown>;
            const wireModel = typeof rb.model === 'string' ? rb.model : '';
            const oc = rb.output_config as { effort?: unknown } | undefined;
            if (wireModel && oc && typeof oc.effort === 'string') {
              const firstRejection = !effortSupportByModel.has(wireModel);
              effortSupportByModel.set(wireModel, []); // empty set = no effort support → strip
              if (verbose && firstRejection) console.log(`[dario] #${requestCount} effort parameter unsupported by ${wireModel} — retrying without output_config.effort (stripped for this model going forward)`);
              delete oc.effort;
              if (Object.keys(oc).length === 0) delete rb.output_config;
              finalBody = Buffer.from(JSON.stringify(rb));
              const retry = await fetch(targetBase, {
                method: req.method ?? 'POST',
                headers: passthrough ? headers : orderHeadersForOutbound(headers),
                body: new Uint8Array(finalBody),
                signal: upstreamAbort.signal,
              });
              upstream = retry;
              peekedBody = null;
              retried = true;
              if (poolAccount) {
                const retrySnapshot = parseRateLimits(upstream.headers);
                if (upstream.status === 429) {
                  pool.markRejected(poolAccount.alias, retrySnapshot);
                } else {
                  pool.updateRateLimits(poolAccount.alias, retrySnapshot);
                }
              }
            }
          } catch { /* body not JSON — forward the original 400 below */ }
          if (!retried) {
            // Couldn't rebuild the body — forward the upstream 400 (already consumed).
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
        } else if (upstream.status === 400 && parseMaxTokensRejection(peekedBody) !== null && finalBody) {
          // max_tokens-cap rejection — dario's DEFAULT_MAX_TOKENS pin exceeds
          // this (older) model's per-model output cap (e.g. opus-4-1 caps at
          // 32000 where newer models allow 64000). Clamp max_tokens to the cap
          // the error reports, retry once, and cache per model so the up-front
          // consult clamps every later request without the round-trip.
          const cap = parseMaxTokensRejection(peekedBody)!;
          let retried = false;
          try {
            const rb = JSON.parse(finalBody.toString('utf8')) as Record<string, unknown>;
            const wireModel = typeof rb.model === 'string' ? rb.model : '';
            if (wireModel && typeof rb.max_tokens === 'number' && rb.max_tokens > cap) {
              const firstRejection = !maxTokensCapByModel.has(wireModel);
              maxTokensCapByModel.set(wireModel, cap);
              if (verbose && firstRejection) console.log(`[dario] #${requestCount} max_tokens ${rb.max_tokens} exceeds ${wireModel} cap ${cap} — retrying clamped (cached per model)`);
              rb.max_tokens = cap; // in-place value mutation — field order untouched
              finalBody = Buffer.from(JSON.stringify(rb));
              const retry = await fetch(targetBase, {
                method: req.method ?? 'POST',
                headers: passthrough ? headers : orderHeadersForOutbound(headers),
                body: new Uint8Array(finalBody),
                signal: upstreamAbort.signal,
              });
              upstream = retry;
              peekedBody = null;
              retried = true;
              if (poolAccount) {
                const retrySnapshot = parseRateLimits(upstream.headers);
                if (upstream.status === 429) {
                  pool.markRejected(poolAccount.alias, retrySnapshot);
                } else {
                  pool.updateRateLimits(poolAccount.alias, retrySnapshot);
                }
              }
            }
          } catch { /* body not JSON — forward the original 400 below */ }
          if (!retried) {
            // Couldn't rebuild the body — forward the upstream 400 (already consumed).
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
        } else if (isLongContextError) {
          // Cache the rejection so future requests on this account skip
          // context-1m up front instead of re-paying the 400/429 round-trip.
          const acctKey = poolAccount?.alias ?? ACCOUNT_KEY_APIKEY;
          const firstRejection = !context1mUnavailable.has(acctKey);
          context1mUnavailable.add(acctKey);
          if (verbose && firstRejection) console.log(`[dario] #${requestCount} context-1m rejected (${upstream.status}) — retrying without it (cached for session)`);
          // Strip both long-context betas: context-1m is the primary, but
          // context-management can trigger the same rejection on models (e.g.
          // Haiku) that don't support either with OAuth subscription auth.
          const LONG_CONTEXT_BETAS = new Set(['context-1m-2025-08-07', 'context-management-2025-06-27']);
          const reducedBeta = beta.split(',').filter((t) => !LONG_CONTEXT_BETAS.has(t)).join(',');
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
          if (poolAccount) {
            const retrySnapshot = parseRateLimits(upstream.headers);
            if (upstream.status === 429) {
              pool.markRejected(poolAccount.alias, retrySnapshot);
            } else {
              pool.updateRateLimits(poolAccount.alias, retrySnapshot);
            }
          }
        } else if (upstream.status === 429) {
          // Not a context-1m issue — try pool failover before surfacing to client
          if (poolAccount) {
            const nextAccount = pool.selectExcluding(triedAliases, modelFamily(requestModel));
            if (nextAccount) {
              triedAliases.add(nextAccount.alias);
              poolAccount = nextAccount;
              accessToken = nextAccount.accessToken;
              headers['Authorization'] = `Bearer ${accessToken}`;
              headers['x-claude-code-session-id'] = resolveOutboundSession(nextAccount, clientSessionKey).sessionId;
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
          // v4: analytics is always-on. A pool account supplies the rate-limit
          // snapshot from `poolAccount.rateLimit` (already authoritative);
          // api-key mode (no pool account) parses it from the upstream response
          // headers on the spot so the TUI's Hits feed shows the same
          // bucket / utilization fields either way.
          {
            const rl = poolAccount?.rateLimit ?? parseRateLimits(upstream.headers);
            analytics.record({
              timestamp: Date.now(),
              account: poolAccount?.alias ?? ACCOUNT_KEY_APIKEY,
              model: requestModel,
              inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
              claim: rl.claim, util5h: rl.util5h, util7d: rl.util7d, overageUtil: rl.overageUtil,
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

      // Auth failover (dario#234). 401/403 means the account's tokens are
      // server-invalidated — retrying on the same account is guaranteed to
      // fail, and the rate-limit-driven selector won't route around the
      // dead account because 401 responses don't include rate-limit
      // headers, so headroom math sees a healthy idle account. Mark the
      // cool-down here, try the next-best account, fall through to the
      // normal forwarding only if no peer is available.
      if (poolAccount && (upstream.status === 401 || upstream.status === 403)) {
        pool.markAuthFailure(poolAccount.alias);
        if (verbose) {
          console.error(`[dario] auth failure (${upstream.status}) on account "${poolAccount.alias}" — placing in cool-down and attempting failover`);
        }
        const nextAccount = pool.selectExcluding(triedAliases, modelFamily(requestModel));
        if (nextAccount) {
          triedAliases.add(nextAccount.alias);
          poolAccount = nextAccount;
          accessToken = nextAccount.accessToken;
          headers['Authorization'] = `Bearer ${accessToken}`;
          headers['x-claude-code-session-id'] = resolveOutboundSession(nextAccount, clientSessionKey).sessionId;
          pool.rebindSticky(stickyKey, nextAccount.alias);
          continue dispatchLoop;
        }
        // No peer available — fall through to normal forwarding so the
        // client sees the upstream's 401/403. Don't swallow the error.
      }

      // Enrich 429 errors with rate limit details from headers (Anthropic only returns "Error")
      if (upstream.status === 429) {
        // Try pool failover before surfacing to client
        if (poolAccount) {
          const nextAccount = pool.selectExcluding(triedAliases, modelFamily(requestModel));
          if (nextAccount) {
            triedAliases.add(nextAccount.alias);
            poolAccount = nextAccount;
            accessToken = nextAccount.accessToken;
            headers['Authorization'] = `Bearer ${accessToken}`;
            headers['x-claude-code-session-id'] = resolveOutboundSession(nextAccount, clientSessionKey).sessionId;
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
        {
          const rl = poolAccount?.rateLimit ?? parseRateLimits(upstream.headers);
          analytics.record({
            timestamp: Date.now(),
            account: poolAccount?.alias ?? ACCOUNT_KEY_APIKEY,
            model: requestModel,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
            claim: rl.claim, util5h: rl.util5h, util7d: rl.util7d, overageUtil: rl.overageUtil,
            latencyMs: Date.now() - startTime, status: 429, isStream: false, isOpenAI,
          });
        }
        res.writeHead(429, responseHeaders);
        res.end(enriched);
        return;
      }

      // Non-429 — exit dispatch loop and forward the response to client.
      // Clear the auth-failure cool-down on the responding account if
      // the upstream returned a 2xx — this account is healthy again,
      // so its consecutive-failure counter resets. dario#234.
      if (poolAccount && upstream.status >= 200 && upstream.status < 300) {
        pool.clearAuthFailure(poolAccount.alias);
      }
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
          } else if (billingClaim && SUBSCRIPTION_CLAIMS.has(billingClaim)) {
            // Any subscription-side claim (incl. *_overage_included) with no
            // overage-utilization header means $0 extra usage — same sync
            // source as the guard so this list can't drift again.
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
        // message_start / message_delta / content_block_delta SSE events as
        // they flow through. Token capture must run regardless of whether a
        // pool account is present: gating on `poolAccount` (null in api-key
        // mode) once skipped the parser entirely, so the analytics.record()
        // call below persisted zeros for input/output tokens. SDK streaming
        // clients had their token usage invisible in /analytics until the fix.
        let streamInputTokens = 0;
        let streamOutputTokens = 0;
        let streamCacheReadTokens = 0;
        let streamCacheCreateTokens = 0;
        let streamThinkingChars = 0;
        const analyticsDecoder = analytics ? new TextDecoder() : null;
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
        // Per-request OpenAI SSE translator — isolated tool-call state so
        // concurrent /v1/chat/completions streams don't cross-contaminate (#642-audit).
        const openaiTranslate = isOpenAI ? createOpenAIStreamTranslator() : null;
        // Gated writer — a no-op once the downstream client has gone away
        // in drain-on-close mode. The read loop keeps consuming so the
        // upstream sees a full-length read; writes to a closed socket are
        // suppressed to avoid EPIPE/warnings and pointless work.
        // Honor downstream backpressure (#642-audit): when res.write() returns
        // false the client's socket buffer is full, so pause the read loop until
        // it drains instead of buffering the whole (fast) upstream in memory.
        let needsDrain = false;
        const writeToClient = (chunk: Uint8Array | string) => {
          if (clientDisconnected) return;
          if (res.write(chunk) === false) needsDrain = true;
        };
        // Resolves on 'close' too, so a vanished client can't wedge the loop.
        const waitForDrain = () => new Promise<void>((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
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
                  } else if (e.type === 'content_block_delta') {
                    // Mirror the non-streaming parseUsage thinking-token
                    // heuristic: ~4 characters per token across thinking_delta
                    // events. Closer than 0, and the same formula the parser
                    // applies for buffered responses, so streaming + non-
                    // streaming numbers stay comparable.
                    const d = (e as { delta?: { type?: string; thinking?: string } }).delta;
                    if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
                      streamThinkingChars += d.thinking.length;
                    }
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
                const translated = openaiTranslate!(line);
                if (translated) writeToClient(translated);
              }
            } else if (streamMapper) {
              const out = streamMapper.feed(value);
              if (out.length > 0) writeToClient(out);
            } else {
              writeToClient(value);
            }
            // Backpressure (#642-audit): if the last writes filled the client
            // buffer, pause reading upstream until it drains.
            if (needsDrain && !clientDisconnected) {
              needsDrain = false;
              await waitForDrain();
            }
          }
          // Flush remaining buffer
          if (isOpenAI && buffer.trim()) {
            const translated = openaiTranslate!(buffer);
            if (translated) writeToClient(translated);
          }
          if (streamMapper) {
            const tail = streamMapper.end();
            if (tail.length > 0) writeToClient(tail);
          }
        } catch (err) {
          if (verbose) console.error('[dario] Stream error:', sanitizeError(err));
          // Tear down the upstream body reader deterministically on an abnormal
          // mid-stream error (e.g. a bare upstream socket reset) so the undici
          // socket is released now, not at GC (#642-audit). No-op if aborted.
          if (!upstreamAbort.signal.aborted) upstreamAbort.abort();
        }
        res.end();
        // Stamp the response-completion timestamp + token count so the
        // next request's think-time delay can model human read time.
        // Only on 2xx — error responses don't represent content the user
        // would read, and using their (often zero) output_tokens would
        // pin think time to baseMs+jitter on the next request needlessly.
        if (upstream.status >= 200 && upstream.status < 300) {
          lastResponseTime = Date.now();
          lastResponseTokens = streamOutputTokens;
        }
        {
          const rl = poolAccount?.rateLimit ?? parseRateLimits(upstream.headers);
          analytics.record({
            timestamp: Date.now(),
            account: poolAccount?.alias ?? ACCOUNT_KEY_APIKEY,
            model: requestModel,
            inputTokens: streamInputTokens, outputTokens: streamOutputTokens,
            cacheReadTokens: streamCacheReadTokens, cacheCreateTokens: streamCacheCreateTokens,
            thinkingTokens: Math.round(streamThinkingChars / 4),
            claim: rl.claim, util5h: rl.util5h, util7d: rl.util7d, overageUtil: rl.overageUtil,
            latencyMs: Date.now() - startTime, status: upstream.status, isStream: true, isOpenAI,
          });
        }
        writeLogLine(logFileStream, {
          ts: new Date().toISOString(), req: requestCount,
          method: req.method ?? '', path: urlPath,
          model: requestModel || undefined,
          status: upstream.status, latency_ms: Date.now() - startTime,
          in_tokens: streamInputTokens, out_tokens: streamOutputTokens,
          cache_read: streamCacheReadTokens, cache_create: streamCacheCreateTokens,
          claim: poolAccount?.rateLimit.claim,
          bucket: poolAccount ? billingBucketFromClaim(poolAccount.rateLimit.claim) : undefined,
          account: poolAccount?.alias,
          client: detectedClientForLog,
          preserve_tools: preserveToolsEffective,
          stream: true,
        });
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

        let bufferedUsage: ReturnType<typeof Analytics.parseUsage> | null = null;
        try {
          const parsed = JSON.parse(responseBody) as Record<string, unknown>;
          bufferedUsage = Analytics.parseUsage(parsed);
        } catch { /* malformed body — log without usage */ }

        // Stamp response-completion state for the next request's think-time
        // delay. Same 2xx-only rule as the streaming path. Falls back to 0
        // tokens when the body wasn't JSON or had no usage block — base +
        // jitter still apply but the per-token component is 0.
        if (upstream.status >= 200 && upstream.status < 300) {
          lastResponseTime = Date.now();
          lastResponseTokens = bufferedUsage?.outputTokens ?? 0;
        }

        if (bufferedUsage) {
          try {
            const rl = poolAccount?.rateLimit ?? parseRateLimits(upstream.headers);
            analytics.record({
              timestamp: Date.now(),
              account: poolAccount?.alias ?? ACCOUNT_KEY_APIKEY,
              model: bufferedUsage.model || requestModel,
              inputTokens: bufferedUsage.inputTokens, outputTokens: bufferedUsage.outputTokens,
              cacheReadTokens: bufferedUsage.cacheReadTokens, cacheCreateTokens: bufferedUsage.cacheCreateTokens,
              thinkingTokens: bufferedUsage.thinkingTokens,
              claim: rl.claim, util5h: rl.util5h, util7d: rl.util7d, overageUtil: rl.overageUtil,
              latencyMs: Date.now() - startTime, status: upstream.status, isStream: false, isOpenAI,
            });
          } catch { /* don't let analytics errors break responses */ }
        }

        writeLogLine(logFileStream, {
          ts: new Date().toISOString(), req: requestCount,
          method: req.method ?? '', path: urlPath,
          model: bufferedUsage?.model || requestModel || undefined,
          status: upstream.status, latency_ms: Date.now() - startTime,
          in_tokens: bufferedUsage?.inputTokens, out_tokens: bufferedUsage?.outputTokens,
          cache_read: bufferedUsage?.cacheReadTokens, cache_create: bufferedUsage?.cacheCreateTokens,
          claim: poolAccount?.rateLimit.claim,
          bucket: poolAccount ? billingBucketFromClaim(poolAccount.rateLimit.claim) : undefined,
          account: poolAccount?.alias,
          client: detectedClientForLog,
          preserve_tools: preserveToolsEffective,
          stream: false,
        });

        if (verbose) console.log(`[dario] #${requestCount} ${upstream.status}`);
      }
    } catch (err) {
      // Differentiate the three failure modes so each gets the right
      // response (and so we don't spam logs when clients simply drop).
      const errLogBase = {
        ts: new Date().toISOString(), req: requestCount,
        method: req.method ?? '', path: urlPath,
        model: requestModel || undefined,
        client: detectedClientForLog,
        preserve_tools: preserveToolsEffective,
      } as const;
      if (upstreamAbortReason === 'client_closed') {
        if (verbose) console.log(`[dario] #${requestCount} aborted (client disconnected)`);
        writeLogLine(logFileStream, { ...errLogBase, reject: 'client-closed' });
      } else if (upstreamAbortReason === 'timeout') {
        console.error(`[dario] #${requestCount} upstream timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`);
        if (!res.headersSent) {
          res.writeHead(504, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Upstream timeout', message: `Anthropic did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s` }));
        } else if (!res.writableEnded) {
          res.end();
        }
        writeLogLine(logFileStream, { ...errLogBase, status: 504, error: 'upstream-timeout' });
      } else {
        // Log full error server-side, return generic message to client
        console.error('[dario] Proxy error:', sanitizeError(err));
        if (!res.headersSent) {
          res.writeHead(502, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Proxy error', message: 'Failed to reach upstream API' }));
        } else if (!res.writableEnded) {
          res.end();
        }
        writeLogLine(logFileStream, { ...errLogBase, status: 502, error: sanitizeError(err) });
      }
    } finally {
      // Always clean up the upstream-abort plumbing if it was set up. The
      // setup happens after the body-read phase, so on fast-path errors
      // (413, body read timeout) these may still be null — guard accordingly.
      if (upstreamTimeout !== null) clearTimeout(upstreamTimeout);
      if (onClientClose !== null) req.off('close', onClientClose);
      queue.release();
    }
  });

  server.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Before erroring, check whether dario itself is already running on this
      // port. If it is, the user just ran `dario login` or `dario proxy` twice
      // — treat it as a no-op rather than a crash.
      try {
        const displayHost = isLoopbackHost(host) ? 'localhost' : host;
        const res = await fetch(`http://${displayHost}:${port}/health`);
        const body = await res.json() as Record<string, unknown>;
        if (body && (body.status === 'ok' || body.status === 'degraded')) {
          // The /health endpoint's `oauth` field is a status enum
          // ('healthy' | 'expired' | 'broken' | 'none') — not a token
          // and not any kind of credential. CodeQL's clear-text-logging
          // heuristic flags any logged field whose key contains "oauth",
          // so we whitelist by allow-list rather than disable the rule.
          const allowedOauthStatuses = new Set(['healthy', 'expired', 'broken', 'none', 'degraded']);
          const rawOauth = typeof body.oauth === 'string' ? body.oauth : '';
          const oauthStatusLabel = allowedOauthStatuses.has(rawOauth) ? rawOauth : 'unknown';
          const requestsServed = typeof body.requests === 'number' ? body.requests : 0;
          console.log('');
          console.log(`  dario — already running on http://${displayHost}:${port}`);
          console.log('');
          console.log(`  OAuth: ${oauthStatusLabel}  |  requests served: ${requestsServed}`);
          console.log('');
          console.log('  Usage:');
          console.log(`    ANTHROPIC_BASE_URL=http://${displayHost}:${port}`);
          console.log('    ANTHROPIC_API_KEY=dario');
          console.log('');
          process.exit(0);
        }
      } catch {
        // Not dario — fall through to the generic error.
      }
      console.error(`[dario] Port ${port} is already in use by another process.`);
      console.error(`[dario] Free it with: kill $(lsof -ti:${port}) or change the port with --port <n>`);
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

  // Strict-template fail-closed mode. Template must be from a live capture
  // (not the bundled snapshot) and must not have drifted from the installed
  // CC. Operator opts in via --strict-template / DARIO_STRICT_TEMPLATE=1.
  // Same philosophy as --strict-tls: make the unsafe state require intent.
  // dario#77.
  if (opts.strictTemplate) {
    if (CC_TEMPLATE._source === 'bundled') {
      console.error(`[dario] Refusing to start proxy in --strict-template mode: template source is 'bundled' (no live capture available).`);
      console.error(`[dario] Fix: run \`claude --print hello\` once so dario can capture the live template, then retry. Or drop --strict-template if the bundled fingerprint is acceptable for this run.`);
      process.exit(1);
    }
    if (drift.drifted) {
      console.error(`[dario] Refusing to start proxy in --strict-template mode: template drift detected (${drift.message}).`);
      console.error(`[dario] Fix: rm ~/.dario/cc-template.live.json and retry (the next capture will be against your current CC), or drop --strict-template if the drift is acceptable.`);
      process.exit(1);
    }
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
  //
  // Skipped entirely under --no-live-capture / DARIO_NO_LIVE_CAPTURE=1 —
  // the operator has opted into a bundled-only shape (air-gapped runs,
  // reproducible-build CI, deliberate pinning). dario#77.
  if (!opts.noLiveCapture) {
    void import('./live-fingerprint.js').then(({ refreshLiveFingerprintAsync }) =>
      refreshLiveFingerprintAsync({ silent: false, force: drift.drifted }).catch(() => { /* noop */ }),
    );
  } else {
    console.log('[dario] --no-live-capture: background live fingerprint refresh skipped; using bundled template.');
  }

  server.listen(port, host, () => {
    const modeLine = passthrough
      ? 'Mode: passthrough (OAuth swap only, no injection)'
      : `OAuth: ${status.status} (expires in ${status.expiresIn})`;
    const fastNote = fastModelOverride ? `, ${fastModelOverride} (Haiku-tier sub-agents)` : '';
    const modelLine = modelOverride
      ? `Model: ${modelOverride} (all requests)${fastNote}`
      : `Model: passthrough (client decides)${fastNote}`;
    // Pool line surfaces the account state on every startup. The pool is the
    // one credential model now (v5.0): a plain `dario login` shows as a pool of
    // one. An empty pool is only reachable in admin-bootstrap / api-key mode.
    const poolLine = pool.size === 0
      ? 'Pool: empty (admin bootstrap / api-key mode) — no accounts loaded'
      : pool.size === 1
        ? 'Pool: 1 account (a pool of one) — add more with `dario accounts add <alias>` to load-balance'
        : `Pool: ${pool.size} accounts — headroom-routed, sticky for multi-turn`;
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
    if (opts.noClaudeAuth) console.log('  Claude auth: disabled (--no-claude-auth) — OpenAI-compatible backends only; Claude token untouched');
    console.log(`  ${poolLine}`);
    if (!isLoopbackHost(host)) {
      console.log('');
      console.log(`  ⚠  Bound to ${host} — reachable from other machines on the network.`);
      if (!apiKey) {
        console.log('     No auth configured. Any host that can reach this port can proxy');
        console.log('     requests through your OAuth subscription. Set DARIO_API_KEY');
        console.log('     before exposing dario beyond loopback.');
      } else {
        console.log('     Auth required — accepted credentials: x-api-key / Authorization (DARIO_API_KEY).');
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
      // The pool refresh loop (above) is the SOLE refresher of every account's
      // token lineage. Pulse with a token the pool already keeps fresh; never
      // refresh from this side — doing so would race the pool refreshing the
      // same lineage and trip Anthropic's refresh-token reuse-detection (the
      // 2026-06-23 fleet outage, dario#641-audit). Empty in api-key mode (no
      // pool account); presence is an OAuth-session concept and is skipped there.
      const token = pool.all()[0]?.accessToken ?? '';
      if (!token) return;
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

  // Token refresh is owned entirely by the pool's 15-min refresh loop (above),
  // the sole refresher of every account's token lineage. The pre-v5 single-
  // account periodic refresh that lived here is gone with the single-account
  // path — refreshing credentials.json alongside the pool would double-refresh
  // a shared lineage and trip reuse-detection (see the presence-loop note).

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[dario] Shutting down...');
    clearInterval(presenceInterval);
    clearInterval(refreshInterval);
    if (logFileStream) logFileStream.end();
    server.close(() => process.exit(0));
    // Force exit after 5s if connections don't close
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

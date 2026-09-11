/**
 * Codex account storage — the "altman" engine (dario#1009).
 *
 * Deliberately isolated from accounts.ts: separate directory
 * (~/.dario/codex-accounts/), separate types, no shared code path with the
 * Claude pool — in particular none of the pool/lock/lease machinery, which
 * a live race test showed this provider does not need (see the
 * getFreshCodexAccount comment below). Request routing lives in
 * provider-adapter.ts + codex-backend.ts; this module owns credentials on
 * disk and the selection/refresh in front of them.
 */
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  generateCodexPKCE,
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  refreshCodexAccessToken,
  CodexRefreshError,
  type CodexTokens,
} from './codex-oauth.js';
import { durableWriteFile } from './durable-write.js';
import { ProviderCooldowns } from './provider-cooldown.js';

const DARIO_DIR = join(homedir(), '.dario');
const CODEX_ACCOUNTS_DIR = join(DARIO_DIR, 'codex-accounts');

export interface CodexAccountCredentials {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
}

/** Same alias charset/traversal guard as accounts.ts's safeAliasPath. */
function safeAliasPath(alias: string): string | null {
  if (typeof alias !== 'string' || alias.length === 0) return null;
  const leaf = basename(alias);
  if (leaf !== alias) return null;
  if (leaf === '.' || leaf === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/.test(leaf)) return null;
  return join(CODEX_ACCOUNTS_DIR, `${leaf}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(CODEX_ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
}

export async function listCodexAccountAliases(): Promise<string[]> {
  try {
    await ensureDir();
    const entries = await readdir(CODEX_ACCOUNTS_DIR);
    return entries.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * "Is the codex route available at all" — the routing question, asked per
 * request rather than once at startup (dario#1138).
 *
 * The proxy used to resolve this a single time while booting, so an account
 * stored by `dario codex add` against an ALREADY-RUNNING proxy stayed
 * invisible until a restart: /v1/models advertised no gpt slugs and a listed
 * slug fell through to the Claude path as an unknown model. `dario login`
 * restarts the proxy by convention, `dario codex add` does not.
 *
 * Cheap enough to ask often — a readdir of a directory holding at most a
 * handful of files — but an idle proxy still shouldn't hit the filesystem on
 * every request, so the NEGATIVE answer is cached briefly. The positive one
 * isn't cached: the caller goes on to read the credentials anyway, and a
 * `codex remove` has to take effect immediately.
 */
const CODEX_PRESENCE_NEGATIVE_TTL_MS = 30_000;
let codexAbsentUntil = 0;

export async function hasAnyCodexAccount(nowMs: number = Date.now()): Promise<boolean> {
  if (nowMs < codexAbsentUntil) return false;
  const present = (await listCodexAccountAliases()).length > 0;
  codexAbsentUntil = present ? 0 : nowMs + CODEX_PRESENCE_NEGATIVE_TTL_MS;
  return present;
}

/** Drop the negative cache so a test doesn't have to sleep out its TTL. */
export function _resetCodexPresenceCacheForTest(): void {
  codexAbsentUntil = 0;
}

export async function loadCodexAccount(alias: string): Promise<CodexAccountCredentials | null> {
  const path = safeAliasPath(alias);
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as CodexAccountCredentials;
  } catch {
    return null;
  }
}

export async function loadAllCodexAccounts(): Promise<CodexAccountCredentials[]> {
  const aliases = await listCodexAccountAliases();
  const loaded = await Promise.all(aliases.map(a => loadCodexAccount(a)));
  return loaded.filter((a): a is CodexAccountCredentials => a !== null);
}

export async function saveCodexAccount(creds: CodexAccountCredentials): Promise<void> {
  const path = safeAliasPath(creds.alias);
  if (!path) throw new Error(`invalid codex account alias: ${creds.alias}`);
  await ensureDir();
  await durableWriteFile(path, JSON.stringify(creds, null, 2), 0o600);
  // An account stored in THIS process (`dario codex add` in a running admin
  // path, or a test) must not be hidden by a negative cache entry taken
  // moments earlier.
  codexAbsentUntil = 0;
}

export async function removeCodexAccount(alias: string): Promise<boolean> {
  const path = safeAliasPath(alias);
  if (!path) return false;
  try {
    await unlink(path);
    refreshFailures.delete(alias);
    return true;
  } catch {
    return false;
  }
}

export function getCodexAccountsDir(): string {
  return CODEX_ACCOUNTS_DIR;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startAddCodexAccount(
  alias: string,
): Promise<{ authorizeUrl: string; codeVerifier: string; state: string }> {
  if (!safeAliasPath(alias)) {
    throw new Error(`invalid account alias "${alias}" (allowed: letters, digits, _-. — up to 64 chars, no path separators)`);
  }
  const { codeVerifier, codeChallenge } = generateCodexPKCE();
  const state = base64url(randomBytes(32));
  const authorizeUrl = buildCodexAuthorizeUrl(codeChallenge, state);
  return { authorizeUrl, codeVerifier, state };
}

export async function completeAddCodexAccount(
  alias: string,
  code: string,
  codeVerifier: string,
): Promise<CodexAccountCredentials> {
  if (!safeAliasPath(alias)) {
    throw new Error(`invalid account alias "${alias}"`);
  }
  const tokens: CodexTokens = await exchangeCodexAuthorizationCode(code, codeVerifier);
  const creds: CodexAccountCredentials = {
    alias,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    idToken: tokens.idToken,
  };
  await saveCodexAccount(creds);
  // Freshly minted credentials — whatever the old ones failed with is history.
  refreshFailures.delete(alias);
  return creds;
}

/**
 * Refresh 30 min before expiry — same buffer as oauth.ts's Claude path.
 * No single-flight or distributed-lock wrapping here (unlike accounts.ts's
 * refreshAccountToken) — see codex-oauth.ts's header for why.
 */
const REFRESH_BUFFER_MS = 30 * 60 * 1000;

export function codexAccountNeedsRefresh(creds: CodexAccountCredentials): boolean {
  return Date.now() >= creds.expiresAt - REFRESH_BUFFER_MS;
}

export async function refreshCodexAccount(creds: CodexAccountCredentials): Promise<CodexAccountCredentials> {
  const tokens = await refreshCodexAccessToken(creds.refreshToken);
  const updated: CodexAccountCredentials = {
    ...creds,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    idToken: tokens.idToken,
  };
  await saveCodexAccount(updated);
  return updated;
}

/**
 * A refresh this process is not going to attempt right now: either the last one
 * failed inside the cool-down below, or the one just attempted failed. Carries
 * the alias so the caller can name the CODEX account in the client's error —
 * the whole point of the fix, since the request otherwise fell through to the
 * Claude path and got told to run `dario login`.
 */
export class CodexCredentialsUnavailableError extends Error {
  readonly alias: string;
  readonly status: number;
  readonly failedAt: number;
  constructor(alias: string, failure: CodexRefreshFailure) {
    super(`codex account ${alias}: token refresh failed (${failure.status || 'no response'}): ${failure.message}`);
    this.name = 'CodexCredentialsUnavailableError';
    this.alias = alias;
    this.status = failure.status;
    this.failedAt = failure.at;
  }
}

/** Last refresh rejection remembered for an alias. No token material here. */
export interface CodexRefreshFailure {
  /** When the failure was observed (ms epoch). */
  at: number;
  /** Upstream HTTP status, or 0 when no response arrived (transport/timeout). */
  status: number;
  /** First ~120 chars of the upstream body / error text — never a token. */
  message: string;
}

interface CodexRefreshFailureEntry extends CodexRefreshFailure {
  /** No further refresh attempt before this instant (ms epoch). */
  retryAt: number;
  /** One log line per outage, not one per retry — see the log below. */
  logged: boolean;
}

/**
 * A dead refresh_token used to cost one token-endpoint POST PER REQUEST,
 * forever, silently: getFreshCodexAccount only collapsed CONCURRENT refreshes
 * and remembered nothing about a failure, so every inbound request re-asked.
 * Same shape as codex-backend.ts's MODEL_CACHE_ERROR_TTL_MS — remember the
 * failure briefly, so a broken account costs one attempt a minute and recovers
 * on its own within a minute of the operator fixing it.
 */
const REFRESH_FAILURE_TTL_MS = 60 * 1000;
const refreshFailures = new Map<string, CodexRefreshFailureEntry>();

/** Last remembered refresh failure for an alias, or null. Read-only view for
 *  the admin surface (`GET /codex`) — never triggers an upstream call. */
export function getCodexRefreshFailure(alias: string): CodexRefreshFailure | null {
  const hit = refreshFailures.get(alias);
  return hit ? { at: hit.at, status: hit.status, message: hit.message } : null;
}

/** Test seam — forget every remembered failure. */
export function _resetCodexRefreshFailuresForTest(): void {
  refreshFailures.clear();
}

function noteRefreshFailure(alias: string, err: unknown): CodexRefreshFailureEntry {
  const status = err instanceof CodexRefreshError ? err.status : 0;
  const raw = err instanceof CodexRefreshError
    ? err.bodySnippet
    : (err instanceof Error ? err.message : String(err));
  const previous = refreshFailures.get(alias);
  const entry: CodexRefreshFailureEntry = {
    at: Date.now(),
    status,
    message: raw.slice(0, 120),
    retryAt: Date.now() + REFRESH_FAILURE_TTL_MS,
    logged: previous?.logged ?? false,
  };
  if (!entry.logged) {
    // ONE line per outage. The body snippet is the upstream's own error text
    // (`invalid_grant`, an HTML 502 page, a timeout message) — the tokens
    // themselves are never logged.
    console.error(
      `[dario] codex account ${alias}: token refresh failed (${status || 'no response'}): ${entry.message} — ` +
      `not retrying for ${Math.round(REFRESH_FAILURE_TTL_MS / 1000)}s. Re-add with \`dario codex add ${alias}\` if this persists.`,
    );
    entry.logged = true;
  }
  refreshFailures.set(alias, entry);
  return entry;
}

function noteRefreshRecovered(alias: string): void {
  const previous = refreshFailures.get(alias);
  refreshFailures.delete(alias);
  if (previous?.logged) console.log(`[dario] codex account ${alias}: token refresh recovered`);
}

/**
 * In-process refresh serialization.
 *
 * dario#1010's open question is answered: test/manual/codex-refresh-race.mjs
 * was run twice against a live ChatGPT Plus account and came back TOLERANT both
 * times — two concurrent refreshes of the same refresh_token BOTH succeed, and
 * each returns a different new refresh_token. OpenAI does not invalidate the
 * previous one. So Codex needs none of the Claude engine's pool/lock/lease
 * machinery (#993/#1008): no Durable Object, no Redis, nothing cross-process.
 *
 * What's left is purely an efficiency concern — N concurrent requests arriving
 * on an expiring token shouldn't fire N identical refresh calls. One in-memory
 * promise per alias collapses them. If a second dario process refreshes the same
 * account at the same time, both simply succeed; last writer wins on disk and
 * the other process's token stays valid until its own expiry.
 */
const inflightRefresh = new Map<string, Promise<CodexAccountCredentials>>();

/**
 * Return credentials guaranteed fresh enough to send upstream, refreshing (once,
 * per alias, per process) when within the expiry buffer.
 *
 * Throws {@link CodexCredentialsUnavailableError} when the refresh failed —
 * including when it failed RECENTLY and this call therefore made no upstream
 * attempt at all. Callers must treat the throw as "the codex route is not
 * available for this request" and say so naming the codex account; swallowing
 * it is what turned a dead token into a per-request token-endpoint storm with
 * a misleading "run `dario login`" answer to the client.
 */
export async function getFreshCodexAccount(creds: CodexAccountCredentials): Promise<CodexAccountCredentials> {
  if (!codexAccountNeedsRefresh(creds)) {
    // Credentials on disk are fresh again — an operator re-added the account,
    // or another process refreshed it. Nothing to cool down anymore.
    noteRefreshRecovered(creds.alias);
    return creds;
  }
  const existing = inflightRefresh.get(creds.alias);
  if (existing) return existing;
  const remembered = refreshFailures.get(creds.alias);
  if (remembered && Date.now() < remembered.retryAt) {
    throw new CodexCredentialsUnavailableError(creds.alias, remembered);
  }
  const p = refreshCodexAccount(creds)
    .then((fresh) => {
      noteRefreshRecovered(creds.alias);
      return fresh;
    })
    .catch((err: unknown) => {
      throw new CodexCredentialsUnavailableError(creds.alias, noteRefreshFailure(creds.alias, err));
    })
    .finally(() => {
      inflightRefresh.delete(creds.alias);
    });
  inflightRefresh.set(creds.alias, p);
  return p;
}

/**
 * Pick the account to serve a request. Single account is the expected case (one
 * ChatGPT subscription); with several, `DARIO_CODEX_ACCOUNT` names one and
 * otherwise the first alphabetically wins. No rotation/least-recently-used
 * balancing — a subscription is per-seat, so spreading load across seats is the
 * user's decision to make explicitly, not something to do implicitly.
 */
/**
 * Per-seat cool-downs and conversation stickiness for the ChatGPT pool
 * (dario#1244 follow-up).
 *
 * Until now selectCodexAccount returned `sort()[0]` — the alphabetically FIRST
 * account, every time. `dario add altman` will happily store a dozen seats and
 * dario would use exactly one of them. That is why the account-wide 429 on
 * 2026-09-07 took the whole GPT lane down: a second seat sat there, healthy and
 * unreachable, while every request failed over to Claude.
 *
 * Reuses ProviderCooldowns keyed by ALIAS rather than by provider name. It is
 * already the right shape — arbitrary string key, injectable clock, entries
 * dropped on read — so the pool needs no second cool-down implementation.
 *
 * ROTATION IS PER-CONVERSATION, NOT PER-REQUEST, and that is the whole design.
 * The Codex prompt cache is scoped to the serving account: a conversation that
 * builds a prefix on seat A reads nothing from it on seat B, and measured cache
 * share on this lane is 59% in production against a 73% controlled ceiling.
 * Rotating per request would trade a rate-limit problem for a cache problem and
 * come out behind. So a conversation binds to a seat and stays there until that
 * seat actually declines.
 *
 * Deliberately NOT headroom routing like the Claude pool. Claude responds with
 * `anthropic-ratelimit-*` headers on every response, so that pool can read
 * utilisation before it picks. The Codex backend states nothing until it 429s —
 * the only signal is the decline itself plus its `retry-after` — so this is
 * fill-first with cool-down eviction, which is what the available signal
 * supports. If the backend ever starts reporting utilisation, this is where
 * headroom would go.
 */
let codexCooldowns = new ProviderCooldowns();

/** conversation sticky key -> alias. Bounded; swept when it exceeds the cap. */
const codexSticky = new Map<string, string>();
const CODEX_STICKY_MAX = 500;

/** Record that `alias` declined, for as long as the upstream asked. */
export function noteCodexDecline(alias: string, retryAfterMs?: number | null): number {
  return codexCooldowns.note(alias, retryAfterMs);
}

/** A seat that just served is not rate-limited — clear it. */
export function clearCodexDecline(alias: string): void {
  codexCooldowns.clear(alias);
}

/** Ms until `alias` is askable again; 0 when it is askable now. */
export function codexCooldownRemainingMs(alias: string): number {
  return codexCooldowns.remainingMs(alias);
}

/** Test seam — forget every cool-down and binding. */
export function _resetCodexPoolForTest(): void {
  codexSticky.clear();
  // A fresh instance rather than clearing per alias: the previous version
  // emptied the sticky map first and then iterated it, so it cleared nothing
  // and cool-downs leaked between test cases.
  codexCooldowns = new ProviderCooldowns();
}

/** The alias currently bound to a conversation, or null. */
export function codexStickyAliasFor(key: string | null | undefined): string | null {
  return key ? codexSticky.get(key) ?? null : null;
}

function bindCodexSticky(key: string, alias: string): void {
  if (codexSticky.size >= CODEX_STICKY_MAX && !codexSticky.has(key)) {
    // Oldest-first eviction: Map preserves insertion order, so the first key is
    // the least recently bound. Losing a binding costs one cache miss, never
    // correctness, so a cheap sweep beats an LRU.
    const oldest = codexSticky.keys().next().value;
    if (oldest !== undefined) codexSticky.delete(oldest);
  }
  codexSticky.set(key, alias);
}

/**
 * Choose a ChatGPT seat for this request.
 *
 * Order, most specific first:
 *   1. an explicitly named alias (`x-dario-account`, DARIO_CODEX_ACCOUNT) — a
 *      pin is an instruction, so it is honoured even while cooling; the caller
 *      asked for that seat and gets its answer, 429 included.
 *   2. the seat this conversation is already bound to, unless it is cooling.
 *   3. the first seat alphabetically that is not cooling — deterministic, so a
 *      given conversation lands on the same seat across a restart and keeps its
 *      prompt cache.
 *   4. null when every seat is cooling. The caller answers from that rather
 *      than spending a request that can only 429 again.
 */
export async function selectCodexAccount(
  preferredAlias?: string,
  opts?: { stickyKey?: string | null },
): Promise<CodexAccountCredentials | null> {
  const alias = preferredAlias || process.env.DARIO_CODEX_ACCOUNT;
  if (alias) {
    const one = await loadCodexAccount(alias);
    if (one) return one;
  }
  const all = await loadAllCodexAccounts();
  if (all.length === 0) return null;
  const byAlias = [...all].sort((a, b) => a.alias.localeCompare(b.alias));

  const key = opts?.stickyKey ?? null;
  if (key) {
    const bound = codexSticky.get(key);
    if (bound && !codexCooldowns.isCooled(bound)) {
      const hit = byAlias.find((c) => c.alias === bound);
      // A binding to a seat that has since been removed falls through to a
      // fresh pick rather than failing the request.
      if (hit) return hit;
      codexSticky.delete(key);
    }
  }

  const free = byAlias.find((c) => !codexCooldowns.isCooled(c.alias));
  if (!free) return null;
  if (key) bindCodexSticky(key, free.alias);
  return free;
}

/**
 * The next askable seat that this request has NOT already tried.
 *
 * Mid-flight failover: a seat that 429s during a request hands the SAME
 * request to a peer rather than failing it. Without this the pool only helps
 * the request AFTER the one that discovered the limit — the discovering
 * request still failed, every time a window rolled over.
 *
 * `tried` is per-request, so a seat already attempted here is never revisited
 * inside the same request even if its cool-down has not landed yet. That is
 * the codex mirror of the Claude pool's selectExcluding, and it is what makes
 * the loop terminate: every pass adds a seat, so it is bounded by pool size.
 *
 * Stickiness is deliberately NOT consulted. The bound seat is the one that
 * just declined; re-offering it would loop, and a conversation whose seat has
 * gone away is better served elsewhere than not at all.
 */
export async function selectCodexAccountExcluding(
  tried: ReadonlySet<string>,
): Promise<CodexAccountCredentials | null> {
  const all = await loadAllCodexAccounts();
  if (all.length === 0) return null;
  return [...all]
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .find((c) => !tried.has(c.alias) && !codexCooldowns.isCooled(c.alias)) ?? null;
}
/** Every seat is cooling — the fail-fast condition, for the caller's message. */
export async function allCodexAccountsCooled(): Promise<boolean> {
  const aliases = await listCodexAccountAliases();
  return aliases.length > 0 && aliases.every((a) => codexCooldowns.isCooled(a));
}

/** Longest remaining cool-down across every seat, for a `retry-after`. */
export async function codexPoolRetryAfterMs(): Promise<number> {
  const aliases = await listCodexAccountAliases();
  return aliases.reduce((max, a) => Math.max(max, codexCooldowns.remainingMs(a)), 0);
}

/**
 * Parse whatever the user pastes back after authorizing.
 *
 * Three accepted shapes, because all three are what people actually have on
 * their clipboard:
 *
 *   1. the FULL redirect URL out of the browser address bar —
 *      `http://localhost:1455/auth/callback?code=…&state=…`. This is the
 *      common one: the manual-paste flow starts no listener on 1455, so the
 *      browser lands on a connection error and the address bar is the only
 *      place the code is visible. The first live login failed exactly here.
 *   2. `code#state`, the fragment-joined form the Claude flow's success page
 *      renders (parseManualPaste in oauth.ts).
 *   3. a bare code.
 *
 * Codex-local rather than shared with oauth.ts: the Claude flow has no
 * redirect-URL shape to parse, and its parser is on the login path for every
 * user of the Claude engine.
 */
export function parseCodexManualPaste(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  if (!trimmed) return { code: '', state: null };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get('code') ?? '',
        state: url.searchParams.get('state'),
      };
    } catch {
      return { code: '', state: null };
    }
  }
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) return { code: trimmed, state: null };
  return {
    code: trimmed.slice(0, hashIdx).trim(),
    state: trimmed.slice(hashIdx + 1).trim(),
  };
}

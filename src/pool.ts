/**
 * Account pool — rate limit tracking, headroom routing, failover.
 *
 * Activated automatically when `~/.dario/accounts/` contains any account
 * (one is enough — dario#618). Login-only dario (`~/.dario/credentials.json`,
 * no accounts/ entries) keeps the same code path it has always had.
 */
import { createHash, randomUUID } from 'node:crypto';

/**
 * Compute a stable stickiness key from a conversation's first user
 * message. Multi-turn agent sessions carry the same first user message
 * on every turn, so hashing it gives a stable per-conversation key that
 * doesn't require client cooperation. Empty / whitespace-only inputs
 * return null so callers bypass stickiness on unhashable requests.
 *
 * Uses SHA-256 truncated to 16 hex chars (64 bits) — plenty of collision
 * headroom for a pool of at most a few hundred active conversations per
 * proxy instance, and small enough to log without spam.
 */
export function computeStickyKey(firstUserMessage: string | null | undefined): string | null {
  const trimmed = (firstUserMessage ?? '').trim();
  if (trimmed.length === 0) return null;
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
}

export interface AccountIdentity {
  deviceId: string;
  accountUuid: string;
  sessionId: string;
}

export interface RateLimitSnapshot {
  status: string;
  util5h: number;
  util7d: number;
  /**
   * Per-model 7-day utilization buckets — Anthropic carves separate
   * weekly windows for some model families. As of 2026-04-25 the live
   * API emits `anthropic-ratelimit-unified-7d_sonnet-utilization` on
   * Sonnet responses (corresponds to the "Sonnet only" line on the user
   * dashboard); other families do not yet have dedicated buckets but
   * the parser scans the header set generically so any future
   * `7d_<family>` header is captured automatically.
   *
   * Keyed by the family suffix as it arrived on the wire (lowercase,
   * e.g. `sonnet` / `opus` / `haiku`). Empty when no per-model headers
   * were on the response.
   */
  perModel7d: Record<string, number>;
  overageUtil: number;
  claim: string;
  reset: number;
  fallbackPct: number;
  updatedAt: number;
}

export const EMPTY_SNAPSHOT: RateLimitSnapshot = {
  status: 'unknown',
  util5h: 0,
  util7d: 0,
  perModel7d: {},
  overageUtil: 0,
  claim: 'unknown',
  reset: 0,
  fallbackPct: 0,
  updatedAt: 0,
};

/** Freshness of an account's utilisation reading — see `utilFreshness`. */
export interface UtilFreshness {
  /** When util5h/util7d were last observed, epoch ms; null if never. */
  lastObservedAt: number | null;
  /** Age of that reading in ms; null if never observed. */
  utilAgeMs: number | null;
}

/**
 * Derive how old an account's utilisation reading is (dario#1032).
 *
 * `util5h` / `util7d` are a SNAPSHOT of the last response the account served.
 * They do not tick on their own, and nothing refreshes them while an account is
 * parked (rejected, or in auth cooldown) — so they stay frozen at whatever they
 * read at the moment it was parked. The pool does return parked accounts to
 * service on its own and the value corrects itself when it does, which is what
 * makes this a REPORTING problem rather than a routing one: the payload carried
 * no timestamp, so no consumer could tell a current reading from one frozen
 * minutes ago, and a dashboard rendered "5-hour window full" for an account
 * that had since reset and was free.
 *
 * `updatedAt` was already on the snapshot; it was simply never surfaced. An
 * `updatedAt` of 0 is EMPTY_SNAPSHOT's "never observed", which must report as
 * null rather than as an age of ~56 years since epoch.
 */
export function utilFreshness(rl: RateLimitSnapshot, now: number): UtilFreshness {
  const lastObservedAt = rl.updatedAt || null;
  return {
    lastObservedAt,
    utilAgeMs: lastObservedAt === null ? null : Math.max(0, now - lastObservedAt),
  };
}

/** When an account's rate-limit window rolls over — see `rateLimitWindow`. */
export interface RateLimitWindow {
  /**
   * Epoch ms the window resets at, from `anthropic-ratelimit-unified-reset`;
   * null when no response on this account has stated one.
   */
  resetAt: number | null;
  /** Ms until that reset, floored at 0 once it has passed; null when unknown. */
  resetInMs: number | null;
}

/**
 * The reset moment of the window an account's last reading was measured
 * against (dario#1244). The snapshot has carried `reset` since the header was
 * first parsed and routing has expired rejections on it since #1232, but no
 * operator surface showed it: a seat read `status: rejected` with nothing
 * saying until when, and `requestCount: 0` beside it (a 429 serves nothing,
 * so the attempt was never counted) made the rejection look like one dario
 * had made up. For a `rejected` seat this is when the rejection lifts; for
 * an `allowed` one, when its representative window rolls. The header is
 * epoch SECONDS; both fields here are milliseconds, like `expiresInMs` and
 * `utilAgeMs`.
 */
export function rateLimitWindow(rl: RateLimitSnapshot, now: number): RateLimitWindow {
  if (!(rl.reset > 0)) return { resetAt: null, resetInMs: null };
  const resetAt = rl.reset * 1000;
  return { resetAt, resetInMs: Math.max(0, resetAt - now) };
}

/**
 * One line for a log or a doctor row:
 * `5h 104%, 7d 25%, claim five_hour, resets in 37m`.
 */
export function describeRateLimitSnapshot(rl: RateLimitSnapshot, now: number = Date.now()): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const { resetInMs } = rateLimitWindow(rl, now);
  const reset = resetInMs === null ? 'no reset stated'
    : resetInMs === 0 ? 'window already rolled'
    : `resets in ${formatDurationMs(resetInMs)}`;
  return `5h ${pct(rl.util5h)}, 7d ${pct(rl.util7d)}, claim ${rl.claim}, ${reset}`;
}

function formatDurationMs(ms: number): string {
  const totalMins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The identity of the rate-limit window a reading was measured against:
 * its representative claim plus its reset second, or null when the reading
 * states no live window (no reset, a reset that has passed, or no claim).
 *
 * Two seats that report the same key are one subscription under two aliases
 * (dario#1244, "a few have the same issue"): two independent windows all but
 * never share a reset second, and two readings of one window always do. The
 * organization id is deliberately NOT part of the key — several seats can
 * share an organization and still have their own windows — the window itself
 * is the fact that matters for headroom.
 */
export function windowKey(rl: RateLimitSnapshot, now: number): string | null {
  if (!(rl.reset > 0) || rl.reset * 1000 <= now) return null;
  if (!rl.claim || rl.claim === 'unknown') return null;
  return `${rl.claim}@${rl.reset}`;
}

/** For every seat, the other aliases whose last reading names the same live window. */
export function windowPeers(accounts: readonly PoolAccount[], now: number): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const a of accounts) {
    const k = windowKey(a.rateLimit, now);
    if (!k) continue;
    const list = byKey.get(k);
    if (list) list.push(a.alias); else byKey.set(k, [a.alias]);
  }
  const out = new Map<string, string[]>();
  for (const a of accounts) {
    const k = windowKey(a.rateLimit, now);
    out.set(a.alias, k ? (byKey.get(k) ?? []).filter((alias) => alias !== a.alias) : []);
  }
  return out;
}

/**
 * How many windows the pool really has: each measured live window once, and
 * each seat without a live reading as its own (nothing says otherwise yet).
 */
export function distinctWindows(accounts: readonly PoolAccount[], now: number): number {
  const keys = new Set<string>();
  let unmeasured = 0;
  for (const a of accounts) {
    const k = windowKey(a.rateLimit, now);
    if (k) keys.add(k); else unmeasured++;
  }
  return keys.size + unmeasured;
}

export interface PoolAccount {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: AccountIdentity;
  rateLimit: RateLimitSnapshot;
  requestCount: number;
  /**
   * Upstream 429s this account has answered. `requestCount` counts requests
   * the account SERVED, and a 429 served nothing — so a seat parked on its
   * first attempt read `requestCount: 0` next to `status: rejected`, as if
   * dario had rejected a seat it never called (dario#1244). This is the field
   * that says it was tried.
   */
  rejectedCount: number;
  /** Epoch ms of the most recent 429 on this account; undefined if never. */
  lastRejectedAt?: number;
  /**
   * The Anthropic organization behind this seat's token, from the
   * `anthropic-organization-id` response header: learned on the first
   * response the seat serves, written to its record with the next token
   * refresh (dario#1244 — a reading that surprises you is usually a token on
   * an organization other than the one whose usage page you are looking at).
   * Undefined until seen.
   */
  organizationId?: string;
  /**
   * Set when the current reading came from a peer instance (pool-sync.ts):
   * that instance's id. Cleared by the next reading this instance takes
   * itself. A seat parked on a peer's 429 shows `rejected` with
   * `rejectedCount` unchanged — the 429 was the peer's — and this says so.
   */
  adoptedFrom?: string;
  /** Epoch ms of the OAuth grant (refresh-grant.ts); undefined when unknown. */
  grantedAt?: number;
  /**
   * Auth-failure cool-down (dario#234). Set when an upstream returns
   * 401/403 or an `authentication_error` / `permission_error` /
   * `invalid_grant` body — tokens are server-invalidated and the
   * selector should route around this account until either:
   *   (a) a successful request on this account clears the cool-down, or
   *   (b) the cool-down window expires
   *
   * Without this, the selector keeps picking the dead account because
   * 401 responses don't include rate-limit headers, so headroom math
   * sees a healthy idle account. Reproed live with a stale `login`
   * back-fill against an OAuth-derived account: pool routed every
   * request to the dead login and never tried the healthy peer.
   */
  lastAuthFailureAt?: number;
  consecutiveAuthFailures: number;
}

/**
 * Cool-down schedule after auth failures. First failure: 60s. Each
 * consecutive failure doubles the window up to 30 minutes. Cleared
 * by any successful response on the same account. Numbers are tunable
 * — the shape is the design.
 */
const AUTH_COOLDOWN_BASE_MS = 60 * 1000;
const AUTH_COOLDOWN_MAX_MS = 30 * 60 * 1000;

export function authCooldownMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const ms = AUTH_COOLDOWN_BASE_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(ms, AUTH_COOLDOWN_MAX_MS);
}

export function isInAuthCooldown(account: PoolAccount, now: number = Date.now()): boolean {
  if (!account.lastAuthFailureAt || account.consecutiveAuthFailures <= 0) return false;
  const cooldown = authCooldownMs(account.consecutiveAuthFailures);
  return now - account.lastAuthFailureAt < cooldown;
}

/**
 * How long before a token's stated expiry the router stops trusting it. A
 * request selected at T must still be valid when it reaches Anthropic.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;

/** Why the router cannot serve a request from an account. */
export type AccountIneligibility = 'rate-limited' | 'token-expired' | 'auth-cooldown';

/**
 * The single answer to "can the router serve a request from this account, and
 * if not, why not?" (dario#1030).
 *
 * This predicate was inline at four sites in this file and had been
 * re-implemented, as a SUBSET, by a fifth reader in health-response.ts — which
 * filtered on auth-cooldown alone. A pool whose tokens had all expired, or
 * whose accounts were all rate-limited, therefore reported `healthy` /
 * `authenticated: true` on /health while every request it served failed. That
 * is the exact case /health exists to catch: a monitor watching it sees
 * nothing, and `dario doctor` reads the same derivation.
 *
 * It returns the REASON rather than a boolean because the surfaces want to say
 * why — /health's `expiresIn` line, the 503 body, and doctor's routing row all
 * need to name the failure, and a boolean forces each of them to re-derive it
 * and drift again.
 */
/**
 * Has the window that produced a `rejected` reading rolled over?
 *
 * A rejection is a verdict with an expiry date: `anthropic-ratelimit-unified-reset`
 * names the moment the window that refused the request resets. Past it, the old
 * reading says nothing about the account any more.
 *
 * This matters because a rejected account is filtered out of `select()`, so it
 * is sent no further requests, so `updateRateLimits` never runs for it and its
 * snapshot never refreshes. The only routes back into rotation were the
 * all-exhausted fallback in `select()` and a proxy restart. Observed on the
 * fleet box (2026-09-06): one seat sat parked on a 106% five-hour reading while
 * a second subscription carried every request, and it would have stayed parked
 * past its own reset for as long as the other seat held out.
 *
 * `reset` is epoch SECONDS — the header's own unit, the same one `formatReset`
 * scales — so it is converted here. A snapshot with no reset (0) keeps its
 * rejection: with no stated rollover there is nothing to expire, and guessing
 * would push a genuinely throttled account back into rotation.
 */
export function rateLimitWindowPassed(rl: RateLimitSnapshot, now: number = Date.now()): boolean {
  return rl.reset > 0 && rl.reset * 1000 <= now;
}

/**
 * The status string the operator-facing surfaces report for one account —
 * `GET /accounts` and `GET /admin/accounts`, which must agree with each other
 * and with what routing actually does.
 *
 * Auth cool-down outranks the rate-limit reading: a 401 streak is both the more
 * urgent fact and the one the rate-limit headers cannot describe, since 401
 * responses carry none. An expired rejection degrades to `unknown` rather than
 * `allowed` — the window rolled over, but nothing has measured the account
 * since, and reporting `allowed` would assert a serving capacity no request has
 * demonstrated. `unknown` is what a never-used account already reports, which is
 * exactly the state this is: no current observation.
 */
export function reportedAccountStatus(account: PoolAccount, now: number = Date.now()): string {
  if (isInAuthCooldown(account, now)) return 'auth-cooldown';
  if (account.rateLimit.status === 'rejected' && rateLimitWindowPassed(account.rateLimit, now)) return 'unknown';
  return account.rateLimit.status;
}

export function accountIneligibility(
  account: PoolAccount,
  now: number = Date.now(),
): AccountIneligibility | null {
  // A rejection outlives its own window unless it is allowed to expire:
  // nothing refreshes a parked account's snapshot, because being parked is
  // what stops it being sent requests.
  if (account.rateLimit.status === 'rejected' && !rateLimitWindowPassed(account.rateLimit, now)) return 'rate-limited';
  if (account.expiresAt <= now + TOKEN_EXPIRY_MARGIN_MS) return 'token-expired';
  if (isInAuthCooldown(account, now)) return 'auth-cooldown';
  return null;
}

/** Boolean form of `accountIneligibility` — the router's eligibility filter. */
export function isAccountEligible(account: PoolAccount, now: number = Date.now()): boolean {
  return accountIneligibility(account, now) === null;
}

/**
 * A seat parked on a 429 whose stated window has not rolled yet — the one
 * state the router must never re-probe: the 429 named the reset, the clock
 * has not reached it, and a probe can only 429 again. A rejection with no
 * stated reset is NOT this: with nothing to expire, asking is the only way
 * back, so it stays probeable (dario#1244).
 */
export function isParkedInLiveWindow(account: PoolAccount, now: number = Date.now()): boolean {
  const rl = account.rateLimit;
  return rl.status === 'rejected' && rl.reset > 0 && rl.reset * 1000 > now;
}

/**
 * The operator's next step for one seat, next to `status` on both listings
 * (dario#1244 — "do I have to re-login?" should not need the docs table).
 * `wait`: the seat comes back on its own (a live rate-limit window, or a
 * single auth blip cooling down). `regrant`: an auth-failure streak, which is
 * a dead refresh token. `none`: nothing to do.
 */
export function accountAction(account: PoolAccount, now: number = Date.now()): 'none' | 'wait' | 'regrant' {
  if (isInAuthCooldown(account, now)) return account.consecutiveAuthFailures >= 2 ? 'regrant' : 'wait';
  if (isParkedInLiveWindow(account, now)) return 'wait';
  return 'none';
}

export interface PoolStatus {
  accounts: number;
  healthy: number;
  exhausted: number;
  totalHeadroom: number;
  bestAccount: string;
  queued: number;
}

/**
 * Pool routing strategy.
 *
 * `headroom` (default) — every selection picks the account with the most
 * headroom, spreading new conversations across all seats.
 *
 * `fill-first` — concentrate new conversations on the lexicographically-
 * first eligible account (by alias) until its headroom drops to the 2%
 * floor, then spill to the next. Two things headroom spreading can't give
 * you: primary/backup semantics (a `z-backup` seat stays untouched until
 * `a-main` is actually drained), and cache concentration (every fresh
 * conversation lands where the prompt-cache pressure already is, keeping
 * the spill seat's windows fully fresh for when they're needed). Alias
 * order is the operator's knob — name seats `1-main` / `2-overflow` to
 * pick the fill order. Sticky bindings behave identically in both modes;
 * strategy only decides where UNBOUND (new) conversations land.
 */
export type PoolStrategy = 'headroom' | 'fill-first';

/**
 * Resolve the pool strategy from an explicit value (CLI flag / config file,
 * already precedence-merged by the caller) with `DARIO_POOL_STRATEGY` as
 * the env fallback. Unrecognized values fall through — a typo behaves like
 * the default rather than crashing startup, matching the other resolvers
 * in this codebase (see resolveSessionRotationConfig).
 */
export function resolvePoolStrategy(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): PoolStrategy {
  for (const c of [explicit, env.DARIO_POOL_STRATEGY]) {
    if (typeof c !== 'string') continue;
    const s = c.trim().toLowerCase();
    if (s === 'headroom' || s === 'fill-first') return s;
  }
  return 'headroom';
}

interface QueuedRequest {
  resolve: (account: PoolAccount) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

/**
 * Match `anthropic-ratelimit-unified-7d_<family>-utilization`. Generic on
 * `<family>` so a future `7d_opus` / `7d_haiku` (or anything Anthropic
 * adds without notice) is captured automatically. The family is
 * normalized to lowercase to match `modelFamily()` output.
 */
const PER_MODEL_7D_HEADER = /^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-utilization$/i;

/** Parse an Anthropic response's rate-limit headers into a snapshot. */
export function parseRateLimits(headers: Headers): RateLimitSnapshot {
  const get = (key: string) => headers.get(`anthropic-ratelimit-unified-${key}`) ?? '';
  const perModel7d: Record<string, number> = {};
  // Iterate the full header set — `headers.get` only retrieves known
  // keys, but Anthropic can add new `7d_<family>-utilization` shapes
  // unannounced. Scanning the iterator means the parser is automatically
  // forward-compatible. Real `Headers` instances and test-side mocks
  // (which implement `.entries()` but not direct iteration) both work
  // through the explicit `.entries()` call.
  const entries = (typeof headers.entries === 'function')
    ? headers.entries()
    : (headers as unknown as Iterable<[string, string]>);
  for (const [k, v] of entries as Iterable<[string, string]>) {
    const m = k.match(PER_MODEL_7D_HEADER);
    if (m && m[1]) {
      perModel7d[m[1].toLowerCase()] = parseFloat(v) || 0;
    }
  }
  return {
    status: get('status') || 'unknown',
    util5h: parseFloat(get('5h-utilization')) || 0,
    util7d: parseFloat(get('7d-utilization')) || 0,
    perModel7d,
    overageUtil: parseFloat(get('overage-utilization')) || 0,
    claim: get('representative-claim') || 'unknown',
    reset: parseInt(get('reset')) || 0,
    fallbackPct: parseFloat(get('fallback-percentage')) || 0,
    updatedAt: Date.now(),
  };
}

/**
 * Extract the model family (`opus` / `sonnet` / `haiku` / `fable`) from a
 * request's model id. Used to look up the per-model 7d bucket in
 * `RateLimitSnapshot.perModel7d` during routing decisions. Returns null
 * for non-Claude models or model ids that don't carry a recognizable
 * family token (those requests just use the unified buckets).
 *
 * Generous on input shape: matches `claude-opus-4-7`, `opus`, `claude-3-7-sonnet-…`,
 * `claude-haiku-4-5`, `claude-fable-5[1m]`, anything containing the family token.
 * Lowercase-normalized so it pairs cleanly with `parseRateLimits`'s lowercase
 * family keys (the header parser is generic on `7d_<family>`, so a `7d_fable`
 * bucket is captured automatically the moment Anthropic starts emitting it —
 * this function is what lets routing USE it).
 */
export function modelFamily(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return null;
}

/**
 * Compute headroom for a single account given its rate-limit snapshot.
 * Headroom is the slack between the most-saturated relevant bucket and
 * full utilization: `1 - max(util5h, util7d, util_per_model_if_known)`.
 *
 * When `family` is supplied AND the snapshot has a corresponding per-
 * model 7d bucket, that bucket is included in the max. When the family
 * isn't represented in the snapshot (e.g. account hasn't seen a Sonnet
 * request yet so `7d_sonnet` is unknown), headroom is computed from the
 * unified buckets only — best-effort, populated on the next response.
 */
export function computeHeadroom(snapshot: RateLimitSnapshot, family?: string | null): number {
  const utils = [snapshot.util5h, snapshot.util7d];
  if (family) {
    const perModel = snapshot.perModel7d[family];
    if (perModel !== undefined) utils.push(perModel);
  }
  return 1 - Math.max(...utils);
}

/**
 * Session stickiness binding — ties a conversation key (derived from the
 * first user message) to one account so multi-turn agent sessions don't
 * rotate accounts mid-conversation and destroy the Anthropic prompt cache.
 *
 * Prompt cache on Claude Max is scoped to `{account × cache_control key}`.
 * A conversation that hits account A on turn 1 builds a cache entry under
 * account A. Turn 2 to account B reads nothing from A's cache and pays
 * cache-create cost again. For a long agent session that's a 5–10× token
 * cost multiplier on the cache-reused portion of every turn after the first.
 *
 * Stickiness: bind the conversation's stickyKey to an account for the life
 * of that conversation, and fall off only when the bound account is
 * exhausted / rejected. The 6-hour TTL is measured from a binding's LAST
 * use, not its creation: an actively-running session refreshes the timer on
 * every turn (see selectSticky), so it is never rebound out from under a
 * warm prompt cache — agent sessions routinely run past 6h, and an age-based
 * TTL would force such a session onto a cold account mid-conversation. A
 * conversation that goes quiet is reaped 6h after its final turn; by then
 * its cache has long expired (Anthropic prompt cache lives at most 1h) and a
 * "same" conversation returning would start fresh anyway, so rebinding is free.
 */
interface StickyBinding {
  alias: string;
  boundAt: number;    // creation time — retained for observability/debugging
  lastUsedAt: number; // last time this binding was returned; drives the idle TTL and LRU eviction
}
const STICKY_IDLE_TTL_MS = 6 * 60 * 60 * 1000; // reap a binding 6h after its LAST use, not its creation
const STICKY_MAX_ENTRIES = 2_000;          // lazy cleanup cap
const STICKY_CLEANUP_INTERVAL_MS = 30_000; // amortize the O(n) TTL/orphan sweep

/**
 * Headroom floor under which an account is treated as "effectively exhausted"
 * for routing decisions. A sticky binding whose account drops below this
 * threshold gets rebound on the next request; the round-robin selector skips
 * accounts below this threshold when picking the next-best slot; the probe
 * loop stops once every candidate is below it. 0.02 == 2%.
 */
const POOL_HEADROOM_FLOOR = 0.02;

// Pick the account with the most headroom in a single pass. The prior
// `.reduce()` form recomputed the incumbent's headroom every iteration
// (~2n computeHeadroom calls); this computes each once (#642-audit).
function pickMaxHeadroom(accounts: PoolAccount[], family?: string | null): PoolAccount {
  let best = accounts[0];
  let bestHeadroom = computeHeadroom(best.rateLimit, family);
  for (let i = 1; i < accounts.length; i++) {
    const h = computeHeadroom(accounts[i].rateLimit, family);
    if (h > bestHeadroom) { best = accounts[i]; bestHeadroom = h; }
  }
  return best;
}

// Fill-first pick: lexicographically-first eligible account still above the
// headroom floor. Alias order (not insertion order) — accounts load from a
// readdir whose order the OS doesn't guarantee, and the operator can control
// alias names but not readdir. Returns null when every candidate is at/below
// the floor so the caller can fall back to max-headroom.
function pickFillFirst(accounts: PoolAccount[], family?: string | null): PoolAccount | null {
  let best: PoolAccount | null = null;
  for (const a of accounts) {
    if (best !== null && a.alias >= best.alias) continue;
    if (computeHeadroom(a.rateLimit, family) > POOL_HEADROOM_FLOOR) best = a;
  }
  return best;
}

export class AccountPool {
  private accounts: Map<string, PoolAccount> = new Map();
  private queue: QueuedRequest[] = [];
  private queueMaxSize = 50;
  private queueTimeoutMs = 60_000;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private sticky: Map<string, StickyBinding> = new Map();
  // Amortize the O(n) sticky TTL/orphan sweep — timestamp of the last run.
  private lastStickyCleanup = 0;

  constructor(private readonly strategy: PoolStrategy = 'headroom') {}

  add(alias: string, opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    deviceId: string;
    accountUuid: string;
    grantedAt?: number;
    organizationId?: string;
  }): void {
    const existing = this.accounts.get(alias);
    // A record whose grantedAt differs from the live entry's is a NEW grant
    // under this alias — a re-login, possibly on a different organization
    // with its own windows. The live state describes the old credential (its
    // rejection and reading, its auth streak, its identity), so it starts
    // fresh (dario#1244): before this, a seat re-granted to clear
    // `auth-cooldown` stayed cooling until the old streak's timer ran out,
    // and one re-granted on another organization stayed parked on the old
    // organization's window. A reconcile carrying the same grant — a token
    // refresh, an admin change to another seat, a peer instance's rotation in
    // HA — keeps the live state as before. So does a record with no grantedAt
    // at all: it cannot be told apart from the same grant.
    const regranted = existing !== undefined && opts.grantedAt !== undefined && opts.grantedAt !== existing.grantedAt;
    const keep = regranted ? undefined : existing;
    this.accounts.set(alias, {
      alias,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
      grantedAt: opts.grantedAt ?? keep?.grantedAt,
      organizationId: opts.organizationId ?? keep?.organizationId,
      adoptedFrom: keep?.adoptedFrom,
      identity: keep?.identity ?? {
        deviceId: opts.deviceId,
        accountUuid: opts.accountUuid,
        sessionId: randomUUID(),
      },
      rateLimit: keep?.rateLimit ?? { ...EMPTY_SNAPSHOT },
      requestCount: keep?.requestCount ?? 0,
      rejectedCount: keep?.rejectedCount ?? 0,
      lastRejectedAt: keep?.lastRejectedAt,
      lastAuthFailureAt: keep?.lastAuthFailureAt,
      consecutiveAuthFailures: keep?.consecutiveAuthFailures ?? 0,
    });
  }

  remove(alias: string): boolean {
    return this.accounts.delete(alias);
  }

  get size(): number {
    return this.accounts.size;
  }

  /**
   * Record an auth failure (401/403/auth_error/permission_error/invalid_grant)
   * against `alias`. Increments the consecutive-failure counter and stamps
   * `lastAuthFailureAt`, putting the account in cool-down (see `authCooldownMs`).
   * Subsequent `select()` calls will skip this account until the cool-down
   * expires or `clearAuthFailure` is called.
   *
   * No-op if the alias isn't in the pool.
   */
  markAuthFailure(alias: string): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    const now = Date.now();
    // Escalate the exponential cool-down only for a genuinely fresh failure.
    // A burst of concurrent in-flight requests that all 401 on the same account
    // (before the first cool-down takes hold) would otherwise bump the counter
    // k times and jump the window to authCooldownMs(k) instead of 60s
    // (#642-audit). isInAuthCooldown reflects state BEFORE this failure, so the
    // burst escalates once; always refresh the timestamp to hold the window.
    if (!isInAuthCooldown(account, now)) {
      account.consecutiveAuthFailures = (account.consecutiveAuthFailures ?? 0) + 1;
    }
    account.lastAuthFailureAt = now;
  }

  /**
   * Clear an account's auth-failure cool-down. Called by the proxy after a
   * successful upstream response on `alias` — the account is healthy again,
   * so the counter resets and any future failure starts fresh from 60s.
   *
   * Failures and successes are alias-scoped: a success on account A never
   * clears account B's cool-down.
   */
  clearAuthFailure(alias: string): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    if (account.consecutiveAuthFailures === 0 && !account.lastAuthFailureAt) return;
    account.lastAuthFailureAt = undefined;
    account.consecutiveAuthFailures = 0;
  }

  /**
   * Select the best account for the next request. `family` (when supplied)
   * is the request's model family (`opus` / `sonnet` / `haiku`); when
   * present and the account has a matching per-model 7d bucket, that
   * bucket joins the headroom max. Family-less calls fall back to the
   * unified-buckets-only headroom — same behavior as before this PR.
   */
  select(family?: string | null): PoolAccount | null {
    if (this.accounts.size === 0) return null;

    const now = Date.now();
    const all = [...this.accounts.values()];

    const eligible = all.filter(a =>
      isAccountEligible(a, now),
    );

    if (eligible.length > 0) {
      if (this.strategy === 'fill-first') {
        const first = pickFillFirst(eligible, family);
        if (first) return first;
        // Every eligible account is at/below the floor — the terminal state
        // both strategies share. Fall through to max-headroom so the caller
        // still gets the least-drained account instead of null.
      }
      return pickMaxHeadroom(eligible, family);
    }

    // No seat is eligible. A seat parked inside a live window is not
    // re-probed: its 429 named the reset, the clock has not reached it, and a
    // probe there is one upstream round trip that can only 429 again — on the
    // dario#1244 gateway that was 500 probes of one seat inside a single
    // window, `rejectedCount` climbing by one each time and the operator
    // reading it as a seat that needed a re-login. The caller reads
    // `parkedUntil()` and answers the client itself; the seat returns on its
    // own when the window rolls (`rateLimitWindowPassed` makes it eligible
    // again). Auth-cooldown seats are skipped for the same reason: upstream
    // already rejected their tokens.
    //
    // What is left — a rejection with no stated reset (nothing to expire, so
    // asking is the only way back) or an expiring token — is tried least-used
    // first, as before.
    const probeable = all.filter(a => !isInAuthCooldown(a, now) && !isParkedInLiveWindow(a, now));
    if (probeable.length === 0) return null;
    return probeable.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
  }

  /**
   * When EVERY seat is parked inside a live rate-limit window: the epoch ms
   * the earliest window rolls, i.e. the moment the pool can serve again
   * without a probe. Null otherwise — including a pool mixing parked seats
   * with an auth-cooling or token-expired one, which is not "all seats over
   * their windows" and must not be reported (or cooled) as if it were; those
   * pools stay on the existing unavailable handling (dario#1244, and the
   * review on dario#1254 that caught the mixed case).
   */
  parkedUntil(now: number = Date.now()): number | null {
    if (this.accounts.size === 0) return null;
    const all = [...this.accounts.values()];
    if (!all.every(a => isParkedInLiveWindow(a, now))) return null;
    return Math.min(...all.map(a => a.rateLimit.reset * 1000));
  }

  /** Seats currently parked inside a live window (dario#1244). */
  parkedCount(now: number = Date.now()): number {
    return [...this.accounts.values()].filter(a => isParkedInLiveWindow(a, now)).length;
  }

  /**
   * Select with session stickiness. If `stickyKey` is already bound to a
   * healthy account (not rejected, token not near expiry, headroom > 2%),
   * return that account. Otherwise pick by headroom (`select()`) and
   * rebind the key to the chosen account. Null key bypasses stickiness
   * and delegates to `select()`.
   *
   * Rebinding also fires when the previously-bound account is marked
   * rejected (429) or has its headroom drop below 2% — at that point the
   * conversation's cache entry on the old account is effectively stranded
   * until reset anyway, so there's no cost to moving. The new account
   * starts building its own cache for this conversation from turn 1 of
   * the rebind.
   *
   * Also performs lazy cleanup of expired bindings (TTL or size cap).
   */
  selectSticky(stickyKey: string | null, family?: string | null, now: number = Date.now()): PoolAccount | null {
    if (!stickyKey) return this.select(family);
    this.cleanupSticky(now);

    const binding = this.sticky.get(stickyKey);
    if (binding) {
      const bound = this.accounts.get(binding.alias);
      if (bound
        && isAccountEligible(bound, now)
        && computeHeadroom(bound.rateLimit, family) > POOL_HEADROOM_FLOOR
      ) {
        // Refresh the idle timer. A session that keeps taking turns must never
        // be reaped or rebound while active — that would strand its warm prompt
        // cache — so the TTL is re-based to now on every hit.
        binding.lastUsedAt = now;
        return bound;
      }
    }

    const picked = this.select(family);
    if (picked) {
      this.sticky.set(stickyKey, { alias: picked.alias, boundAt: now, lastUsedAt: now });
    }
    return picked;
  }

  /**
   * Rebind a sticky key to a different account — called by proxy after an
   * in-request 429 failover moves to the next-best account. Without this
   * the next turn of the same conversation would re-select the exhausted
   * account via the stale binding, eat another 429, and failover again.
   */
  rebindSticky(stickyKey: string | null, alias: string): void {
    if (!stickyKey) return;
    if (!this.accounts.has(alias)) return;
    const now = Date.now();
    this.sticky.set(stickyKey, { alias, boundAt: now, lastUsedAt: now });
  }

  /**
   * Drop any binding that points at an account no longer in the pool, any
   * binding past the TTL, and if we're over the size cap drop the oldest
   * entries until we're back under. O(n) but n is small (capped at 2k)
   * and this only runs on selectSticky, not on every method.
   */
  private cleanupSticky(now: number = Date.now()): void {
    // TTL/orphan sweep is O(n); amortize it — run at most once per
    // STICKY_CLEANUP_INTERVAL_MS instead of on every selectSticky (#642-audit).
    // Stale bindings are never wrongly USED meanwhile: selectSticky re-validates
    // a binding's expiry/rejection/headroom before returning it.
    if (now - this.lastStickyCleanup >= STICKY_CLEANUP_INTERVAL_MS) {
      this.lastStickyCleanup = now;
      for (const [key, b] of this.sticky) {
        // Reap orphans (account gone) and bindings idle past the TTL. Idle is
        // measured from lastUsedAt, which selectSticky refreshes every turn, so
        // an actively-running conversation is never reaped here.
        if (!this.accounts.has(b.alias) || now - b.lastUsedAt > STICKY_IDLE_TTL_MS) {
          this.sticky.delete(key);
        }
      }
    }
    // Hard size cap always enforced (bounds memory). Batch-evict down to 80% so
    // the O(n log n) sort amortizes over many inserts rather than firing on every
    // new conversation at the cap (#642-audit). Evict least-recently-USED first
    // (true LRU): a binding's only value is its warm prompt cache, and the ones
    // untouched longest are the coldest — least worth keeping.
    if (this.sticky.size > STICKY_MAX_ENTRIES) {
      const target = Math.floor(STICKY_MAX_ENTRIES * 0.8);
      const sorted = [...this.sticky.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      const toDrop = sorted.slice(0, this.sticky.size - target);
      for (const [key] of toDrop) this.sticky.delete(key);
    }
  }

  /** Test/inspection helper — number of live sticky bindings. */
  stickyCount(): number {
    return this.sticky.size;
  }

  /** Test/inspection helper — current alias bound to a key, or null. */
  stickyAliasFor(stickyKey: string): string | null {
    return this.sticky.get(stickyKey)?.alias ?? null;
  }

  /** Select the next-best account, excluding the given set of aliases. */
  selectExcluding(excluded: Set<string>, family?: string | null): PoolAccount | null {
    if (this.accounts.size <= 1) return null;

    const now = Date.now();
    const candidates = [...this.accounts.values()].filter(a => !excluded.has(a.alias));

    const eligible = candidates.filter(a =>
      isAccountEligible(a, now),
    );

    if (eligible.length > 0) {
      // Fill-first failover keeps the fill order: the next account tried
      // after a 429 is the next alias in line, not the max-headroom seat —
      // otherwise a single failover would defeat the concentration the
      // strategy exists to provide.
      if (this.strategy === 'fill-first') {
        const first = pickFillFirst(eligible, family);
        if (first) return first;
      }
      return pickMaxHeadroom(eligible, family);
    }

    // Mid-flight: the seats a 429 could still hand this request to. A seat
    // parked inside a live window is not one of them — on the dario#1244
    // gateway every request walked all six parked seats, six guaranteed 429s
    // a request. Cool-downs are skipped for the same reason.
    const probeable = candidates.filter(a => !isInAuthCooldown(a, now) && !isParkedInLiveWindow(a, now));
    if (probeable.length > 0) {
      return probeable.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
    }

    return null;
  }

  updateRateLimits(alias: string, snapshot: RateLimitSnapshot): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.rateLimit = snapshot;
    account.adoptedFrom = undefined;
    account.requestCount++;
  }

  /**
   * Park `alias` on an upstream 429. Returns true when this takes a seat OUT
   * of rotation — the first 429 of a window — and false when the seat was
   * already parked inside a live window: the all-exhausted fallback in
   * `select()` re-probes parked seats, so a pool with nothing left can 429
   * the same seat many times, and only the transition is worth a log line.
   */
  markRejected(alias: string, snapshot: RateLimitSnapshot): boolean {
    const account = this.accounts.get(alias);
    if (!account) return false;
    const now = snapshot.updatedAt || Date.now();
    const wasParked = account.rateLimit.status === 'rejected' && !rateLimitWindowPassed(account.rateLimit, now);
    account.rateLimit = { ...snapshot, status: 'rejected' };
    account.adoptedFrom = undefined;
    account.rejectedCount++;
    account.lastRejectedAt = now;
    return !wasParked;
  }

  /**
   * Record the organization a response said this seat belongs to. Returns
   * true when it is news — the first observation, or a change (an alias
   * re-granted on another organization) — so the caller persists it once.
   */
  noteOrganization(alias: string, organizationId: string): boolean {
    const account = this.accounts.get(alias);
    if (!account || !organizationId || account.organizationId === organizationId) return false;
    account.organizationId = organizationId;
    return true;
  }

  /**
   * Take a peer instance's reading of `alias` (pool-sync.ts): its snapshot
   * replaces ours, `rejected` parks the seat on it. Counters are left alone
   * — a request the peer served or a 429 it took are the peer's facts — and
   * `adoptedFrom` records whose reading this is. False for an unknown alias.
   */
  adoptSnapshot(alias: string, snapshot: RateLimitSnapshot, rejected: boolean, from: string): boolean {
    const account = this.accounts.get(alias);
    if (!account) return false;
    account.rateLimit = rejected ? { ...snapshot, status: 'rejected' } : { ...snapshot };
    account.adoptedFrom = from;
    return true;
  }

  updateTokens(alias: string, accessToken: string, refreshToken: string, expiresAt: number): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.accessToken = accessToken;
    account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
  }

  get(alias: string): PoolAccount | undefined {
    return this.accounts.get(alias);
  }

  all(): PoolAccount[] {
    return [...this.accounts.values()];
  }

  status(): PoolStatus {
    const all = this.all();
    const now = Date.now();
    const healthy = all.filter(a =>
      isAccountEligible(a, now),
    );
    // Status is a pool-wide aggregate; family-agnostic. Per-model
    // headroom is request-context-specific and only meaningful at
    // select() time.
    const headrooms = all.map(a => computeHeadroom(a.rateLimit));
    const avgHeadroom = headrooms.length > 0 ? headrooms.reduce((a, b) => a + b, 0) / headrooms.length : 0;
    const best = this.select();

    return {
      accounts: all.length,
      healthy: healthy.length,
      exhausted: all.length - healthy.length,
      totalHeadroom: Math.round(avgHeadroom * 100),
      bestAccount: best?.alias ?? 'none',
      queued: this.queue.length,
    };
  }

  /**
   * Wait for an available account. If all accounts are exhausted, queues
   * the request and resolves when an account becomes available via
   * updateRateLimits reducing utilization below threshold.
   */
  async waitForAccount(): Promise<PoolAccount> {
    const immediate = this.select();
    if (immediate) {
      const headroom = computeHeadroom(immediate.rateLimit);
      if (headroom > POOL_HEADROOM_FLOOR) return immediate;
    }

    if (this.queue.length >= this.queueMaxSize) {
      throw new Error('Queue full — all accounts exhausted');
    }

    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => this.drainQueue(), 5_000);
      this.drainTimer.unref();
    }

    return new Promise<PoolAccount>((resolve, reject) => {
      const entry: QueuedRequest = { resolve, reject, enqueuedAt: Date.now() };
      this.queue.push(entry);

      setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error('Queue timeout — no accounts available within 60s'));
        }
      }, this.queueTimeoutMs);
    });
  }

  private drainQueue(): void {
    if (this.queue.length === 0) {
      if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
      return;
    }

    const now = Date.now();
    this.queue = this.queue.filter(entry => {
      if (now - entry.enqueuedAt > this.queueTimeoutMs) {
        entry.reject(new Error('Queue timeout — no accounts available within 60s'));
        return false;
      }
      return true;
    });

    while (this.queue.length > 0) {
      const account = this.select();
      if (!account) break;
      const headroom = computeHeadroom(account.rateLimit);
      if (headroom <= POOL_HEADROOM_FLOOR) break;

      const entry = this.queue.shift();
      if (entry) entry.resolve(account);
    }

    if (this.queue.length === 0 && this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

/** Minimal account shape the pool needs to route — a structural subset of
 *  accounts.ts' AccountCredentials, declared here to keep pool.ts dependency-free. */
export interface ReconcilableAccount {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceId: string;
  accountUuid: string;
  grantedAt?: number;
  organizationId?: string;
}

/**
 * Reconcile a live pool against the current on-disk account set: add or refresh
 * the tokens of every account that exists on disk, and drop any the pool still
 * holds that no longer does. `add` preserves a known alias's rate-limit and
 * identity state, so re-adding an unchanged account is a cheap token refresh
 * rather than a reset.
 *
 * This is the hot-reload primitive behind the headless admin API (#599): the
 * proxy calls it from `onAccountsChanged` so accounts provisioned or removed
 * over HTTP take effect immediately, with no proxy restart. Returns the pool
 * size after reconciliation.
 */
export function reconcilePoolAccounts(pool: AccountPool, accounts: ReconcilableAccount[]): number {
  const wanted = new Set(accounts.map(a => a.alias));
  for (const a of accounts) {
    pool.add(a.alias, {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      deviceId: a.deviceId,
      accountUuid: a.accountUuid,
      grantedAt: a.grantedAt,
      organizationId: a.organizationId,
    });
  }
  for (const existing of pool.all()) {
    if (!wanted.has(existing.alias)) pool.remove(existing.alias);
  }
  return pool.size;
}

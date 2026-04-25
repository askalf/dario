/**
 * Account pool — rate limit tracking, headroom routing, failover.
 *
 * Activated automatically when `~/.dario/accounts/` contains 2+ accounts.
 * Single-account dario (`~/.dario/credentials.json`) keeps the same code
 * path it has always had; the pool only runs when there are multiple
 * accounts to distribute against.
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

export interface PoolAccount {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: AccountIdentity;
  rateLimit: RateLimitSnapshot;
  requestCount: number;
}

export interface PoolStatus {
  accounts: number;
  healthy: number;
  exhausted: number;
  totalHeadroom: number;
  bestAccount: string;
  queued: number;
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
 * Extract the model family (`opus` / `sonnet` / `haiku`) from a request's
 * model id. Used to look up the per-model 7d bucket in
 * `RateLimitSnapshot.perModel7d` during routing decisions. Returns null
 * for non-Claude models or model ids that don't carry a recognizable
 * family token (those requests just use the unified buckets).
 *
 * Generous on input shape: matches `claude-opus-4-7`, `opus`, `claude-3-7-sonnet-…`,
 * `claude-haiku-4-5`, anything containing the family token. Lowercase-normalized
 * so it pairs cleanly with `parseRateLimits`'s lowercase family keys.
 */
export function modelFamily(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
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
 * exhausted / rejected. The 6-hour TTL matches the Max plan's five-hour
 * rate-limit window plus a buffer — past that point a "same" conversation
 * would be starting a fresh window anyway, so rebinding is free.
 */
interface StickyBinding {
  alias: string;
  boundAt: number;
}
const STICKY_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const STICKY_MAX_ENTRIES = 2_000;          // lazy cleanup cap

/**
 * Headroom floor under which an account is treated as "effectively exhausted"
 * for routing decisions. A sticky binding whose account drops below this
 * threshold gets rebound on the next request; the round-robin selector skips
 * accounts below this threshold when picking the next-best slot; the probe
 * loop stops once every candidate is below it. 0.02 == 2%.
 */
const POOL_HEADROOM_FLOOR = 0.02;

export class AccountPool {
  private accounts: Map<string, PoolAccount> = new Map();
  private queue: QueuedRequest[] = [];
  private queueMaxSize = 50;
  private queueTimeoutMs = 60_000;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private sticky: Map<string, StickyBinding> = new Map();

  add(alias: string, opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    deviceId: string;
    accountUuid: string;
  }): void {
    const existing = this.accounts.get(alias);
    this.accounts.set(alias, {
      alias,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
      identity: existing?.identity ?? {
        deviceId: opts.deviceId,
        accountUuid: opts.accountUuid,
        sessionId: randomUUID(),
      },
      rateLimit: existing?.rateLimit ?? { ...EMPTY_SNAPSHOT },
      requestCount: existing?.requestCount ?? 0,
    });
  }

  remove(alias: string): boolean {
    return this.accounts.delete(alias);
  }

  get size(): number {
    return this.accounts.size;
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
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );

    if (eligible.length > 0) {
      return eligible.reduce((best, curr) => {
        const bestHeadroom = computeHeadroom(best.rateLimit, family);
        const currHeadroom = computeHeadroom(curr.rateLimit, family);
        return currHeadroom > bestHeadroom ? curr : best;
      });
    }

    // All accounts exhausted — return the one with the earliest reset
    const withReset = all.filter(a => a.rateLimit.reset > 0);
    if (withReset.length > 0) {
      return withReset.reduce((a, b) => a.rateLimit.reset < b.rateLimit.reset ? a : b);
    }

    // No rate-limit data at all — least-used first
    return all.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
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
  selectSticky(stickyKey: string | null, family?: string | null): PoolAccount | null {
    if (!stickyKey) return this.select(family);
    this.cleanupSticky();

    const binding = this.sticky.get(stickyKey);
    if (binding) {
      const bound = this.accounts.get(binding.alias);
      const now = Date.now();
      if (bound
        && bound.rateLimit.status !== 'rejected'
        && bound.expiresAt > now + 30_000
        && computeHeadroom(bound.rateLimit, family) > POOL_HEADROOM_FLOOR
      ) {
        return bound;
      }
    }

    const picked = this.select(family);
    if (picked) {
      this.sticky.set(stickyKey, { alias: picked.alias, boundAt: Date.now() });
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
    this.sticky.set(stickyKey, { alias, boundAt: Date.now() });
  }

  /**
   * Drop any binding that points at an account no longer in the pool, any
   * binding past the TTL, and if we're over the size cap drop the oldest
   * entries until we're back under. O(n) but n is small (capped at 2k)
   * and this only runs on selectSticky, not on every method.
   */
  private cleanupSticky(): void {
    const now = Date.now();
    for (const [key, b] of this.sticky) {
      if (!this.accounts.has(b.alias) || now - b.boundAt > STICKY_TTL_MS) {
        this.sticky.delete(key);
      }
    }
    if (this.sticky.size > STICKY_MAX_ENTRIES) {
      const sorted = [...this.sticky.entries()].sort((a, b) => a[1].boundAt - b[1].boundAt);
      const toDrop = sorted.slice(0, this.sticky.size - STICKY_MAX_ENTRIES);
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
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );

    if (eligible.length > 0) {
      return eligible.reduce((best, curr) => {
        const bestHeadroom = computeHeadroom(best.rateLimit, family);
        const currHeadroom = computeHeadroom(curr.rateLimit, family);
        return currHeadroom > bestHeadroom ? curr : best;
      });
    }

    if (candidates.length > 0) {
      return candidates.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
    }

    return null;
  }

  updateRateLimits(alias: string, snapshot: RateLimitSnapshot): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.rateLimit = snapshot;
    account.requestCount++;
  }

  markRejected(alias: string, snapshot: RateLimitSnapshot): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.rateLimit = { ...snapshot, status: 'rejected' };
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
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
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

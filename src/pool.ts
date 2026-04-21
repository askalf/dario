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

/** Parse an Anthropic response's rate-limit headers into a snapshot. */
export function parseRateLimits(headers: Headers): RateLimitSnapshot {
  const get = (key: string) => headers.get(`anthropic-ratelimit-unified-${key}`) ?? '';
  return {
    status: get('status') || 'unknown',
    util5h: parseFloat(get('5h-utilization')) || 0,
    util7d: parseFloat(get('7d-utilization')) || 0,
    overageUtil: parseFloat(get('overage-utilization')) || 0,
    claim: get('representative-claim') || 'unknown',
    reset: parseInt(get('reset')) || 0,
    fallbackPct: parseFloat(get('fallback-percentage')) || 0,
    updatedAt: Date.now(),
  };
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

  /** Select the best account for the next request. */
  select(): PoolAccount | null {
    if (this.accounts.size === 0) return null;

    const now = Date.now();
    const all = [...this.accounts.values()];

    const eligible = all.filter(a =>
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );

    if (eligible.length > 0) {
      return eligible.reduce((best, curr) => {
        const bestHeadroom = 1 - Math.max(best.rateLimit.util5h, best.rateLimit.util7d);
        const currHeadroom = 1 - Math.max(curr.rateLimit.util5h, curr.rateLimit.util7d);
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
  selectSticky(stickyKey: string | null): PoolAccount | null {
    if (!stickyKey) return this.select();
    this.cleanupSticky();

    const binding = this.sticky.get(stickyKey);
    if (binding) {
      const bound = this.accounts.get(binding.alias);
      const now = Date.now();
      if (bound
        && bound.rateLimit.status !== 'rejected'
        && bound.expiresAt > now + 30_000
        && (1 - Math.max(bound.rateLimit.util5h, bound.rateLimit.util7d)) > POOL_HEADROOM_FLOOR
      ) {
        return bound;
      }
    }

    const picked = this.select();
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
  selectExcluding(excluded: Set<string>): PoolAccount | null {
    if (this.accounts.size <= 1) return null;

    const now = Date.now();
    const candidates = [...this.accounts.values()].filter(a => !excluded.has(a.alias));

    const eligible = candidates.filter(a =>
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );

    if (eligible.length > 0) {
      return eligible.reduce((best, curr) => {
        const bestHeadroom = 1 - Math.max(best.rateLimit.util5h, best.rateLimit.util7d);
        const currHeadroom = 1 - Math.max(curr.rateLimit.util5h, curr.rateLimit.util7d);
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
    const headrooms = all.map(a => 1 - Math.max(a.rateLimit.util5h, a.rateLimit.util7d));
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
      const headroom = 1 - Math.max(immediate.rateLimit.util5h, immediate.rateLimit.util7d);
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
      const headroom = 1 - Math.max(account.rateLimit.util5h, account.rateLimit.util7d);
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

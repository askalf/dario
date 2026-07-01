/**
 * Minimal token-bucket rate limiter (#620).
 *
 * Zero-dependency, in-memory, monotonic-time refill. Used to throttle the
 * admin API's mutations and repeated auth failures (src/admin-api.ts), but
 * kept generic. The clock is injectable so the refill math is deterministic
 * under test — no `sleep`.
 *
 * `tryRemove()` consumes one token if any are available; `retryAfterMs()`
 * reports how long until the next token, for a `Retry-After` header.
 */
export interface RateLimiter {
  /** Consume one token. Returns true if allowed, false if the bucket is empty. */
  tryRemove(nowMs?: number): boolean;
  /** Milliseconds until at least one token is available (0 if available now). */
  retryAfterMs(nowMs?: number): number;
}

/**
 * @param capacity     max tokens (burst size); also the starting fill.
 * @param refillPerSec tokens added per second (fractional allowed).
 * @param now          clock in ms; injectable for tests.
 */
export function createTokenBucket(
  capacity: number,
  refillPerSec: number,
  now: () => number = Date.now,
): RateLimiter {
  let tokens = capacity;
  let last = now();

  function refill(t: number): void {
    if (t <= last) return; // clock didn't advance — nothing to add
    tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
    last = t;
  }

  return {
    tryRemove(nowMs = now()): boolean {
      refill(nowMs);
      if (tokens >= 1) { tokens -= 1; return true; }
      return false;
    },
    retryAfterMs(nowMs = now()): number {
      refill(nowMs);
      if (tokens >= 1) return 0;
      if (refillPerSec <= 0) return Infinity; // never refills
      return Math.ceil(((1 - tokens) / refillPerSec) * 1000);
    },
  };
}

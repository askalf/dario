/**
 * Per-provider rate-limit cool-down for the failover chain (DEV-f66b131c).
 *
 * The chain used to have no memory. Every 429 was a fresh discovery, so with
 * BOTH ends capped — a spent Claude 5h window and a 429-ing ChatGPT
 * subscription — one request walked codex → claude → codex before dropping,
 * and the next request did it again. 185 such lines in 38 minutes on
 * 2026-09-02. That is the wrong shape twice over: at the moment quota is the
 * scarce resource the chain spends TWICE as much of it discovering there is
 * none, and whatever is cycling when a window rolls over consumes the fresh
 * window ahead of legitimately queued work.
 *
 * Two rules, both enforced here so the request path can stay a straight line:
 *
 *   WITHIN a request  — an entry that already declined is never revisited
 *                       ({@link canAttempt} against the attempted set).
 *   ACROSS requests   — a 429 cools the entry for a bounded interval, honouring
 *                       `retry-after` when the upstream sends one.
 *
 * When every entry is cooled the caller fails fast with one terminal verdict
 * instead of a retry storm — see {@link allProvidersCooled}.
 *
 * Provider-granular, not entry-granular: a chain names MODELS
 * (`gpt-5.6-sol,claude-sonnet-5`) but a 429 is a property of the ACCOUNT
 * behind them, so cooling `codex` also cools every other codex slug in the
 * chain, which is the correct blast radius.
 *
 * The clock is injectable so the whole thing is testable without sleeping.
 */

/** Cool-down applied when the upstream gives no `retry-after`. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Ceiling on any cool-down. An upstream is free to say "come back in 4 hours";
 * honouring that literally would keep a provider parked long after a window
 * reset we cannot observe. One re-probe per 15 minutes is cheap.
 */
export const MAX_COOLDOWN_MS = 15 * 60_000;

/** Machine-readable terminal verdict. Distinct from `pool exhausted` (which
 *  implies a peer exists) and from the billing/credential classes. */
export const ALL_PROVIDERS_RATE_LIMITED = 'all-providers-rate-limited';

/**
 * `retry-after` as milliseconds. The header is either delta-seconds or an
 * HTTP-date (RFC 9110 §10.2.3); both are accepted, anything else is null so
 * the caller falls back to its default rather than trusting a parse it did not
 * get. A date already in the past yields 0 — "retry now" — not a negative.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_COOLDOWN_MS);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_COOLDOWN_MS);
}

/** A provider that declined, and for how long it should stay declined. */
export class ProviderCooldowns {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly defaultMs: number = DEFAULT_COOLDOWN_MS,
  ) {}

  /**
   * Record a 429 (or an equivalent "not right now") for `provider`. Returns the
   * cool-down actually applied, so the caller can put it in its one log line.
   * A `retryAfterMs` of 0 is honoured as "retry now" and cools nothing.
   */
  note(provider: string, retryAfterMs?: number | null): number {
    const ms = retryAfterMs == null ? this.defaultMs : Math.min(Math.max(retryAfterMs, 0), MAX_COOLDOWN_MS);
    this.until.set(provider, this.now() + ms);
    return ms;
  }

  /** Clear on a success — a provider that just served is not rate-limited. */
  clear(provider: string): void {
    this.until.delete(provider);
  }

  remainingMs(provider: string): number {
    const at = this.until.get(provider);
    if (at == null) return 0;
    const left = at - this.now();
    if (left <= 0) {
      // Expired entries are dropped on read; nothing else sweeps this map and
      // a long-lived proxy would otherwise accumulate one entry per provider
      // forever (bounded, but pointlessly).
      this.until.delete(provider);
      return 0;
    }
    return left;
  }

  isCooled(provider: string): boolean {
    return this.remainingMs(provider) > 0;
  }
}

/**
 * May this request try `provider`? False when it already declined during THIS
 * request (the codex → claude → codex revisit) or when it is cooling from an
 * earlier one.
 */
export function canAttempt(
  provider: string,
  attempted: ReadonlySet<string>,
  cooldowns: ProviderCooldowns,
): boolean {
  return !attempted.has(provider) && !cooldowns.isCooled(provider);
}

/**
 * Every named provider is cooling — the fail-fast condition. An EMPTY list is
 * NOT "all cooled": nothing configured is a configuration answer, not a rate
 * limit, and must keep its existing message.
 */
export function allProvidersCooled(providers: readonly string[], cooldowns: ProviderCooldowns): boolean {
  return providers.length > 0 && providers.every(p => cooldowns.isCooled(p));
}

/** Longest remaining cool-down across `providers` — what to put in `retry-after`. */
export function cooldownRetryAfterMs(providers: readonly string[], cooldowns: ProviderCooldowns): number {
  return providers.reduce((max, p) => Math.max(max, cooldowns.remainingMs(p)), 0);
}

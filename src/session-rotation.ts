/**
 * Session-ID lifecycle (v3.28, direction #1 — interactive-side rotation).
 *
 * Every outbound request to Anthropic carries a session identifier in the
 * CC request body's metadata. Real Claude Code holds that id stable through
 * a conversation and mints a new one when the user returns after an idle
 * gap — roughly "one id per conversation", not per HTTP call. A proxy that
 * rotates per-request looks synthetic; one that never rotates looks equally
 * synthetic over long sessions. v3.19 tightened the per-request leak into a
 * single hardcoded 15-minute idle window; this module generalises that into
 * a registry so operators can tune the behaviour and so the multi-client
 * case (dario fanning multiple UIs through one proxy) stops sharing one id.
 *
 * Three independent knobs:
 *
 *   idleRotateMs — the v3.19 behaviour: rotate after this many ms of no
 *                  traffic on a given session. Default 15 min preserves
 *                  v3.27 exactly when the other knobs stay at defaults.
 *
 *   jitterMs     — the observable idle threshold for a given session is
 *                  idleRotateMs + U(0, jitterMs), sampled once at session
 *                  creation. A zero-jitter proxy rotates at exactly the
 *                  same interval every time; adding jitter means the floor
 *                  can't be inferred from long-run rotation cadence.
 *
 *   maxAgeMs     — hard cap on a session's total lifetime regardless of
 *                  activity. Optional (undefined disables). A chatty
 *                  always-on pipeline would otherwise keep one session id
 *                  alive for days; real CC conversations don't.
 *
 *   perClient    — when true, the registry keys sessions by the caller's
 *                  `x-session-id` / `x-client-session-id` header so two
 *                  upstream UIs talking to one dario don't collapse onto
 *                  a single session id. Default false preserves v3.27
 *                  single-account semantics.
 *
 * Pure logic (decideSessionRotation) is separated from the stateful cache
 * (SessionRegistry) so tests can walk every decision branch without Maps,
 * timers, or UUID sources. The proxy injects a `() => string` id factory
 * (randomUUID) and `() => number` rng so both are swappable in tests.
 *
 * v5.0 (pool-as-primitive): this registry is now the ONE session-id mechanism.
 * Every request carries an `accountKey` — the selected pool account's alias
 * (or a synthetic key in upstream-api-key mode) — so each account keeps its
 * own idle/jitter/max-age lifecycle. The caller passes the account's minted
 * `identity.sessionId` as a `seedId`, used only for that account's first
 * session so the first request stays byte-identical to the pre-v5 stable id;
 * idle/age rotation then mints fresh ids via `newId()`. `perClient` still
 * sub-partitions each account's sessions by the caller's session header.
 */

export interface SessionRotationConfig {
  /** Idle threshold in ms: if no traffic for this long, the session rotates on the next request. */
  idleRotateMs: number;
  /** Max additional uniform-random ms added to the idle threshold at session creation. Pass 0 to disable. */
  jitterMs: number;
  /** Optional hard cap on session lifetime in ms. Undefined = no cap. */
  maxAgeMs?: number;
  /** When true, key sessions by client header so multiple upstreams get distinct ids. Default false. */
  perClient: boolean;
}

export interface SessionEntry {
  /** The session id sent to Anthropic in the outbound body. */
  upstreamSessionId: string;
  /** Wall-clock creation time (ms since epoch). */
  createdAt: number;
  /** Wall-clock time of last outbound use (ms since epoch). */
  lastUsedAt: number;
  /** Jitter offset sampled once at creation; added to cfg.idleRotateMs to get this session's effective idle threshold. */
  idleJitterOffsetMs: number;
}

export type RotationDecision = 'keep' | 'rotate-new' | 'rotate-idle' | 'rotate-age';

/**
 * Pure decision: should the given entry be rotated at `now`?
 *
 * Returns 'rotate-new' when no entry exists yet (first use for this key).
 * Returns 'rotate-idle' when traffic has been silent for longer than this
 * entry's sampled threshold. Returns 'rotate-age' when the entry's
 * absolute lifetime exceeds cfg.maxAgeMs (when set). Otherwise 'keep'.
 *
 * Idle is checked before age so an idle-but-young session rotates on a
 * fresh conversation boundary rather than churning mid-conversation at
 * exactly its max-age. Negative config values are clamped to 0 (lenient:
 * a typoed flag should behave like "rotate eagerly", not crash startup).
 */
export function decideSessionRotation(
  entry: SessionEntry | undefined,
  now: number,
  cfg: SessionRotationConfig,
): RotationDecision {
  if (!entry) return 'rotate-new';
  const idleBase = Math.max(0, cfg.idleRotateMs);
  const idleThreshold = idleBase + Math.max(0, entry.idleJitterOffsetMs);
  if (now - entry.lastUsedAt > idleThreshold) return 'rotate-idle';
  if (cfg.maxAgeMs !== undefined && cfg.maxAgeMs > 0 && now - entry.createdAt > cfg.maxAgeMs) {
    return 'rotate-age';
  }
  return 'keep';
}

/** Result of SessionRegistry.getOrCreate — both the id to send and why it was chosen. */
export interface RegistryResult {
  sessionId: string;
  rotated: boolean;
  reason: RotationDecision;
}

/**
 * Per-client session cache with rotation + LRU eviction.
 *
 * Not concurrency-safe — the proxy's dispatch loop is single-threaded
 * JavaScript and call sites are serialized by the event loop. The
 * registry is intentionally a plain Map, not a TTL cache, because
 * rotation timing is part of the observable behaviour we're modelling
 * and a background sweeper would add a separate dimension (WHEN entries
 * disappear) that doesn't exist in a real CC client.
 *
 * maxEntries defaults to 1024 — more than enough for any reasonable
 * fan-out while capping memory growth against a pathological client
 * that sends a fresh session header on every request.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(
    private readonly cfg: SessionRotationConfig,
    private readonly newId: () => string,
    private readonly rng: () => number = Math.random,
    private readonly maxEntries: number = 1024,
  ) {}

  /**
   * Resolve the outbound session id for a given account + client key at `now`.
   *
   * `accountKey` partitions sessions by the selected pool account so each
   * account rotates on its own idle timer. `clientKey` is the caller-side
   * session header, added as a sub-partition only when cfg.perClient is true
   * (ignored otherwise). Callers pass the raw header value and let the registry
   * decide — otherwise flipping perClient at runtime would require threading
   * the decision to every call site.
   *
   * `seedId`, when provided, is used as the session id only on the FIRST
   * creation for a key (decision === 'rotate-new'): it lets the caller carry a
   * pre-minted id (the account's identity.sessionId) into the registry so the
   * account's first request is byte-identical to the pre-v5 stable id. Idle /
   * age rotations ignore the seed and mint a fresh id via newId().
   *
   * Updates lastUsedAt on the entry (whether kept or freshly minted),
   * and nudges the entry to the end of the insertion-order map so
   * eviction under maxEntries pressure is LRU.
   */
  getOrCreate(accountKey: string, clientKey: string | undefined, now: number, seedId?: string): RegistryResult {
    const key = this.cfg.perClient
      ? `${accountKey}\u0000${clientKey && clientKey.length > 0 ? clientKey : 'default'}`
      : accountKey;
    const existing = this.entries.get(key);
    const decision = decideSessionRotation(existing, now, this.cfg);
    if (decision === 'keep' && existing) {
      existing.lastUsedAt = now;
      // Re-insert to refresh LRU position.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return { sessionId: existing.upstreamSessionId, rotated: false, reason: 'keep' };
    }
    const jitterOffset = this.cfg.jitterMs > 0 ? Math.floor(this.rng() * this.cfg.jitterMs) : 0;
    const entry: SessionEntry = {
      // Seed only a brand-new key; a rotation (idle/age) always mints fresh.
      upstreamSessionId: decision === 'rotate-new' && seedId ? seedId : this.newId(),
      createdAt: now,
      lastUsedAt: now,
      idleJitterOffsetMs: jitterOffset,
    };
    this.entries.set(key, entry);
    this.evictIfOverCap();
    return { sessionId: entry.upstreamSessionId, rotated: true, reason: decision };
  }

  /**
   * Read the current id for a client key without touching lastUsedAt.
   *
   * Used by out-of-band consumers (e.g. presence pings) that want to
   * reflect the most recently assigned session id but must not count
   * as activity for rotation purposes. Returns undefined if no entry.
   */
  peek(accountKey: string, clientKey: string | undefined): string | undefined {
    const key = this.cfg.perClient
      ? `${accountKey}\u0000${clientKey && clientKey.length > 0 ? clientKey : 'default'}`
      : accountKey;
    return this.entries.get(key)?.upstreamSessionId;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIfOverCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Resolve a SessionRotationConfig from explicit options, env vars, and defaults.
 *
 * Precedence (highest first):
 *   1. Explicit argument (typically from CLI flag)
 *   2. DARIO_SESSION_IDLE_ROTATE_MS / DARIO_SESSION_JITTER_MS /
 *      DARIO_SESSION_MAX_AGE_MS / DARIO_SESSION_PER_CLIENT env vars
 *   3. Defaults: idleRotateMs=15min, jitterMs=0, maxAgeMs=undefined,
 *      perClient=false — exactly matches the hardcoded v3.27 behaviour.
 *
 * Invalid numeric strings fall through to the next source. For perClient,
 * '1' / 'true' / 'yes' (case-insensitive) enable; anything else stays at
 * the explicit or default value.
 */
export function resolveSessionRotationConfig(
  explicit: { idleRotateMs?: number; jitterMs?: number; maxAgeMs?: number; perClient?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): SessionRotationConfig {
  const idleRotateMs = pickNonNegativeInt(
    explicit.idleRotateMs,
    env.DARIO_SESSION_IDLE_ROTATE_MS,
  ) ?? 15 * 60 * 1000;
  const jitterMs = pickNonNegativeInt(
    explicit.jitterMs,
    env.DARIO_SESSION_JITTER_MS,
  ) ?? 0;
  const maxAgeMs = pickPositiveInt(
    explicit.maxAgeMs,
    env.DARIO_SESSION_MAX_AGE_MS,
  );
  const perClient = pickBool(explicit.perClient, env.DARIO_SESSION_PER_CLIENT) ?? false;
  return { idleRotateMs, jitterMs, maxAgeMs, perClient };
}

function pickNonNegativeInt(...candidates: (number | string | undefined)[]): number | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = typeof c === 'number' ? c : parseInt(c, 10);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

function pickPositiveInt(...candidates: (number | string | undefined)[]): number | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = typeof c === 'number' ? c : parseInt(c, 10);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function pickBool(...candidates: (boolean | string | undefined)[]): boolean | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === 'boolean') return c;
    const s = c.trim().toLowerCase();
    if (s === '') continue;
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  }
  return undefined;
}

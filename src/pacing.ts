/**
 * Inter-request pacing (v3.24, direction #6 — behavioral smoothing).
 *
 * Real CC traffic has human-paced gaps between requests — sub-second when
 * the model is streaming tool-loop output, multi-second when the user is
 * typing the next message. A proxy that fires requests at machine speed
 * with perfectly uniform spacing stands out against that rhythm.
 *
 * This module supplies the pure gap-calculation function the proxy's
 * rate governor calls before every outbound fetch. Two knobs:
 *
 *   minGapMs    — lower bound on the wall-clock distance between requests.
 *                 Was a hardcoded 500ms through v3.23; keep 500 as default
 *                 so back-compat is exact when both knobs stay at defaults.
 *
 *   jitterMs    — uniform random addition on top of minGap. The *effective*
 *                 gap for a given request is minGap + U(0, jitter). Adds
 *                 non-uniformity so an observer can't infer the floor from
 *                 the long-run minimum of inter-arrival times.
 *
 * Pure over (now, lastRequestTime, minGap, jitter, rng) so the tests can
 * exercise every edge without spawning timers. The proxy passes
 * `Math.random` as the rng at runtime; tests pass a deterministic stub.
 *
 * The first request in a session (lastRequestTime === 0) is never paced —
 * the purpose is smoothing the *gap between* requests, not delaying the
 * first one from whenever the consumer happens to connect.
 */

export interface PacingConfig {
  /** Minimum wall-clock milliseconds between the completion of one request and the start of the next. */
  minGapMs: number;
  /** Max additional uniform-random jitter (ms) added on top of minGap. Pass 0 to disable. */
  jitterMs: number;
}

/**
 * How many milliseconds to sleep before the next upstream fetch.
 *
 * Returns 0 when no delay is required — either because this is the first
 * request of the session, or enough wall-clock time has already elapsed
 * since `lastRequestTime`.
 *
 * `rng` defaults to Math.random; tests inject a deterministic stub.
 * Negative configuration values are clamped to 0 (lenient, not an error).
 */
export function computePacingDelay(
  now: number,
  lastRequestTime: number,
  cfg: PacingConfig,
  rng: () => number = Math.random,
): number {
  if (lastRequestTime <= 0) return 0;
  const minGap = Math.max(0, cfg.minGapMs);
  const jitter = Math.max(0, cfg.jitterMs);
  const jitterAdd = jitter > 0 ? Math.floor(rng() * jitter) : 0;
  const effectiveGap = minGap + jitterAdd;
  const elapsed = now - lastRequestTime;
  if (elapsed >= effectiveGap) return 0;
  return effectiveGap - elapsed;
}

/**
 * Resolve a PacingConfig from explicit options, env vars, and defaults.
 *
 * Precedence (highest first):
 *   1. Explicit argument (typically from CLI flag)
 *   2. DARIO_PACE_MIN_MS / DARIO_PACE_JITTER_MS env vars
 *   3. Legacy DARIO_MIN_INTERVAL_MS env var (minGap only — matches v3.23
 *      behavior so existing setups don't regress silently)
 *   4. Defaults: minGap=500, jitter=0 (or jitter=300 under stealth)
 *
 * `stealth` enables a behavioral-stealth preset: when true and the
 * specific knob isn't overridden by explicit/env, fall through to a
 * non-zero default that adds inter-request jitter. The minGap floor is
 * already 500ms by default and isn't touched.
 *
 * Invalid strings (non-numeric, negative) are ignored and fall through to
 * the next source — a typoed env var shouldn't fail-loud at startup.
 */
export function resolvePacingConfig(
  explicit: { minGapMs?: number; jitterMs?: number; stealth?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): PacingConfig {
  const stealth = explicit.stealth === true;
  const minGap = pickNonNegativeInt(
    explicit.minGapMs,
    env.DARIO_PACE_MIN_MS,
    env.DARIO_MIN_INTERVAL_MS,
  ) ?? 500;
  const jitter = pickNonNegativeInt(
    explicit.jitterMs,
    env.DARIO_PACE_JITTER_MS,
  ) ?? (stealth ? 300 : 0);
  return { minGapMs: minGap, jitterMs: jitter };
}

function pickNonNegativeInt(...candidates: (number | string | undefined)[]): number | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = typeof c === 'number' ? c : parseInt(c, 10);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * Post-response "think time" simulation (behavioral smoothing extension).
 *
 * Inter-request `computePacingDelay` enforces a floor on the wall-clock
 * distance between two outbound requests. Think time models the
 * orthogonal axis: how long a real interactive Claude Code user would
 * spend reading a response before sending the next message. Without it,
 * agentic loops fire the next request as fast as the client can stamp
 * one out, which creates an inter-arrival distribution that's
 * structurally absent in real interactive sessions (read-then-type has
 * variance correlated with response length; agent loops don't).
 *
 *   delay = baseMs + perTokenMs * lastResponseTokens + U(0, jitterMs)
 *
 * Then clamped to [0, maxMs] and reduced by elapsed time since the
 * response completed (so a slow downstream consumer doesn't double-pay).
 *
 * `lastResponseTime === 0` returns 0 — there's no response to read on
 * the first request of a session. Session-start jitter is a separate
 * function (`computeSessionStartDelay`) since it has different semantics.
 */
export interface ThinkTimeConfig {
  /** Constant ms added to every think-time sample, regardless of tokens. */
  baseMs: number;
  /** Additional ms per output token of the previous response (linear). */
  perTokenMs: number;
  /** Max uniform-random jitter (ms) added on top. */
  jitterMs: number;
  /** Upper bound on think time. Prevents pathological pauses on very long responses. */
  maxMs: number;
}

export function computeThinkTimeDelay(
  now: number,
  lastResponseTime: number,
  lastResponseTokens: number,
  cfg: ThinkTimeConfig,
  rng: () => number = Math.random,
): number {
  if (lastResponseTime <= 0) return 0;
  const base = Math.max(0, cfg.baseMs);
  const perToken = Math.max(0, cfg.perTokenMs);
  const jitter = Math.max(0, cfg.jitterMs);
  const max = Math.max(0, cfg.maxMs);
  const tokens = Math.max(0, lastResponseTokens);
  // Short-circuit when all knobs are zero — avoids unnecessary rng calls
  // and the elapsed-time math on the hot path when think time is off.
  if (base === 0 && perToken === 0 && jitter === 0) return 0;
  const jitterAdd = jitter > 0 ? Math.floor(rng() * jitter) : 0;
  let target = base + perToken * tokens + jitterAdd;
  if (max > 0 && target > max) target = max;
  const elapsed = now - lastResponseTime;
  if (elapsed >= target) return 0;
  return target - elapsed;
}

/**
 * Resolve a ThinkTimeConfig from explicit options, env vars, and
 * defaults. All defaults are 0 — feature is opt-in. `maxMs` defaults to
 * 30000 (30s) when any think-time knob is enabled and the user hasn't
 * set their own cap; on a fully-disabled config the cap doesn't matter
 * since the short-circuit above returns 0 first.
 */
export function resolveThinkTimeConfig(
  explicit: { baseMs?: number; perTokenMs?: number; jitterMs?: number; maxMs?: number; stealth?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): ThinkTimeConfig {
  // Behavioral-stealth preset: when `stealth` is on and the specific
  // knob isn't overridden by explicit/env, fall through to non-zero
  // defaults sized for typical interactive CC pacing — ~800ms minimum
  // read time, ~4ms per output token (skimming speed), ±1500ms jitter,
  // capped at 25s so a 5000-token response doesn't pause for half a
  // minute. Defaults all stay 0 (off) when stealth isn't set.
  const stealth = explicit.stealth === true;
  const base = pickNonNegativeInt(explicit.baseMs, env.DARIO_THINK_TIME_BASE_MS) ?? (stealth ? 800 : 0);
  const perToken = pickNonNegativeInt(explicit.perTokenMs, env.DARIO_THINK_TIME_PER_TOKEN_MS) ?? (stealth ? 4 : 0);
  const jitter = pickNonNegativeInt(explicit.jitterMs, env.DARIO_THINK_TIME_JITTER_MS) ?? (stealth ? 1500 : 0);
  const max = pickNonNegativeInt(explicit.maxMs, env.DARIO_THINK_TIME_MAX_MS) ?? (stealth ? 25000 : 30000);
  return { baseMs: base, perTokenMs: perToken, jitterMs: jitter, maxMs: max };
}

/**
 * Session-start delay (behavioral smoothing extension).
 *
 * Every new single-account session — first request after startup, first
 * request after a session-id rotation — currently fires at machine
 * speed (lastRequestTime resets to 0, computePacingDelay returns 0).
 * Every session opens with an identical zero-delay first request, which
 * is a detectable signal on long-run traffic statistics. Real CC users
 * open a new session by opening the binary and typing a prompt — that's
 * seconds of latency, not microseconds.
 *
 *   delay = minMs + U(0, jitterMs)
 *
 * Returns the sampled delay directly (no elapsed-time check — this is a
 * one-shot delay applied to the first request of a session, before any
 * upstream call has happened).
 */
export interface SessionStartConfig {
  /** Constant ms floor for session-start delay. */
  minMs: number;
  /** Max uniform-random jitter (ms) added on top. */
  jitterMs: number;
}

export function computeSessionStartDelay(
  cfg: SessionStartConfig,
  rng: () => number = Math.random,
): number {
  const min = Math.max(0, cfg.minMs);
  const jitter = Math.max(0, cfg.jitterMs);
  if (min === 0 && jitter === 0) return 0;
  const jitterAdd = jitter > 0 ? Math.floor(rng() * jitter) : 0;
  return min + jitterAdd;
}

export function resolveSessionStartConfig(
  explicit: { minMs?: number; jitterMs?: number; stealth?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): SessionStartConfig {
  // Stealth preset: 1200ms floor + up to 3000ms uniform jitter ≈ 1.2s–4.2s
  // first-request latency, matching observed real-CC session-open ranges.
  const stealth = explicit.stealth === true;
  const min = pickNonNegativeInt(explicit.minMs, env.DARIO_SESSION_START_MIN_MS) ?? (stealth ? 1200 : 0);
  const jitter = pickNonNegativeInt(explicit.jitterMs, env.DARIO_SESSION_START_JITTER_MS) ?? (stealth ? 3000 : 0);
  return { minMs: min, jitterMs: jitter };
}

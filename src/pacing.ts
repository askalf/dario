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
 *   4. Defaults: minGap=500, jitter=0
 *
 * Invalid strings (non-numeric, negative) are ignored and fall through to
 * the next source — a typoed env var shouldn't fail-loud at startup.
 */
export function resolvePacingConfig(
  explicit: { minGapMs?: number; jitterMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): PacingConfig {
  const minGap = pickNonNegativeInt(
    explicit.minGapMs,
    env.DARIO_PACE_MIN_MS,
    env.DARIO_MIN_INTERVAL_MS,
  ) ?? 500;
  const jitter = pickNonNegativeInt(
    explicit.jitterMs,
    env.DARIO_PACE_JITTER_MS,
  ) ?? 0;
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

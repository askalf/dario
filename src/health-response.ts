/**
 * /health response builder — extracted so the public-vs-internal disclosure rule
 * is unit-testable without spinning a proxy.
 *
 * dario's /health is auth-free (docker healthchecks + `depends_on: service_healthy`
 * need it before any secret is configured). When dario sits behind a Cloudflare
 * tunnel with a public /health bypass (uptime monitoring), that endpoint is
 * world-readable — so it must not leak OAuth internals (token countdown, request
 * volume, refresh errors). The Cloudflare edge stamps `cf-ray` on every request it
 * proxies, so its presence marks a request as having come from the public internet.
 * Internal callers (the docker healthcheck, `dario doctor`, the self-probe) hit
 * dario directly on loopback with no CF headers and still get the full detail.
 *
 * The HTTP status (200 healthy / 503 degraded) is identical either way, so external
 * uptime monitoring that keys on the status code is unaffected.
 */

export interface HealthStatusLike {
  status: string;
  canRefresh?: boolean;
  expiresIn?: string;
  refreshFailures?: number;
  lastRefreshError?: string;
  /** dario's package version, surfaced to internal callers on /health (#640). */
  version?: string;
  /**
   * Live session-tracking counts, surfaced to internal callers only. Both
   * structures reap lazily (no background sweeper — see session-rotation.ts),
   * so this raw in-memory size also reveals whether lazy cleanup keeps up.
   */
  sessions?:
    | { mode: 'pool'; stickyBindings: number }
    | { mode: 'single'; active: number };
  /**
   * Request-queue snapshot (dario#905), surfaced to internal callers only.
   * `active === maxConcurrent` with `queued > 0` for a sustained period is
   * the slot-exhaustion signature — before this field existed, that state
   * was invisible from outside the process while every request 504'd.
   */
  queue?: {
    active: number;
    queued: number;
    maxConcurrent: number;
    maxQueued: number;
    /**
     * Epoch ms since the queue has been at capacity with NO slot released
     * (dario#905). Null when not at capacity; reset by any release, so
     * sustained legitimate load never accumulates age here. See
     * request-queue.ts for why turnover — not depth — is the wedge signal.
     */
    stalledSince?: number | null;
  };
  /**
   * Verdict from the opt-in serving probe (`/health?probe=1`), when the caller
   * asked for one and was trusted enough to be given it. Absent otherwise —
   * a plain /health never spends a token, so its absence means "not asked
   * for", never "failed".
   */
  probe?: ServingProbeLike;
}

/**
 * The subset of serving-probe.ts's ProbeResult that /health renders. Declared
 * structurally rather than imported so this module stays free of the probe's
 * network machinery and remains unit-testable as a pure function.
 */
export interface ServingProbeLike {
  ok: boolean;
  reason: string;
  checkedAt: number;
  latencyMs: number;
  model: string;
  status?: number;
  detail?: string;
}

export interface HealthResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pool-aware status derivation (#636)
// ---------------------------------------------------------------------------
// /status and /health must reflect what will actually happen to requests. In
// pool mode (any accounts/ entry per #618, or admin mode per #599) the legacy
// single-account getStatus() reads credentials.json — which a login-less
// pool-only setup legitimately doesn't have — so those surfaces reported
// authenticated:false / 503 "degraded" while the pool served traffic fine,
// breaking docker healthchecks and the TUI on exactly the headless deployment
// the admin API was built for. Pure function so the derivation is
// unit-testable without spinning a proxy (test/health-response.mjs).

export interface PoolAccountStatusLike {
  expiresAt: number;
  inAuthCooldown: boolean;
}

export interface PoolDerivedStatus {
  authenticated: boolean;
  status: 'healthy' | 'broken' | 'none';
  expiresAt?: number;
  expiresIn?: string;
  /** Distinguishes the pool-derived shape from single-account getStatus(). */
  mode: 'pool';
  accounts: number;
}

function formatMsLeft(ms: number): string {
  const clamped = Math.max(0, ms);
  return `${Math.floor(clamped / 3_600_000)}h ${Math.floor((clamped % 3_600_000) / 60_000)}m`;
}

export function derivePoolStatus(
  accounts: readonly PoolAccountStatusLike[],
  now: number,
  adminEnabled: boolean,
): PoolDerivedStatus {
  if (accounts.length === 0) {
    // Empty admin pool: 'none'/503 is CORRECT here (every LLM request 503s
    // until an account exists) — but say how to fix it instead of implying
    // `dario login`, which is exactly what an admin-mode operator avoids.
    return {
      authenticated: false,
      status: 'none',
      mode: 'pool',
      accounts: 0,
      expiresIn: adminEnabled
        ? 'no accounts yet — add one via POST /admin/login/start'
        : 'no accounts yet — run `dario accounts add <alias>`',
    };
  }
  const usable = accounts.filter((a) => !a.inAuthCooldown);
  if (usable.length === 0) {
    // Every account is routing-excluded after upstream auth failures — the
    // next request will fail, which is the deadness /health exists to signal.
    return {
      authenticated: false,
      status: 'broken',
      mode: 'pool',
      accounts: accounts.length,
      expiresAt: Math.min(...accounts.map((a) => a.expiresAt)),
      expiresIn: 'all accounts in auth-cooldown',
    };
  }
  // Earliest expiry among USABLE accounts — the pool's background refresh
  // (15-min loop) keeps these rolling, mirroring what the startup banner
  // reports for a warm pool.
  const earliest = Math.min(...usable.map((a) => a.expiresAt));
  return {
    authenticated: true,
    status: 'healthy',
    mode: 'pool',
    accounts: accounts.length,
    expiresAt: earliest,
    expiresIn: formatMsLeft(earliest - now),
  };
}

/**
 * Render `stalledSince` as an elapsed duration alongside the raw stamp. The
 * stamp alone forces every consumer to subtract against its own clock, which
 * is exactly the arithmetic a shell-based healthcheck can't do — and #905's
 * reporter was writing his monitor in bash.
 */
function withStalledFor(
  q: NonNullable<HealthStatusLike['queue']>,
  now: number,
): Record<string, unknown> {
  const { stalledSince, ...rest } = q;
  if (stalledSince === null || stalledSince === undefined) return { ...rest, stalledSince: null };
  return { ...rest, stalledSince, stalledForMs: Math.max(0, now - stalledSince) };
}

export function buildHealthResponse(
  s: HealthStatusLike,
  requestCount: number,
  includeInternal: boolean,
  now: number = Date.now(),
): HealthResponse {
  const structurallyDead =
    s.status === 'broken' ||
    s.status === 'none' ||
    (s.status === 'expired' && s.canRefresh === false);
  // A failed round-trip is authoritative over a clean structural read: the
  // whole point of the probe (dario#905) is the state where local inspection
  // says healthy and every real request fails. When one was run and it came
  // back false, /health must say degraded — that is what makes an existing
  // status-code-only uptime monitor start seeing the outage it used to miss.
  const dead = structurallyDead || s.probe?.ok === false;
  const httpStatus = dead ? 503 : 200;
  const liveness = { status: dead ? 'degraded' : 'ok' };
  // Only trusted callers (authenticated, or bare loopback not via the CF
  // tunnel — see shouldDiscloseHealthInternals) get the OAuth internals.
  // Everyone else (LAN, public tunnel) gets the liveness verdict only; the
  // HTTP status is identical either way so uptime checks still work. #642:
  // this used to key on the presence of the client-suppliable `cf-ray`
  // header, which failed OPEN — a direct non-tunnel caller omits it and got
  // the full internal view. `lastRefreshError` is no longer exposed here at
  // all (it can carry a raw upstream error string); it remains on the
  // key-gated /status.
  const body: Record<string, unknown> = includeInternal
    ? {
        ...liveness,
        ...(s.version ? { version: s.version } : {}),
        oauth: s.status,
        expiresIn: s.expiresIn,
        requests: requestCount,
        ...(s.sessions ? { sessions: s.sessions } : {}),
        ...(s.queue ? { queue: withStalledFor(s.queue, now) } : {}),
        ...(s.probe ? { probe: { ...s.probe, ageMs: Math.max(0, now - s.probe.checkedAt) } } : {}),
        ...(s.refreshFailures ? { refreshFailures: s.refreshFailures } : {}),
      }
    : liveness;
  return { httpStatus, body };
}

/**
 * Did this caller ask for a serving probe? (`/health?probe=1`, dario#905.)
 *
 * Accepts `probe=1` / `probe=true` / bare `probe`, rejects `probe=0` and
 * `probe=false` — a monitor templating the flag from a boolean config should
 * get the behaviour it wrote, not a probe on every poll because the parameter
 * was merely present. Anything unparseable is treated as "not asked": the
 * failure direction for a token-spending flag has to be off.
 */
export function probeRequested(url: string | undefined): boolean {
  const q = url?.indexOf('?') ?? -1;
  if (q < 0) return false;
  const v = new URLSearchParams(url!.slice(q + 1)).get('probe');
  if (v === null) return false;
  if (v === '') return true; // bare `?probe`
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Decide whether to actually RUN a serving probe for this caller (dario#905).
 *
 * Deliberately stricter than shouldDiscloseHealthInternals, because this is
 * not a disclosure decision — it spends the operator's money.
 *
 * The disclosure gate treats "authenticated" as sufficient, and
 * `authenticateRequest` returns TRUE when no DARIO_API_KEY is configured at
 * all. That is a reasonable convenience for the common loopback setup, and
 * harmless for a read-only field. It is not harmless here: an unkeyed dario
 * published through a Cloudflare tunnel would otherwise expose `?probe=1` as a
 * button any anonymous caller could press to bill the operator, once per TTL,
 * forever.
 *
 * So the probe additionally refuses anything that arrived through the tunnel,
 * whatever `authenticated` says. This only ever DENIES — it cannot widen
 * access — and it makes the spend path independent of whether an API key
 * happens to be configured.
 *
 * Accepted trade-off: an operator who authenticates THROUGH the tunnel is also
 * refused, and has to probe from beside the proxy instead. For a flag whose
 * failure direction is "silently spends money", off is the right default.
 */
export function shouldRunServingProbe(opts: {
  requested: boolean;
  discloseInternals: boolean;
  viaCfRay: boolean;
}): boolean {
  if (!opts.requested) return false;
  if (opts.viaCfRay) return false;
  return opts.discloseInternals;
}

/**
 * Decide whether a /health caller may see the OAuth internals (#642).
 *
 * /health is intentionally auth-free (docker healthchecks need it before a
 * key is configured), so we cannot simply gate on the API key. Trust model:
 *   - authenticated (valid DARIO_API_KEY)      -> internal (an internal caller)
 *   - came via the Cloudflare tunnel (cf-ray)  -> public   (world-reachable)
 *   - otherwise bare loopback                  -> internal (docker HC / doctor)
 *   - otherwise (LAN, other container, WAN)    -> public
 * The cf-ray check is now only ever used to DENY (force public), never to
 * grant, so spoofing it cannot widen disclosure — the previous fail-open
 * direction is closed.
 */
export function shouldDiscloseHealthInternals(opts: {
  authenticated: boolean;
  loopback: boolean;
  viaCfRay: boolean;
}): boolean {
  if (opts.authenticated) return true;
  if (opts.viaCfRay) return false;
  return opts.loopback;
}

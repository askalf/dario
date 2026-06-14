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
}

export interface HealthResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

export function buildHealthResponse(
  s: HealthStatusLike,
  requestCount: number,
  viaPublicTunnel: boolean,
): HealthResponse {
  const dead =
    s.status === 'broken' ||
    s.status === 'none' ||
    (s.status === 'expired' && s.canRefresh === false);
  const httpStatus = dead ? 503 : 200;
  const liveness = { status: dead ? 'degraded' : 'ok' };
  const body: Record<string, unknown> = viaPublicTunnel
    ? liveness
    : {
        ...liveness,
        oauth: s.status,
        expiresIn: s.expiresIn,
        requests: requestCount,
        ...(s.refreshFailures ? { refreshFailures: s.refreshFailures } : {}),
        ...(s.lastRefreshError ? { lastRefreshError: s.lastRefreshError } : {}),
      };
  return { httpStatus, body };
}

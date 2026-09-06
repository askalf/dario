/**
 * Seat pin — route one request to one named pool account, with no failover.
 *
 * The read-only probe primitive behind `dario accounts check <alias>`: "does
 * this seat serve this model right now?" cannot be answered by a normal
 * request, because the pool picks the seat by headroom and fails over on
 * 401/429 (to a peer, then to the Codex leg). A pinned request does none of
 * that: it goes to the named seat and the upstream status comes back as-is.
 *
 * Gated on the admin API — `DARIO_ADMIN=1` plus a distinct `DARIO_ADMIN_TOKEN`
 * sent in `x-dario-admin-token` — because choosing the seat is an admin act
 * (it bypasses headroom routing and can burn one seat's window on purpose).
 * The proxy's own API key still applies to the request as usual. With the
 * admin API off the header is refused, not ignored: a probe that silently
 * became a normal request would report the wrong seat as healthy.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const SEAT_PIN_HEADER = 'x-dario-account';
export const SEAT_PIN_TOKEN_HEADER = 'x-dario-admin-token';

/** Same charset as accounts.ts safeAliasPath — anything else is not a seat. */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/;

export type SeatPin =
  | { kind: 'none' }
  | { kind: 'disabled' }
  | { kind: 'unauthorized' }
  | { kind: 'invalid-alias'; alias: string }
  | { kind: 'pinned'; alias: string };

function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export function resolveSeatPin(
  headers: IncomingHttpHeaders,
  opts: { adminEnabled: boolean; adminTokenBuf: Buffer | null },
): SeatPin {
  const raw = first(headers[SEAT_PIN_HEADER]);
  if (raw === undefined) return { kind: 'none' };
  const alias = raw.trim();
  if (!opts.adminEnabled || !opts.adminTokenBuf) return { kind: 'disabled' };
  const provided = first(headers[SEAT_PIN_TOKEN_HEADER]);
  if (!provided) return { kind: 'unauthorized' };
  const providedBuf = Buffer.from(provided);
  if (providedBuf.length !== opts.adminTokenBuf.length || !timingSafeEqual(providedBuf, opts.adminTokenBuf)) {
    return { kind: 'unauthorized' };
  }
  if (!ALIAS_RE.test(alias)) return { kind: 'invalid-alias', alias };
  return { kind: 'pinned', alias };
}

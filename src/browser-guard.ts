/**
 * Browser request guard: keeps a web page from using a proxy it can reach.
 * A tab on any site can reach 127.0.0.1, and CORS only stops a page from
 * reading a response, not from sending a `no-cors` request in the first place.
 *
 * isCrossOriginAllowed refuses a state-changing request a page on another
 * origin sent. Same algorithm as Go's net/http CrossOriginProtection: GET,
 * HEAD and OPTIONS pass (a cross-origin page cannot read their responses),
 * `Sec-Fetch-Site: same-origin | none` passes, an `Origin` on the trusted list
 * passes, any other `Sec-Fetch-Site` is refused, and a browser that predates
 * `Sec-Fetch-Site` falls back to comparing `Origin` with `Host`. It reads only
 * headers a page cannot forge, and applies only to a request carrying one of
 * them (isBrowserRequest): SDKs, curl and CLI clients send neither. Node's
 * fetch sends `Sec-Fetch-Mode: cors`, so nothing here reads `Sec-Fetch-Mode`.
 *
 * isHostAllowed closes DNS rebinding. A page on attacker.example whose name is
 * re-pointed at 127.0.0.1 is same-origin with the proxy as far as the browser
 * knows, so the origin check passes it and the page can read every response.
 * Its requests still carry `Host: attacker.example`, so a request must name the
 * proxy by a host that cannot be rebound: localhost, a *.localhost name
 * (browsers resolve those to loopback without DNS), an IP literal (no DNS to
 * re-point), the bind host, or the host of a trusted origin. This check cannot
 * wait for a browser header: browsers send `Sec-Fetch-Site` only to a
 * trustworthy URL, which http://attacker.example is not, and a same-origin GET
 * carries no `Origin`, so a rebound GET looks exactly like curl.
 *
 * The host check only matters where an absent credential is served, i.e. no
 * DARIO_API_KEY. With the key set, a rebinding page never holds it and gets
 * the same 401 as anyone else, so a keyed proxy behind a tunnel hostname keeps
 * serving without listing that hostname anywhere.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Headers = Record<string, string | string[] | undefined>;

function headerOf(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Lower-cased `scheme://host[:port]` with no trailing slash, the form a
 * browser's `Origin` header takes. An http(s) origin goes through URL so a
 * default port or trailing slash in DARIO_CORS_ORIGIN still matches. Other
 * schemes (`chrome-extension://<id>`) have an opaque URL origin, so they are
 * compared as written. `null` (sandboxed frames, file: pages) stays `null` so
 * an operator can trust it explicitly. Anything else returns undefined and is
 * never trusted.
 */
export function normalizeOrigin(origin: string): string | undefined {
  let o = origin.trim().toLowerCase();
  // A loop, not /\/+$/: that regex backtracks quadratically on a long run of
  // slashes, and the Origin header is caller-controlled.
  while (o.endsWith('/')) o = o.slice(0, -1);
  if (o === 'null') return o;
  if (/^https?:\/\//.test(o)) {
    try {
      return new URL(o).origin;
    } catch {
      return undefined;
    }
  }
  return /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/.test(o) ? o : undefined;
}

function httpHostOf(origin: string): URL | undefined {
  return /^https?:\/\//.test(origin) ? new URL(origin) : undefined;
}

/** The hostname of a `Host` header, port dropped and lower-cased; `[::1]` keeps its brackets. */
export function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? undefined : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  if (colon === -1) return h;
  // More than one colon unbracketed is not a valid Host.
  return h.indexOf(':', colon + 1) === -1 ? h.slice(0, colon) : undefined;
}

/** Whether the request carries a header only a browser sets. */
export function isBrowserRequest(headers: Headers): boolean {
  return headerOf(headers, 'sec-fetch-site') !== undefined || headerOf(headers, 'origin') !== undefined;
}

/**
 * The trusted origin list: the CORS origin dario already advertises.
 * Unparseable entries drop out instead of matching anything.
 */
export function trustedOriginSet(origins: string[]): Set<string> {
  const out = new Set<string>();
  for (const o of origins) {
    const n = normalizeOrigin(o);
    if (n) out.add(n);
  }
  return out;
}

export function isCrossOriginAllowed(method: string | undefined, headers: Headers, trusted: Set<string>): boolean {
  if (SAFE_METHODS.has((method ?? '').toUpperCase())) return true;
  const site = headerOf(headers, 'sec-fetch-site')?.toLowerCase();
  if (site === 'same-origin' || site === 'none') return true;
  const origin = headerOf(headers, 'origin');
  const normalized = origin === undefined ? undefined : normalizeOrigin(origin);
  if (normalized !== undefined && trusted.has(normalized)) return true;
  // A browser that sends Sec-Fetch-Site said cross-site or same-site here.
  if (site !== undefined) return false;
  // Neither header: not a browser, or one too old to send either on a POST.
  if (origin === undefined) return true;
  const url = normalized === undefined ? undefined : httpHostOf(normalized);
  const host = headerOf(headers, 'host')?.trim().toLowerCase();
  return url !== undefined && host !== undefined && url.host === host;
}

/** Host names a request may use to reach an unkeyed proxy, besides *.localhost and IP literals. */
export function allowedHosts(trusted: Set<string>, bindHost: string | undefined): Set<string> {
  const out = new Set<string>(['localhost']);
  for (const o of trusted) {
    const url = httpHostOf(o);
    if (url) out.add(url.hostname);
  }
  if (bindHost) {
    const h = bindHost.trim().toLowerCase();
    out.add(h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
  }
  return out;
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isHostAllowed(headers: Headers, allowed: Set<string>): boolean {
  const host = headerOf(headers, 'host');
  // A browser always sends Host, so a request without one is not a rebound page.
  if (host === undefined) return true;
  const name = hostnameOf(host);
  if (name === undefined) return false;
  if (allowed.has(name)) return true;
  if (name.endsWith('.localhost')) return true;
  return IPV4_LITERAL.test(name) || name.startsWith('[');
}

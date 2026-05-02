// Optional outbound-proxy routing for upstream API calls. Behind
// `--upstream-proxy=URL` / `--via=URL` / `DARIO_UPSTREAM_PROXY`, dario
// routes all of its outbound fetch() calls — `api.anthropic.com`,
// configured OpenAI-compat backends, OAuth flows, drift checks, doctor
// probes — through the supplied proxy. Localhost-bound fetches bypass
// it (the inbound HTTP server is unaffected; this only wraps egress).
//
// Use case: security-conscious users who want dario's upstream traffic
// routed through their VPN provider's HTTP proxy endpoint without
// putting the entire host on a system-level VPN. Pair with the HTTP
// proxy mode of Mullvad / AirVPN / a local privoxy-on-Tor / corporate
// proxy infrastructure / Cloudflare WARP via gateway / etc.
//
// Runtime constraints:
//   - Requires Bun. Bun's fetch implements the `proxy` option natively;
//     Node's built-in fetch (undici-backed) ignores it silently and
//     would yield a misleading "looks like it's working" failure mode.
//     dario already auto-relaunches under Bun when available; if the
//     user is on Node and sets this flag, refuse to start with a clear
//     "install Bun" message.
//   - HTTP/HTTPS proxies only. SOCKS5 is not supported by Bun 1.3.x's
//     fetch (`UnsupportedProxyProtocol`). Most VPN providers expose an
//     HTTP proxy endpoint alongside their SOCKS5 one (Mullvad, AirVPN);
//     point the flag at that.
//
// Wire-fidelity note: the proxy sits *outside* the TLS session — TLS
// to api.anthropic.com terminates at Anthropic, not at the proxy.
// Bun's BoringSSL ClientHello is preserved end-to-end. The only thing
// the proxy can see in HTTPS-CONNECT mode is the destination hostname
// (via SNI) and the byte timing.

export interface OutboundProxyConfig {
  /** Original URL string supplied by the user. Passed verbatim to fetch's `proxy` option. */
  url: string;
  /** Parsed scheme — http or https. SOCKS rejected at parse time. */
  scheme: 'http' | 'https';
  /** Sanitized URL for logging — credentials redacted. */
  display: string;
}

/**
 * Parse and validate an outbound-proxy URL. Returns null for empty/undefined
 * input (no proxy configured). Throws with a clear message on:
 *   - URL parse failure
 *   - SOCKS scheme (unsupported by Bun fetch)
 *   - Other unsupported schemes
 */
export function parseOutboundProxy(raw: string | undefined): OutboundProxyConfig | null {
  if (!raw || raw.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `--upstream-proxy: ${JSON.stringify(raw)} is not a valid URL. Expected http://host:port or https://host:port.`,
    );
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

  if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks') {
    throw new Error(
      `--upstream-proxy: SOCKS5 is not supported by the underlying fetch runtime (Bun 1.3.x). ` +
      `Use the HTTP proxy endpoint of your VPN provider instead — e.g. Mullvad / AirVPN / corporate proxy / privoxy-on-Tor all expose http://host:port. ` +
      `If your provider only exposes SOCKS5, run a local SOCKS-to-HTTP bridge (privoxy with forward-socks5) and point dario at the HTTP side.`,
    );
  }

  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error(
      `--upstream-proxy: unsupported scheme ${JSON.stringify(scheme)}. Use http:// or https://.`,
    );
  }

  // Sanitize for logging: hide username/password if embedded in URL.
  const display = (() => {
    if (!parsed.username && !parsed.password) return parsed.toString();
    const safe = new URL(parsed.toString());
    if (safe.username) safe.username = '***';
    if (safe.password) safe.password = '***';
    return safe.toString();
  })();

  return { url: parsed.toString(), scheme: scheme as 'http' | 'https', display };
}

/**
 * Heuristic check: does this URL target localhost / loopback?
 * Used to skip the proxy wrapper for self-targeting fetches (doctor
 * pings the local server, etc.). Lenient on parse errors — anything
 * unparseable returns false (proxied as a bare hostname, conservatively).
 */
export function isLocalhostUrl(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  let urlStr: string;
  if (typeof input === 'string') {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.toString();
  } else if (typeof input === 'object' && 'url' in (input as Record<string, unknown>)) {
    const u = (input as { url?: unknown }).url;
    urlStr = typeof u === 'string' ? u : '';
  } else {
    return false;
  }
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    // URL.hostname for IPv6 includes the brackets ([::1]); strip for matching.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.endsWith('.localhost')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Install a global fetch wrapper that adds `{ proxy }` to outbound
 * (non-localhost) calls. Idempotent over a single dario startup —
 * called once from cli.ts before startProxy.
 *
 * Refuses to install on non-Bun runtimes because Node's built-in fetch
 * silently ignores the proxy option, which would yield false-success
 * behavior (requests appearing to route through the proxy when they
 * actually go direct). Better to fail loud at startup than fail silent
 * at request time.
 */
export function installOutboundProxyWrapper(config: OutboundProxyConfig): void {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (!isBun) {
    throw new Error(
      `--upstream-proxy requires the Bun runtime. Node's built-in fetch ignores the \`proxy\` option silently — ` +
      `the flag would appear to work while requests actually went direct. Install Bun (https://bun.sh) and re-run; ` +
      `dario auto-relaunches under Bun when available, or you can run \`bun run\` directly.`,
    );
  }

  const originalFetch = globalThis.fetch;
  // Wrap. Localhost targets bypass the proxy (loopback shouldn't tunnel).
  // The wrapper preserves originalFetch's behavior for everything else
  // and adds the `proxy` field. Bun honors it; the rest of the args
  // (headers, body, signal, dispatcher, etc.) pass through unchanged.
  const wrapped: typeof fetch = ((input, init) => {
    if (isLocalhostUrl(input)) {
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }
    // Use a typed cast — Bun's fetch options include `proxy`, but TS's
    // standard fetch types don't.
    const bunInit = { ...(init || {}), proxy: config.url } as Parameters<typeof fetch>[1];
    return originalFetch(input as Parameters<typeof fetch>[0], bunInit);
  }) as typeof fetch;
  globalThis.fetch = wrapped;
}

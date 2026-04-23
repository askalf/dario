/**
 * Live probe of Anthropic's /oauth/authorize endpoint.
 *
 * Lifted from scripts/_authorize-probe-classifier.mjs and
 * scripts/check-cc-authorize-probe.mjs so `dario doctor --probe` can
 * reuse the same logic without re-importing from scripts. The .mjs
 * files re-export from this module for the CI drift watcher.
 *
 * Motivating pattern: Anthropic's policy engine flips scope
 * acceptability without changing what CC ships in its binary, so the
 * binary-scan drift watcher can't see the flip. The live probe fills
 * that gap — but from GitHub Actions IPs it hits Cloudflare's bot
 * challenge and comes back "inconclusive" most of the time. Running
 * the same probe from a user's own machine (via `dario doctor
 * --probe`) is the workaround: CF doesn't challenge residential IPs
 * the same way. See dario #42 / #71 for the incidents this prevents.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * The specific string Anthropic's authorize endpoint returns for a
 * scope set its policy engine rejects. Observed across multiple
 * incidents (dario #22, #42, #71) — stable across the policy flips.
 */
export const REJECT_MARKER = 'Invalid request format';

/** Not a real callback — the probe only needs the initial response. */
const PROBE_REDIRECT_URI = 'http://localhost:12345/callback';

const PROBE_TIMEOUT_MS = 15_000;

/**
 * The minimal response shape the classifier needs. `fetch` results can
 * be mapped to this in one call (see `probeAuthorize` below).
 */
export interface AuthorizeResponse {
  status: number;
  location: string | null;
  body: string;
  error: string | null;
}

export type ProbeVerdict = 'accepted' | 'rejected' | 'inconclusive';

export interface ClassifiedVerdict {
  verdict: ProbeVerdict;
  reason: string;
}

/** Cloudflare fronts claude.ai and challenges unrecognized clients. */
function isCloudflareChallenge({ status, body }: Pick<AuthorizeResponse, 'status' | 'body'>): boolean {
  const bodyText = typeof body === 'string' ? body : '';
  if (bodyText.includes('Just a moment...') || bodyText.includes('/cdn-cgi/challenge-platform/')) {
    return true;
  }
  if (status === 403 && bodyText.includes('cdn-cgi')) {
    return true;
  }
  return false;
}

/**
 * Classify a single authorize-endpoint response.
 *
 *   accepted     — 3xx redirect to login/consent, OR 2xx without the
 *                  reject marker. The scope set passed validation.
 *   rejected     — body contains the specific "Invalid request format"
 *                  marker. The scope set was refused.
 *   inconclusive — fetch error, Cloudflare challenge, or any other
 *                  response shape we can't categorize. Not drift; try
 *                  again.
 */
export function classifyAuthorizeResponse({ status, location, body, error }: AuthorizeResponse): ClassifiedVerdict {
  if (error) {
    return { verdict: 'inconclusive', reason: `fetch error: ${error}` };
  }

  if (isCloudflareChallenge({ status, body })) {
    return {
      verdict: 'inconclusive',
      reason:
        `blocked by Cloudflare bot challenge (status=${status}). ` +
        `The live probe is unreliable from CI IPs — rely on the scope-literal ` +
        `scan in check-cc-drift.mjs, or run this probe from a trusted network.`,
    };
  }

  const bodyText = typeof body === 'string' ? body : '';
  if (bodyText.includes(REJECT_MARKER)) {
    return { verdict: 'rejected', reason: `body contains "${REJECT_MARKER}"` };
  }

  if (status >= 300 && status < 400 && typeof location === 'string' && location.length > 0) {
    return { verdict: 'accepted', reason: `${status} redirect to ${location}` };
  }

  if (status >= 200 && status < 300) {
    return { verdict: 'accepted', reason: `${status} body rendered, no reject marker` };
  }

  return {
    verdict: 'inconclusive',
    reason: `unexpected response: status=${status}, location=${location ?? 'none'}, body_len=${bodyText.length}`,
  };
}

export interface DriftItem {
  probe: 'A' | 'B';
  severity: 'high' | 'medium' | 'info';
  message: string;
}

export interface CombinedVerdict {
  outcome: 'clean' | 'drift' | 'inconclusive';
  drift: boolean;
  items: DriftItem[];
}

/**
 * Combine the verdicts for probe A (pinned 6-scope) and probe B
 * (5-scope, org:create_api_key removed) into a single watcher result.
 * See scripts/check-cc-authorize-probe.mjs for the full rationale.
 */
export function combineVerdicts(a: ClassifiedVerdict, b: ClassifiedVerdict): CombinedVerdict {
  if (a.verdict === 'inconclusive' || b.verdict === 'inconclusive') {
    const items: DriftItem[] = [];
    if (a.verdict === 'inconclusive') items.push({ probe: 'A', severity: 'info', message: `probe A inconclusive: ${a.reason}` });
    if (b.verdict === 'inconclusive') items.push({ probe: 'B', severity: 'info', message: `probe B inconclusive: ${b.reason}` });
    return { outcome: 'inconclusive', drift: false, items };
  }

  const items: DriftItem[] = [];

  if (a.verdict !== 'accepted') {
    items.push({
      probe: 'A',
      severity: 'high',
      message:
        `Pinned FALLBACK.scopes (6-scope) no longer accepted by authorize endpoint (${a.reason}). ` +
        `This is the dario #42 / #71 failure mode: users will hit "Invalid request format" on fresh login. ` +
        `Investigate which scope the server now rejects and update FALLBACK.scopes in src/cc-oauth-detect.ts; ` +
        `bump the cache suffix (CACHE_PATH) so existing users regenerate.`,
    });
  }

  if (b.verdict === 'accepted') {
    items.push({
      probe: 'B',
      severity: 'info',
      message:
        `5-scope form (org:create_api_key removed) is ALSO accepted. Anthropic's authorize ` +
        `endpoint appears permissive for this client_id — both the 6-scope form our users send ` +
        `and the 5-scope form are accepted. Nothing to fix; recorded so we notice when it flips.`,
    });
  }

  const hasDrift = items.some((i) => i.severity === 'high');
  return {
    outcome: hasDrift ? 'drift' : 'clean',
    drift: hasDrift,
    items,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Probe: build authorize URL, fetch once (with one redirect hop), classify
// ─────────────────────────────────────────────────────────────────────

export interface ProbeConfig {
  clientId: string;
  authorizeUrl: string;
  scopes: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Test hook. Default: `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ProbeResult extends ClassifiedVerdict {
  /** The exact URL sent — useful for the user to paste into a browser if the verdict is rejected. */
  probedUrl: string;
  /** Scope count from `scopes`, for quick human read-out. */
  scopeCount: number;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkceChallenge(): string {
  const verifier = base64url(randomBytes(32));
  return base64url(createHash('sha256').update(verifier).digest());
}

export function buildProbeAuthorizeUrl(cfg: ProbeConfig): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: PROBE_REDIRECT_URI,
    scope: cfg.scopes,
    code_challenge: pkceChallenge(),
    code_challenge_method: 'S256',
    state: base64url(randomBytes(16)),
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

const PROBE_HEADERS: Record<string, string> = {
  'User-Agent': 'dario-cc-authorize-probe/1 (+https://github.com/askalf/dario)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

async function fetchOnce(url: string, opts: ProbeOptions): Promise<AuthorizeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: PROBE_HEADERS,
    });
    const location = res.headers.get('location');
    let body = '';
    try {
      body = await res.text();
    } catch (err) {
      return { status: res.status, location, body: '', error: `read body failed: ${(err as Error)?.message ?? String(err)}` };
    }
    return { status: res.status, location, body, error: null };
  } catch (err) {
    return { status: 0, location: null, body: '', error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Probe the authorize endpoint with the given config. Follows exactly
 * one redirect hop if the Location points at a trusted Anthropic host
 * (claude.ai / claude.com / *.anthropic.com) — the legacy
 * `claude.com/cai/oauth/authorize` edge 307s to claude.ai and the
 * destination is where the validation happens. Stopping at the edge
 * would silently treat every scope set as accepted.
 */
export async function runAuthorizeProbe(cfg: ProbeConfig, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const url = buildProbeAuthorizeUrl(cfg);
  const first = await fetchOnce(url, opts);

  const trustedRedirect =
    first.status >= 300 && first.status < 400 &&
    typeof first.location === 'string' &&
    /^https:\/\/(claude\.ai|claude\.com|[\w-]+\.anthropic\.com)\//.test(first.location);

  const response = trustedRedirect && first.location !== null
    ? await fetchOnce(first.location, opts)
    : first;

  const classified = classifyAuthorizeResponse(response);
  const scopeCount = cfg.scopes.split(/\s+/).filter(Boolean).length;
  return { ...classified, probedUrl: url, scopeCount };
}

/**
 * serving-probe.ts — the "can dario actually serve a request?" check.
 * Opt-in, trusted-callers-only, cached and single-flighted.
 */
import { classifyUpstreamRejection, rejectionRemediation } from './upstream-rejection.js';

const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';

export const DEFAULT_PROBE_MODEL = 'claude-haiku-4-5';
export const DEFAULT_PROBE_TTL_MS = 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export type ProbeReason =
  | 'served'
  | 'billing-required'
  | 'rate-limited'
  | 'upstream-overloaded'
  | 'no-token'
  | 'auth-rejected'
  | 'upstream-error'
  | 'timeout'
  | 'network-error';

export interface ProbeResult {
  ok: boolean;
  reason: ProbeReason;
  checkedAt: number;
  latencyMs: number;
  model: string;
  status?: number;
  detail?: string;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  upstreamApiKey?: string;
  now?: () => number;
  model?: string;
  timeoutMs?: number;
  ttlMs?: number;
}

let cache: ProbeResult | null = null;
let inflight: Promise<ProbeResult> | null = null;

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function classifyProbeResponse(status: number, body = ''): { ok: boolean; reason: ProbeReason; detail?: string } {
  if (status >= 200 && status < 300) return { ok: true, reason: 'served' };
  // 429/529 are TRANSIENT: the seat is servable, the window is just closed.
  // They stay ok:true (reason still reported) so a watchdog does not restart on
  // an ordinary overage window — see test/health-verdict.mjs. Only states that
  // do NOT self-clear (billing, credential, upstream-error) are ok:false.
  if (status === 529) return { ok: true, reason: 'upstream-overloaded', detail: 'Upstream is overloaded; retry later.' };
  const rejection = classifyUpstreamRejection(status, body);
  if (rejection.class === 'billing') {
    return { ok: false, reason: 'billing-required', detail: rejectionRemediation(rejection) };
  }
  if (rejection.class === 'rate_limit') {
    return { ok: true, reason: 'rate-limited', detail: rejectionRemediation(rejection) };
  }
  if (rejection.class === 'credential') {
    return { ok: false, reason: 'auth-rejected', detail: rejectionRemediation(rejection) };
  }
  return { ok: false, reason: 'upstream-error', detail: rejectionRemediation(rejection) };
}

/** Backward-compatible status-only classifier; body-aware callers use classifyProbeResponse. */
export function classifyProbeStatus(status: number): { ok: boolean; reason: ProbeReason } {
  const { ok, reason } = classifyProbeResponse(status);
  return { ok, reason };
}

async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const model = deps.model ?? process.env.DARIO_PROBE_MODEL ?? DEFAULT_PROBE_MODEL;
  const timeoutMs = deps.timeoutMs ?? envInt('DARIO_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS);
  const startedAt = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const finish = (r: Omit<ProbeResult, 'checkedAt' | 'latencyMs' | 'model'>): ProbeResult => ({
    ...r, model, checkedAt: now(), latencyMs: now() - startedAt,
  });

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (deps.upstreamApiKey) {
      headers['x-api-key'] = deps.upstreamApiKey;
    } else {
      if (!deps.getToken) return finish({ ok: false, reason: 'no-token', detail: 'no token source configured' });
      let token: string;
      try {
        token = await Promise.race([
          deps.getToken(),
          new Promise<never>((_, reject) => {
            ctl.signal.addEventListener('abort', () => reject(new Error('token acquisition timed out')), { once: true });
          }),
        ]);
      } catch (err) {
        return finish({ ok: false, reason: 'no-token', detail: errText(err) });
      }
      headers.authorization = `Bearer ${token}`;
      headers['anthropic-beta'] = OAUTH_BETA;
    }

    const res = await f(ANTHROPIC_MESSAGES, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: ctl.signal,
    });
    const body = await res.text().catch(() => '');
    return finish({ ...classifyProbeResponse(res.status, body), status: res.status });
  } catch (err) {
    const aborted = ctl.signal.aborted || (err as Error)?.name === 'AbortError';
    return finish({
      ok: false,
      reason: aborted ? 'timeout' : 'network-error',
      detail: aborted ? `no upstream response within ${timeoutMs}ms` : errText(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getServingProbe(deps: ProbeDeps = {}): Promise<ProbeResult> {
  const now = (deps.now ?? Date.now)();
  const ttl = deps.ttlMs ?? envInt('DARIO_PROBE_TTL_MS', DEFAULT_PROBE_TTL_MS);
  if (cache !== null && now - cache.checkedAt < ttl) return cache;
  if (inflight !== null) return inflight;
  inflight = runProbe(deps)
    .then((result) => {
      cache = result;
      return result;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function probeAgeMs(result: ProbeResult, now: number): number {
  return Math.max(0, now - result.checkedAt);
}

export function _resetServingProbeForTest(): void {
  cache = null;
  inflight = null;
}

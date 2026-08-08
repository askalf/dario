/**
 * serving-probe.ts — the "can dario actually serve a request?" check.
 *
 * WHY THIS EXISTS (dario#905, dario#921)
 *
 * dario's existing health surfaces are both STRUCTURAL — they inspect state,
 * they never prove anything end-to-end:
 *
 *   /livez   the HTTP server is accepting connections. Always 200.
 *   /health  credentials/pool look sane: token not expired, refresh not broken,
 *            accounts not all in auth-cooldown, queue snapshot attached.
 *
 * Neither can catch the failure class that actually took a user down for ~14h
 * across four episodes (#905): dario looking perfectly healthy from the outside
 * while every real request failed. The reporter's remediation was an external
 * watchdog that sends a real inference call and restarts the service when it
 * doesn't come back — i.e. the user had to write the liveness check dario
 * should own. This module is that check, brought in-house.
 *
 * It also covers a class /health provably cannot see: an account whose token is
 * unexpired and refreshable (so `status: healthy`) but whose accountUuid has
 * drifted, so upstream 401s every request. Structural inspection says fine;
 * only a round-trip says otherwise.
 *
 * WHAT IT PROVES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The probe is a minimal `POST /v1/messages` (max_tokens 1) sent DIRECTLY to
 * api.anthropic.com with the same auth the request path uses — pool bearer, or
 * `x-api-key` in upstream-API-key mode. That proves: a token can be acquired,
 * the network path is up, and upstream accepts our credential.
 *
 * It deliberately does NOT go through dario's own proxy path:
 *   - No recursion, no self-deadlock, no port/auth assumptions.
 *   - It must not take a concurrency slot. A probe that queues behind real
 *     traffic would report "unhealthy" during a legitimate burst and hand a
 *     watchdog a reason to restart a busy-but-fine dario. Slot exhaustion is
 *     covered instead by `queue.saturatedSince` (request-queue.ts), which is
 *     free, needs no tokens, and cannot false-positive on a short burst.
 *
 * So: the probe covers the credential/network axis, the queue snapshot covers
 * the concurrency axis. Neither claims to cover the transform path.
 *
 * COST AND EXPOSURE
 *
 * A probe is a real billed request. Three guards, all load-bearing:
 *   1. OPT-IN. Only runs when a caller explicitly asks (`/health?probe=1`).
 *      A plain /health never spends a token — existing docker healthchecks and
 *      uptime monitors keep their current cost profile, which is zero.
 *   2. TRUSTED CALLERS ONLY. proxy.ts honours `?probe=1` only for callers that
 *      already pass shouldDiscloseHealthInternals. A world-readable /health
 *      behind a Cloudflare tunnel bypass must not be a button the internet can
 *      press to spend the operator's tokens.
 *   3. CACHED + SINGLE-FLIGHTED. Results are reused for `ttlMs` (default 60s)
 *      and concurrent callers share one in-flight request, so a monitor polling
 *      every second still costs at most one probe per minute.
 *
 * VERDICT SEMANTICS — why 429 is NOT a failure
 *
 * `ok` answers "would a restart or an alert help?", not "did the call return
 * 200". Rate-limited (429) and upstream-overloaded (529) are healthy states:
 * dario is working, the answer is legitimately "not right now", and a watchdog
 * that restarts on them just thrashes. That is the same lesson /livez already
 * encodes in proxy.ts — a shared-refresh-family outage once had dario restart
 * -looping for 4h+ because the healthcheck keyed on a condition a restart
 * cannot fix. Auth rejection, 5xx, network failure and timeout DO set ok=false.
 */

const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';

/** Cheapest family, and the one doctor's own probe already uses. */
export const DEFAULT_PROBE_MODEL = 'claude-haiku-4-5';
export const DEFAULT_PROBE_TTL_MS = 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Why the round-trip ended the way it did. Carried on both verdicts so an
 * operator reading a green probe can still tell "served" from "rate-limited".
 */
export type ProbeReason =
  | 'served'
  | 'rate-limited'
  | 'upstream-overloaded'
  | 'no-token'
  | 'auth-rejected'
  | 'upstream-error'
  | 'timeout'
  | 'network-error';

export interface ProbeResult {
  /** False only for conditions where dario is the problem — see module header. */
  ok: boolean;
  reason: ProbeReason;
  /** Epoch ms the round-trip completed. */
  checkedAt: number;
  /** Wall time of the round-trip, including token acquisition. */
  latencyMs: number;
  model: string;
  /** Upstream HTTP status, when upstream answered at all. */
  status?: number;
  /** Short failure detail. Never carries a token or a raw body. */
  detail?: string;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  /** OAuth bearer source. Ignored when upstreamApiKey is set. */
  getToken?: () => Promise<string>;
  /** Per-token API mode — forwarded as x-api-key, mirroring request-path auth. */
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

/**
 * Map an upstream HTTP status onto a verdict. Pure, so the whole policy
 * ("which statuses mean dario is broken") is testable without a network.
 */
export function classifyProbeStatus(status: number): { ok: boolean; reason: ProbeReason } {
  if (status >= 200 && status < 300) return { ok: true, reason: 'served' };
  // Serving fine, just throttled — restarting cannot help, so do not fail.
  if (status === 429) return { ok: true, reason: 'rate-limited' };
  if (status === 529) return { ok: true, reason: 'upstream-overloaded' };
  // The credential is being rejected even though local state looks valid.
  // This is the accountUuid-drift signature /health structurally cannot see.
  if (status === 401 || status === 403) return { ok: false, reason: 'auth-rejected' };
  return { ok: false, reason: 'upstream-error' };
}

async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const model = deps.model ?? process.env.DARIO_PROBE_MODEL ?? DEFAULT_PROBE_MODEL;
  const timeoutMs = deps.timeoutMs ?? envInt('DARIO_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS);
  const startedAt = now();

  // Arm the deadline BEFORE token acquisition so a wedged refresh is bounded
  // too, not just the fetch — the same trap model-catalog.ts hit in #642: a
  // getToken() that never settles would leave `inflight` non-null forever and
  // permanently wedge every future probe on a stale cached verdict.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const finish = (r: Omit<ProbeResult, 'checkedAt' | 'latencyMs' | 'model'>): ProbeResult => ({
    ...r,
    model,
    checkedAt: now(),
    latencyMs: now() - startedAt,
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
          new Promise<never>((_, rej) => {
            ctl.signal.addEventListener('abort', () => rej(new Error('token acquisition timed out')), { once: true });
          }),
        ]);
      } catch (err) {
        // An empty pool lands here — the message already says so (pool.ts /
        // catalogDeps phrase it for the operator), so surface it verbatim.
        return finish({ ok: false, reason: 'no-token', detail: errText(err) });
      }
      headers['authorization'] = `Bearer ${token}`;
      headers['anthropic-beta'] = OAUTH_BETA;
    }

    const res = await f(ANTHROPIC_MESSAGES, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: ctl.signal,
    });
    // Drain so the socket is released back to the agent pool. The body is
    // never inspected: a 200 is the whole signal, and the content could carry
    // model output we have no reason to log.
    await res.text().catch(() => '');
    const verdict = classifyProbeStatus(res.status);
    return finish({ ...verdict, status: res.status });
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

/**
 * The cached verdict, refreshing it when stale. Never throws — a health
 * surface that can 500 is worse than useless, so every failure path becomes a
 * `ok: false` verdict with a reason instead of an exception.
 *
 * Concurrent callers past the TTL share one in-flight probe; the loser of the
 * race gets the same result rather than sending a second billed request.
 */
export async function getServingProbe(deps: ProbeDeps = {}): Promise<ProbeResult> {
  const now = (deps.now ?? Date.now)();
  const ttl = deps.ttlMs ?? envInt('DARIO_PROBE_TTL_MS', DEFAULT_PROBE_TTL_MS);
  if (cache !== null && now - cache.checkedAt < ttl) return cache;
  if (inflight !== null) return inflight;
  inflight = runProbe(deps)
    .then((r) => {
      cache = r;
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Age of the cached verdict, for the `ageMs` field callers see. */
export function probeAgeMs(result: ProbeResult, now: number): number {
  return Math.max(0, now - result.checkedAt);
}

export function _resetServingProbeForTest(): void {
  cache = null;
  inflight = null;
}

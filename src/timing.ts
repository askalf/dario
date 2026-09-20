/**
 * Per-request timing split — where a request's wall-clock time went.
 *
 * Until now a request carried one number, `latencyMs`, measured from the
 * moment dario was ready to dispatch to the moment the response ended. It
 * left out the wait for a concurrency slot and the rate governor's sleep,
 * and it folded the provider's time and dario's own work into one figure.
 * A user seeing 6 s per request could not tell whether that was Anthropic,
 * the queue, the 500 ms pacing floor, or the proxy itself (dario#1341 asked
 * for exactly LiteLLM's split: total, provider, overhead, queue, TTFT).
 *
 * Five stamps, all milliseconds, all measured by dario on the same clock:
 *
 *   queueMs         waited for a `--max-concurrent` slot
 *   pacingMs        slept in the rate governor (pacing / think-time /
 *                   session-start floors)
 *   upstreamTtfbMs  first outbound byte → upstream response headers
 *                   (the provider's time-to-first-byte, failover attempts
 *                   included — that is provider time, not dario's)
 *   upstreamMs      first outbound byte → upstream body fully consumed
 *   totalMs         request arrived at dario → response ended
 *
 * and one derived figure, `overheadMs = total − upstream − queue − pacing`:
 * the time dario itself spent reading the body, building the template,
 * translating shapes and relaying SSE. Deliberate waits (queue, pacing) are
 * reported on their own so nobody has to guess whether "overhead" includes
 * them; it does not.
 *
 * Pure over its inputs. The proxy stamps the clock; this module only folds.
 */

export interface RequestTiming {
  queueMs: number;
  pacingMs: number;
  upstreamTtfbMs: number;
  upstreamMs: number;
  totalMs: number;
}

/** Averages over the records in a window that carry a timing split. */
export interface TimingStats {
  /** Records the averages are over. 0 when no request carried timing (older rows, codex legs without a split). */
  samples: number;
  avgQueueMs: number;
  avgPacingMs: number;
  avgUpstreamTtfbMs: number;
  avgUpstreamMs: number;
  avgOverheadMs: number;
}

/** Response headers the client sees before the body, so a curl can read them without /analytics. */
export const TIMING_HEADERS = {
  queue: 'x-dario-queue-ms',
  pacing: 'x-dario-pacing-ms',
  ttfb: 'x-dario-upstream-ttfb-ms',
  /** Arrival → first outbound byte, minus queue and pacing: dario's own pre-upstream work. */
  prep: 'x-dario-prep-ms',
} as const;

const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** dario's own processing time: everything that is neither the provider nor a deliberate wait. Never negative. */
export function overheadMs(t: RequestTiming): number {
  return Math.max(0, Math.round(t.totalMs - t.upstreamMs - t.queueMs - t.pacingMs));
}

/** Fold a set of stamps into a record-ready split; clocks that never ticked read 0, never NaN or negative. */
export function foldTiming(stamps: {
  arrivedAt: number;
  queueMs: number;
  pacingMs: number;
  /** Absent when nothing went upstream (rejected before dispatch). */
  fetchStartedAt?: number;
  upstreamHeadersAt?: number;
  upstreamDoneAt?: number;
  endedAt: number;
}): RequestTiming {
  const fetchAt = stamps.fetchStartedAt ?? stamps.endedAt;
  const headersAt = stamps.upstreamHeadersAt ?? fetchAt;
  const doneAt = stamps.upstreamDoneAt ?? headersAt;
  return {
    queueMs: Math.round(nonNeg(stamps.queueMs)),
    pacingMs: Math.round(nonNeg(stamps.pacingMs)),
    upstreamTtfbMs: Math.round(nonNeg(headersAt - fetchAt)),
    upstreamMs: Math.round(nonNeg(doneAt - fetchAt)),
    totalMs: Math.round(nonNeg(stamps.endedAt - stamps.arrivedAt)),
  };
}

/** The headers known before the body starts. `prepMs` is what remains of arrival→fetch once the waits are taken out. */
export function timingHeaders(t: { queueMs: number; pacingMs: number; upstreamTtfbMs: number; arrivedAt: number; fetchStartedAt: number }): Record<string, string> {
  const prep = Math.max(0, Math.round(t.fetchStartedAt - t.arrivedAt - t.queueMs - t.pacingMs));
  return {
    [TIMING_HEADERS.queue]: String(Math.round(nonNeg(t.queueMs))),
    [TIMING_HEADERS.pacing]: String(Math.round(nonNeg(t.pacingMs))),
    [TIMING_HEADERS.ttfb]: String(Math.round(nonNeg(t.upstreamTtfbMs))),
    [TIMING_HEADERS.prep]: String(prep),
  };
}

/** The split as the request log's snake_case columns. */
export function timingLogFields(t: RequestTiming): { queue_ms: number; pacing_ms: number; upstream_ttfb_ms: number; upstream_ms: number; total_ms: number; overhead_ms: number } {
  return { queue_ms: t.queueMs, pacing_ms: t.pacingMs, upstream_ttfb_ms: t.upstreamTtfbMs, upstream_ms: t.upstreamMs, total_ms: t.totalMs, overhead_ms: overheadMs(t) };
}

export function timingStats(timings: readonly (RequestTiming | undefined)[]): TimingStats {
  const rows = timings.filter((t): t is RequestTiming => t !== undefined);
  if (rows.length === 0) {
    return { samples: 0, avgQueueMs: 0, avgPacingMs: 0, avgUpstreamTtfbMs: 0, avgUpstreamMs: 0, avgOverheadMs: 0 };
  }
  const avg = (pick: (t: RequestTiming) => number): number => Math.round(rows.reduce((s, t) => s + pick(t), 0) / rows.length);
  return {
    samples: rows.length,
    avgQueueMs: avg(t => t.queueMs),
    avgPacingMs: avg(t => t.pacingMs),
    avgUpstreamTtfbMs: avg(t => t.upstreamTtfbMs),
    avgUpstreamMs: avg(t => t.upstreamMs),
    avgOverheadMs: avg(overheadMs),
  };
}

/** The five families `/metrics` exports as summaries, each read off the recent records that carry a split. */
export const TIMING_METRIC_FAMILIES: ReadonlyArray<{ name: string; help: string; pick: (t: RequestTiming) => number }> = [
  { name: 'dario_queue_wait_ms', help: 'Time a request waited for a concurrency slot, ms.', pick: t => t.queueMs },
  { name: 'dario_pacing_wait_ms', help: 'Time a request slept in the rate governor (pacing / think-time / session-start floors), ms.', pick: t => t.pacingMs },
  { name: 'dario_upstream_ttfb_ms', help: 'First outbound byte to upstream response headers, ms (the provider\'s time to first byte).', pick: t => t.upstreamTtfbMs },
  { name: 'dario_upstream_latency_ms', help: 'First outbound byte to upstream body fully consumed, ms (the provider\'s time).', pick: t => t.upstreamMs },
  { name: 'dario_overhead_ms', help: 'Time dario itself spent on a request: total minus upstream, queue and pacing, ms.', pick: overheadMs },
];

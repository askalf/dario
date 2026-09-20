/**
 * Prometheus text exposition for `GET /metrics` (dario#1341).
 *
 * Everything here is derived from state dario already keeps — the rolling
 * analytics window, the request queue, and the ledger — rendered in the
 * text format every scraper reads. No new collection, no new state: the
 * endpoint is a view, and a scrape costs the same as `GET /analytics`.
 *
 * Pure over its inputs so it is testable without a proxy. Label values are
 * escaped per the exposition rules (backslash, double quote, newline).
 */
import type { AnalyticsSummary, RequestRecord } from './analytics.js';
import { billingBucketFromClaim } from './analytics.js';
import type { QueueSnapshot } from './request-queue.js';
import type { LedgerSummary } from './ledger.js';
import { TIMING_METRIC_FAMILIES } from './timing.js';

export interface MetricsInput {
  summary: AnalyticsSummary;
  queue: QueueSnapshot;
  lifetime: LedgerSummary | null;
  /** Most recent records, newest last — the latency quantiles come from these. */
  recent: readonly RequestRecord[];
  version: string;
}

const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const labels = (kv: Record<string, string>): string => {
  const parts = Object.entries(kv).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

const num = (n: number): string => {
  if (!Number.isFinite(n)) return n === Infinity ? '+Inf' : n === -Infinity ? '-Inf' : 'NaN';
  return String(n);
};

/** Nearest-rank quantile over a sorted ascending array. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

export function renderPrometheus(input: MetricsInput): string {
  const { summary, queue, lifetime, recent, version } = input;
  const out: string[] = [];
  // `_total` names are counters by Prometheus convention; everything else here
  // is a gauge. The latency summary is emitted by hand below.
  const metric = (name: string, help: string, rows: [Record<string, string>, number][], type: 'gauge' | 'counter' = name.endsWith('_total') ? 'counter' : 'gauge') => {
    if (rows.length === 0) return;
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const [kv, v] of rows) out.push(`${name}${labels(kv)} ${num(v)}`);
  };

  metric('dario_info', 'dario version, always 1.', [[{ version }, 1]]);

  // ---- all-time (since proxy start) -------------------------------------
  const all = summary.allTime;
  metric('dario_requests_total', 'Requests served since the proxy started.', [[{}, all.requests]]);
  metric('dario_tokens_total', 'Tokens since the proxy started, by kind.', [
    [{ kind: 'input' }, all.totalInputTokens],
    [{ kind: 'output' }, all.totalOutputTokens],
    [{ kind: 'cache_read' }, all.totalCacheReadTokens],
    [{ kind: 'cache_create' }, all.totalCacheCreateTokens],
    [{ kind: 'thinking' }, all.totalThinkingTokens],
  ]);
  metric('dario_estimated_cost_usd_total', 'API-equivalent cost of all traffic since the proxy started, USD at list price.', [[{}, all.estimatedCost]]);
  metric('dario_error_rate', 'Share of requests that failed, 0..1, all-time.', [[{}, all.errorRate]]);

  // ---- rolling window ----------------------------------------------------
  const w = summary.window;
  const win = { window_minutes: String(w.minutes) };
  metric('dario_window_requests', 'Requests in the rolling window.', [[win, w.requests]]);
  metric('dario_window_avg_latency_ms', 'Mean request latency in the rolling window, ms.', [[win, w.avgLatencyMs]]);
  // The split behind the mean (src/timing.ts). Absent when no row in the
  // window carried one — an older proxy's rows, or nothing served yet.
  const wt = w.timing;
  if (wt && wt.samples > 0) {
    metric('dario_window_avg_upstream_ttfb_ms', 'Mean upstream time to first byte in the rolling window, ms.', [[win, wt.avgUpstreamTtfbMs]]);
    metric('dario_window_avg_upstream_latency_ms', 'Mean upstream time (first outbound byte to body consumed) in the rolling window, ms.', [[win, wt.avgUpstreamMs]]);
    metric('dario_window_avg_overhead_ms', 'Mean time dario itself spent per request in the rolling window, ms.', [[win, wt.avgOverheadMs]]);
    metric('dario_window_avg_queue_wait_ms', 'Mean wait for a concurrency slot in the rolling window, ms.', [[win, wt.avgQueueMs]]);
    metric('dario_window_avg_pacing_wait_ms', 'Mean rate-governor sleep in the rolling window, ms.', [[win, wt.avgPacingMs]]);
  }
  metric('dario_window_error_rate', 'Share of requests that failed in the rolling window, 0..1.', [[win, w.errorRate]]);
  metric('dario_window_cached_prompt_percent', 'Share of prompt tokens served from cache in the rolling window, 0..100.', [[win, w.cachedPromptPercent]]);
  metric('dario_window_estimated_cost_usd', 'API-equivalent cost of the rolling window, USD.', [[win, w.estimatedCost]]);

  // ---- billing buckets (window) ------------------------------------------
  const buckets = new Map<string, number>();
  for (const [claim, n] of Object.entries(w.claimBreakdown ?? {})) {
    const b = billingBucketFromClaim(claim);
    buckets.set(b, (buckets.get(b) ?? 0) + n);
  }
  metric('dario_window_billing_requests', 'Requests in the rolling window by billing bucket.',
    [...buckets.entries()].map(([bucket, n]) => [{ bucket }, n] as [Record<string, string>, number]));

  // ---- per account -------------------------------------------------------
  const accounts = Object.entries(summary.perAccount);
  metric('dario_account_requests_total', 'Requests per pool seat since the proxy started.',
    accounts.map(([account, a]) => [{ account }, a.requests]));
  metric('dario_account_utilization', 'Last reported rate-limit utilization per seat, 0..1.',
    accounts.flatMap(([account, a]) => [
      [{ account, window: '5h' }, a.currentUtil5h] as [Record<string, string>, number],
      [{ account, window: '7d' }, a.currentUtil7d] as [Record<string, string>, number],
    ]));
  metric('dario_account_estimated_cost_usd', 'API-equivalent cost per seat since the proxy started, USD.',
    accounts.map(([account, a]) => [{ account }, a.estimatedCost]));

  // ---- per model ---------------------------------------------------------
  const models = Object.entries(summary.perModel);
  metric('dario_model_requests_total', 'Requests per model since the proxy started.',
    models.map(([model, m]) => [{ model }, m.requests]));
  metric('dario_model_estimated_cost_usd', 'API-equivalent cost per model since the proxy started, USD.',
    models.map(([model, m]) => [{ model }, m.estimatedCost]));

  // ---- per consumer (named key / header) ---------------------------------
  const consumers = Object.entries(summary.perConsumer);
  metric('dario_consumer_requests_total', 'Requests per consumer (named key or x-dario-consumer) since the proxy started.',
    consumers.map(([consumer, c]) => [{ consumer }, c.requests]));
  metric('dario_consumer_estimated_cost_usd', 'API-equivalent cost per consumer since the proxy started, USD.',
    consumers.map(([consumer, c]) => [{ consumer }, c.estimatedCost]));

  // ---- queue ---------------------------------------------------------------
  metric('dario_queue_active', 'Requests in flight upstream.', [[{}, queue.active]]);
  metric('dario_queue_queued', 'Requests waiting for a slot.', [[{}, queue.queued]]);
  metric('dario_queue_max_concurrent', 'Configured in-flight ceiling.', [[{}, queue.maxConcurrent]]);
  metric('dario_queue_max_queued', 'Configured queue ceiling.', [[{}, queue.maxQueued]]);
  metric('dario_queue_stalled', '1 when slots are held but nothing is turning over, else 0.', [[{}, queue.stalledSince ? 1 : 0]]);
  metric('dario_queue_max_wait_ms', 'Longest a request has waited for a slot since start, ms.', [[{}, queue.maxWaitMs]]);
  metric('dario_queue_consumers_active', 'Distinct consumers with a request in flight.', [[{}, queue.consumersActive]]);

  // ---- latency quantiles over the recent records -------------------------
  const lat = recent.map(r => r.latencyMs).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (lat.length > 0) {
    out.push('# HELP dario_request_latency_ms Request latency over the most recent records, ms (nearest-rank quantiles).');
    out.push('# TYPE dario_request_latency_ms summary');
    for (const q of [0.5, 0.9, 0.99]) out.push(`dario_request_latency_ms{quantile="${q}"} ${num(quantile(lat, q))}`);
    out.push(`dario_request_latency_ms_sum ${num(lat.reduce((a, b) => a + b, 0))}`);
    out.push(`dario_request_latency_ms_count ${lat.length}`);
  }
  // The same quantiles for each leg of the split, over the recent records
  // that carry one. A row without timing (older proxy, pre-upstream reject)
  // is left out rather than counted as zero.
  const timed = recent.map(r => r.timing).filter((t): t is NonNullable<typeof t> => t !== undefined);
  if (timed.length > 0) {
    for (const fam of TIMING_METRIC_FAMILIES) {
      const vals = timed.map(fam.pick).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
      out.push(`# HELP ${fam.name} ${fam.help} Nearest-rank quantiles over the most recent records.`);
      out.push(`# TYPE ${fam.name} summary`);
      for (const q of [0.5, 0.9, 0.99]) out.push(`${fam.name}{quantile="${q}"} ${num(quantile(vals, q))}`);
      out.push(`${fam.name}_sum ${num(vals.reduce((a, b) => a + b, 0))}`);
      out.push(`${fam.name}_count ${vals.length}`);
    }
  }

  // ---- predictions -------------------------------------------------------
  const p = summary.predictions;
  if (p.estimatedExhaustionMinutes !== null) {
    metric('dario_predicted_exhaustion_minutes', 'Minutes until the current seat window is predicted to exhaust at the present burn rate.', [[{}, p.estimatedExhaustionMinutes]]);
  }
  metric('dario_burn_tokens_per_minute', 'Token burn rate over the rolling window.', [[{}, p.tokenBurnRate]]);
  metric('dario_burn_cost_usd_per_minute', 'API-equivalent cost burn rate over the rolling window, USD/min.', [[{}, p.costBurnRate]]);

  // ---- ledger (survives restarts) ----------------------------------------
  if (lifetime) {
    metric('dario_ledger_requests_total', 'Requests in the ledger (covered + metered, 2xx), lifetime.', [[{}, lifetime.requests]]);
    metric('dario_ledger_api_equivalent_usd', 'What subscription-covered traffic would have cost on the metered API, lifetime, USD.', [[{}, lifetime.apiEquivalentCost]]);
    metric('dario_ledger_metered_usd', 'What metered traffic actually cost at list price, lifetime, USD.', [[{}, lifetime.meteredCost]]);
    metric('dario_ledger_recent_api_equivalent_usd', 'API-equivalent spend over trailing UTC-day windows, USD.', [
      [{ window: 'today' }, lifetime.recent.today],
      [{ window: '7d' }, lifetime.recent.last7d],
      [{ window: '30d' }, lifetime.recent.last30d],
    ]);
    metric('dario_ledger_model_api_equivalent_usd', 'Lifetime API-equivalent spend per model, USD.',
      Object.entries(lifetime.perModel).map(([model, m]) => [{ model, provider: m.provider }, m.apiEquivalentCost]));
    metric('dario_ledger_model_requests_total', 'Lifetime requests per model in the ledger.',
      Object.entries(lifetime.perModel).map(([model, m]) => [{ model, provider: m.provider }, m.requests]));
    metric('dario_ledger_consumer_api_equivalent_usd', 'Lifetime API-equivalent spend per consumer, USD.',
      Object.entries(lifetime.perConsumer).map(([consumer, c]) => [{ consumer }, c.apiEquivalentCost]));
  }

  return out.join('\n') + '\n';
}

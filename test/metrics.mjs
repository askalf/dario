#!/usr/bin/env node
/**
 * renderPrometheus — the /metrics text exposition (dario#1341), hermetic.
 *
 * Drives the renderer with a hand-built AnalyticsSummary / QueueSnapshot /
 * LedgerSummary and asserts the exposition: every family has HELP+TYPE, the
 * `_total` names are counters, labels are escaped, quantiles are nearest-rank,
 * a null ledger omits the ledger family, and a non-finite prediction is left
 * out rather than printed as NaN.
 */
import { renderPrometheus, quantile } from '../dist/metrics.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const win = (over) => ({
  totalInputTokens: 1000, totalOutputTokens: 200, totalThinkingTokens: 5, totalCacheReadTokens: 300, totalCacheCreateTokens: 50,
  cachedPromptPercent: 22.5, estimatedCost: 1.25, avgLatencyMs: 812.4, errorRate: 0.05,
  continuations: { attempted: 0, resumed: 0, failed: 0 }, claimBreakdown: { five_hour: 3, overage: 1 }, ...over,
});
const summary = {
  window: { ...win({}), minutes: 60, requests: 4 },
  allTime: { ...win({ estimatedCost: 9.5 }), requests: 40 },
  perAccount: { login: { requests: 30, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, cachedPromptPercent: 0, estimatedCost: 7, currentUtil5h: 0.42, currentUtil7d: 0.13, lastClaim: 'five_hour' } },
  perConsumer: { 'ali"ce\\x': { requests: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, cachedPromptPercent: 0, estimatedCost: 0.5, accounts: ['login'], lastModel: 'claude-sonnet-5' } },
  perModel: { 'claude-sonnet-5': { requests: 40, avgInputTokens: 1, avgOutputTokens: 1, avgThinkingTokens: 0, avgCacheReadTokens: 0, avgCacheCreateTokens: 0, cachedPromptPercent: 0, estimatedCost: 9.5 } },
  utilization: { lastUtil5h: 0.42, lastUtil7d: 0.13 },
  predictions: { estimatedExhaustionMinutes: null, tokenBurnRate: 12.5, costBurnRate: 0.02 },
};
const queue = { active: 2, queued: 1, maxConcurrent: 20, maxQueued: 100, stalledSince: null, maxWaitMs: 340, maxConcurrentPerConsumer: 0, consumersActive: 1 };
const lifetime = {
  path: '/x/ledger.json', since: '2026-09-12T00:00:00.000Z', days: 6, requests: 27_000,
  apiEquivalentCost: 987.65, meteredCost: 3.21,
  tokens: { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
  perProvider: { anthropic: { requests: 26_000, apiEquivalentCost: 960 }, openai: { requests: 1_000, apiEquivalentCost: 27.65 } },
  perModel: { 'claude-opus-5': { provider: 'anthropic', requests: 20_000, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreateTokens: 1, apiEquivalentCost: 900, meteredCost: 0 } },
  perConsumer: { alice: { requests: 5, apiEquivalentCost: 12, meteredCost: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, recent: { today: 1, last7d: 2, last30d: 3 }, lastDay: '2026-09-17', models: ['claude-opus-5'] } },
  recent: { today: 48.2, last7d: 413, last30d: 413 },
};
const recent = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map(latencyMs => ({ latencyMs }));

header('quantile');
{
  const s = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  check('p50 nearest-rank = 500', quantile(s, 0.5) === 500, quantile(s, 0.5));
  check('p90 = 900', quantile(s, 0.9) === 900, quantile(s, 0.9));
  check('p99 = 1000', quantile(s, 0.99) === 1000, quantile(s, 0.99));
  check('empty is NaN', Number.isNaN(quantile([], 0.5)));
}

header('exposition');
const text = renderPrometheus({ summary, queue, lifetime, recent, version: '6.9.0-test' });
const lines = text.split('\n');
const has = (l) => lines.includes(l);
{
  check('ends with a newline', text.endsWith('\n'));
  check('info gauge carries the version', has('dario_info{version="6.9.0-test"} 1'));
  check('requests_total is a counter', has('# TYPE dario_requests_total counter') && has('dario_requests_total 40'));
  check('every HELP has a TYPE right after it', lines.every((l, i) => !l.startsWith('# HELP') || lines[i + 1]?.startsWith('# TYPE')));
  check('tokens by kind', has('dario_tokens_total{kind="cache_read"} 300') && has('dario_tokens_total{kind="thinking"} 5'));
  check('window gauge labelled by minutes', has('dario_window_requests{window_minutes="60"} 4'));
  check('window avg latency', has('dario_window_avg_latency_ms{window_minutes="60"} 812.4'));
  check('billing buckets fold claims', has('dario_window_billing_requests{bucket="subscription"} 3') && has('dario_window_billing_requests{bucket="extra_usage"} 1'), lines.filter(l => l.startsWith('dario_window_billing')).join(' | '));
  check('per-seat utilization both windows', has('dario_account_utilization{account="login",window="5h"} 0.42') && has('dario_account_utilization{account="login",window="7d"} 0.13'));
  check('per-model cost', has('dario_model_estimated_cost_usd{model="claude-sonnet-5"} 9.5'));
  check('consumer label is escaped', has('dario_consumer_requests_total{consumer="ali\\"ce\\\\x"} 2'), lines.filter(l => l.startsWith('dario_consumer_requests_total')).join(' | '));
  check('queue gauges', has('dario_queue_active 2') && has('dario_queue_queued 1') && has('dario_queue_stalled 0') && has('dario_queue_max_wait_ms 340'));
  check('latency summary quantiles', has('dario_request_latency_ms{quantile="0.5"} 500') && has('dario_request_latency_ms{quantile="0.99"} 1000'));
  check('latency sum + count', has('dario_request_latency_ms_sum 5500') && has('dario_request_latency_ms_count 10'));
  check('null exhaustion is omitted, not NaN', !text.includes('dario_predicted_exhaustion') && !text.includes('NaN'));
  check('burn rates', has('dario_burn_tokens_per_minute 12.5') && has('dario_burn_cost_usd_per_minute 0.02'));
  check('ledger lifetime', has('dario_ledger_api_equivalent_usd 987.65') && has('dario_ledger_metered_usd 3.21') && has('dario_ledger_requests_total 27000'));
  check('ledger recent windows', has('dario_ledger_recent_api_equivalent_usd{window="7d"} 413'));
  check('ledger per model carries provider', has('dario_ledger_model_api_equivalent_usd{model="claude-opus-5",provider="anthropic"} 900'));
  check('ledger per consumer', has('dario_ledger_consumer_api_equivalent_usd{consumer="alice"} 12'));
  check('no stray undefined', !text.includes('undefined'));
}

header('timing split (dario#1341 follow-up)');
{
  check('a summary without timing emits no window split gauges', !text.includes('dario_window_avg_overhead_ms') && !text.includes('dario_window_avg_upstream_ttfb_ms'));
  check('records without timing emit no split families', !text.includes('dario_overhead_ms') && !text.includes('dario_upstream_ttfb_ms'));
  const timed = [
    { ...recent[0], timing: { queueMs: 0, pacingMs: 0, upstreamTtfbMs: 100, upstreamMs: 400, totalMs: 450 } },   // overhead 50
    { ...recent[1], timing: { queueMs: 20, pacingMs: 300, upstreamTtfbMs: 200, upstreamMs: 800, totalMs: 1200 } }, // overhead 80
    { ...recent[2] },                                                                                              // no split: left out
  ];
  const withTiming = { ...summary, window: { ...summary.window, timing: { samples: 2, avgQueueMs: 10, avgPacingMs: 150, avgUpstreamTtfbMs: 150, avgUpstreamMs: 600, avgOverheadMs: 65 } } };
  const t = renderPrometheus({ summary: withTiming, queue, lifetime: null, recent: timed, version: 'x' });
  const tl = t.split('\n');
  check('window split gauges', tl.includes('dario_window_avg_overhead_ms{window_minutes="60"} 65') && tl.includes('dario_window_avg_upstream_ttfb_ms{window_minutes="60"} 150') && tl.includes('dario_window_avg_pacing_wait_ms{window_minutes="60"} 150'), tl.filter(l => l.includes('window_avg')).join(' | '));
  for (const fam of ['dario_queue_wait_ms', 'dario_pacing_wait_ms', 'dario_upstream_ttfb_ms', 'dario_upstream_latency_ms', 'dario_overhead_ms']) {
    check(`${fam} is a summary over the timed rows only`, tl.includes(`# TYPE ${fam} summary`) && tl.includes(`${fam}_count 2`), tl.filter(l => l.includes(fam)).join(' | '));
  }
  check('overhead quantiles are the derived figure', tl.includes('dario_overhead_ms{quantile="0.5"} 50') && tl.includes('dario_overhead_ms{quantile="0.99"} 80') && tl.includes('dario_overhead_ms_sum 130'), tl.filter(l => l.startsWith('dario_overhead_ms')).join(' | '));
  check('ttfb quantiles', tl.includes('dario_upstream_ttfb_ms{quantile="0.9"} 200') && tl.includes('dario_upstream_ttfb_ms_sum 300'));
  check('every HELP still has a TYPE right after it', tl.every((l, i) => !l.startsWith('# HELP') || tl[i + 1]?.startsWith('# TYPE')));
  const zeroSamples = renderPrometheus({ summary: { ...summary, window: { ...summary.window, timing: { samples: 0, avgQueueMs: 0, avgPacingMs: 0, avgUpstreamTtfbMs: 0, avgUpstreamMs: 0, avgOverheadMs: 0 } } }, queue, lifetime: null, recent: [], version: 'x' });
  check('zero samples emits no window split gauges', !zeroSamples.includes('dario_window_avg_overhead_ms'));
}

header('edges');
{
  const noLedger = renderPrometheus({ summary, queue, lifetime: null, recent: [], version: 'x' });
  check('ledger disabled omits the ledger family', !noLedger.includes('dario_ledger_'));
  check('no records omits the latency summary', !noLedger.includes('dario_request_latency_ms'));
  const stalled = renderPrometheus({ summary, queue: { ...queue, stalledSince: Date.now() }, lifetime: null, recent: [], version: 'x' });
  check('stalled queue reads 1', stalled.split('\n').includes('dario_queue_stalled 1'));
  const withExhaustion = renderPrometheus({ summary: { ...summary, predictions: { ...summary.predictions, estimatedExhaustionMinutes: 42 } }, queue, lifetime: null, recent: [], version: 'x' });
  check('exhaustion prediction when present', withExhaustion.split('\n').includes('dario_predicted_exhaustion_minutes 42'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

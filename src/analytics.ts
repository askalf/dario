/**
 * Token analytics — per-request billing tracking, utilization trends,
 * window exhaustion predictions, cost estimation.
 *
 * In-memory rolling window. Exposed via two endpoints on the running
 * proxy:
 *
 *   - GET /analytics         — rolling summary (`AnalyticsSummary`)
 *   - GET /analytics/stream  — Server-Sent Events of new `RequestRecord`s
 *                              as they're appended. The v4 TUI's Hits
 *                              tab subscribes here for the live request
 *                              feed; non-TUI clients can `curl -N` it.
 *
 * Pre-v4 the class only emitted data when pool mode was active; v4
 * promotes analytics to always-on so single-account users get the same
 * UX. The EventEmitter mixin below makes the streaming endpoint cheap —
 * each subscriber listens for `'record'` and writes one SSE frame.
 */

import { EventEmitter } from 'node:events';

export interface RequestRecord {
  timestamp: number;
  account: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  thinkingTokens: number;
  claim: string;
  util5h: number;
  util7d: number;
  overageUtil: number;
  latencyMs: number;
  status: number;
  isStream: boolean;
  isOpenAI: boolean;
}

/**
 * The four billing buckets a request can land in, derived from the
 * `anthropic-ratelimit-unified-representative-claim` response header.
 *
 * - `subscription`         — request billed against the user's 5h subscription window (Max/Pro)
 * - `subscription_fallback` — server-side fallback subscription bucket (rare, still covered)
 * - `extra_usage`          — overage / pay-as-you-go, paid on top of subscription
 * - `api`                  — pure API key billing, no subscription involved
 * - `unknown`              — header absent or unparseable (non-200 responses, stream aborts)
 *
 * Exposed in `/analytics` summaries and in verbose per-request logs so
 * users can see at a glance which bucket their traffic is actually hitting.
 * See #34 for background.
 */
export type BillingBucket =
  | 'subscription'
  | 'subscription_fallback'
  | 'extra_usage'
  | 'api'
  | 'unknown';

/**
 * Map the raw `representative-claim` header value to a human-friendly
 * billing bucket. Pure function; no state; safe to call from any context.
 */
export function billingBucketFromClaim(claim: string | null | undefined): BillingBucket {
  switch (claim) {
    case 'five_hour':
    case 'seven_day':
    // `*_overage_included` — the plan's INCLUDED overage credit, observed live
    // 2026-07-05 on a Max account at 7d 82% with the `7d_oi` bucket at 99%:
    // fable answered normally (genuine model echo, stop_reason end_turn),
    // status=allowed_warning, overage-utilization 0 — $0 out of pocket, so it
    // is subscription billing, not extra usage. Real paid overage still
    // arrives as `overage` and still halts the guard. Pre-classification the
    // guard's halt-on-unknown design 503'd the proxy on every such claim
    // (30-min cooldown loops) exactly when the weekly window tightens.
    case 'five_hour_overage_included':
    case 'seven_day_overage_included':
      return 'subscription';
    case 'five_hour_fallback':
    case 'seven_day_fallback':
      return 'subscription_fallback';
    case 'overage':
      return 'extra_usage';
    case 'api':
      return 'api';
    default:
      return 'unknown';
  }
}

/**
 * The `representative-claim` values that mean "billed against the subscription
 * pool" — the place dario exists to keep traffic. `five_hour`/`seven_day` and
 * their server-side `_fallback` variants are all subscription billing (see
 * `billingBucketFromClaim` + discussion #1). Anything else is either a
 * non-subscription billing classification or the `unknown` sentinel below.
 */
export const SUBSCRIPTION_CLAIMS: ReadonlySet<string> = new Set([
  'five_hour',
  'seven_day',
  'five_hour_fallback',
  'seven_day_fallback',
  'five_hour_overage_included',
  'seven_day_overage_included',
]);

/**
 * One-line per-request usage summary for verbose (-v / -vv) logs.
 *
 * dario already parses `input_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens` off every response into analytics and the
 * `--log-file`, but never printed them to the console — so anyone debugging
 * subscription burn (dario#678) only ever saw the request body and the
 * billing *bucket*, never the cache accounting that actually governs cost.
 * This surfaces it next to the existing `billing:` line so a plain `-vv`
 * capture is self-diagnosing.
 *
 * `cachedPct` = cache_read / (input + cache_read + cache_create): the share of
 * *prompt* tokens served from cache rather than freshly billed. On a repeated
 * prompt a LOW value means the prefix is being re-created (a >5-minute gap
 * expired the 5m TTL, or the cached prefix changed) — the exact signal the
 * cache-TTL discussion turns on. Output tokens are excluded from the ratio
 * (they are never cacheable). Pure + total-zero-safe for unit testing.
 */
export function formatUsageLogLine(
  requestCount: number,
  u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreateTokens?: number },
): string {
  const inp = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  const cr = u.cacheReadTokens ?? 0;
  const cc = u.cacheCreateTokens ?? 0;
  const promptTotal = inp + cr + cc;
  const pct = promptTotal > 0 ? Math.round((cr / promptTotal) * 100) : 0;
  return `[dario] #${requestCount} usage: in=${inp} out=${out} cache_read=${cr} cache_create=${cc} (${pct}% of prompt from cache)`;
}

/**
 * The sentinel `claim` dario assigns when a response carried no rate-limit
 * header at all (non-200s, stream aborts, early rejects — see `pool.ts`
 * `parseRateLimits` / `EMPTY_SNAPSHOT`). It is NOT a billing classification,
 * so the overage-guard must never halt on it.
 */
export const NO_BILLING_CLAIM = 'unknown';

/**
 * True when a claim represents real *non-subscription* billing — the
 * condition the overage-guard halts on (see `overage-guard.ts`, #288).
 *
 * Deliberately an allow-list, not `claim === 'overage'`: it halts on anything
 * that is NOT a known subscription claim AND NOT the `unknown` sentinel. That
 * catches `overage` and `api` as before, but ALSO any new credit/SDK bucket
 * string Anthropic introduces — e.g. the 2026-06-15 Agent-SDK/headless split,
 * whose credit-bucket claim dario has never observed (it keeps traffic in the
 * pool) and so cannot hardcode. `unknown` is exempt: halting on it would halt
 * the proxy on every transient non-200/stream-abort.
 */
export function isNonSubscriptionBilling(claim: string | null | undefined): boolean {
  if (!claim || claim === NO_BILLING_CLAIM) return false;
  return !SUBSCRIPTION_CLAIMS.has(claim);
}

// Anthropic pricing (per 1M tokens, USD). Not authoritative — used for
// rough burn-rate display in the /analytics summary.
interface Rate { input: number; output: number; cacheRead: number; cacheCreate: number }
interface PricingEntry extends Rate {
  /**
   * Optional promotional pricing in effect through `until` (inclusive, UTC
   * end-of-day), after which the standard rate above applies. Date-modeled so
   * historical cost estimates stay accurate on BOTH sides of the cutover
   * instead of always showing one rate — each request is priced at the rate
   * effective at its own timestamp.
   */
  intro?: Rate & { until: string }; // 'YYYY-MM-DD'
}

const PRICING: Record<string, PricingEntry> = {
  // Fable 5 — official pricing (published with the 2026-07-01 redeploy):
  // $10/$50 per 1M in/out, 5m cache-write $12.50, cache-read $1 (platform docs).
  // Was previously assumed at the opus-4-8 rate ($5/$25) — corrected here.
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  // Opus 4.6 is $5/$25 (same as 4.7/4.8), not the old $15/$75 Opus-4.1 rate.
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  // Sonnet 5 standard $3/$15; launch intro $2/$10 through 2026-08-31, then
  // standard. Cache rates follow Anthropic's usual 0.1x-read / 1.25x-write of
  // input. Date-modeled below (was a flat display estimate before).
  'claude-sonnet-5': {
    input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75,
    intro: { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5, until: '2026-08-31' },
  },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-haiku-4-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
};

/**
 * The per-1M-token rate for `model` in effect at `atMs` (epoch ms): the intro
 * rate while within its window, otherwise the standard rate. A trailing context
 * tag (`claude-sonnet-5[1m]`, `claude-opus-4-7[1m]`) is stripped before lookup —
 * the [1m] ids used to fall through to the sonnet fallback and bill at the wrong
 * family's rate. Unknown models fall back to the sonnet-4-6 rate. Exported for
 * tests.
 */
export function pricingRateFor(model: string, atMs: number): Rate {
  const baseModel = model.replace(/\[[^\]]*\]$/, '');
  const entry = PRICING[baseModel] ?? PRICING['claude-sonnet-4-6']!;
  if (entry.intro && atMs <= Date.parse(`${entry.intro.until}T23:59:59.999Z`)) {
    const { until: _until, ...introRate } = entry.intro;
    return introRate;
  }
  return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheCreate: entry.cacheCreate };
}

function estimateCost(record: RequestRecord): number {
  // Price each record at the rate effective at ITS OWN timestamp, so a window
  // that spans a pricing cutover (e.g. Sonnet 5's intro ending 2026-08-31)
  // estimates each side correctly rather than repricing history at today's rate.
  const p = pricingRateFor(record.model, record.timestamp);
  return (
    (record.inputTokens * p.input) +
    (record.outputTokens * p.output) +
    (record.cacheReadTokens * p.cacheRead) +
    (record.cacheCreateTokens * p.cacheCreate)
  ) / 1_000_000;
}

export class Analytics extends EventEmitter {
  private records: RequestRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords: number = 10_000) {
    super();
    // High default — the /analytics/stream SSE endpoint creates one
    // listener per active subscriber, and Node warns at 10 by default.
    // 100 is generous for the TUI use case (one process, ~5 tabs)
    // without hiding genuine leaks.
    this.setMaxListeners(100);
    this.maxRecords = maxRecords;
  }

  /**
   * Append a request record to the rolling window and fan it out to
   * any `'record'` listeners (the SSE stream subscribers). Emit happens
   * AFTER the push so a subscriber that re-queries `recent()` from
   * inside its handler sees the new record.
   *
   * The emit is wrapped in try/catch so a misbehaving subscriber can't
   * crash the proxy hot-path; errors land on stderr (visible in
   * --verbose) but don't propagate.
   */
  record(r: RequestRecord): void {
    this.records.push(r);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
    try {
      this.emit('record', r);
    } catch (err) {
      // Subscriber threw — log + swallow. Not catastrophic; the record
      // itself is already in the rolling window.
      console.error('[dario] analytics subscriber threw:', (err as Error).message);
    }
  }

  /**
   * Return the most recent `n` records (newest last). Used by the SSE
   * endpoint to send a backlog snapshot before the live tail starts,
   * so a freshly-attached TUI sees the recent state instead of an
   * empty list.
   */
  recent(n: number = 100): RequestRecord[] {
    return this.records.slice(-n);
  }

  /** Parse usage from a non-streaming Anthropic response body. */
  static parseUsage(body: Record<string, unknown>): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    thinkingTokens: number;
    model: string;
  } {
    const u = body.usage as Record<string, number> | undefined;
    const content = body.content as Array<{ type: string; thinking?: string }> | undefined;
    const thinkingChars = content
      ?.filter(b => b.type === 'thinking')
      .reduce((s, b) => s + (b.thinking?.length ?? 0), 0) ?? 0;
    const thinkingTokens = Math.round(thinkingChars / 4);

    return {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreateTokens: u?.cache_creation_input_tokens ?? 0,
      thinkingTokens,
      model: (body.model as string) ?? 'unknown',
    };
  }

  summary(windowMinutes: number = 60): AnalyticsSummary {
    const cutoff = Date.now() - windowMinutes * 60_000;
    const recent = this.records.filter(r => r.timestamp >= cutoff);
    const allTime = this.records;

    return {
      window: {
        minutes: windowMinutes,
        requests: recent.length,
        ...this.computeStats(recent),
      },
      allTime: {
        requests: allTime.length,
        ...this.computeStats(allTime),
      },
      perAccount: this.perAccountStats(recent),
      perModel: this.perModelStats(recent),
      utilization: this.currentUtilization(recent),
      predictions: this.predict(recent),
    };
  }

  private computeStats(records: RequestRecord[]): WindowStats {
    if (records.length === 0) {
      return {
        totalInputTokens: 0, totalOutputTokens: 0, totalThinkingTokens: 0,
        estimatedCost: 0, avgLatencyMs: 0, errorRate: 0,
        claimBreakdown: {},
        billingBucketBreakdown: {
          subscription: 0,
          subscription_fallback: 0,
          extra_usage: 0,
          api: 0,
          unknown: 0,
        },
        subscriptionPercent: 0,
      };
    }

    const totalInput = records.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutput = records.reduce((s, r) => s + r.outputTokens, 0);
    const totalThinking = records.reduce((s, r) => s + r.thinkingTokens, 0);
    const cost = records.reduce((s, r) => s + estimateCost(r), 0);
    const avgLatency = records.reduce((s, r) => s + r.latencyMs, 0) / records.length;
    const errors = records.filter(r => r.status >= 400).length;

    const claims: Record<string, number> = {};
    const buckets: Record<BillingBucket, number> = {
      subscription: 0,
      subscription_fallback: 0,
      extra_usage: 0,
      api: 0,
      unknown: 0,
    };
    for (const r of records) {
      claims[r.claim] = (claims[r.claim] ?? 0) + 1;
      buckets[billingBucketFromClaim(r.claim)]++;
    }

    const subscriptionHits = buckets.subscription + buckets.subscription_fallback;
    const billedRequests = records.length - buckets.unknown;
    const subscriptionPct = billedRequests > 0
      ? Math.round((subscriptionHits / billedRequests) * 10000) / 100
      : 0;

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalThinkingTokens: totalThinking,
      estimatedCost: Math.round(cost * 10000) / 10000,
      avgLatencyMs: Math.round(avgLatency),
      errorRate: Math.round((errors / records.length) * 10000) / 10000,
      claimBreakdown: claims,
      billingBucketBreakdown: buckets,
      subscriptionPercent: subscriptionPct,
    };
  }

  private perAccountStats(records: RequestRecord[]): Record<string, PerAccountStat> {
    const grouped: Record<string, RequestRecord[]> = {};
    for (const r of records) {
      (grouped[r.account] ??= []).push(r);
    }

    const result: Record<string, PerAccountStat> = {};
    for (const [account, recs] of Object.entries(grouped)) {
      const last = recs[recs.length - 1]!;
      result[account] = {
        requests: recs.length,
        inputTokens: recs.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: recs.reduce((s, r) => s + r.outputTokens, 0),
        estimatedCost: Math.round(recs.reduce((s, r) => s + estimateCost(r), 0) * 10000) / 10000,
        currentUtil5h: last.util5h,
        currentUtil7d: last.util7d,
        lastClaim: last.claim,
      };
    }
    return result;
  }

  private perModelStats(records: RequestRecord[]): Record<string, PerModelStat> {
    const grouped: Record<string, RequestRecord[]> = {};
    for (const r of records) {
      (grouped[r.model] ??= []).push(r);
    }

    const result: Record<string, PerModelStat> = {};
    for (const [model, recs] of Object.entries(grouped)) {
      result[model] = {
        requests: recs.length,
        avgInputTokens: Math.round(recs.reduce((s, r) => s + r.inputTokens, 0) / recs.length),
        avgOutputTokens: Math.round(recs.reduce((s, r) => s + r.outputTokens, 0) / recs.length),
        avgThinkingTokens: Math.round(recs.reduce((s, r) => s + r.thinkingTokens, 0) / recs.length),
        estimatedCost: Math.round(recs.reduce((s, r) => s + estimateCost(r), 0) * 10000) / 10000,
      };
    }
    return result;
  }

  /**
   * The most recent rate-limit snapshot in the window — current 5h / 7d
   * utilization (0–1) as of the last request. The Analytics tab's rate-limit
   * gauge reads this; an empty window reads 0/0. Mirrors `perAccountStats`'
   * `last.util*` "current" semantics.
   *
   * Replaces the old per-5-min-bucket `utilizationTrend` array: the TUI gauge
   * (the only consumer of `summary.utilization`) reads `.lastUtil5h` /
   * `.lastUtil7d`, which on the array shape were `undefined` → rendered NaN%.
   * See #600.
   */
  private currentUtilization(records: RequestRecord[]): { lastUtil5h: number; lastUtil7d: number } {
    if (records.length === 0) return { lastUtil5h: 0, lastUtil7d: 0 };
    const last = records[records.length - 1]!;
    return { lastUtil5h: last.util5h, lastUtil7d: last.util7d };
  }

  private predict(records: RequestRecord[]): {
    estimatedExhaustionMinutes: number | null;
    tokenBurnRate: number;
    costBurnRate: number;
  } {
    if (records.length < 3) {
      return { estimatedExhaustionMinutes: null, tokenBurnRate: 0, costBurnRate: 0 };
    }

    const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const durationMin = (last.timestamp - first.timestamp) / 60_000;

    if (durationMin < 1) {
      return { estimatedExhaustionMinutes: null, tokenBurnRate: 0, costBurnRate: 0 };
    }

    const totalTokens = sorted.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    const totalCost = sorted.reduce((s, r) => s + estimateCost(r), 0);
    const tokenBurnRate = totalTokens / durationMin;
    const costBurnRate = (totalCost / durationMin) * 60;

    const currentUtil = last.util5h;
    if (currentUtil >= 0.95) {
      return {
        estimatedExhaustionMinutes: 0,
        tokenBurnRate: Math.round(tokenBurnRate),
        costBurnRate: Math.round(costBurnRate * 100) / 100,
      };
    }

    const utilGrowthRate = (last.util5h - first.util5h) / durationMin;
    if (utilGrowthRate <= 0) {
      return {
        estimatedExhaustionMinutes: null,
        tokenBurnRate: Math.round(tokenBurnRate),
        costBurnRate: Math.round(costBurnRate * 100) / 100,
      };
    }

    const minutesToExhaustion = (1.0 - currentUtil) / utilGrowthRate;

    return {
      estimatedExhaustionMinutes: Math.round(minutesToExhaustion),
      tokenBurnRate: Math.round(tokenBurnRate),
      costBurnRate: Math.round(costBurnRate * 100) / 100,
    };
  }
}

interface PerAccountStat {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  currentUtil5h: number;
  currentUtil7d: number;
  lastClaim: string;
}

interface PerModelStat {
  requests: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgThinkingTokens: number;
  estimatedCost: number;
}

interface WindowStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  estimatedCost: number;
  avgLatencyMs: number;
  errorRate: number;
  claimBreakdown: Record<string, number>;
  /** Count of requests in each derived billing bucket. See #34. */
  billingBucketBreakdown: Record<BillingBucket, number>;
  /**
   * Percentage of *classified* requests (non-unknown) that hit a
   * subscription bucket. The headline number for "is dario routing me
   * through my subscription?" — should be 100% for a clean setup. See #34.
   */
  subscriptionPercent: number;
}

export interface AnalyticsSummary {
  window: WindowStats & {
    minutes: number;
    requests: number;
  };
  allTime: WindowStats & {
    requests: number;
  };
  perAccount: Record<string, PerAccountStat>;
  perModel: Record<string, PerModelStat>;
  /** Current 5h / 7d rate-limit utilization (0–1) as of the last request. */
  utilization: { lastUtil5h: number; lastUtil7d: number };
  predictions: {
    estimatedExhaustionMinutes: number | null;
    tokenBurnRate: number;
    costBurnRate: number;
  };
}

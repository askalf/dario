/**
 * Token analytics — per-request billing tracking, utilization trends,
 * window exhaustion predictions, cost estimation.
 *
 * In-memory rolling window; exposed via the /analytics endpoint when
 * pool mode is active.
 */

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

// Anthropic pricing (per 1M tokens, USD). Not authoritative — used for
// rough burn-rate display in the /analytics summary.
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  'claude-haiku-4-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
};

function estimateCost(record: RequestRecord): number {
  const p = PRICING[record.model] ?? PRICING['claude-sonnet-4-6']!;
  return (
    (record.inputTokens * p.input) +
    (record.outputTokens * p.output) +
    (record.cacheReadTokens * p.cacheRead) +
    (record.cacheCreateTokens * p.cacheCreate)
  ) / 1_000_000;
}

export class Analytics {
  private records: RequestRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords: number = 10_000) {
    this.maxRecords = maxRecords;
  }

  record(r: RequestRecord): void {
    this.records.push(r);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
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
      utilization: this.utilizationTrend(recent),
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

  private utilizationTrend(records: RequestRecord[]): Array<{
    timestamp: number;
    avgUtil5h: number;
    avgUtil7d: number;
    requests: number;
  }> {
    if (records.length === 0) return [];
    const bucketMs = 5 * 60_000;
    const buckets: Map<number, RequestRecord[]> = new Map();

    for (const r of records) {
      const key = Math.floor(r.timestamp / bucketMs) * bucketMs;
      const existing = buckets.get(key);
      if (existing) {
        existing.push(r);
      } else {
        buckets.set(key, [r]);
      }
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, recs]) => ({
        timestamp: ts,
        avgUtil5h: Math.round(recs.reduce((s, r) => s + r.util5h, 0) / recs.length * 100) / 100,
        avgUtil7d: Math.round(recs.reduce((s, r) => s + r.util7d, 0) / recs.length * 100) / 100,
        requests: recs.length,
      }));
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
  utilization: Array<{
    timestamp: number;
    avgUtil5h: number;
    avgUtil7d: number;
    requests: number;
  }>;
  predictions: {
    estimatedExhaustionMinutes: number | null;
    tokenBurnRate: number;
    costBurnRate: number;
  };
}

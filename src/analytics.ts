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
import { createHash } from 'node:crypto';

export interface RequestRecord {
  timestamp: number;
  /**
   * Who the request was for (dario#1244 follow-up — a gateway shared by a
   * team had no way to say which person's traffic went where): the
   * `x-dario-consumer` header verbatim, else a hash of the body's user id.
   * Absent when neither was present.
   */
  consumer?: string;
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
  /**
   * Set when the stream died with content on the wire and the mid-stream
   * guard acted (v6.1, src/midstream.ts): what came of it and, when a resume
   * delivered, which leg served the rest. Absent on every ordinary request.
   */
  continuation?: RequestContinuation;
}

export interface RequestContinuation {
  /** See midstream.ts ContinuationOutcome. */
  outcome: 'continued' | 'continued-unfinished' | 'resume-failed' | 'no-target';
  /** Label of the leg that served the rest (`gpt-5.6-terra (codex)`), when one did. */
  by?: string;
  /** Characters the client already had when the stream died. */
  partialChars: number;
}

/**
 * How the continuations in a window went. `attempted` is every stream that
 * died with content on the wire and a guard in place; the other four
 * partition it. The number that says whether --pool-fallback is set up to
 * catch a dying stream, and how often one dies at all.
 */
export interface ContinuationStats {
  attempted: number;
  /** The client holds one complete message. */
  finished: number;
  /** A resume delivered content and then died too; the stream was left open-ended. */
  unfinished: number;
  /** Every choice delivered nothing; the stream ended truncated as before. */
  failed: number;
  /** Nothing to resume through — no --pool-fallback entry for the other provider. */
  noTarget: number;
}

export function continuationStats(records: readonly RequestRecord[]): ContinuationStats {
  const out: ContinuationStats = { attempted: 0, finished: 0, unfinished: 0, failed: 0, noTarget: 0 };
  for (const r of records) {
    if (!r.continuation) continue;
    out.attempted++;
    switch (r.continuation.outcome) {
      case 'continued': out.finished++; break;
      case 'continued-unfinished': out.unfinished++; break;
      case 'resume-failed': out.failed++; break;
      case 'no-target': out.noTarget++; break;
    }
  }
  return out;
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
    case 'chatgpt_subscription':
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
  // The codex engine: a request served from a ChatGPT-subscription account
  // (dario#1009). There is no Anthropic claim header on that path; the proxy
  // stamps this one. It is subscription billing — the user's ChatGPT plan —
  // so it must be recognised here, or the overage guard reads it as
  // pay-as-you-go and halts the proxy after the first GPT request.
  'chatgpt_subscription',
]);

/** The claim the proxy stamps on codex-engine requests (see above). */
export const CODEX_CLAIM = 'chatgpt_subscription';

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
/**
 * Share of PROMPT tokens served from cache: cache_read / (input + cache_read +
 * cache_create), as a percentage with two decimals (the same rounding as
 * subscriptionPercent). Output tokens are excluded; they are never cacheable.
 * Zero-safe. The single definition behind the summary's cache fields.
 */
export function cachedPromptPercent(inputTokens: number, cacheReadTokens: number, cacheCreateTokens: number): number {
  const promptTotal = inputTokens + cacheReadTokens + cacheCreateTokens;
  return promptTotal > 0 ? Math.round((cacheReadTokens / promptTotal) * 10000) / 100 : 0;
}

export function formatUsageLogLine(
  requestCount: number,
  u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreateTokens?: number },
  consumer?: string,
): string {
  const inp = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  const cr = u.cacheReadTokens ?? 0;
  const cc = u.cacheCreateTokens ?? 0;
  const promptTotal = inp + cr + cc;
  const pct = promptTotal > 0 ? Math.round((cr / promptTotal) * 100) : 0;
  return `[dario] #${requestCount} usage: in=${inp} out=${out} cache_read=${cr} cache_create=${cc} (${pct}% of prompt from cache)${consumer ? ` consumer=${consumer}` : ''}`;
}

/**
 * The sentinel `claim` dario assigns when a response carried no rate-limit
 * header at all (non-200s, stream aborts, early rejects — see `pool.ts`
 * `parseRateLimits` / `EMPTY_SNAPSHOT`). It is NOT a billing classification,
 * so the overage-guard must never halt on it.
 */
export const NO_BILLING_CLAIM = 'unknown';

/** Request header naming the consumer a request is for. */
export const CONSUMER_HEADER = 'x-dario-consumer';

/**
 * The consumer named by the `x-dario-consumer` header: one printable-ASCII
 * token, no spaces, at most 64 characters — anything else is treated as
 * absent rather than becoming an analytics key.
 */
export function consumerFromHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const token = raw.trim();
  return token.length > 0 && token.length <= 64 && /^[\x21-\x7e]+$/.test(token) ? token : undefined;
}

/**
 * A consumer derived from the request body when no header named one: the
 * Anthropic `metadata.user_id` (Claude Code sends
 * `user_<hash>_account_<uuid>_session_<uuid>`; the session part is dropped
 * so one person is one key across sessions) or the OpenAI `user` field.
 * Hashed, so no account id or raw user id becomes an analytics key.
 */
export function consumerFromBody(body: Record<string, unknown> | null | undefined): string | undefined {
  if (!body) return undefined;
  const meta = body.metadata;
  const userId = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).user_id : undefined;
  const raw = typeof userId === 'string' && userId.length > 0 ? userId
    : typeof body.user === 'string' && body.user.length > 0 ? body.user
    : undefined;
  if (!raw) return undefined;
  const person = raw.match(/^(user_[0-9a-f]+_account_[0-9a-f-]+)_session_/i)?.[1] ?? raw;
  return 'u_' + createHash('sha256').update(person).digest('hex').slice(0, 12);
}

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
export interface Rate { input: number; output: number; cacheRead: number; cacheCreate: number }
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

/**
 * Published per-1M-token rates, keyed by dario's model id.
 *
 * EXPORTED so scripts/check-pricing-drift.mjs can diff it against Anthropic's
 * published table. These are external facts with no natural expiry: an entry
 * that is correct today goes wrong the moment Anthropic changes it, and
 * nothing in this repo would notice. That has happened twice — Sonnet 5's
 * cancelled cutover (#1047) and Haiku 4.5 carrying Haiku 3.5's rates — which
 * is why the watcher exists (#1048).
 */
export const PRICING: Record<string, PricingEntry> = {
  // Fable 5 — official pricing (published with the 2026-07-01 redeploy):
  // $10/$50 per 1M in/out, 5m cache-write $12.50, cache-read $1 (platform docs).
  // Was previously assumed at the opus-4-8 rate ($5/$25) — corrected here.
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 },
  // Opus 5 ships at the Opus 4.8 rate — $5/$25, no long-context premium. (Its
  // fast-mode tier is $10/$50, but that rides `speed:"fast"` on the API path,
  // which the subscription surface dario proxies never sends.)
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  // Opus 4.6 is $5/$25 (same as 4.7/4.8), not the old $15/$75 Opus-4.1 rate.
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  // Sonnet 5 is $2/$10 — PERMANENTLY. This shipped as "introductory pricing
  // through 2026-08-31, then $3/$15", and was modeled here as a dated cutover.
  // Anthropic has since cancelled that increase and made $2/$10 the standard
  // price, so the cutover must NOT stay: on 2026-09-01 it would have silently
  // started pricing every Sonnet 5 record 50% high, with no error and nothing
  // in the output to suggest the number had moved.
  //
  // Left as a flat rate rather than an `intro` whose `until` sits far in the
  // future — a date nobody is watching is exactly what caused this.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  // Haiku 4.5 is $1/$5. This carried $0.80/$4 — Haiku 3.5's row, copied
  // wholesale including its cache rates — so every Haiku 4.5 cost read ~20%
  // LOW. Found by check-pricing-drift.mjs on its very first run (#1048).
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 },
};

/**
 * OpenAI's published per-1M-token rates for the models the codex backend
 * serves, standard tier, read off developers.openai.com/api/docs/pricing on
 * 2026-09-11. Kept apart from PRICING because scripts/check-pricing-drift.mjs
 * diffs that table against Anthropic's page and would report every row here
 * as "absent upstream". OpenAI charges nothing to write a cache entry, so
 * cacheCreate is the input rate (the codex path reports no cache writes
 * anyway — `cached_tokens` lands in cacheReadTokens, the rest in inputTokens).
 *
 * Before this table every `gpt-*` row was priced at the sonnet-4-6 fallback:
 * a ChatGPT-plan request showed up in "would-be API cost" at Anthropic's
 * rate for a model Anthropic does not sell. Nothing watches this table yet.
 */
export const OPENAI_PRICING: Record<string, Rate> = {
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheCreate: 10 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheCreate: 4 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheCreate: 2 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheCreate: 0.2 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheCreate: 5 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheCreate: 2.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheCreate: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheCreate: 0.2 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreate: 1.75 },
};

/** The unknown-model rate on the OpenAI side: dario's default codex model. */
const OPENAI_FALLBACK_MODEL = 'gpt-5.6-terra';

export type PricingProvider = 'anthropic' | 'openai';

/**
 * Which price list a model id belongs to. Every id the codex backend serves
 * starts `gpt-`; the rest of the pattern covers the older OpenAI families a
 * `--model-alias` might name. Anything else is priced as Claude.
 */
export function providerOfModel(model: string): PricingProvider {
  return /^(gpt-|o\d|codex|chatgpt)/i.test(model) ? 'openai' : 'anthropic';
}

/**
 * The per-1M-token rate for `model` in effect at `atMs` (epoch ms): the intro
 * rate while within its window, otherwise the standard rate. A trailing context
 * tag (`claude-sonnet-5[1m]`, `claude-opus-4-7[1m]`) is stripped before lookup —
 * the [1m] ids used to fall through to the sonnet fallback and bill at the wrong
 * family's rate — and so are an effort suffix (`gpt-5.6-terra:high`) and the
 * dated form the response echoes (`claude-haiku-4-5-20251001`, which priced
 * at the sonnet fallback until the ledger's first live run caught it).
 * Unknown Claude models fall back to the sonnet-4-6 rate, unknown OpenAI
 * models to gpt-5.6-terra's. Exported for tests.
 */
export function pricingRateFor(model: string, atMs: number): Rate {
  const baseModel = model.replace(/\[[^\]]*\]$/, '').replace(/:[a-z]+$/i, '').replace(/-\d{8}$/, '');
  if (providerOfModel(baseModel) === 'openai') {
    const rate = OPENAI_PRICING[baseModel] ?? OPENAI_PRICING[OPENAI_FALLBACK_MODEL]!;
    return { ...rate };
  }
  const entry = PRICING[baseModel] ?? PRICING['claude-sonnet-4-6']!;
  if (entry.intro && atMs <= Date.parse(`${entry.intro.until}T23:59:59.999Z`)) {
    const { until: _until, ...introRate } = entry.intro;
    return introRate;
  }
  return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheCreate: entry.cacheCreate };
}

/**
 * USD the four token buckets would bill at `model`'s rate in effect at `atMs`.
 * The ledger prices its per-day rows through this too, so a pricing
 * correction reprices history instead of freezing the old number in.
 */
export function costOfTokens(
  model: string,
  atMs: number,
  t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
): number {
  const p = pricingRateFor(model, atMs);
  return (
    (t.inputTokens * p.input) +
    (t.outputTokens * p.output) +
    (t.cacheReadTokens * p.cacheRead) +
    (t.cacheCreateTokens * p.cacheCreate)
  ) / 1_000_000;
}

function estimateCost(record: RequestRecord): number {
  // Price each record at the rate effective at ITS OWN timestamp, so a window
  // that spans a pricing cutover (no model currently has one — Sonnet 5's
  // scheduled increase was cancelled and its $2/$10 made permanent)
  // estimates each side correctly rather than repricing history at today's rate.
  return costOfTokens(record.model, record.timestamp, record);
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
      perConsumer: this.perConsumerStats(recent),
      perModel: this.perModelStats(recent),
      utilization: this.currentUtilization(recent),
      predictions: this.predict(recent),
    };
  }

  private computeStats(records: RequestRecord[]): WindowStats {
    if (records.length === 0) {
      return {
        totalInputTokens: 0, totalOutputTokens: 0, totalThinkingTokens: 0,
        totalCacheReadTokens: 0, totalCacheCreateTokens: 0, cachedPromptPercent: 0,
        estimatedCost: 0, avgLatencyMs: 0, errorRate: 0,
        continuations: { attempted: 0, finished: 0, unfinished: 0, failed: 0, noTarget: 0 },
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
    const totalCacheRead = records.reduce((s, r) => s + r.cacheReadTokens, 0);
    const totalCacheCreate = records.reduce((s, r) => s + r.cacheCreateTokens, 0);
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
      totalCacheReadTokens: totalCacheRead,
      totalCacheCreateTokens: totalCacheCreate,
      cachedPromptPercent: cachedPromptPercent(totalInput, totalCacheRead, totalCacheCreate),
      estimatedCost: Math.round(cost * 10000) / 10000,
      avgLatencyMs: Math.round(avgLatency),
      errorRate: Math.round((errors / records.length) * 10000) / 10000,
      continuations: continuationStats(records),
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
      const inputTokens = recs.reduce((s, r) => s + r.inputTokens, 0);
      const cacheReadTokens = recs.reduce((s, r) => s + r.cacheReadTokens, 0);
      const cacheCreateTokens = recs.reduce((s, r) => s + r.cacheCreateTokens, 0);
      result[account] = {
        requests: recs.length,
        inputTokens,
        outputTokens: recs.reduce((s, r) => s + r.outputTokens, 0),
        cacheReadTokens,
        cacheCreateTokens,
        cachedPromptPercent: cachedPromptPercent(inputTokens, cacheReadTokens, cacheCreateTokens),
        estimatedCost: Math.round(recs.reduce((s, r) => s + estimateCost(r), 0) * 10000) / 10000,
        currentUtil5h: last.util5h,
        currentUtil7d: last.util7d,
        lastClaim: last.claim,
      };
    }
    return result;
  }

  /** Per-consumer usage — only records that carry a consumer take part. */
  private perConsumerStats(records: RequestRecord[]): Record<string, PerConsumerStat> {
    const grouped: Record<string, RequestRecord[]> = {};
    for (const r of records) {
      if (!r.consumer) continue;
      (grouped[r.consumer] ??= []).push(r);
    }
    const result: Record<string, PerConsumerStat> = {};
    for (const [consumer, recs] of Object.entries(grouped)) {
      const inputTokens = recs.reduce((s, r) => s + r.inputTokens, 0);
      const cacheReadTokens = recs.reduce((s, r) => s + r.cacheReadTokens, 0);
      const cacheCreateTokens = recs.reduce((s, r) => s + r.cacheCreateTokens, 0);
      result[consumer] = {
        requests: recs.length,
        inputTokens,
        outputTokens: recs.reduce((s, r) => s + r.outputTokens, 0),
        cacheReadTokens,
        cacheCreateTokens,
        cachedPromptPercent: cachedPromptPercent(inputTokens, cacheReadTokens, cacheCreateTokens),
        estimatedCost: Math.round(recs.reduce((s, r) => s + estimateCost(r), 0) * 10000) / 10000,
        accounts: [...new Set(recs.map((r) => r.account))].sort(),
        lastModel: recs[recs.length - 1]!.model,
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
      const inputTokens = recs.reduce((s, r) => s + r.inputTokens, 0);
      const cacheReadTokens = recs.reduce((s, r) => s + r.cacheReadTokens, 0);
      const cacheCreateTokens = recs.reduce((s, r) => s + r.cacheCreateTokens, 0);
      result[model] = {
        requests: recs.length,
        avgInputTokens: Math.round(inputTokens / recs.length),
        avgOutputTokens: Math.round(recs.reduce((s, r) => s + r.outputTokens, 0) / recs.length),
        avgThinkingTokens: Math.round(recs.reduce((s, r) => s + r.thinkingTokens, 0) / recs.length),
        avgCacheReadTokens: Math.round(cacheReadTokens / recs.length),
        avgCacheCreateTokens: Math.round(cacheCreateTokens / recs.length),
        cachedPromptPercent: cachedPromptPercent(inputTokens, cacheReadTokens, cacheCreateTokens),
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
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Share of this account's prompt tokens served from cache (see cachedPromptPercent). */
  cachedPromptPercent: number;
  estimatedCost: number;
  currentUtil5h: number;
  currentUtil7d: number;
  lastClaim: string;
}

interface PerConsumerStat {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Share of this consumer's prompt tokens served from cache (see cachedPromptPercent). */
  cachedPromptPercent: number;
  estimatedCost: number;
  /** Seats this consumer's requests were served by, sorted. */
  accounts: string[];
  lastModel: string;
}

interface PerModelStat {
  requests: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgThinkingTokens: number;
  avgCacheReadTokens: number;
  avgCacheCreateTokens: number;
  /** Share of this model's prompt tokens served from cache (see cachedPromptPercent). */
  cachedPromptPercent: number;
  estimatedCost: number;
}

interface WindowStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  /**
   * Share of prompt tokens served from cache across the window. The number
   * that says whether a long-running session is being re-billed its prefix
   * every turn (dario#678). Until now readable only off a -v console, one
   * request at a time, and never for the codex engine at all.
   */
  cachedPromptPercent: number;
  estimatedCost: number;
  avgLatencyMs: number;
  errorRate: number;
  /** Mid-stream continuations in the window and how they went (v6.1 guard, counted since v6.6.1). */
  continuations: ContinuationStats;
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
  /** Keyed by consumer (`x-dario-consumer`, or the hashed user id); empty when no request named one. */
  perConsumer: Record<string, PerConsumerStat>;
  perModel: Record<string, PerModelStat>;
  /** Current 5h / 7d rate-limit utilization (0–1) as of the last request. */
  utilization: { lastUtil5h: number; lastUtil7d: number };
  predictions: {
    estimatedExhaustionMinutes: number | null;
    tokenBurnRate: number;
    costBurnRate: number;
  };
}

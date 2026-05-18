/**
 * Analytics tab — rolling-window summary + per-model + rate-limit bars.
 *
 * Polls /analytics on the running proxy every 2s. Renders:
 *
 *   - Top-line counters (requests, tokens in/out, cache hit, cost saved)
 *   - Per-model bars (request share by model)
 *   - Rate-limit bars (5h / 7d utilization)
 *   - Billing-bucket breakdown (subscription vs extra-usage vs api)
 *
 * State machine is straightforward — fetch + cache; no key interaction
 * beyond 'r' for forced refresh.
 */

import type { Tab, TabContext } from '../tab.js';
import { fg, dim, brand, progressBar, pad } from '../render.js';
import { renderKvRow } from '../layout.js';

/** Subset of AnalyticsSummary the Analytics tab actually renders. */
interface SummaryShape {
  window: {
    minutes: number;
    requests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalThinkingTokens: number;
    estimatedCost: number;
    avgLatencyMs: number;
    subscriptionPercent: number;
    billingBucketBreakdown: Record<string, number>;
  };
  allTime: { requests: number };
  perModel: Record<string, { requests: number; totalInputTokens: number; totalOutputTokens: number }>;
  utilization: { lastUtil5h: number; lastUtil7d: number };
}

export interface AnalyticsState {
  summary: SummaryShape | null;
  loading: boolean;
  error: string | null;
  lastFetchAt: number;
  /**
   * If true, ignore the polling cadence and refetch on the next tick.
   * Set by the 'r' key handler.
   */
  forceRefresh: boolean;
}

const POLL_INTERVAL_MS = 2000;

export const AnalyticsTab: Tab<AnalyticsState> = {
  id: 'analytics',
  label: 'Analytics',
  hotkey: 'A',  // capital A to avoid colliding with Accounts (a)

  initialState(): AnalyticsState {
    return {
      summary: null,
      loading: true,
      error: null,
      lastFetchAt: 0,
      forceRefresh: false,
    };
  },

  onMount(_state, ctx) {
    void fetchSummary(ctx);
    return undefined;
  },

  onTick(state, ctx) {
    const now = Date.now();
    if (state.forceRefresh) {
      ctx.setState({ forceRefresh: false } as Partial<AnalyticsState>);
      void fetchSummary(ctx);
      return;
    }
    if (now - state.lastFetchAt >= POLL_INTERVAL_MS && !state.loading) {
      void fetchSummary(ctx);
    }
  },

  onKey(state, key) {
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      return { ...state, forceRefresh: true };
    }
    return undefined;
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;
    const barWidth = Math.min(36, w - 32);

    lines.push(' ' + brand('Analytics') + dim(`  — last ${state.summary?.window.minutes ?? 60} min`));

    if (!state.summary && state.loading) {
      lines.push('');
      lines.push('  ' + dim('Loading…'));
      return lines.join('\n');
    }
    if (!state.summary && state.error) {
      lines.push('');
      lines.push('  ' + fg('red', `Cannot reach proxy: ${state.error}`));
      lines.push('  ' + dim('Start the proxy with `dario proxy`, then this view refreshes automatically.'));
      return lines.join('\n');
    }
    if (!state.summary) {
      lines.push('');
      lines.push('  ' + dim('(no data yet)'));
      return lines.join('\n');
    }

    const s = state.summary;

    // ── Counters ───────────────────────────────────────────────
    const rpm = s.window.requests / Math.max(1, s.window.minutes);
    lines.push('');
    lines.push('  ' + renderKvRow('Requests',
      `${s.window.requests}  ${dim(`(${rpm.toFixed(1)}/min)`)}`, w - 4));
    lines.push('  ' + renderKvRow('Tokens in',
      formatNumber(s.window.totalInputTokens), w - 4));
    lines.push('  ' + renderKvRow('Tokens out',
      formatNumber(s.window.totalOutputTokens), w - 4));
    lines.push('  ' + renderKvRow('Thinking tokens',
      formatNumber(s.window.totalThinkingTokens), w - 4));
    lines.push('  ' + renderKvRow('Avg latency',
      `${Math.round(s.window.avgLatencyMs)}ms`, w - 4));
    lines.push('  ' + renderKvRow('Subscription %',
      `${(s.window.subscriptionPercent * 100).toFixed(0)}%`, w - 4));

    // ── Per-model bars ─────────────────────────────────────────
    const models = Object.entries(s.perModel).sort((a, b) => b[1].requests - a[1].requests);
    if (models.length > 0) {
      lines.push('');
      lines.push(' ' + brand('Per-model'));
      const totalReq = Math.max(1, models.reduce((sum, [, m]) => sum + m.requests, 0));
      for (const [name, m] of models) {
        const share = m.requests / totalReq;
        const sharePct = `${(share * 100).toFixed(0)}%`.padStart(4);
        lines.push('  ' + pad(shortenModelName(name), 18) +
          fg('green', progressBar(share, barWidth)) +
          '  ' + dim(`${sharePct} (${m.requests})`));
      }
    }

    // ── Rate-limit ────────────────────────────────────────────
    lines.push('');
    lines.push(' ' + brand('Rate-limit'));
    lines.push('  ' + pad('5h', 6) +
      fg('cyan', progressBar(s.utilization.lastUtil5h, barWidth)) +
      '  ' + dim(`${(s.utilization.lastUtil5h * 100).toFixed(0)}%`));
    lines.push('  ' + pad('7d', 6) +
      fg('cyan', progressBar(s.utilization.lastUtil7d, barWidth)) +
      '  ' + dim(`${(s.utilization.lastUtil7d * 100).toFixed(0)}%`));
    // Overage bucket (v4.1, dario#288). Count of requests that landed in
    // the overage bucket within the rolling window. Empty bar in normal
    // operation; non-zero count renders in red. Hard zero IS the success
    // signal here — anything else is "investigate immediately."
    const overageCount = s.window.billingBucketBreakdown?.extra_usage ?? 0;
    const totalCount = Object.values(s.window.billingBucketBreakdown ?? {}).reduce((a, b) => a + b, 0);
    const overageFrac = totalCount > 0 ? overageCount / totalCount : 0;
    const overageColor = overageCount > 0 ? 'red' : 'cyan';
    lines.push('  ' + pad('Overage', 6) +
      fg(overageColor, progressBar(overageFrac, barWidth)) +
      '  ' + (overageCount > 0
        ? fg('red', `${overageCount} req`) + dim(` of ${totalCount}`)
        : dim('0  ← clean')));

    // ── Billing buckets ───────────────────────────────────────
    const buckets = s.window.billingBucketBreakdown;
    const totalBucketCount = Object.values(buckets).reduce((a, b) => a + b, 0);
    if (totalBucketCount > 0) {
      lines.push('');
      lines.push(' ' + brand('Billing'));
      for (const [bucket, count] of Object.entries(buckets)) {
        if (count === 0) continue;
        lines.push('  ' + pad(bucket, 22) + dim(`${count} req`));
      }
    }

    // Footer
    lines.push('');
    lines.push(' ' + dim(`Updated ${ago(state.lastFetchAt)}. Press ${fg('cyan', 'r')} to refresh.`));
    return lines.join('\n');
  },
};

async function fetchSummary(ctx: TabContext<AnalyticsState>): Promise<void> {
  ctx.setState({ loading: true } as Partial<AnalyticsState>);
  try {
    const s = await ctx.client.getJson<SummaryShape>('/analytics');
    ctx.setState({
      summary: s,
      loading: false,
      lastFetchAt: Date.now(),
      error: null,
    } as Partial<AnalyticsState>);
  } catch (e) {
    ctx.setState({
      loading: false,
      lastFetchAt: Date.now(),
      error: (e as Error).message,
    } as Partial<AnalyticsState>);
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function shortenModelName(model: string): string {
  return model.replace(/^claude-/, '').slice(0, 18);
}

function ago(ts: number): string {
  if (ts === 0) return 'never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 1) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

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
import { fg, dim, brand, progressBar, pad, truncate } from '../render.js';
import { renderKvRow } from '../layout.js';
import { fitPanels, type Panel } from '../panels.js';

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
  perAccount: Record<string, { requests: number; currentUtil5h: number; currentUtil7d: number; lastClaim: string }>;
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

/**
 * Label column for the gauge rows (5h / 7d / Overage). Was 6, which is
 * narrower than "Overage" — `pad` truncates rather than overflowing, so
 * the row rendered as `Overa…` hard against its bar. That row is the
 * "investigate immediately" signal, so it should be the one row that
 * reads unambiguously.
 */
const GAUGE_LABEL_W = 8;

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

    // Bounded like every other row. This is a `required` panel, so the row
    // budget never clips it — without a truncate it overflows a very narrow
    // terminal (25 wide at 24 cols). Found by tools/tui-audit.
    lines.push(truncate(' ' + brand('Analytics') + dim(`  — last ${state.summary?.window.minutes ?? 60} min`), w));

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

    // Panels are built full-size then fitted to the row budget. Rendering
    // all of them unconditionally overflowed a default 80x24 terminal by
    // four rows (#868); the clip took whatever sorted last rather than
    // whatever mattered least.
    const panels: Panel[] = [{ lines: [...lines], priority: 0, required: true }];
    lines.length = 0;

    // ── Counters ───────────────────────────────────────────────
    const rpm = s.window.requests / Math.max(1, s.window.minutes);
    const counters: string[] = [''];
    counters.push('  ' + renderKvRow('Requests',
      `${s.window.requests}  ${dim(`(${rpm.toFixed(1)}/min)`)}`, w - 4));
    counters.push('  ' + renderKvRow('Tokens in',
      formatNumber(s.window.totalInputTokens), w - 4));
    counters.push('  ' + renderKvRow('Tokens out',
      formatNumber(s.window.totalOutputTokens), w - 4));
    counters.push('  ' + renderKvRow('Thinking tokens',
      formatNumber(s.window.totalThinkingTokens), w - 4));
    counters.push('  ' + renderKvRow('Avg latency',
      `${Math.round(s.window.avgLatencyMs)}ms`, w - 4));
    counters.push('  ' + renderKvRow('Subscription %',
      `${s.window.subscriptionPercent.toFixed(0)}%`, w - 4));
    // Headline numbers — the two that answer "is this costing me money?"
    // survive as the collapsed form.
    panels.push({
      lines: counters,
      collapsed: ['',
        '  ' + renderKvRow('Requests', `${s.window.requests}  ${dim(`(${rpm.toFixed(1)}/min)`)}`, w - 4),
        '  ' + renderKvRow('Subscription %', `${s.window.subscriptionPercent.toFixed(0)}%`, w - 4)],
      priority: 1,
    });

    // ── Per-model bars ─────────────────────────────────────────
    const models = Object.entries(s.perModel).sort((a, b) => b[1].requests - a[1].requests);
    if (models.length > 0) {
      const perModel: string[] = ['', ' ' + brand('Per-model')];
      const totalReq = Math.max(1, models.reduce((sum, [, m]) => sum + m.requests, 0));
      for (const [name, m] of models) {
        const share = m.requests / totalReq;
        const sharePct = `${(share * 100).toFixed(0)}%`.padStart(4);
        perModel.push('  ' + pad(shortenModelName(name), 18) +
          fg('green', progressBar(share, barWidth)) +
          '  ' + dim(`${sharePct} (${m.requests})`));
      }
      // Breakdown, not a signal — degrades first.
      panels.push({
        lines: perModel,
        collapsed: ['', '  ' + renderKvRow('Per-model', dim(`${models.length} model${models.length === 1 ? '' : 's'}`), w - 4)],
        priority: 5,
      });
    }

    // ── Rate-limit ────────────────────────────────────────────
    // Each account hits its OWN 5h/7d windows, so with >1 account an
    // aggregate gauge is misleading (#600) — show one row per account, the
    // bar tracking the binding constraint (max of 5h/7d = closest to a limit).
    const rate: string[] = [''];
    const accts = s.perAccount ? Object.entries(s.perAccount) : [];
    let peakUtil = Math.max(s.utilization.lastUtil5h, s.utilization.lastUtil7d);
    if (accts.length > 1) {
      rate.push(' ' + brand('Rate-limit') + dim('  (per account)'));
      const acctBarWidth = Math.max(8, Math.min(20, w - 48));
      for (const [alias, a] of accts.sort((x, y) => y[1].requests - x[1].requests)) {
        const u5 = a.currentUtil5h ?? 0;
        const u7 = a.currentUtil7d ?? 0;
        const peak = Math.max(u5, u7);
        peakUtil = Math.max(peakUtil, peak);
        rate.push('  ' + pad(alias, 14) +
          fg(peak >= 0.9 ? 'red' : 'cyan', progressBar(peak, acctBarWidth)) +
          '  ' + dim(`5h ${(u5 * 100).toFixed(0)}%`.padEnd(8)) +
          dim(`7d ${(u7 * 100).toFixed(0)}%`));
      }
    } else {
      rate.push(' ' + brand('Rate-limit'));
      rate.push('  ' + pad('5h', GAUGE_LABEL_W) +
        fg('cyan', progressBar(s.utilization.lastUtil5h, barWidth)) +
        '  ' + dim(`${(s.utilization.lastUtil5h * 100).toFixed(0)}%`));
      rate.push('  ' + pad('7d', GAUGE_LABEL_W) +
        fg('cyan', progressBar(s.utilization.lastUtil7d, barWidth)) +
        '  ' + dim(`${(s.utilization.lastUtil7d * 100).toFixed(0)}%`));
    }
    // Overage bucket (v4.1, dario#288). Count of requests that landed in
    // the overage bucket within the rolling window. Empty bar in normal
    // operation; non-zero count renders in red. Hard zero IS the success
    // signal here — anything else is "investigate immediately."
    const overageCount = s.window.billingBucketBreakdown?.extra_usage ?? 0;
    const totalCount = Object.values(s.window.billingBucketBreakdown ?? {}).reduce((a, b) => a + b, 0);
    const overageFrac = totalCount > 0 ? overageCount / totalCount : 0;
    const overageColor = overageCount > 0 ? 'red' : 'cyan';
    const overageRow = '  ' + pad('Overage', GAUGE_LABEL_W) +
      fg(overageColor, progressBar(overageFrac, barWidth)) +
      '  ' + (overageCount > 0
        ? fg('red', `${overageCount} req`) + dim(` of ${totalCount}`)
        : dim('0  ← clean'));
    rate.push(overageRow);
    // Overage is the "investigate immediately" signal and utilisation is
    // what predicts a halt, so this panel is never dropped — collapsed it
    // keeps the overage row plus the binding utilisation number.
    panels.push({
      lines: rate,
      collapsed: ['',
        '  ' + renderKvRow('Peak utilisation', `${(peakUtil * 100).toFixed(0)}%`, w - 4),
        overageRow],
      priority: 2,
      required: true,
    });

    // ── Billing buckets ───────────────────────────────────────
    const buckets = s.window.billingBucketBreakdown;
    const totalBucketCount = Object.values(buckets).reduce((a, b) => a + b, 0);
    if (totalBucketCount > 0) {
      const billing: string[] = ['', ' ' + brand('Billing')];
      let shown = 0;
      for (const [bucket, count] of Object.entries(buckets)) {
        if (count === 0) continue;
        billing.push('  ' + pad(bucket, 22) + dim(`${count} req`));
        shown++;
      }
      panels.push({
        lines: billing,
        collapsed: ['', '  ' + renderKvRow('Billing', dim(`${shown} bucket${shown === 1 ? '' : 's'}, ${totalBucketCount} req`), w - 4)],
        priority: 4,
      });
    }

    // Footer — reserved outside the fit so the refresh key stays reachable.
    // Bounded: `ago()` grows without limit on a long-lived session, and
    // this row is now always rendered (it used to be clipped away with the
    // rest of an over-long body).
    const footer = ['', truncate(' ' + dim(`Updated ${ago(state.lastFetchAt)}. Press ${fg('cyan', 'r')} to refresh.`), w)];
    const body = fitPanels(panels, Math.max(0, dimv.rows - footer.length));
    return [...body, ...footer].join('\n');
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

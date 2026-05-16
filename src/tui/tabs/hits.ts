/**
 * Hits tab — live request stream with per-record detail drill-down.
 *
 * Subscribes to /analytics/stream on mount. Each incoming RequestRecord
 * is prepended to the buffer (newest at the top of the visible list).
 * Up/Down navigate the selection; the lower pane shows the selected
 * record's full field set.
 *
 * Layout:
 *
 *   ┌─ Hits ────────────────────────[ ↑↓ select · r refresh ]
 *   │  HH:MM:SS  METHOD  MODEL          IN     OUT   LAT    ST
 *   │  18:42:01  POST    opus-4-7       842    216   1.2s  200  ←
 *   │  18:42:03  POST    sonnet-4-6     1.2k   480   0.8s  200
 *   │  …
 *   ├─────────────────────────────────────────────────────────────
 *   │  selected: 18:42:01  req_011…NvMn
 *   │    account:  sprayberryit (single)
 *   │    model:    claude-opus-4-7
 *   │    bucket:   subscription
 *   │    tokens:   in 842 / out 216 / cache-read 6.2k / thinking 84
 *   │    latency:  1.18s   stream: yes  status: 200
 *   │    5h util:  18%     7d util: 8%
 *   └─────────────────────────────────────────────────────────────
 */

import type { Tab, TabContext } from '../tab.js';
import { fg, dim, brand, inverse, BOX, pad, truncate } from '../render.js';
import { renderKvRow } from '../layout.js';
import { billingBucketFromClaim } from '../../analytics.js';
import type { RequestRecord } from '../../analytics.js';

const MAX_BUFFER = 5000;

export interface HitsState {
  buffer: RequestRecord[];   // newest LAST in the array; we render newest-first
  selectedIdx: number;       // 0 = newest; -1 = none / not yet selected
  subscribed: boolean;
  connectionError: string | null;
}

export const HitsTab: Tab<HitsState> = {
  id: 'hits',
  label: 'Hits',
  hotkey: 'h',

  initialState(): HitsState {
    return { buffer: [], selectedIdx: -1, subscribed: false, connectionError: null };
  },

  onMount(_state, ctx) {
    // Subscribe to the live stream. Each record is prepended-conceptually
    // (we push to the array and render in reverse, which keeps the
    // buffer's mutation simple — Array.push is O(1) while unshift is O(n)).
    const close = ctx.client.subscribeAnalyticsStream<RequestRecord>(
      (record) => {
        ctx.setState((s: HitsState) => {
          const next: HitsState = {
            ...s,
            buffer: [...s.buffer, record].slice(-MAX_BUFFER),
            subscribed: true,
            connectionError: null,
          };
          // If user was at top (newest), keep them there. -1 means "no
          // selection yet"; auto-select newest on first record.
          if (s.selectedIdx === -1 || s.selectedIdx === 0) {
            next.selectedIdx = 0;
          }
          return next;
        });
      },
      (err) => {
        ctx.setState({ subscribed: false, connectionError: err.message } as Partial<HitsState>);
      },
    );
    ctx.registerCleanup(close);
    return undefined;
  },

  onKey(state, key) {
    if (state.buffer.length === 0) return undefined;
    // ↑ — go to OLDER (toward higher index in our reversed display)
    if (key.name === 'up') {
      const max = state.buffer.length - 1;
      return { ...state, selectedIdx: Math.min(state.selectedIdx + 1, max) };
    }
    // ↓ — go to NEWER
    if (key.name === 'down') {
      return { ...state, selectedIdx: Math.max(state.selectedIdx - 1, 0) };
    }
    // PgUp / PgDn — step by 10
    if (key.name === 'pageup') {
      const max = state.buffer.length - 1;
      return { ...state, selectedIdx: Math.min(state.selectedIdx + 10, max) };
    }
    if (key.name === 'pagedown') {
      return { ...state, selectedIdx: Math.max(state.selectedIdx - 10, 0) };
    }
    // Home — jump to newest
    if (key.name === 'home') {
      return { ...state, selectedIdx: 0 };
    }
    // End — jump to oldest
    if (key.name === 'end') {
      return { ...state, selectedIdx: state.buffer.length - 1 };
    }
    return undefined;
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;
    const totalRows = dimv.rows;
    // Split the body roughly 60/40 between list and detail.
    const detailRows = 9;
    const listRows = Math.max(3, totalRows - detailRows - 2);

    if (state.buffer.length === 0) {
      lines.push(' ' + brand('Hits') + dim('  — live request stream'));
      lines.push('');
      if (state.connectionError) {
        lines.push('  ' + fg('red', `SSE error: ${state.connectionError}`));
        lines.push('  ' + dim('Is `dario proxy` running? The stream reconnects automatically on the next mount.'));
      } else if (!state.subscribed) {
        lines.push('  ' + dim('Connecting to /analytics/stream …'));
      } else {
        lines.push('  ' + dim('Waiting for requests. Send one through dario to see it land here.'));
      }
      return lines.join('\n');
    }

    // Render newest-first: the LAST element of the buffer renders at
    // the TOP of the list.
    const newestFirst = [...state.buffer].reverse();
    const startIdx = clampVisibleStart(state.selectedIdx, listRows, newestFirst.length);
    const endIdx = Math.min(startIdx + listRows, newestFirst.length);

    // Column layout — fixed widths to keep alignment stable across
    // varied content. Fall back to truncation when columns overflow.
    const colTime = 9;
    const colModel = 18;
    const colIn = 8, colOut = 7, colLat = 7, colStatus = 5;

    lines.push(' ' + brand('Hits') +
      dim(`  ${state.buffer.length} buffered · ${state.subscribed ? fg('green', 'live') : fg('yellow', 'disconnected')}`));
    lines.push('');
    // Header row (aligned with data rows)
    lines.push('  ' + dim(
      pad('time', colTime) +
      pad('model', colModel) +
      pad('in', colIn) +
      pad('out', colOut) +
      pad('lat', colLat) +
      pad('st', colStatus)
    ));

    for (let i = startIdx; i < endIdx; i++) {
      const r = newestFirst[i];
      const marker = i === state.selectedIdx ? fg('cyan', '▎') : ' ';
      const row = marker + ' ' +
        pad(formatTime(r.timestamp), colTime) +
        pad(shortenModel(r.model), colModel) +
        pad(formatTokens(r.inputTokens), colIn) +
        pad(formatTokens(r.outputTokens), colOut) +
        pad(formatLatency(r.latencyMs), colLat) +
        pad(formatStatus(r.status), colStatus);
      lines.push(i === state.selectedIdx ? inverse(truncate(row, w - 2)) : truncate(row, w - 2));
    }

    // Scroll hint
    if (newestFirst.length > listRows) {
      lines.push(' ' + dim(
        `${state.selectedIdx + 1} / ${newestFirst.length}  ` +
        (startIdx > 0 ? '↑ more ' : '') +
        (endIdx < newestFirst.length ? '↓ more' : '')
      ));
    }

    // Separator
    lines.push(' ' + dim(BOX.horizontal.repeat(w - 2)));

    // Detail pane
    if (state.selectedIdx >= 0 && state.selectedIdx < newestFirst.length) {
      const r = newestFirst[state.selectedIdx];
      lines.push('  ' + brand('Selected') + dim(`  ${formatTime(r.timestamp)}`));
      lines.push('  ' + renderKvRow('Account', r.account, w - 4));
      lines.push('  ' + renderKvRow('Model', r.model, w - 4));
      lines.push('  ' + renderKvRow('Billing bucket', billingBucketFromClaim(r.claim), w - 4));
      lines.push('  ' + renderKvRow('Tokens', tokenBreakdown(r), w - 4));
      lines.push('  ' + renderKvRow('Latency', `${formatLatency(r.latencyMs)}  ${dim(r.isStream ? '(streaming)' : '(buffered)')}`, w - 4));
      lines.push('  ' + renderKvRow('Util at request',
        `5h ${(r.util5h * 100).toFixed(0)}%   7d ${(r.util7d * 100).toFixed(0)}%`, w - 4));
      lines.push('  ' + renderKvRow('Status', formatStatus(r.status), w - 4));
    } else {
      lines.push('');
      lines.push('  ' + dim('Use ↑↓ to select a request for details.'));
    }

    return lines.join('\n');
  },
};

/**
 * Decide what range of the (newest-first) buffer to show given the
 * current selection. Keeps the selection visible: if selected drifts
 * off the bottom we scroll down; off the top we scroll up.
 */
function clampVisibleStart(selectedIdx: number, listRows: number, total: number): number {
  if (selectedIdx < 0) return 0;
  // Try to keep selection roughly centered when scrolling
  const desired = selectedIdx - Math.floor(listRows / 3);
  return Math.max(0, Math.min(desired, Math.max(0, total - listRows)));
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

function shortenModel(model: string): string {
  return model.replace(/^claude-/, '');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

function formatStatus(code: number): string {
  if (code >= 200 && code < 300) return fg('green', String(code));
  if (code >= 400 && code < 500) return fg('yellow', String(code));
  if (code >= 500) return fg('red', String(code));
  return String(code);
}

function tokenBreakdown(r: RequestRecord): string {
  const parts = [`in ${r.inputTokens}`, `out ${r.outputTokens}`];
  if (r.cacheReadTokens > 0) parts.push(`cache-read ${formatTokens(r.cacheReadTokens)}`);
  if (r.cacheCreateTokens > 0) parts.push(`cache-create ${formatTokens(r.cacheCreateTokens)}`);
  if (r.thinkingTokens > 0) parts.push(`thinking ${r.thinkingTokens}`);
  return parts.join(' / ');
}

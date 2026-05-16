/**
 * Status tab — at-a-glance proxy + auth + config-source view.
 *
 * Read-mostly. On mount: probe /health for proxy reachability; load
 * config-file metadata locally. On any key, return undefined (no
 * mutations from this tab).
 *
 * Layout:
 *
 *   ┌─ Proxy ─────────────────────────────────────────┐
 *   │  status:      running                           │
 *   │  port:        3456                              │
 *   │  oauth:       healthy (expires in 7h 41m)       │
 *   │  requests:    247                               │
 *   └─────────────────────────────────────────────────┘
 *   ┌─ Config ────────────────────────────────────────┐
 *   │  source:      ~/.dario/config.json              │
 *   │  schema:      v1                                │
 *   │  …per-knob effective values (read-only)         │
 *   └─────────────────────────────────────────────────┘
 */

import type { Tab, TabContext } from '../tab.js';
import { fg, dim, brand } from '../render.js';
import { renderKvRow } from '../layout.js';

export interface StatusState {
  loading: boolean;
  /** Proxy /health response, or null if unreachable. */
  health: {
    status: string;
    oauth: string;
    expiresIn?: string;
    requests?: number;
  } | null;
  /** Config-file load source: file | missing | invalid. */
  configSource: 'file' | 'missing' | 'invalid' | null;
  /** Last refresh timestamp (ms). */
  lastRefreshAt: number;
  /** Error from the last refresh attempt, if any. */
  error: string | null;
}

export const StatusTab: Tab<StatusState> = {
  id: 'status',
  label: 'Status',
  hotkey: 's',

  initialState(): StatusState {
    return {
      loading: true,
      health: null,
      configSource: null,
      lastRefreshAt: 0,
      error: null,
    };
  },

  async onMount(_state, ctx: TabContext): Promise<StatusState | undefined> {
    return refreshStatus(ctx);
  },

  onKey(state, key) {
    // `r` triggers a manual refresh by signaling the parent to call
    // onMount again. The parent watches for a sentinel state.
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      return { ...state, loading: true };
    }
    return undefined;
  },

  render(state, dim_): string {
    const lines: string[] = [];
    const w = dim_.cols;

    if (state.loading && !state.health) {
      lines.push('');
      lines.push('  ' + dim('Loading status…'));
      return lines.join('\n');
    }

    // ── Proxy section ──────────────────────────────────────────
    lines.push(' ' + brand('Proxy'));
    if (state.health) {
      lines.push('  ' + renderKvRow('Status',  fg('green', state.health.status), w - 4));
      lines.push('  ' + renderKvRow('OAuth',   formatOauth(state.health.oauth, state.health.expiresIn), w - 4));
      lines.push('  ' + renderKvRow('Requests', String(state.health.requests ?? 0), w - 4));
    } else {
      lines.push('  ' + renderKvRow('Status', fg('red', 'unreachable — is `dario proxy` running?'), w - 4));
      if (state.error) {
        lines.push('  ' + renderKvRow('Error', dim(state.error), w - 4));
      }
    }
    lines.push('');

    // ── Config section ─────────────────────────────────────────
    lines.push(' ' + brand('Config'));
    const sourceLabel = state.configSource === 'file' ? '~/.dario/config.json'
                     : state.configSource === 'missing' ? dim('(no file — using defaults)')
                     : state.configSource === 'invalid' ? fg('yellow', '(file present but invalid — using defaults)')
                     : dim('not loaded');
    lines.push('  ' + renderKvRow('Source', sourceLabel, w - 4));
    lines.push('');

    // ── Footer hint ────────────────────────────────────────────
    lines.push('');
    lines.push(' ' + dim(`Last refresh: ${formatAgo(state.lastRefreshAt)}. Press ${fg('cyan', 'r')} to refresh.`));

    return lines.join('\n');
  },
};

/**
 * Refresh the Status tab's data — probe /health, load config file
 * metadata. Exported separately so the parent can re-invoke on key
 * 'r' without re-running the full onMount flow.
 */
export async function refreshStatus(ctx: TabContext): Promise<StatusState> {
  const { loadConfig } = await import('../../config-file.js');
  const fileResult = loadConfig();
  let health: StatusState['health'] = null;
  let error: string | null = null;
  try {
    const h = await ctx.client.health();
    health = h;
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    loading: false,
    health,
    configSource: fileResult.source,
    lastRefreshAt: Date.now(),
    error,
  };
}

function formatOauth(label: string, expiresIn?: string): string {
  if (label === 'healthy') {
    return fg('green', expiresIn ? `healthy (expires in ${expiresIn})` : 'healthy');
  }
  if (label === 'expired') return fg('yellow', 'expired (refresh on next request)');
  if (label === 'broken') return fg('red', 'broken — run `dario login`');
  if (label === 'none') return dim('no credentials');
  return label;
}

function formatAgo(ts: number): string {
  if (ts === 0) return 'never';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 1) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

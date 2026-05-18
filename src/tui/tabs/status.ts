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
import type { OverageGuardStatus } from '../proxy-client.js';

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
  /** Overage-guard state from /admin/resume — null if unreachable. */
  overageGuard: OverageGuardStatus | null;
  /** Transient: did we just attempt a manual resume? */
  resumePending: boolean;
  resumeMessage: string | null;
  resumeKind: 'success' | 'info' | 'error' | null;
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
      overageGuard: null,
      resumePending: false,
      resumeMessage: null,
      resumeKind: null,
      lastRefreshAt: 0,
      error: null,
    };
  },

  async onMount(_state, ctx: TabContext): Promise<StatusState | undefined> {
    return refreshStatus(ctx);
  },

  onTick(state, ctx) {
    // Drive the async side-effects that onKey can't fire directly.
    if (state.resumePending) {
      void performResume(ctx).then((delta) => ctx.setState(delta as Partial<StatusState>));
      return;
    }
    // Poll the overage-guard state every 2s so the halt countdown stays
    // current without the user having to press `r`. Cheap GET; the proxy
    // is on loopback. Skip when the rest of the status is still loading.
    if (!state.loading && state.overageGuard !== null && state.overageGuard.halted) {
      // While halted, refresh every 2s so the countdown updates.
      const since = Date.now() - state.lastRefreshAt;
      if (since >= 2000) {
        void ctx.client.getOverageGuard().then((g) => {
          if (g) ctx.setState({ overageGuard: g, lastRefreshAt: Date.now() } as Partial<StatusState>);
        });
      }
    }
  },

  onKey(state, key) {
    // `r` triggers a manual refresh — signal the parent to call onMount again.
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      return { ...state, loading: true };
    }
    // `R` (shift-r) resumes the overage-guard halt state when one is active.
    // Returning a sentinel state with resumePending=true signals the parent
    // to fire the async resume() call.
    if (key.name === 'printable' && key.ch === 'R' && !key.ctrl) {
      if (state.overageGuard?.halted) {
        return { ...state, resumePending: true, resumeMessage: 'Resuming…', resumeKind: 'info' };
      }
      return { ...state, resumeMessage: 'Nothing to resume — proxy is not halted.', resumeKind: 'info' };
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

    // ── Overage-guard section (v4.1, dario#288) ────────────────
    if (state.overageGuard) {
      lines.push(' ' + brand('Overage-guard'));
      if (state.overageGuard.halted && state.overageGuard.state) {
        const s = state.overageGuard.state;
        const remainingMs = Math.max(0, s.cooldownUntil - Date.now());
        const remaining = formatDuration(remainingMs);
        // Red banner header — this is the loud surface when halted
        lines.push('  ' + fg('red', '⚠ HALTED') + '  ' + dim(`overage detected ${formatAgo(s.since)} ago`));
        lines.push('  ' + renderKvRow('Request', `${s.request.model}  ${dim('account=' + s.request.account)}`, w - 4));
        lines.push('  ' + renderKvRow('Cause', `representative-claim = ${fg('red', s.request.claim)}`, w - 4));
        lines.push('  ' + renderKvRow('Auto-resume in', remaining === '0s' ? fg('yellow', 'now (cooldown elapsed)') : remaining, w - 4));
        lines.push('  ' + renderKvRow('Manual resume', `press ${fg('cyan', 'R')} here, or ${fg('cyan', 'dario resume')} from any shell`, w - 4));
      } else {
        lines.push('  ' + renderKvRow('State', fg('green', 'normal'), w - 4));
        const cfg = state.overageGuard.config;
        lines.push('  ' + renderKvRow('Mode',
          `${cfg.enabled ? fg('green', 'enabled') : fg('yellow', 'disabled')}  ${dim(`behavior=${cfg.behavior}  cooldown=${formatDuration(cfg.cooldownMs)}`)}`, w - 4));
      }
      if (state.resumeMessage) {
        const c = state.resumeKind === 'error' ? 'red' : state.resumeKind === 'success' ? 'green' : 'cyan';
        lines.push('  ' + fg(c, state.resumeMessage));
      }
      lines.push('');
    }

    // ── Footer hint ────────────────────────────────────────────
    lines.push('');
    const resumeHint = state.overageGuard?.halted ? ` · ${fg('cyan', 'R')} resume` : '';
    lines.push(' ' + dim(`Last refresh: ${formatAgo(state.lastRefreshAt)}. ${fg('cyan', 'r')} refresh${resumeHint}.`));

    return lines.join('\n');
  },
};

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

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
  // Overage-guard state — best-effort; never throws (proxy-client wraps the
  // GET in try/catch and returns null). Surface as 'unknown' when null.
  const overageGuard = await ctx.client.getOverageGuard();
  return {
    loading: false,
    health,
    configSource: fileResult.source,
    overageGuard,
    resumePending: false,
    resumeMessage: null,
    resumeKind: null,
    lastRefreshAt: Date.now(),
    error,
  };
}

/**
 * Fire the manual-resume POST and update state. Called by TuiApp when the
 * Status tab returns a state with resumePending=true (the `R` key path).
 * Lives here next to refreshStatus so all status-tab-side-effects sit
 * together.
 */
export async function performResume(ctx: TabContext<StatusState>): Promise<Partial<StatusState>> {
  try {
    const result = await ctx.client.resume();
    const refreshed = await ctx.client.getOverageGuard();
    return {
      overageGuard: refreshed,
      resumePending: false,
      resumeMessage: result.wasHalted
        ? `Resumed at ${result.resumedAt}.`
        : 'Already running normally — no-op.',
      resumeKind: 'success',
    };
  } catch (e) {
    return {
      resumePending: false,
      resumeMessage: `Resume failed: ${(e as Error).message}`,
      resumeKind: 'error',
    };
  }
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

/**
 * Accounts tab — list of OAuth subscription accounts in the pool.
 *
 * Source of truth is the RUNNING PROXY's live pool (`GET /accounts`), not a
 * local disk read: the TUI is its own process, and in a containerized / admin
 * (#599) / login-less-pool (#630) deployment the accounts live in the proxy's
 * volume, so reading `~/.dario/accounts/` in the TUI process comes up empty
 * while the proxy serves several accounts fine (#641). We fall back to the disk
 * read only when the proxy is unreachable, and flag it so the user knows the
 * view may be stale.
 *
 * Read-mostly. Mutations (add/remove) require the CLI or the admin API — the
 * tab shows the relevant command in the footer.
 *
 * Layout:
 *
 *   ┌─ Accounts ──────────────────────────────────────┐
 *   │  alias            expires    util5h   util7d    │
 *   │  ─────            ───────    ──────   ──────    │
 *   │  default          7h 41m       12%      4%      │
 *   │  alt              expired       0%      0%      │
 *   │  …                                              │
 *   └─────────────────────────────────────────────────┘
 *   To add: `dario accounts add <alias>`
 *   To remove: `dario accounts remove <alias>`
 */

import type { Tab, TabContext } from '../tab.js';
import { fg, dim, brand, pad } from '../render.js';
import { renderKvRow } from '../layout.js';

export interface AccountsState {
  loading: boolean;
  accounts: Array<{
    alias: string;
    expiresAt: number;
    /** Live pool fields — present when sourced from the proxy's `/accounts`. */
    util5h?: number;
    util7d?: number;
    status?: string;
  }>;
  error: string | null;
  /** Where the list came from: the running proxy's pool, the proxy's
   *  single-account mode, or a local disk fallback when the proxy is down. */
  source?: 'pool' | 'single-account' | 'disk';
}

/** Shape of the proxy's `GET /accounts` response (see src/proxy.ts). */
interface AccountsEndpoint {
  mode?: 'pool' | 'single-account';
  accounts?: Array<{
    alias: string;
    expiresInMs?: number;
    util5h?: number;
    util7d?: number;
    status?: string;
  }>;
}

export const AccountsTab: Tab<AccountsState> = {
  id: 'accounts',
  label: 'Accounts',
  hotkey: 'a',

  initialState(): AccountsState {
    return { loading: true, accounts: [], error: null };
  },

  async onMount(_state, ctx: TabContext): Promise<AccountsState | undefined> {
    return refreshAccounts(ctx);
  },

  onKey(state, key) {
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      return { ...state, loading: true };
    }
    return undefined;
  },

  onTick(state, ctx) {
    // onKey can only return new state, not run async work — so a manual
    // refresh ('r') just sets loading:true and this tick drives the refetch.
    // `refreshInFlight` guards against the 250ms tick stacking overlapping
    // fetches while one is already running.
    if (state.loading && !refreshInFlight) {
      refreshInFlight = true;
      void refreshAccounts(ctx)
        .then((next) => ctx.setState(next))
        .finally(() => { refreshInFlight = false; });
    }
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;

    lines.push(' ' + brand('Accounts'));

    if (state.loading && state.accounts.length === 0) {
      lines.push('');
      lines.push('  ' + dim('Loading accounts…'));
      return lines.join('\n');
    }

    if (state.accounts.length === 0) {
      lines.push('');
      if (state.source === 'single-account') {
        lines.push('  ' + dim('Single-account mode (`dario login`) — no pool.'));
        lines.push('  ' + 'Start a pool: ' + fg('cyan', 'dario accounts add <alias>'));
      } else {
        lines.push('  ' + dim('No accounts in the pool.'));
        lines.push('  ' + 'Add one: ' + fg('cyan', 'dario accounts add <alias>'));
      }
      return lines.join('\n');
    }

    // Live pool data (from /accounts) carries utilization; the disk fallback
    // doesn't, so show the util columns only when the pool populated them.
    const hasUtil = state.accounts.some((a) => a.util5h !== undefined);

    if (state.source === 'disk') {
      lines.push('  ' + fg('yellow', 'proxy unreachable — showing on-disk accounts (may be stale)'));
    }

    // Header row
    lines.push('  ' + dim(
      hasUtil
        ? pad('alias', 20) + pad('expires', 14) + pad('util5h', 9) + pad('util7d', 9) + pad('status', 14)
        : pad('alias', 20) + pad('expires', 16) + pad('source', 24)
    ));
    lines.push('  ' + dim('─'.repeat(Math.min(w - 4, 66))));

    for (const acc of state.accounts) {
      const aliasCol = pad(acc.alias, 20);
      if (hasUtil) {
        const expiresCol = pad(formatExpiry(acc.expiresAt), 14);
        const u5 = pad(acc.util5h !== undefined ? `${Math.round(acc.util5h * 100)}%` : '—', 9);
        const u7 = pad(acc.util7d !== undefined ? `${Math.round(acc.util7d * 100)}%` : '—', 9);
        const statusCol = acc.status ?? '—';
        const statusFg = statusCol === 'auth-cooldown' ? fg('yellow', statusCol) : dim(statusCol);
        lines.push('  ' + aliasCol + expiresCol + u5 + u7 + statusFg);
      } else {
        const expiresCol = pad(formatExpiry(acc.expiresAt), 16);
        const sourceCol = '~/.dario/accounts/' + acc.alias + '.json';
        lines.push('  ' + aliasCol + expiresCol + dim(sourceCol));
      }
    }

    lines.push('');
    lines.push(' ' + dim('Mutations via CLI:'));
    lines.push('   ' + fg('cyan', 'dario accounts add <alias>'));
    lines.push('   ' + fg('cyan', 'dario accounts remove <alias>'));

    // Refresh hint
    lines.push('');
    lines.push(' ' + renderKvRow('', '', w - 2));   // spacer
    lines.push(' ' + dim(`Press ${fg('cyan', 'r')} to refresh.`));

    return lines.join('\n');
  },
};

/** Guards the onTick refetch against overlapping in-flight fetches. */
let refreshInFlight = false;

export async function refreshAccounts(ctx?: TabContext<AccountsState>): Promise<AccountsState> {
  // Preferred source: the running proxy's live pool. This is what actually
  // serves traffic, and it works regardless of which process/host/volume the
  // TUI itself runs on — the fix for #641, where a containerized proxy held
  // the accounts and the TUI's local disk read came up empty.
  if (ctx) {
    try {
      const r = await ctx.client.getJson<AccountsEndpoint>('/accounts');
      if (r.mode === 'single-account') {
        return { loading: false, accounts: [], error: null, source: 'single-account' };
      }
      if (Array.isArray(r.accounts)) {
        const now = Date.now();
        return {
          loading: false,
          source: 'pool',
          accounts: r.accounts.map((a) => ({
            alias: a.alias,
            expiresAt: now + (a.expiresInMs ?? 0),
            util5h: a.util5h,
            util7d: a.util7d,
            status: a.status,
          })),
          error: null,
        };
      }
      // Unknown shape — fall through to the disk read below.
    } catch {
      // Proxy unreachable (not running, wrong port, missing key) — fall back
      // to the on-disk view so a standalone TUI still shows something, flagged
      // stale so the user knows it isn't the live pool.
      return diskFallback();
    }
  }
  return diskFallback();
}

async function diskFallback(): Promise<AccountsState> {
  try {
    const { listAccountAliases, loadAllAccounts } = await import('../../accounts.js');
    const aliases = await listAccountAliases();
    if (aliases.length === 0) {
      return { loading: false, accounts: [], error: null, source: 'disk' };
    }
    const all = await loadAllAccounts();
    return {
      loading: false,
      source: 'disk',
      accounts: all.map((a) => ({ alias: a.alias, expiresAt: a.expiresAt })),
      error: null,
    };
  } catch (e) {
    return { loading: false, accounts: [], error: (e as Error).message, source: 'disk' };
  }
}

function formatExpiry(expiresAt: number): string {
  if (expiresAt === 0) return dim('—');
  const remainingMs = expiresAt - Date.now();
  if (remainingMs < 0) return fg('yellow', 'expired');
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return fg('green', `${days}d ${hours % 24}h`);
  }
  if (hours > 0) return fg('green', `${hours}h ${minutes}m`);
  return fg('green', `${minutes}m`);
}

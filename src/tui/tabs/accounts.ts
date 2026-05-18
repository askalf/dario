/**
 * Accounts tab — list of OAuth subscription accounts in the pool.
 *
 * Read-mostly. Mutations (add/remove) require the CLI — the tab
 * shows the relevant command in the footer.
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
    /** Optional rate-limit fields populated when /accounts endpoint exists. */
    util5h?: number;
    util7d?: number;
  }>;
  error: string | null;
}

export const AccountsTab: Tab<AccountsState> = {
  id: 'accounts',
  label: 'Accounts',
  hotkey: 'a',

  initialState(): AccountsState {
    return { loading: true, accounts: [], error: null };
  },

  async onMount(_state, _ctx: TabContext): Promise<AccountsState | undefined> {
    return refreshAccounts();
  },

  onKey(state, key) {
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      return { ...state, loading: true };
    }
    return undefined;
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
      lines.push('  ' + dim('No accounts in the pool.'));
      lines.push('  ' + 'Add one: ' + fg('cyan', 'dario accounts add <alias>'));
      return lines.join('\n');
    }

    // Header row
    lines.push('  ' + dim(
      pad('alias', 20) + pad('expires', 16) + pad('source', 24)
    ));
    lines.push('  ' + dim('─'.repeat(Math.min(w - 4, 60))));

    for (const acc of state.accounts) {
      const aliasCol = pad(acc.alias, 20);
      const expiresCol = pad(formatExpiry(acc.expiresAt), 16);
      const sourceCol = '~/.dario/accounts/' + acc.alias + '.json';
      lines.push('  ' + aliasCol + expiresCol + dim(sourceCol));
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

export async function refreshAccounts(): Promise<AccountsState> {
  try {
    const { listAccountAliases, loadAllAccounts } = await import('../../accounts.js');
    const aliases = await listAccountAliases();
    if (aliases.length === 0) {
      // Single-account / login.json path — show a synthetic "default"
      // entry sourced from ~/.dario/credentials.json or keychain.
      return { loading: false, accounts: [], error: null };
    }
    const all = await loadAllAccounts();
    return {
      loading: false,
      accounts: all.map(a => ({
        alias: a.alias,
        expiresAt: a.expiresAt,
      })),
      error: null,
    };
  } catch (e) {
    return { loading: false, accounts: [], error: (e as Error).message };
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

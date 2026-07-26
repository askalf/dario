/**
 * Backends tab — OpenAI-compat backends configured locally.
 *
 * Read-only view. apiKey is masked. Mutations via CLI:
 *   dario backend add <name> --key=sk-... [--base-url=...]
 *   dario backend remove <name>
 */

import type { Tab } from '../tab.js';
import { fg, dim, brand, pad, truncate } from '../render.js';

export interface BackendsState {
  loading: boolean;
  backends: Array<{ name: string; provider: string; baseUrl: string }>;
  error: string | null;
}

export const BackendsTab: Tab<BackendsState> = {
  id: 'backends',
  label: 'Backends',
  hotkey: 'b',

  initialState(): BackendsState {
    return { loading: true, backends: [], error: null };
  },

  async onMount(): Promise<BackendsState | undefined> {
    return refreshBackends();
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
    // Bound rows at the push site: the column header is 70 wide and the
    // data rows interpolate `baseUrl`, which is unbounded (#868).
    const push = (s: string) => lines.push(truncate(s, w));

    push(' ' + brand('OpenAI-compat Backends'));

    if (state.loading && state.backends.length === 0) {
      push('');
      push('  ' + dim('Loading backends…'));
      return lines.join('\n');
    }

    if (state.backends.length === 0) {
      push('');
      push('  ' + dim('No OpenAI-compat backends configured.'));
      push('  ' + 'Add one: ' + fg('cyan', 'dario backend add openai --key=sk-...'));
      return lines.join('\n');
    }

    // This tab fits today, but it had no row budget at all — one more
    // backend or one more hint line and it would overflow like the others.
    const errorRows = state.error ? 2 : 0;
    const chromeRows = 1 /*title*/ + 1 /*header*/ + 1 /*rule*/ + errorRows +
      1 /*blank*/ + 1 /*"Mutations via CLI:"*/ + 2 /*commands*/;
    const listRows = Math.max(1, dimv.rows - chromeRows);
    const shown = state.backends.slice(0, listRows);
    const hidden = state.backends.length - shown.length;

    // Header
    push('  ' + dim(
      pad('name', 16) + pad('provider', 12) + pad('base url', 40)
    ));
    push('  ' + dim('─'.repeat(Math.min(w - 4, 68))));

    for (const b of shown) {
      push('  ' +
        pad(b.name, 16) +
        pad(b.provider, 12) +
        b.baseUrl
      );
    }
    if (hidden > 0) {
      // Spend the last list row saying what it cost, rather than dropping
      // backends silently.
      lines[lines.length - 1] = truncate('  ' + dim(`… ${hidden + 1} more backends — resize for the rest`), w);
    }

    if (state.error) {
      push('');
      push(' ' + fg('red', `Load error: ${state.error}`));
    }

    push('');
    push(' ' + dim('Mutations via CLI:'));
    push('   ' + fg('cyan', 'dario backend add <name> --key=sk-... [--base-url=...]'));
    push('   ' + fg('cyan', 'dario backend remove <name>'));

    return lines.join('\n');
  },
};

export async function refreshBackends(): Promise<BackendsState> {
  try {
    const { listBackends } = await import('../../openai-backend.js');
    const all = await listBackends();
    return {
      loading: false,
      backends: all.map(b => ({
        name: b.name,
        provider: b.provider,
        baseUrl: b.baseUrl,
      })),
      error: null,
    };
  } catch (e) {
    return { loading: false, backends: [], error: (e as Error).message };
  }
}

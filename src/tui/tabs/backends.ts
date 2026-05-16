/**
 * Backends tab — OpenAI-compat backends configured locally.
 *
 * Read-only view. apiKey is masked. Mutations via CLI:
 *   dario backend add <name> --key=sk-... [--base-url=...]
 *   dario backend remove <name>
 */

import type { Tab } from '../tab.js';
import { fg, dim, brand, pad } from '../render.js';

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

    lines.push(' ' + brand('OpenAI-compat Backends'));

    if (state.loading && state.backends.length === 0) {
      lines.push('');
      lines.push('  ' + dim('Loading backends…'));
      return lines.join('\n');
    }

    if (state.backends.length === 0) {
      lines.push('');
      lines.push('  ' + dim('No OpenAI-compat backends configured.'));
      lines.push('  ' + 'Add one: ' + fg('cyan', 'dario backend add openai --key=sk-...'));
      return lines.join('\n');
    }

    // Header
    lines.push('  ' + dim(
      pad('name', 16) + pad('provider', 12) + pad('base url', 40)
    ));
    lines.push('  ' + dim('─'.repeat(Math.min(w - 4, 68))));

    for (const b of state.backends) {
      lines.push('  ' +
        pad(b.name, 16) +
        pad(b.provider, 12) +
        b.baseUrl
      );
    }

    if (state.error) {
      lines.push('');
      lines.push(' ' + fg('red', `Load error: ${state.error}`));
    }

    lines.push('');
    lines.push(' ' + dim('Mutations via CLI:'));
    lines.push('   ' + fg('cyan', 'dario backend add <name> --key=sk-... [--base-url=...]'));
    lines.push('   ' + fg('cyan', 'dario backend remove <name>'));

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

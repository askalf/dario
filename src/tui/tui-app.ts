/**
 * Top-level TuiApp — composes the six tabs into a single App<S>.
 *
 * Responsibilities:
 *   - Render the header + tab strip + active tab body + footer
 *   - Route keys: Tab cycles, q quits, hotkeys jump, else delegate
 *   - Build per-tab TabContext (client + setState + registerCleanup)
 *   - Drive an onTick heartbeat (every 250ms) for tabs that poll
 *   - Run per-tab cleanups on tab-switch or App shutdown
 */

import { App } from './app.js';
import type { Tab, TabContext } from './tab.js';
import type { Key } from './input.js';
import { ProxyClient } from './proxy-client.js';
import { fg, dim } from './render.js';
import { renderFooter, renderHeader, renderTabStrip } from './layout.js';

import { StatusTab, type StatusState } from './tabs/status.js';
import { ConfigTab, type ConfigState } from './tabs/config.js';
import { AnalyticsTab, type AnalyticsState } from './tabs/analytics.js';
import { HitsTab, type HitsState } from './tabs/hits.js';
import { AccountsTab, type AccountsState } from './tabs/accounts.js';
import { BackendsTab, type BackendsState } from './tabs/backends.js';

const TICK_MS = 250;

/**
 * Composite state shape — one slice per tab plus the activeTab index.
 * Each slice is held with its own static type so tabs don't lose
 * type-safety; the parent dispatcher does the type-erasure when
 * routing setState calls.
 */
export interface TuiState {
  activeTab: number;
  exiting: boolean;
  status: StatusState;
  config: ConfigState;
  analytics: AnalyticsState;
  hits: HitsState;
  accounts: AccountsState;
  backends: BackendsState;
}

const TABS: Array<Tab<unknown>> = [
  StatusTab as Tab<unknown>,
  ConfigTab as Tab<unknown>,
  AnalyticsTab as Tab<unknown>,
  HitsTab as Tab<unknown>,
  AccountsTab as Tab<unknown>,
  BackendsTab as Tab<unknown>,
];

export interface TuiAppOpts {
  /** Base URL of the running proxy. Defaults to http://127.0.0.1:3456. */
  proxyUrl?: string;
  /** API key for the proxy (if DARIO_API_KEY is set). */
  apiKey?: string;
  /** dario package version, displayed in the header. */
  version: string;
}

export function startTuiApp(opts: TuiAppOpts): Promise<void> {
  const proxyUrl = opts.proxyUrl ?? 'http://127.0.0.1:3456';
  const client = new ProxyClient({ baseUrl: proxyUrl, apiKey: opts.apiKey });

  // Per-tab cleanup queues. Each entry is the cleanup fns the tab
  // registered during its current mount. When the user switches tabs,
  // we run + clear the OLD tab's cleanups before mounting the new one.
  const cleanupsByTab = new Map<number, Array<() => void>>();
  for (let i = 0; i < TABS.length; i++) cleanupsByTab.set(i, []);

  const initialState: TuiState = {
    activeTab: 0,
    exiting: false,
    status: StatusTab.initialState(),
    config: ConfigTab.initialState(),
    analytics: AnalyticsTab.initialState(),
    hits: HitsTab.initialState(),
    accounts: AccountsTab.initialState(),
    backends: BackendsTab.initialState(),
  };

  // Forward-declared App ref so the onKey closure can reference it
  // before construction. TS needs the explicit annotation since
  // strict mode disallows referencing a let-binding inside its
  // own initializer expression.
  let app: App<TuiState>;
  app = new App<TuiState>({
    initialState,
    render: (state, dim_) => renderTui(state, dim_, opts.version, proxyUrl),
    onKey: (state, key) => onKey(state, key, app, client, cleanupsByTab),
    afterFrame: () => { /* no-op for now */ },
  });

  // Mount the initial tab. The first tab's onMount fires before the
  // first redraw — that means the loading state shows briefly until
  // the async data arrives. Acceptable for v4.0; could be optimized
  // by pre-fetching before app.start().
  void mountTab(app, client, cleanupsByTab, initialState.activeTab);

  // Tick heartbeat. Calls the active tab's onTick (if any) every
  // TICK_MS. Each tab decides whether to act.
  const tickInterval = setInterval(() => {
    const s = app.getState();
    const tab = TABS[s.activeTab];
    if (tab.onTick) {
      const ctx = makeContext<unknown>(app, client, cleanupsByTab, s.activeTab);
      tab.onTick(stateOf(s, s.activeTab), ctx);
    }
  }, TICK_MS);

  // Global cleanup — fires when app.start()'s returned promise resolves
  // (i.e. when App.stop() runs).
  return app.start().finally(() => {
    clearInterval(tickInterval);
    // Run all per-tab cleanups
    for (const fns of cleanupsByTab.values()) {
      for (const fn of fns) {
        try { fn(); } catch { /* ignore */ }
      }
    }
  });
}

// ── Wiring ─────────────────────────────────────────────────────────

function onKey(
  state: TuiState,
  key: Key,
  app: App<TuiState>,
  client: ProxyClient,
  cleanupsByTab: Map<number, Array<() => void>>,
): TuiState | undefined {
  // ── Global keys ────────────────────────────────────────────
  // q quits — but only when NOT inside an edit field (the Config
  // tab's editor uses 'q' as a literal character).
  const tab = TABS[state.activeTab];
  const inEdit = state.activeTab === 1 /* config */ && state.config.editBuffer !== null;

  if (!inEdit) {
    if (key.name === 'printable' && key.ch === 'q' && !key.ctrl) {
      app.stop();
      return { ...state, exiting: true };
    }
    // Tab cycles forward; Shift+Tab cycles back. Some terminals send
    // Shift+Tab as ESC[Z (BackTab) — parseKeys reports as 'unknown'
    // currently. Listed for v4.x.
    if (key.name === 'tab') {
      return switchTab(state, (state.activeTab + 1) % TABS.length, app, client, cleanupsByTab);
    }
    // Hotkey jump
    if (key.name === 'printable' && !key.ctrl) {
      for (let i = 0; i < TABS.length; i++) {
        if (TABS[i].hotkey === key.ch) {
          return switchTab(state, i, app, client, cleanupsByTab);
        }
      }
    }
  }

  // Delegate to the active tab's onKey
  const tabSlice = stateOf(state, state.activeTab);
  const nextSlice = tab.onKey?.(tabSlice, key);
  if (nextSlice !== undefined && nextSlice !== tabSlice) {
    return withTabState(state, state.activeTab, nextSlice);
  }
  return undefined;
}

function switchTab(
  state: TuiState,
  newIdx: number,
  app: App<TuiState>,
  client: ProxyClient,
  cleanupsByTab: Map<number, Array<() => void>>,
): TuiState {
  if (newIdx === state.activeTab) return state;
  // Run OLD tab's cleanup queue + clear it
  const oldCleanups = cleanupsByTab.get(state.activeTab) ?? [];
  for (const fn of oldCleanups) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupsByTab.set(state.activeTab, []);
  // Call the old tab's onUnmount (synchronous-only)
  const oldTab = TABS[state.activeTab];
  oldTab.onUnmount?.(stateOf(state, state.activeTab));
  // Mount the new tab (fire-and-forget; async state updates via setState)
  void mountTab(app, client, cleanupsByTab, newIdx);
  return { ...state, activeTab: newIdx };
}

async function mountTab(
  app: App<TuiState>,
  client: ProxyClient,
  cleanupsByTab: Map<number, Array<() => void>>,
  idx: number,
): Promise<void> {
  const tab = TABS[idx];
  if (!tab.onMount) return;
  const ctx = makeContext<unknown>(app, client, cleanupsByTab, idx);
  const sliceBefore = stateOf(app.getState(), idx);
  const result = await tab.onMount(sliceBefore, ctx);
  if (result !== undefined) {
    app.setState((s) => withTabState(s, idx, result));
  }
}

function makeContext<S>(
  app: App<TuiState>,
  client: ProxyClient,
  cleanupsByTab: Map<number, Array<() => void>>,
  idx: number,
): TabContext<S> {
  return {
    client,
    setState: (updater) => {
      app.setState((s) => {
        const currentSlice = stateOf(s, idx) as S;
        const nextSlice = typeof updater === 'function'
          ? (updater as (prev: S) => S)(currentSlice)
          : { ...currentSlice, ...updater };
        return withTabState(s, idx, nextSlice);
      });
    },
    registerCleanup: (fn) => {
      cleanupsByTab.get(idx)?.push(fn);
    },
  };
}

/** Read the state slice for tab `idx`. */
function stateOf(s: TuiState, idx: number): unknown {
  const key = TABS[idx].id as keyof TuiState;
  return s[key];
}

/** Return a new TuiState with the slice for tab `idx` replaced. */
function withTabState(s: TuiState, idx: number, sliceVal: unknown): TuiState {
  const key = TABS[idx].id as keyof TuiState;
  return { ...s, [key]: sliceVal } as TuiState;
}

// ── Rendering ───────────────────────────────────────────────────

function renderTui(
  state: TuiState,
  dim_: { cols: number; rows: number },
  version: string,
  proxyUrl: string,
): string {
  const cols = dim_.cols;
  const rows = dim_.rows;

  const out: string[] = [];

  // Row 1: header
  out.push(renderHeader(cols, { version, status: proxyUrl }));

  // Row 2: tab strip
  const tabLabels = TABS.map(t => t.label);
  out.push(renderTabStrip(cols, tabLabels, state.activeTab));
  out.push(dim('─'.repeat(cols)));

  // Body — passed (cols, rows-5) so the tab knows it has rows 4..rows-2
  const bodyRows = rows - 5;
  const tab = TABS[state.activeTab];
  const slice = stateOf(state, state.activeTab);
  const body = tab.render(slice, { cols, rows: bodyRows });
  out.push(body);

  // Footer — fixed key hints (tab-cycling stays universal; per-tab
  // hints are inside each tab body to keep the global footer stable).
  const footerHints = [
    { key: 'Tab', label: 'next tab' },
    { key: 'q',   label: 'quit' },
    { key: 'r',   label: 'refresh' },
  ];
  // Pad body to fill rows before the footer so the footer's row stays
  // at the bottom (close to it — slight underflow OK; row count
  // depends on each tab's content).
  const bodyLines = body.split('\n').length;
  if (bodyLines < bodyRows) {
    out.push(''.padEnd(bodyRows - bodyLines, '\n'));
  }
  out.push(renderFooter(cols, footerHints));

  // Connect with newlines
  void fg;  // silence unused if neither tab uses it through this module
  return out.join('\n');
}

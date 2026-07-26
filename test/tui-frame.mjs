#!/usr/bin/env node
// Frame-level invariants for the composed TUI (header + tab strip + rule
// + active tab body + footer).
//
// The tabs each bound their own rows to varying degrees; this asserts the
// property that actually matters to the user, on the whole frame: the app
// never hands the terminal more physical rows than it has. App.redraw
// writes the frame from row 1 of the alt-screen with no scrollback, so a
// frame taller than `rows` scrolls its own header and tab strip off the
// top — the user loses the one row telling them which tab is active.
//
// Measured before the fix, with data loaded: Status 27 rows, Analytics 28
// and Hits 27, all against a default 80x24 terminal.

import { renderTui } from '../dist/tui/tui-app.js';
import { renderHeader } from '../dist/tui/layout.js';
import { visibleWidth, progressBar } from '../dist/tui/render.js';
import { StatusTab } from '../dist/tui/tabs/status.js';
import { ConfigTab } from '../dist/tui/tabs/config.js';
import { AnalyticsTab } from '../dist/tui/tabs/analytics.js';
import { HitsTab } from '../dist/tui/tabs/hits.js';
import { AccountsTab } from '../dist/tui/tabs/accounts.js';
import { BackendsTab } from '../dist/tui/tabs/backends.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const MODEL = 'claude-opus-4-5-20260101';
const ACCOUNT = 'thomas@sprayberrylabs.com';
const NOW = 1753480000000;

const record = (i) => ({
  timestamp: NOW + i * 1000, account: ACCOUNT, model: MODEL,
  inputTokens: 1000 + i * 137, outputTokens: 500 + i * 61,
  cacheReadTokens: 2048, cacheCreateTokens: 512, thinkingTokens: 256,
  claim: i % 7 === 6 ? 'overage' : 'subscription',
  util5h: 0.42, util7d: 0.17, overageUtil: 0,
  latencyMs: 300 + i * 47, status: 200, isStream: true, isOpenAI: false,
});

const guard = {
  halted: true,
  state: {
    since: NOW - 240000, cooldownUntil: NOW + 1560000,
    reason: 'representative-claim=overage',
    request: { timestamp: NOW - 240000, model: MODEL, account: ACCOUNT, claim: 'overage' },
  },
  config: { enabled: true, behavior: 'halt', cooldownMs: 1800000, notifyOs: true },
};

// Every tab in its *loaded* state — the empty states already fit, so an
// empty fixture would assert nothing.
function loadedState(activeTab) {
  return {
    activeTab,
    exiting: false,
    status: {
      ...StatusTab.initialState(),
      loading: false, configSource: 'missing',
      // `oauth` is the /health status enum (healthy|expired|broken|none, see
      // proxy.ts) — not a credential. 'healthy' is the branch formatOauth
      // actually formats; anything else falls through to a bare passthrough.
      health: { status: 'ok', oauth: 'healthy', expiresIn: '6h 12m', requests: 1234 },
      models: [MODEL, MODEL + '[1m]', 'claude-sonnet-5-20260115', 'claude-fable-5', 'claude-haiku-4-5-20251001'],
      overageGuard: guard, lastRefreshAt: NOW,
    },
    config: ConfigTab.initialState(),
    analytics: {
      ...AnalyticsTab.initialState(),
      loading: false, lastFetchAt: NOW,
      summary: {
        window: {
          minutes: 60, requests: 128, totalInputTokens: 1284321, totalOutputTokens: 486210,
          totalThinkingTokens: 41200, estimatedCost: 12.4471, avgLatencyMs: 1842,
          subscriptionPercent: 0.94,
          billingBucketBreakdown: { subscription: 120, overage: 6, api: 2 },
        },
        allTime: { requests: 98213 },
        perModel: {
          [MODEL]: { requests: 84, totalInputTokens: 901221, totalOutputTokens: 322110 },
          'claude-sonnet-5-20260115': { requests: 44, totalInputTokens: 383100, totalOutputTokens: 164100 },
        },
        utilization: { lastUtil5h: 0.62, lastUtil7d: 0.31 },
        perAccount: {
          [ACCOUNT]: { requests: 96, currentUtil5h: 0.62, currentUtil7d: 0.31, lastClaim: 'subscription' },
          'ops+secondary@sprayberrylabs.com': { requests: 32, currentUtil5h: 0.18, currentUtil7d: 0.09, lastClaim: 'overage' },
        },
      },
    },
    hits: {
      ...HitsTab.initialState(),
      subscribed: true, selectedIdx: 0,
      buffer: Array.from({ length: 24 }, (_, i) => record(i)),
      halt: { since: NOW - 240000, cooldownUntil: NOW + 1560000, request: { claim: 'overage', model: MODEL, account: ACCOUNT } },
    },
    accounts: {
      ...AccountsTab.initialState(),
      loading: false,
      accounts: [
        { alias: ACCOUNT, expiresAt: NOW + 22320000, util5h: 0.62, util7d: 0.31, status: 'active' },
        { alias: 'ops+secondary@sprayberrylabs.com', expiresAt: NOW + 5400000, util5h: 0.18, util7d: 0.09, status: 'active' },
        { alias: 'archive+coldstorage@sprayberrylabs.com', expiresAt: NOW - 1000, util5h: 0, util7d: 0, status: 'expired' },
      ],
    },
    backends: BackendsTab.initialState(),
  };
}

const TAB_NAMES = ['Status', 'Config', 'Analytics', 'Hits', 'Accounts', 'Backends'];
const GEOMETRIES = [[200, 50], [160, 45], [120, 40], [100, 30], [80, 24], [70, 20], [60, 18], [55, 16], [45, 14], [40, 12], [30, 8], [24, 6]];

// ─────────────────────────────────────────────────────────────
header('Frame never exceeds the terminal, any tab, any geometry');
for (const [cols, rows] of GEOMETRIES) {
  for (let t = 0; t < TAB_NAMES.length; t++) {
    const frame = renderTui(loadedState(t), { cols, rows }, '5.4.6', 'http://127.0.0.1:3456');
    const lines = frame.split('\n');
    check(`${TAB_NAMES[t]} ${cols}x${rows}: frame fits rows`, lines.length <= rows, `${lines.length} > ${rows}`);
    const widest = Math.max(...lines.map(visibleWidth));
    check(`${TAB_NAMES[t]} ${cols}x${rows}: no row exceeds cols`, widest <= cols, `widest=${widest}`);
  }
}

// ─────────────────────────────────────────────────────────────
header('The chrome the user navigates by is never what gets dropped');
{
  // Overflow used to push these off the top of the alt-screen. They must
  // survive at the size where the tabs were measured overflowing.
  for (let t = 0; t < TAB_NAMES.length; t++) {
    const lines = renderTui(loadedState(t), { cols: 80, rows: 24 }, '5.4.6', 'http://127.0.0.1:3456').split('\n');
    check(`${TAB_NAMES[t]} 80x24: header row survives`, lines[0].includes('dario'));
    check(`${TAB_NAMES[t]} 80x24: tab strip survives`, lines[1].includes('Status') && lines[1].includes('Backends'));
    check(`${TAB_NAMES[t]} 80x24: footer survives`, lines[lines.length - 1].includes('quit'));
  }
}

// ─────────────────────────────────────────────────────────────
header('Clipping is announced, not silent');
{
  // Status is a fixed ~27 rows loaded, so 24 rows must clip it.
  const frame = renderTui(loadedState(0), { cols: 80, rows: 24 }, '5.4.6', 'http://127.0.0.1:3456');
  check('clipped frame carries a "more rows" note', /more rows? — resize/.test(frame), JSON.stringify(frame.split('\n').slice(-4, -1)));
  // A tall terminal fits Status outright and must NOT show the note.
  const roomy = renderTui(loadedState(0), { cols: 120, rows: 45 }, '5.4.6', 'http://127.0.0.1:3456');
  check('unclipped frame has no note', !/more rows? — resize/.test(roomy));
}

// ─────────────────────────────────────────────────────────────
header('renderHeader shrinks instead of overflowing');
{
  let worst = 0, at = null;
  for (let cols = 10; cols <= 120; cols++) {
    const h = renderHeader(cols, { version: '5.4.6-longish', status: 'http://127.0.0.1:3456' });
    const over = visibleWidth(h) - cols;
    if (over > worst) { worst = over; at = `cols=${cols} width=${visibleWidth(h)}`; }
  }
  check('header fits every width 10-120', worst === 0, at);
  check('header keeps the brand when it has to drop the status',
    renderHeader(30, { version: '5.4.6', status: 'http://127.0.0.1:3456' }).includes('dario'));
}

// ─────────────────────────────────────────────────────────────
header('progressBar degrades instead of throwing');
{
  // Call sites compute the bar width as (terminal width - label columns),
  // which goes negative on a narrow terminal. String.repeat() throws
  // RangeError on a negative count, and that took the whole TUI down:
  // Analytics threw at every width <= 31.
  for (const w of [-8, -1, 0, 1, 10]) {
    let ok = true, out = '';
    try { out = progressBar(0.5, w); } catch { ok = false; }
    check(`progressBar(0.5, ${w}) does not throw`, ok);
    if (ok) check(`progressBar(0.5, ${w}) width is sane`, visibleWidth(out) === Math.max(0, w), `got ${visibleWidth(out)}`);
  }
  check('progressBar tolerates a non-finite value', (() => {
    try { progressBar(NaN, 10); return true; } catch { return false; }
  })());
  // The tab that actually crashed, across the widths that crashed it.
  for (let cols = 20; cols <= 40; cols++) {
    let ok = true;
    try { AnalyticsTab.render(loadedState(2).analytics, { cols, rows: 30 }); } catch { ok = false; }
    check(`Analytics renders at ${cols} cols`, ok);
  }
}

// ─────────────────────────────────────────────────────────────
header('Status halt banner reads correctly');
{
  const body = StatusTab.render(loadedState(0).status, { cols: 100, rows: 40 });
  check('no doubled "ago ago"', !/ago\s+ago/.test(body), JSON.stringify((body.match(/detected[^\n]*/) || [])[0]));
  check('still reports how long ago', /detected \d+[smh] ago/.test(body), JSON.stringify((body.match(/detected[^\n]*/) || [])[0]));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

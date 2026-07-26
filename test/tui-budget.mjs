#!/usr/bin/env node
// Per-tab row budgets (#868).
//
// #866 stopped the app writing frames taller than the terminal, but that
// fix is a floor: renderTui clips whatever sorts last. On Status that was
// the Overage-guard panel, so the tab that tells you the proxy has HALTED
// hid the halt on a default 80x24 terminal.
//
// These assertions are about WHAT a tab gives up, not just how much:
// a tab must fit its budget AND keep the rows that are the reason to look
// at it.

import { fitPanels } from '../dist/tui/panels.js';
import { visibleWidth } from '../dist/tui/render.js';
import { StatusTab } from '../dist/tui/tabs/status.js';
import { AnalyticsTab } from '../dist/tui/tabs/analytics.js';
import { HitsTab } from '../dist/tui/tabs/hits.js';
import { BackendsTab } from '../dist/tui/tabs/backends.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const NOW = 1753480000000;
const MODEL = 'claude-opus-4-5-20260101';
const ACCOUNT = 'thomas@sprayberrylabs.com';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ─────────────────────────────────────────────────────────────
header('fitPanels — degrades least-important first');
{
  const P = (n, priority, opts = {}) => ({
    lines: Array.from({ length: n }, (_, i) => `${opts.tag ?? 'p'}${i}`),
    ...opts,
  });
  const a = { lines: ['a0', 'a1', 'a2'], collapsed: ['a!'], priority: 1 };
  const b = { lines: ['b0', 'b1', 'b2'], collapsed: ['b!'], priority: 5 };

  check('fits untouched when there is room', fitPanels([a, b], 10).join(',') === 'a0,a1,a2,b0,b1,b2');
  check('collapses the LEAST important first',
    fitPanels([a, b], 4).join(',') === 'a0,a1,a2,b!', JSON.stringify(fitPanels([a, b], 4)));
  check('collapses both before dropping anything',
    fitPanels([a, b], 2).join(',') === 'a!,b!', JSON.stringify(fitPanels([a, b], 2)));
  check('drops only after collapsing',
    fitPanels([a, b], 1).join(',') === 'a!', JSON.stringify(fitPanels([a, b], 1)));

  const req = { lines: ['R0', 'R1'], priority: 9, required: true };
  const opt = { lines: ['o0', 'o1'], priority: 0 };
  check('required survives even at the lowest priority',
    fitPanels([req, opt], 2).join(',') === 'R0,R1', JSON.stringify(fitPanels([req, opt], 2)));
  check('display order is preserved, not priority order',
    fitPanels([b, a], 10).join(',') === 'b0,b1,b2,a0,a1,a2');
  check('over-budget required panels are returned rather than truncated',
    fitPanels([req], 1).length === 2, 'renderTui clamp is the final floor');
  void P;
}

// ─────────────────────────────────────────────────────────────
header('Status — a halt is never what gets dropped');
{
  const guard = {
    halted: true,
    state: {
      since: NOW - 240000, cooldownUntil: NOW + 1560000, reason: 'representative-claim=overage',
      request: { timestamp: NOW - 240000, model: MODEL, account: ACCOUNT, claim: 'overage' },
    },
    config: { enabled: true, behavior: 'halt', cooldownMs: 1800000, notifyOs: true },
  };
  const halted = {
    ...StatusTab.initialState(), loading: false, configSource: 'missing',
    health: { status: 'ok', oauth: 'healthy', expiresIn: '6h 12m', requests: 1234 },
    models: [MODEL, MODEL + '[1m]', 'claude-sonnet-5-20260115', 'claude-fable-5', 'claude-haiku-4-5-20251001'],
    overageGuard: guard, lastRefreshAt: NOW,
  };

  for (const rows of [40, 25, 19, 16, 14]) {
    const out = StatusTab.render(halted, { cols: 80, rows });
    const n = out.split('\n').length;
    check(`80x${rows}: body within budget`, n <= rows, `${n} > ${rows}`);
    check(`80x${rows}: HALTED still shown`, /HALTED/.test(strip(out)));
    check(`80x${rows}: resume path still shown`, /dario resume/.test(strip(out)));
  }
  // 19 rows is the body budget of a default 80x24 terminal — the exact
  // case where the halt used to be clipped.
  const at19 = strip(StatusTab.render(halted, { cols: 80, rows: 19 }));
  check('80x24 body: Models collapsed rather than the halt dropped', /advertised/.test(at19), JSON.stringify(at19.slice(0, 80)));
  check('80x24 body: cause still shown', /overage/.test(at19));

  // Idle, Overage-guard is just configuration and may collapse.
  const idle = { ...halted, overageGuard: { halted: false, state: null, config: guard.config } };
  const idleOut = StatusTab.render(idle, { cols: 80, rows: 14 });
  check('idle: fits a short terminal', idleOut.split('\n').length <= 14);
}

// ─────────────────────────────────────────────────────────────
header('Analytics — the overage signal survives');
{
  const s = {
    ...AnalyticsTab.initialState(), loading: false, lastFetchAt: NOW,
    summary: {
      window: {
        minutes: 60, requests: 128, totalInputTokens: 1284321, totalOutputTokens: 486210,
        totalThinkingTokens: 41200, estimatedCost: 12.4, avgLatencyMs: 1842,
        subscriptionPercent: 94, billingBucketBreakdown: { subscription: 120, extra_usage: 6, api: 2 },
      },
      allTime: { requests: 98213 },
      perModel: {
        [MODEL]: { requests: 84, totalInputTokens: 9, totalOutputTokens: 3 },
        'claude-sonnet-5-20260115': { requests: 44, totalInputTokens: 3, totalOutputTokens: 1 },
      },
      utilization: { lastUtil5h: 0.62, lastUtil7d: 0.31 },
      perAccount: {
        [ACCOUNT]: { requests: 96, currentUtil5h: 0.62, currentUtil7d: 0.31, lastClaim: 'subscription' },
        'ops+secondary@sprayberrylabs.com': { requests: 32, currentUtil5h: 0.18, currentUtil7d: 0.09, lastClaim: 'extra_usage' },
      },
    },
  };
  for (const rows of [40, 25, 19, 14, 10]) {
    const out = AnalyticsTab.render(s, { cols: 80, rows });
    const n = out.split('\n').length;
    check(`80x${rows}: body within budget`, n <= rows, `${n} > ${rows}`);
    check(`80x${rows}: overage row survives`, /Overage/.test(strip(out)), JSON.stringify(strip(out).slice(0, 70)));
    check(`80x${rows}: refresh hint survives`, /refresh/.test(strip(out)));
  }
  // The gauge label column was 6 — narrower than "Overage", so `pad`
  // truncated the most important row's label to "Overa…".
  const full = strip(AnalyticsTab.render(s, { cols: 100, rows: 40 }));
  check('overage row is labelled in full, not "Overa…"', /Overage/.test(full) && !/Overa…/.test(full));

  // Narrow widths at a height that still renders the title. tui-frame.mjs
  // sweeps to 24x6, but at 6 rows the body budget is 1 and the frame clamp
  // swaps the title for the "… more rows" note before it can be measured,
  // so the title's own width went unchecked. tools/tui-audit caught it live
  // at 24x8: " Analytics  — last 60 min" is 25 wide.
  for (const cols of [24, 28, 32, 40]) {
    const lines = AnalyticsTab.render(s, { cols, rows: 8 }).split('\n');
    const widest = Math.max(...lines.map(visibleWidth));
    check(`Analytics ${cols}x8: no row exceeds cols`, widest <= cols, `widest=${widest}`);
  }
}

// ─────────────────────────────────────────────────────────────
header('Hits — chrome reservation matches what it renders');
{
  const rec = (i) => ({
    timestamp: NOW + i * 1000, account: ACCOUNT, model: MODEL,
    inputTokens: 1000 + i, outputTokens: 500 + i, cacheReadTokens: 0,
    cacheCreateTokens: 0, thinkingTokens: 0, claim: 'subscription',
    util5h: 0.4, util7d: 0.2, overageUtil: 0, latencyMs: 300,
    status: 200, isStream: true, isOpenAI: false,
  });
  const base = {
    ...HitsTab.initialState(), subscribed: true, selectedIdx: 0,
    buffer: Array.from({ length: 40 }, (_, i) => rec(i)),
  };
  const halted = {
    ...base,
    halt: { since: NOW - 240000, cooldownUntil: NOW + 1560000, request: { claim: 'overage', model: MODEL, account: ACCOUNT } },
  };
  for (const rows of [45, 35, 25, 19, 14, 10]) {
    for (const [label, st] of [['plain', base], ['halted', halted]]) {
      const n = HitsTab.render(st, { cols: 100, rows }).split('\n').length;
      check(`${label} 100x${rows}: body within budget`, n <= rows, `${n} > ${rows}`);
    }
  }
  check('halted still shows the banner', /HALTED/.test(strip(HitsTab.render(halted, { cols: 100, rows: 19 }))));
}

// ─────────────────────────────────────────────────────────────
header('Backends — bounded in both directions');
{
  const b = (i) => ({ name: `backend-${i}`, provider: 'openai', baseUrl: `https://api.example-${i}.com/v1/very/long/base/url/path` });
  const s = { ...BackendsTab.initialState(), loading: false, backends: Array.from({ length: 12 }, (_, i) => b(i)) };
  for (const cols of [40, 60, 80, 120]) {
    for (const rows of [30, 19, 12]) {
      const lines = BackendsTab.render(s, { cols, rows }).split('\n');
      check(`${cols}x${rows}: within budget`, lines.length <= rows, `${lines.length} > ${rows}`);
      const widest = Math.max(...lines.map(visibleWidth));
      check(`${cols}x${rows}: no row exceeds cols`, widest <= cols, `widest=${widest}`);
    }
  }
  check('truncated list says how many are hidden',
    /more backends/.test(strip(BackendsTab.render(s, { cols: 100, rows: 12 }))));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

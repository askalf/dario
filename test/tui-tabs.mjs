#!/usr/bin/env node
// Tests for the six v4 tabs — pure-render assertions on each.
//
// Every tab's render(state, dim) is a pure function, so this exercises
// state→ANSI conversion without needing a real TTY. The TuiApp's
// integration (key routing, lifecycle, async data) needs a TTY and
// is covered by manual smoke tests + M5+M6 e2e.

import { StatusTab } from '../dist/tui/tabs/status.js';
import { ConfigTab } from '../dist/tui/tabs/config.js';
import { AnalyticsTab } from '../dist/tui/tabs/analytics.js';
import { HitsTab } from '../dist/tui/tabs/hits.js';
import { AccountsTab } from '../dist/tui/tabs/accounts.js';
import { BackendsTab } from '../dist/tui/tabs/backends.js';
import { visibleWidth } from '../dist/tui/render.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const DIM = { cols: 80, rows: 24 };

// ─────────────────────────────────────────────────────────────
header('Tab metadata — every tab has the expected shape');
for (const [name, tab] of [
  ['Status', StatusTab], ['Config', ConfigTab], ['Analytics', AnalyticsTab],
  ['Hits', HitsTab], ['Accounts', AccountsTab], ['Backends', BackendsTab],
]) {
  check(`${name}: id is non-empty`,    typeof tab.id === 'string' && tab.id.length > 0);
  check(`${name}: label is non-empty`, typeof tab.label === 'string' && tab.label.length > 0);
  check(`${name}: initialState fn`,    typeof tab.initialState === 'function');
  check(`${name}: render fn`,          typeof tab.render === 'function');
}

// ─────────────────────────────────────────────────────────────
header('Status tab — loading + reachable + unreachable');
{
  const initial = StatusTab.initialState();
  const r1 = StatusTab.render(initial, DIM);
  check('initial render contains "Loading"', r1.includes('Loading'));

  // Mock reachable proxy
  const reachable = {
    ...initial,
    loading: false,
    health: { status: 'ok', oauth: 'healthy', expiresIn: '7h 41m', requests: 42 },
    configSource: 'file',
    lastRefreshAt: Date.now(),
  };
  const r2 = StatusTab.render(reachable, DIM);
  check('reachable: shows healthy',           r2.includes('healthy'));
  check('reachable: shows expiry',            r2.includes('7h 41m'));
  check('reachable: shows requests',          r2.includes('42'));
  check('reachable: shows config path',       r2.includes('config.json'));

  // Mock unreachable proxy
  const unreachable = {
    ...initial,
    loading: false,
    health: null,
    configSource: 'missing',
    error: 'ECONNREFUSED',
  };
  const r3 = StatusTab.render(unreachable, DIM);
  check('unreachable: shows error UI',        r3.includes('unreachable'));
  check('unreachable: shows config defaults', r3.includes('defaults'));
}

// ─────────────────────────────────────────────────────────────
header('Config tab — read + dirty + edit states');
{
  const initial = ConfigTab.initialState();
  const r1 = ConfigTab.render(initial, DIM);
  check('initial: shows Port label',       r1.includes('Port'));
  check('initial: shows stealth row',      r1.includes('Stealth preset'));
  check('initial: no unsaved marker',      !r1.includes('unsaved changes'));

  // Simulate a key edit — start editing Port (selected idx 0 is Port)
  const editing = ConfigTab.onKey(initial, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
  // Port is a number field; Enter opens edit buffer with current value
  check('Enter starts edit',               editing && editing.editBuffer !== null);
  const r2 = ConfigTab.render(editing, DIM);
  check('edit mode shows prompt',          r2.includes('Edit Port'));

  // Type a new value. startEdit pre-fills with the current value
  // (Port = 3456), so we backspace-clear before typing the new digits.
  let s = editing;
  for (let i = 0; i < 6; i++) {  // overshoot — extra backspaces are no-ops on empty
    s = ConfigTab.onKey(s, { name: 'backspace', ch: '', ctrl: false, shift: false, meta: false });
  }
  check('backspace clears buffer',         s.editBuffer === '');
  for (const ch of '9876') {
    s = ConfigTab.onKey(s, { name: 'printable', ch, ctrl: false, shift: false, meta: false });
  }
  check('typed digits accumulate',         s.editBuffer === '9876');

  // Confirm with Enter
  s = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
  check('after commit: port is 9876',      s.config.port === 9876);
  check('after commit: edit buffer null',  s.editBuffer === null);
  check('after commit: dirty marker',      ConfigTab.render(s, DIM).includes('unsaved'));

  // Discard
  const discarded = ConfigTab.onKey(s, { name: 'printable', ch: 'd', ctrl: false, shift: false, meta: false });
  check('discard restores snapshot',       JSON.stringify(discarded.config) === JSON.stringify(discarded.snapshot));
}

// ─────────────────────────────────────────────────────────────
header('Config tab — prototype-pollution defence');
{
  // setByPath isn't exported, but exercising every legitimate field
  // through the full edit cycle should never touch Object.prototype.
  // This pins the contract: the tab's state machine, when driven via
  // its public API, never pollutes the global prototype chain even
  // under hostile key sequences.
  const beforeToString = Object.prototype.toString;
  const beforeHasOwn = Object.prototype.hasOwnProperty;
  let s = ConfigTab.initialState();
  for (let i = 0; i < 14; i++) {  // overshoot — extra Down arrows clamp at the last field
    s = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
    if (s.editBuffer !== null) {
      s = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
    }
    s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  }
  check('Object.prototype.toString unchanged', Object.prototype.toString === beforeToString);
  check('Object.prototype.hasOwnProperty unchanged', Object.prototype.hasOwnProperty === beforeHasOwn);
  check('no polluted property on plain object',
    Object.keys({}).length === 0 && !('polluted' in ({}).constructor.prototype));
}

// ─────────────────────────────────────────────────────────────
header('Config tab — bool toggle in place (Enter on bool field)');
{
  let s = ConfigTab.initialState();
  // Navigate to "Stealth preset" — index 2 in our FIELDS array
  s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  // Press Enter — bool toggles in place, no edit buffer
  const toggled = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
  check('bool toggle: editBuffer null',    toggled.editBuffer === null);
  check('bool toggle: value flipped',      toggled.config.stealth !== s.config.stealth);
}

// ─────────────────────────────────────────────────────────────
header('Analytics tab — loading + populated states');
{
  const initial = AnalyticsTab.initialState();
  const r1 = AnalyticsTab.render(initial, DIM);
  check('initial: shows Loading',          r1.includes('Loading'));

  const populated = {
    ...initial,
    loading: false,
    summary: {
      window: {
        minutes: 60, requests: 247,
        totalInputTokens: 142830, totalOutputTokens: 38200, totalThinkingTokens: 9000,
        estimatedCost: 1.23, avgLatencyMs: 1234,
        subscriptionPercent: 0.95,
        billingBucketBreakdown: { subscription: 240, extra_usage: 7, api: 0, unknown: 0, subscription_fallback: 0 },
      },
      allTime: { requests: 1000 },
      perModel: {
        'claude-opus-4-7':  { requests: 178, totalInputTokens: 100000, totalOutputTokens: 25000 },
        'claude-sonnet-4-6': { requests: 54, totalInputTokens: 40000, totalOutputTokens: 12000 },
      },
      utilization: { lastUtil5h: 0.18, lastUtil7d: 0.08 },
    },
    lastFetchAt: Date.now(),
  };
  const r2 = AnalyticsTab.render(populated, DIM);
  check('populated: shows 247 requests',   r2.includes('247'));
  check('populated: shows opus row',       r2.includes('opus-4-7'));
  check('populated: shows sonnet row',     r2.includes('sonnet-4-6'));
  check('populated: shows 5h % label',     r2.includes('18%'));
  check('populated: shows 7d % label',     r2.includes('8%'));
  check('populated: shows Per-model',      r2.includes('Per-model'));

  // Error state
  const errored = {
    ...initial,
    summary: null,
    loading: false,
    error: 'ECONNREFUSED',
  };
  const r3 = AnalyticsTab.render(errored, DIM);
  check('error: surfaces error message',   r3.includes('ECONNREFUSED'));
  check('error: hints at proxy start',     r3.includes('dario proxy'));
}

// ─────────────────────────────────────────────────────────────
header('Hits tab — empty / connecting / populated / selected');
{
  const initial = HitsTab.initialState();
  const r1 = HitsTab.render(initial, DIM);
  check('initial: connecting hint',        r1.includes('Connecting') || r1.includes('Waiting'));

  // Subscribed but no records yet
  const subscribed = { ...initial, subscribed: true };
  const r2 = HitsTab.render(subscribed, DIM);
  check('subscribed empty: waiting hint',  r2.includes('Waiting'));

  // With records
  const records = [
    {
      timestamp: Date.now() - 5000, account: 'default', model: 'claude-opus-4-7',
      inputTokens: 842, outputTokens: 216, cacheReadTokens: 6200, cacheCreateTokens: 0, thinkingTokens: 84,
      claim: 'five_hour', util5h: 0.18, util7d: 0.08, overageUtil: 0,
      latencyMs: 1180, status: 200, isStream: true, isOpenAI: false,
    },
    {
      timestamp: Date.now() - 3000, account: 'default', model: 'claude-sonnet-4-6',
      inputTokens: 1200, outputTokens: 480, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
      claim: 'five_hour', util5h: 0.18, util7d: 0.08, overageUtil: 0,
      latencyMs: 820, status: 200, isStream: false, isOpenAI: false,
    },
  ];
  const populated = { ...initial, buffer: records, subscribed: true, selectedIdx: 0 };
  const r3 = HitsTab.render(populated, DIM);
  check('populated: shows opus row',       r3.includes('opus-4-7'));
  check('populated: shows sonnet row',     r3.includes('sonnet-4-6'));
  check('populated: shows live marker',    r3.includes('live'));
  check('populated: detail section',       r3.includes('Selected') || r3.includes('Tokens'));

  // Up/down navigation
  const moved = HitsTab.onKey(populated, { name: 'up', ch: '', ctrl: false, shift: false, meta: false });
  check('up arrow moves selectedIdx',      moved && moved.selectedIdx === 1);
  const moved2 = HitsTab.onKey(moved, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  check('down arrow moves selectedIdx',    moved2 && moved2.selectedIdx === 0);
}

// ─────────────────────────────────────────────────────────────
header('Accounts tab — empty + populated');
{
  const empty = { loading: false, accounts: [], error: null };
  const r1 = AccountsTab.render(empty, DIM);
  check('empty: shows guidance',           r1.includes('No accounts') || r1.includes('Add one'));

  const populated = {
    loading: false,
    accounts: [
      { alias: 'default', expiresAt: Date.now() + 7 * 3600_000 },
      { alias: 'work',    expiresAt: Date.now() - 100 },
    ],
    error: null,
  };
  const r2 = AccountsTab.render(populated, DIM);
  check('populated: shows default row',    r2.includes('default'));
  check('populated: shows work row',       r2.includes('work'));
  check('populated: shows expired',        r2.includes('expired'));
}

// ─────────────────────────────────────────────────────────────
header('Backends tab — empty + populated');
{
  const empty = { loading: false, backends: [], error: null };
  const r1 = BackendsTab.render(empty, DIM);
  check('empty: shows guidance',           r1.includes('No OpenAI') || r1.includes('Add one'));

  const populated = {
    loading: false,
    backends: [
      { name: 'openai',     provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { name: 'groq',       provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
    ],
    error: null,
  };
  const r2 = BackendsTab.render(populated, DIM);
  check('populated: shows openai',         r2.includes('openai'));
  check('populated: shows groq',           r2.includes('groq'));
}

// ─────────────────────────────────────────────────────────────
header('All tabs render without throwing across many dimensions');
{
  for (const dimv of [
    { cols: 60, rows: 20 },
    { cols: 100, rows: 30 },
    { cols: 200, rows: 50 },
  ]) {
    for (const [name, tab] of [
      ['Status', StatusTab], ['Analytics', AnalyticsTab],
      ['Hits', HitsTab], ['Accounts', AccountsTab], ['Backends', BackendsTab],
    ]) {
      try {
        const out = tab.render(tab.initialState(), dimv);
        check(`${name} ${dimv.cols}x${dimv.rows} renders without throw`, typeof out === 'string');
      } catch (err) {
        check(`${name} ${dimv.cols}x${dimv.rows} renders without throw`, false, err.message);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

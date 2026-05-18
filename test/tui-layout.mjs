#!/usr/bin/env node
// Tests for src/tui/layout.ts — header/footer/tabstrip/kv-row/wrap.
//
// All pure string-returning functions; assertions are visible-width
// + structural shape checks rather than exact byte-equality, because
// the layout uses ANSI color codes that we don't want to hard-pin
// in case the palette changes.

import {
  renderHeader, renderFooter, renderTabStrip, renderScrollIndicator,
  wrap, renderKvRow,
} from '../dist/tui/layout.js';
import { visibleWidth } from '../dist/tui/render.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('renderHeader — version + status');
{
  const h = renderHeader(80, { version: '4.0.0' });
  check('width matches',                visibleWidth(h) === 80);
  check('contains version',             h.includes('4.0.0'));
  check('contains dario',               h.includes('dario'));
  check('starts with top-left corner',  h.startsWith('┌'));
  check('ends with top-right corner',   h.endsWith('┐'));

  const withStatus = renderHeader(80, { version: '4.0.0', status: 'http://localhost:3456' });
  check('with status: width matches',   visibleWidth(withStatus) === 80);
  check('with status: contains URL',    withStatus.includes('http://localhost:3456'));
}

// ─────────────────────────────────────────────────────────────
header('renderFooter — key hints');
{
  const hints = [{ key: 'Tab', label: 'switch panel' }, { key: 'q', label: 'quit' }];
  const f = renderFooter(80, hints);
  check('contains Tab hint',            f.includes('Tab'));
  check('contains switch panel',        f.includes('switch panel'));
  check('contains q hint',              f.includes('q'));
  check('contains quit',                f.includes('quit'));
  // Brackets around keys
  check('bracket-wrapped keys',         f.includes('[Tab]') && f.includes('[q]'));

  // Narrow width truncates
  const narrow = renderFooter(20, hints);
  check('narrow footer ≤ 20 visible',   visibleWidth(narrow) <= 20);
}

// ─────────────────────────────────────────────────────────────
header('renderTabStrip — active tab inverse');
{
  const tabs = ['Status', 'Config', 'Analytics'];
  const t = renderTabStrip(80, tabs, 1);  // Config active
  check('width matches',                visibleWidth(t) === 80);
  check('contains all tabs',            tabs.every(tab => t.includes(tab)));
  // Active tab is wrapped in inverse codes
  check('Config is inverse-wrapped',    t.includes('\x1b[7m') && t.includes('Config'));
  // Other tabs aren't (or at least aren't inverse-active)
  const status0 = renderTabStrip(80, tabs, 0);
  check('different active changes output', status0 !== t);
}

// ─────────────────────────────────────────────────────────────
header('renderScrollIndicator');
{
  check('no indicator when total ≤ visible', renderScrollIndicator(10, 5, 0) === '');
  check('no indicator when total = visible', renderScrollIndicator(10, 10, 0) === '');
  const ind = renderScrollIndicator(10, 100, 23);
  check('shows position when overflow', ind.includes('24'));
  check('shows total when overflow',    ind.includes('100'));
}

// ─────────────────────────────────────────────────────────────
header('wrap — word-wrap to width');
{
  check('short text → 1 line',          wrap('hello', 20).length === 1);
  check('exact fit → 1 line',           wrap('hello', 5).length === 1);

  const wrapped = wrap('hello world this is a longer text', 10);
  check('wraps when overflow',          wrapped.length > 1);
  // Every line ≤ 10 visible
  check('every line ≤ width',           wrapped.every(l => visibleWidth(l) <= 10));

  // Newlines preserved as paragraph breaks
  const para = wrap('line one\nline two', 20);
  check('preserves newlines as breaks', para.length === 2);
  check('preserves order',              para[0] === 'line one' && para[1] === 'line two');

  // Word longer than width → hard-break
  const big = wrap('a-very-long-word-with-no-spaces', 5);
  check('hard-breaks long word',        big.length >= 5);
  check('hard-break: every chunk ≤ 5',  big.every(l => visibleWidth(l) <= 5));

  // Width 0 → empty
  check('width 0 → empty',              wrap('hello', 0).length === 0);
}

// ─────────────────────────────────────────────────────────────
header('renderKvRow — key/value layout');
{
  const row = renderKvRow('Port', '3456', 40);
  check('starts with Port:',            row.startsWith('Port:'));
  check('contains value',               row.includes('3456'));
  check('total width = 40',             visibleWidth(row) === 40);

  // Long value truncates
  const longRow = renderKvRow('Path', '/very/long/path/that/exceeds/the/available/width/easily', 30);
  check('long value truncates',         visibleWidth(longRow) <= 30);

  // Short value padded
  const shortRow = renderKvRow('K', 'v', 20);
  check('short row pads to width',      visibleWidth(shortRow) === 20);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

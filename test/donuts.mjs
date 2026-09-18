#!/usr/bin/env node
/**
 * Spend donuts — slice math and the two renderers, hermetic.
 *
 *   - donutSlices: top-N + "other", shares sum to 1, zero/negative dropped
 *   - donutPaths: one arc per slice, a lone slice is a full circle, the
 *     large-arc flag flips past 50%
 *   - renderSpendDonuts: three rings, escaped labels, the frame of the card
 *   - renderAnalyticsView: headline/ledger-disabled branch, escaped model
 *     names, queue numbers when present
 *   - the UI shell carries no data and no inline token
 */
import { donutSlices, donutPaths, renderSpendDonuts, renderAnalyticsView, ANALYTICS_UI_SHELL, escapeHtml } from '../dist/donuts.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const near = (a, b) => Math.abs(a - b) < 1e-9;

header('donutSlices');
{
  const s = donutSlices({ a: 50, b: 30, c: 10, d: 5, e: 3, f: 1, g: 1 }, 3);
  check('top 3 kept in order', s.slice(0, 3).map(x => x.label).join(',') === 'a,b,c', s.map(x => x.label));
  check('rest folded into other', s[3]?.label === 'other' && s[3].value === 10, JSON.stringify(s[3]));
  check('shares sum to 1', near(s.reduce((n, x) => n + x.share, 0), 1));
  check('zero and negative dropped', donutSlices({ a: 0, b: -2, c: 4 }).length === 1);
  check('empty in, empty out', donutSlices({}).length === 0 && donutSlices({ a: 0 }).length === 0);
  check('no other bucket when nothing is left', !donutSlices({ a: 1, b: 1 }, 5).some(x => x.label === 'other'));
}

header('donutPaths');
{
  check('empty ring is a grey circle', /circle[^>]*stroke="#1f2937"/.test(donutPaths([], 0, 0, 10, 4)));
  check('single slice is a full circle, not an empty arc', /<circle/.test(donutPaths([{ label: 'a', value: 1, share: 1 }], 0, 0, 10, 4)) && !/<path/.test(donutPaths([{ label: 'a', value: 1, share: 1 }], 0, 0, 10, 4)));
  const two = donutPaths([{ label: 'a', value: 7, share: 0.7 }, { label: 'b', value: 3, share: 0.3 }], 100, 100, 50, 10);
  check('two slices -> two arcs', (two.match(/<path/g) || []).length === 2);
  check('the 70% arc sets the large-arc flag, the 30% does not', /A 50 50 0 1 1/.test(two) && /A 50 50 0 0 1/.test(two), two);
  check('other slice uses the grey', /stroke="#6b7280"/.test(donutPaths([{ label: 'a', value: 1, share: 0.5 }, { label: 'other', value: 1, share: 0.5 }], 0, 0, 10, 4)));
}

const lifetime = {
  path: '/x', since: '2026-09-12T00:00:00.000Z', days: 6, requests: 100, apiEquivalentCost: 90, meteredCost: 10,
  tokens: { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
  perProvider: { anthropic: { requests: 90, apiEquivalentCost: 80 }, openai: { requests: 10, apiEquivalentCost: 10 } },
  perModel: {
    'claude-opus-5': { provider: 'anthropic', requests: 60, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreateTokens: 1, apiEquivalentCost: 60, meteredCost: 0 },
    '<script>evil</script>': { provider: 'anthropic', requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreateTokens: 1, apiEquivalentCost: 1, meteredCost: 0 },
  },
  perConsumer: { alice: { requests: 5, apiEquivalentCost: 12, meteredCost: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, recent: { today: 1, last7d: 2, last30d: 3 }, lastDay: '2026-09-17', models: ['claude-opus-5'] } },
  recent: { today: 1, last7d: 2, last30d: 3 },
};

header('renderSpendDonuts');
{
  const svg = renderSpendDonuts(lifetime);
  check('is one 640x320 svg', svg.startsWith('<svg') && svg.includes('viewBox="0 0 640 320"'));
  check('three ring titles', ['BY MODEL', 'BY KEY', 'BY BILLING'].every(t => svg.includes(t)));
  check('model name is escaped', svg.includes('&lt;script&gt;') && !svg.includes('<script>'));
  check('total in the header', svg.includes('$100'));
  check('covered vs metered both present', svg.includes('>subscription<') && svg.includes('>metered<'), svg.match(/>[a-z ()/]+<\/text>/g)?.slice(-6));
  const noKeys = renderSpendDonuts({ ...lifetime, perConsumer: {} });
  check('no named keys -> placeholder text', noKeys.includes('no named keys'));
}

header('renderAnalyticsView');
{
  const summary = {
    window: { minutes: 60, requests: 4, avgLatencyMs: 812.4, errorRate: 0.05, cachedPromptPercent: 22.5, totalInputTokens: 0, totalOutputTokens: 0, totalThinkingTokens: 0, totalCacheReadTokens: 0, totalCacheCreateTokens: 0, estimatedCost: 0, continuations: {}, claimBreakdown: {} },
    allTime: { requests: 40 }, perAccount: { login: { requests: 30, currentUtil5h: 0.42, currentUtil7d: 0.13, lastClaim: 'five_hour' } },
    perConsumer: {}, perModel: {}, utilization: { lastUtil5h: 0, lastUtil7d: 0 }, predictions: { estimatedExhaustionMinutes: null, tokenBurnRate: 0, costBurnRate: 0 },
    queue: { active: 2, queued: 1 },
  };
  const html = renderAnalyticsView(summary, lifetime, '6.9.0-test');
  check('headline carries the api-equivalent number', html.includes('$90'));
  check('window stats rendered', html.includes('812 ms') && html.includes('5.0%'));
  check('queue numbers rendered', html.includes('2 / 1'));
  check('rings embedded', html.includes('<svg'));
  check('model table escapes names', html.includes('&lt;script&gt;evil') && !html.includes('<script>evil'));
  check('seat table', html.includes('login') && html.includes('42%'));
  check('version in the footer', html.includes('dario 6.9.0-test'));
  const off = renderAnalyticsView(summary, null, 'x');
  check('ledger disabled branch', off.includes('ledger disabled') && !off.includes('<svg'));
}

header('shell');
{
  check('shell is html with the fetch to /analytics/view', ANALYTICS_UI_SHELL.startsWith('<!doctype html>') && ANALYTICS_UI_SHELL.includes("fetch('/analytics/view'"));
  check('shell carries no numbers or tokens', !/\$\d/.test(ANALYTICS_UI_SHELL) && !ANALYTICS_UI_SHELL.includes('dk_'));
  check('escapeHtml covers the five', escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

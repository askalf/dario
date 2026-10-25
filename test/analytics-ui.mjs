#!/usr/bin/env node
// The dashboard's arithmetic, run outside a browser. The served page keeps
// its ledger maths and its boot decision in a <script id="cockpit-maths">
// block with no DOM in it, so this file evaluates that block as text and
// checks
//   - calendar ranges: "today" is today even when the last request was
//     yesterday; "7d" and "30d" are the last seven and thirty dates, idle
//     days included; "all" runs from the oldest day in the table
//   - money comes from the proxy's priced rows only, never from token counts
//   - the boot decision: a file:// open is the sample whatever the head says,
//     a served page with the marker is live, a served page without it probes
import { runInNewContext } from 'node:vm';
import { analyticsUiPage } from '../dist/donuts.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const page = analyticsUiPage();
const block = /<script id="cockpit-maths">([\s\S]*?)<\/script>/.exec(page);
if (!block) { console.log('  FAIL the served page has no cockpit-maths block'); process.exit(1); }
const M = runInNewContext(`${block[1]}; DarioMaths`, {});

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-25T18:30:00Z');
const day = (back) => new Date(NOW - back * DAY).toISOString().slice(0, 10);
const cell = (requests, tokens) => ({ requests, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });

header('the block stands alone');
{
  check('it exports the four functions and touches no DOM', typeof M.calendarDays === 'function' && typeof M.ledgerSlice === 'function' && typeof M.modeFor === 'function' && typeof M.dayKey === 'function' && !/document\.|window\./.test(block[1]));
}

header('calendar ranges');
{
  const idle = { days: { [day(1)]: { 'claude-sonnet-5': { covered: cell(3, 3000) } } }, priced: { days: { [day(1)]: { 'claude-sonnet-5': { covered: 0.006 } } } } };
  check('"today" is today when the last request was yesterday', JSON.stringify(M.calendarDays(idle, 'today', NOW)) === JSON.stringify([day(0)]));
  const t = M.ledgerSlice(idle, 'today', NOW);
  check('and an idle today totals zero rather than yesterday', t.total.covered === 0 && t.total.requests === 0 && t.daily.length === 1 && t.daily[0].day === day(0), JSON.stringify(t));
  const sparse = { days: {}, priced: { days: {} } };
  for (const back of [0, 2, 9, 40, 200]) { sparse.days[day(back)] = { m: { covered: cell(1, 1000) } }; sparse.priced.days[day(back)] = { m: { covered: 1 } }; }
  const seven = M.calendarDays(sparse, '7d', NOW);
  check('"7d" is the last seven dates, oldest first, ending today', seven.length === 7 && seven[0] === day(6) && seven[6] === day(0) && seven.every((d, i) => i === 0 || Date.parse(d) - Date.parse(seven[i - 1]) === DAY), seven.join(','));
  const s7 = M.ledgerSlice(sparse, '7d', NOW);
  check('and it counts only the rows inside those dates (2 of 5), with zeros on the idle days', s7.total.covered === 2 && s7.total.requests === 2 && s7.daily.length === 7 && s7.daily.filter((d) => d.covered === 0).length === 5, JSON.stringify(s7.daily));
  const s30 = M.ledgerSlice(sparse, '30d', NOW);
  check('"30d" is thirty dates: the row 9 days back is in, the one 40 days back is out', s30.days.length === 30 && s30.days[0] === day(29) && s30.total.covered === 3, JSON.stringify({ days: s30.days.length, covered: s30.total.covered }));
  const all = M.ledgerSlice(sparse, 'all', NOW);
  check('"all" runs from the oldest day in the table to today, every date in between', all.days.length === 201 && all.days[0] === day(200) && all.total.covered === 5, all.days.length);
  check('an empty table is one day, today; no table at all still gives the dates', JSON.stringify(M.calendarDays({ days: {} }, 'all', NOW)) === JSON.stringify([day(0)]) && M.calendarDays(null, '7d', NOW).length === 7);
  const ancient = { days: { '2019-01-01': { m: { covered: cell(1, 1) } } } };
  check('"all" is capped at the two years the proxy keeps', M.calendarDays(ancient, 'all', NOW).length === 731);
}

header('money comes from the priced rows, never from tokens');
{
  const d0 = day(0);
  const L = {
    days: { [d0]: { 'claude-opus-5-5': { covered: cell(2, 1_000_000), metered: cell(1, 1_000_000) }, 'gpt-5.6-terra': { covered: cell(4, 500_000) } } },
    consumers: { [d0]: { alice: { 'claude-opus-5-5': { covered: cell(2, 1_000_000) } }, bob: { 'gpt-5.6-terra': { covered: cell(4, 500_000) } } } },
    priced: { days: { [d0]: { 'claude-opus-5-5': { covered: 4.5, metered: 4 }, 'gpt-5.6-terra': { covered: 1.25 } } }, consumers: { [d0]: { alice: { 'claude-opus-5-5': { covered: 4.5 } }, bob: { 'gpt-5.6-terra': { covered: 1.25 } } } } },
  };
  const s = M.ledgerSlice(L, 'today', NOW);
  check('totals are the priced rows (covered 5.75, metered 4); requests and tokens come from the cells', near(s.total.covered, 5.75) && s.total.metered === 4 && s.total.requests === 7 && s.total.tokens === 2_500_000, JSON.stringify(s.total));
  check('per model and per consumer read the priced rows too', near(s.perModel['claude-opus-5-5'].covered, 4.5) && s.perModel['claude-opus-5-5'].metered === 4 && s.perModel['gpt-5.6-terra'].covered === 1.25 && s.perConsumer.alice.covered === 4.5 && s.perConsumer.bob.covered === 1.25 && s.perConsumer.bob.requests === 4, JSON.stringify({ m: s.perModel, c: s.perConsumer }));
  const u = M.ledgerSlice({ days: L.days, consumers: L.consumers }, 'today', NOW);
  check('a table without priced rows (an older proxy) counts requests and tokens and shows no money, rather than inventing a rate', u.total.covered === 0 && u.total.metered === 0 && u.total.requests === 7 && u.perConsumer.alice.covered === 0, JSON.stringify(u.total));
  check('the page carries no rate for live data: the only price table is the sample\'s', /SAMPLE_RATES/.test(page) && !/\bPRICING\b/.test(page) && !/cellCost|priceOf/.test(page));
}

header('the boot decision');
{
  check('opened from disk it is the sample, marker or not', M.modeFor('file:', 'served') === 'sample' && M.modeFor('file:', undefined) === 'sample' && M.modeFor('about:', 'served') === 'sample');
  check('served with the marker it is live at once', M.modeFor('http:', 'served') === 'live' && M.modeFor('https:', 'served') === 'live');
  check('served without the marker it probes', M.modeFor('http:', undefined) === 'probe' && M.modeFor('https:', '') === 'probe');
  check('the served page carries the marker in its head and decides by protocol first', /<head>[\s\S]*window\.DARIO_COCKPIT="served"[\s\S]*<\/head>/.test(page) && /modeFor\(location\.protocol,\s*window\.DARIO_COCKPIT\)/.test(page));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

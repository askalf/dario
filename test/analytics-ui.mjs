#!/usr/bin/env node
// The dashboard's arithmetic, run outside a browser. The served page keeps
// its ledger maths and its boot decision in a <script id="cockpit-maths">
// block with no DOM in it, so this file evaluates that block as text and
// checks
//   - calendar ranges: "today" is today even when the last request was
//     yesterday; "7d" and "30d" are the last seven and thirty dates, idle
//     days included; "all" runs from the oldest day in the table, uncapped
//   - money comes from the proxy's priced rows only, never from token counts
//   - record times: the stream sends epoch milliseconds, the sample ISO
//     strings; the hour window, the sparkline and the feed read both
//   - key budgets: a dollar limit, a token limit, both (the tighter one is
//     the meter) or neither (and only then "no budget")
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
  check('it exports the maths and touches no DOM', ['calendarDays', 'ledgerSlice', 'modeFor', 'dayKey', 'tsOf', 'perFiveMinutes', 'budgetView'].every((f) => typeof M[f] === 'function') && !/document\.|window\./.test(block[1]));
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
  // The proxy keeps 730 dates with traffic, not 730 calendar days: a table with a row three years back and one today is valid and both count.
  const wide = { days: { [day(1000)]: { m: { covered: cell(1, 1000) } }, [day(0)]: { m: { covered: cell(1, 1000) } } }, priced: { days: { [day(1000)]: { m: { covered: 7 } }, [day(0)]: { m: { covered: 1 } } } } };
  const w = M.ledgerSlice(wide, 'all', NOW);
  check('"all" keeps every retained date however far back: 1001 dates, both rows counted', w.days.length === 1001 && w.days[0] === day(1000) && w.total.covered === 8 && w.total.requests === 2 && w.daily[0].covered === 7, JSON.stringify({ n: w.days.length, first: w.days[0], covered: w.total.covered }));
  check('a junk date key does not break the span', M.calendarDays({ days: { 'not-a-date': {} } }, 'all', NOW).length === 1);
}

header('the stream sends timestamps as numbers');
{
  const T = (ms) => ({ timestamp: ms });
  check('tsOf reads a number, an ISO string and a numeric string the same way; anything else is NaN', M.tsOf(T(NOW)) === NOW && M.tsOf(T(new Date(NOW).toISOString())) === NOW && M.tsOf(T(String(NOW))) === NOW && Number.isNaN(M.tsOf(T('soon'))) && Number.isNaN(M.tsOf({})) && Number.isNaN(M.tsOf(null)));
  const records = [T(NOW - 10_000), T(new Date(NOW - 120_000).toISOString()), T(NOW - 20 * 60_000), T(NOW - 59 * 60_000), T(NOW - 61 * 60_000), T(NOW + 5_000), T('soon')];
  const bins = M.perFiveMinutes(records, NOW);
  check('twelve five-minute bins over the last hour, oldest first, from numeric and ISO timestamps alike', bins.length === 12 && bins[11] === 2 && bins[7] === 1 && bins[0] === 1 && bins.reduce((a, b) => a + b, 0) === 4, bins.join(','));
  check('a record older than an hour, one from the future and one without a readable time are left out', M.perFiveMinutes([T(NOW - 3_600_000), T(NOW + 1), T('x')], NOW).every((b) => b === 0));
  check('the feed and the window summary read the time through tsOf, not Date.parse', /hms\(DarioMaths\.tsOf\(x\)\)/.test(page) && !/Date\.parse\(x\.timestamp\)/.test(page));
}

header('key budgets: dollars, tokens, both or neither');
{
  const usdOnly = M.budgetView({ budget: { usd_per_day: 60 } }, { usedUsd: 15, usedTokens: 500_000 });
  check('a dollar budget: the limit, the fraction, and the meter follows it', usdOnly.usdLimit === 60 && usdOnly.tokenLimit === null && near(usdOnly.utilisation, 0.25) && usdOnly.binding === 'usd' && usdOnly.usedTokens === 500_000, JSON.stringify(usdOnly));
  const tokOnly = M.budgetView(null, { tokensPerDay: 2_000_000, usedTokens: 1_500_000, usedUsd: 3 });
  check('a token-only budget from /analytics alone is a budget: the meter follows the tokens, not "no budget"', tokOnly.usdLimit === null && tokOnly.tokenLimit === 2_000_000 && near(tokOnly.utilisation, 0.75) && tokOnly.binding === 'tokens' && near(tokOnly.tokenFraction, 0.75) && tokOnly.usdFraction === null, JSON.stringify(tokOnly));
  const both = M.budgetView({ budget: { usd_per_day: 100, tokens_per_day: 1_000_000 } }, { usedUsd: 10, usedTokens: 900_000 });
  check('both limits: the meter is the tighter one and says which binds', near(both.utilisation, 0.9) && both.binding === 'tokens' && near(both.usdFraction, 0.1) && near(both.tokenFraction, 0.9), JSON.stringify(both));
  const bothUsd = M.budgetView({ budget: { usd_per_day: 10, tokens_per_day: 1_000_000 } }, { usedUsd: 9, usedTokens: 100_000 });
  check('and the other way round', near(bothUsd.utilisation, 0.9) && bothUsd.binding === 'usd', JSON.stringify(bothUsd));
  const none = M.budgetView({ budget: null }, { usedUsd: 2.1, usedTokens: 2_100_000 });
  check('neither limit (or a zero limit) is no budget: no meter, the use still shown', none.usdLimit === null && none.tokenLimit === null && none.utilisation === null && none.binding === null && none.usedUsd === 2.1 && M.budgetView({ budget: { usd_per_day: 0 } }, {}).utilisation === null, JSON.stringify(none));
  check('the key limit wins over the window figure when both are present', M.budgetView({ budget: { usd_per_day: 50 } }, { usdPerDay: 40, usedUsd: 25 }).usdLimit === 50 && M.budgetView({}, { usdPerDay: 40, usedUsd: 25 }).usdLimit === 40);
  check('the card reads the budget through budgetView', /DarioMaths\.budgetView\(k,b\)/.test(page));
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

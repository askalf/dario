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
//   - /health: the verdict is read from the body on 503 as on 200, and a
//     proxy that stops answering shows as unreachable, never as a stale
//     "healthy"
//   - the stream: a failed response or a dropped connection retries with a
//     backoff, a refused credential asks for the token, stop() ends it; the
//     loop is run here against a fake transport, 502 first and then a good
//     stream, with no reload in between
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
  check('it exports the maths and touches no DOM', ['calendarDays', 'ledgerSlice', 'modeFor', 'dayKey', 'tsOf', 'perFiveMinutes', 'budgetView', 'healthFrom', 'headerStatus', 'parseSse', 'streamNext', 'sseLoop'].every((f) => typeof M[f] === 'function') && !/document\.|window\.|\bfetch\(|setTimeout\(|new TextDecoder|new AbortController/.test(block[1]));
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

header('/health is read from the body, whatever the status code');
{
  const healthy = M.healthFrom({ status: 200, body: { status: 'ok', oauth: 'healthy', version: '6.16.0' } }, null, NOW);
  check('200 with status ok is healthy', healthy.body.status === 'ok' && !healthy.unreachable && healthy.seenAt === NOW && M.headerStatus(healthy, false).cls === 'good' && M.headerStatus(healthy, false).text === 'healthy');
  const degraded = M.healthFrom({ status: 503, body: { status: 'degraded', oauth: 'broken' } }, healthy, NOW + 30_000);
  check('healthy, then a 503: the body says degraded and the page shows it, instead of keeping the old healthy read', degraded.body.status === 'degraded' && !degraded.unreachable && degraded.seenAt === NOW + 30_000 && M.headerStatus(degraded, false).cls === 'warn' && M.headerStatus(degraded, false).text === 'degraded · oauth broken', JSON.stringify(M.headerStatus(degraded, false)));
  const initial = M.healthFrom({ status: 503, body: { status: 'degraded' } }, null, NOW);
  check('opened during the outage: degraded at once, not "connecting"', initial.body.status === 'degraded' && M.headerStatus(initial, false).text === 'degraded');
  const down = M.healthFrom(null, healthy, NOW + 60_000);
  check('a transport failure keeps the last body but marks it unreachable: the pill says so and names the last verdict', down.unreachable && down.body.status === 'ok' && down.seenAt === NOW && M.headerStatus(down, false).cls === 'bad' && M.headerStatus(down, false).text === 'unreachable · last healthy', JSON.stringify(M.headerStatus(down, false)));
  const gateway = M.healthFrom({ status: 502, body: null }, healthy, NOW);
  check('a 502 without a JSON verdict (a reverse proxy page) is unreachable too', gateway.unreachable && gateway.body.status === 'ok');
  check('nothing yet is "connecting"; never reached is "unreachable"; a halt wins over everything', M.headerStatus(null, false).text === 'connecting' && M.headerStatus(M.healthFrom(null, null, NOW), false).text === 'unreachable' && M.headerStatus(healthy, true).text === 'halted' && M.headerStatus(healthy, true).cls === 'bad');
  check('the page reads /health through healthFrom on success and on failure alike, not through the throwing getJson', /healthFrom\(res,/.test(page) && /healthFrom\(null,/.test(page) && !/getJson\('\/health'\)/.test(page));
}

header('the stream reconnects after a failed response');
{
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const chunks = (list) => { let i = 0; return { getReader: () => ({ read: () => Promise.resolve(i < list.length ? { done: false, value: list[i++] } : { done: true }) }) }; };
  const run = (responses) => {
    const t = { states: [], got: [], pending: [], calls: 0, auth: 0, open: 0 };
    t.loop = M.sseLoop({
      path: '/analytics/stream',
      fetchFn: () => { t.calls++; const r = responses.shift(); return r instanceof Error ? Promise.reject(r) : Promise.resolve(r || { ok: false, status: 502 }); },
      headers: () => ({}),
      abort: () => { const c = { signal: { aborted: false }, abort() { c.signal.aborted = true; } }; return c; },
      decoder: () => (s) => s,
      schedule: (fn, ms) => t.pending.push({ fn, ms }),
      onState: (ok, note) => t.states.push(ok + ':' + note),
      onOpen: () => t.open++,
      onAuth: () => t.auth++,
      onChunk: (m) => t.got.push(m),
    });
    return t;
  };
  const t = run([{ ok: false, status: 502 }, { ok: true, status: 200, body: chunks([`data: {"timestamp":${NOW},"consumer":"ci"}\n\n: keepalive\n\nevent: overage_warn\ndata: {"reason":"near"}\n\n`]) }]);
  await settle();
  check('a 502 from a reverse proxy schedules a retry in 2 s rather than ending the loop', t.calls === 1 && t.states.join('|') === 'false:stream reconnecting' && t.pending.length === 1 && t.pending[0].ms === 2000, JSON.stringify({ states: t.states, pending: t.pending.map((p) => p.ms) }));
  t.pending.shift().fn();
  await settle();
  check('the retry connects: the header goes live, the record and the event arrive, no reload in between', t.calls === 2 && t.open === 1 && t.states[1] === 'true:live · stream' && t.got.length === 2 && t.got[0].event === 'message' && t.got[0].data.consumer === 'ci' && t.got[1].event === 'overage_warn' && t.got[1].data.reason === 'near', JSON.stringify({ states: t.states, got: t.got }));
  check('the server closing the stream is another retry, at 2 s again because the connection had opened', t.states[2] === 'false:stream reconnecting' && t.pending.length === 1 && t.pending[0].ms === 2000, JSON.stringify(t.pending.map((p) => p.ms)));
  const delays = [];
  for (let i = 0; i < 6; i++) { t.pending.shift().fn(); await settle(); delays.push(t.pending[0] && t.pending[0].ms); }
  check('repeated failures back off 4, 8, 16, 30, 30, 30 s', delays.join(',') === '4000,8000,16000,30000,30000,30000', delays.join(','));
  t.loop.stop(); t.pending.shift().fn(); await settle();
  check('after stop() nothing connects and nothing is scheduled', t.calls === 8 && t.pending.length === 0, JSON.stringify({ calls: t.calls, pending: t.pending.length }));
  const a = run([{ ok: false, status: 401 }]);
  await settle();
  check('a refused credential asks for the token once and does not retry', a.auth === 1 && a.states.join('|') === 'false:stream needs the token' && a.pending.length === 0 && a.calls === 1, JSON.stringify(a.states));
  const d = run([new Error('network')]);
  await settle();
  check('a dropped connection retries', d.pending.length === 1 && d.states[0] === 'false:stream reconnecting', JSON.stringify(d.states));
  check('the page runs the stream through sseLoop; the old dead end on a failed response is gone', /DarioMaths\.sseLoop\(\{ path:'\/analytics\/stream'/.test(page) && !/state\.streamOk=false; renderHeader\(\); return;/.test(page));
  check('parseSse: an event with JSON, a bare record, multi-line data, and null without JSON', M.parseSse('event: overage_halt\ndata: {"reason":"x"}').event === 'overage_halt' && M.parseSse('data: {"a":1}').event === 'message' && M.parseSse('data: {"a":\ndata: 2}').data.a === 2 && M.parseSse('data: nope') === null && M.parseSse('event: ping') === null);
  check('streamNext: cancelled stops, 401 and 403 ask, everything else retries with a capped backoff', M.streamNext({ aborted: true }, 0).action === 'stop' && M.streamNext({ status: 401 }, 0).action === 'auth' && M.streamNext({ status: 403 }, 0).action === 'auth' && M.streamNext({ status: 502 }, 0).delayMs === 2000 && M.streamNext({ error: true }, 9).delayMs === 30000 && M.streamNext({ closed: true }, 0).action === 'retry');
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

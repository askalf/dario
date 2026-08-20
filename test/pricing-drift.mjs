#!/usr/bin/env node
// Tests for scripts/check-pricing-drift.mjs — the parse + diff behind the
// pricing drift watcher.
//
// This watcher's failure mode is SILENCE, the same class as health-verdict.sh.
// If the published table gains a column, renames one, or moves, a naive parser
// does not error — it finds nothing, reports "aligned", and dario keeps
// charging whatever it last believed. The first anyone hears is a wrong number
// in front of a user. So most of what follows asserts that the parser THROWS
// rather than that it succeeds.
//
// The fixture is a trimmed copy of the real published table, including the
// awkward parts: markdown links inside model cells, $0.50 and $12.50 cells,
// and a retired model dario does not price.

import { parsePricingTable, priceFromCell, modelIdFromDisplayName, diffPricing, staleIntroWindows }
  from '../scripts/check-pricing-drift.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const throws = (fn, re) => {
  try { fn(); return false; }
  catch (e) { return re ? re.test(e.message) : true; }
};

const HEADER = '| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |';
const SEP    = '| --- | --- | --- | --- | --- | --- |';
const ROWS = [
  '| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |',
  '| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
  '| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
  '| Claude Opus 4.7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
  '| Claude Opus 4.6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
  '| Claude Opus 4.1 ([retired, except on Bedrock](https://example.com/x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |',
  '| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |',
  '| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |',
  '| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |',
  '| Claude Haiku 3.5 ([retired](https://example.com/y)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |',
];
const DOC = ['# Pricing', '', '## Model pricing', '', HEADER, SEP, ...ROWS, '', 'Some prose after.'].join('\n');

header('cell parsing');
{
  check('$5 / MTok', priceFromCell('$5 / MTok') === 5);
  check('$12.50 / MTok', priceFromCell('$12.50 / MTok') === 12.5);
  check('$0.50 / MTok', priceFromCell('$0.50 / MTok') === 0.5);
  check('$0.08 / MTok', priceFromCell('$0.08 / MTok') === 0.08);
  check('non-price cell -> null', priceFromCell('Claude Opus 5') === null);
  check('empty -> null', priceFromCell('') === null);
  // A unit change would silently halve or double every number. Reject it.
  check('a different unit is NOT parsed as a price', priceFromCell('$5 / KTok') === null);
  check('a bare number is NOT parsed', priceFromCell('5') === null);
}

header('model name -> dario id');
{
  check('Claude Opus 4.8', modelIdFromDisplayName('Claude Opus 4.8') === 'claude-opus-4-8');
  check('Claude Sonnet 5', modelIdFromDisplayName('Claude Sonnet 5') === 'claude-sonnet-5');
  check('Claude Haiku 4.5', modelIdFromDisplayName('Claude Haiku 4.5') === 'claude-haiku-4-5');
  check('strips a trailing markdown link',
    modelIdFromDisplayName('Claude Opus 4.1 ([retired, except on Bedrock](https://example.com/x))') === 'claude-opus-4-1');
  check('non-Claude row -> null', modelIdFromDisplayName('Total') === null);
  check('separator junk -> null', modelIdFromDisplayName('---') === null);
}

header('happy path');
{
  const r = parsePricingTable(DOC);
  check('parsed every model row', Object.keys(r).length === 10, Object.keys(r).join(','));
  check('sonnet 5 rates', JSON.stringify(r['claude-sonnet-5']) ===
    JSON.stringify({ input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 }));
  check('haiku 4.5 rates (the row dario had wrong)', JSON.stringify(r['claude-haiku-4-5']) ===
    JSON.stringify({ input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 }));
  check('cacheCreate reads the 5m column, not the 1h one', r['claude-fable-5'].cacheCreate === 12.5);
  check('cacheRead reads Cache Hits & Refreshes', r['claude-fable-5'].cacheRead === 1);
  check('stops at the end of the table', r['some prose after.'] === undefined);
}

header('columns are matched by NAME, not position');
{
  // Upstream reordering columns must not silently map cache reads onto writes.
  const swapped = DOC
    .replace(HEADER, '| Model | Output Tokens | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes |')
    .replace('| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |',
             '| Claude Sonnet 5 | $10 / MTok | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok |');
  const r = parsePricingTable(swapped);
  check('reordered columns still read correctly',
    r['claude-sonnet-5'].input === 2 && r['claude-sonnet-5'].output === 10 &&
    r['claude-sonnet-5'].cacheCreate === 2.5 && r['claude-sonnet-5'].cacheRead === 0.2);
}

header('every way of NOT knowing throws — never a quiet "aligned"');
{
  check('a renamed column throws',
    throws(() => parsePricingTable(DOC.replace('Cache Hits & Refreshes', 'Cache Reads')), /table shape/));
  check('no table at all throws',
    throws(() => parsePricingTable('# Pricing\n\nPricing has moved to another page.\n'), /table shape/));
  check('HTML instead of markdown throws',
    throws(() => parsePricingTable('<!DOCTYPE html><html><body>nope</body></html>'), /table shape/));
  check('empty input throws', throws(() => parsePricingTable('')));
  // A table that parses but yields almost nothing is a shape change too.
  const thin = ['# P', '', HEADER, SEP,
    '| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |'].join('\n');
  check('an implausibly thin parse throws rather than reporting clean',
    throws(() => parsePricingTable(thin), /only 1 model rows/));
}

header('picking the RIGHT table when several look alike');
{
  // The batch-pricing table is also "Model | $x / MTok" shaped and appears
  // later on the same page. Header matching must not land on it.
  const batch = ['| Model | Batch input | Batch output |', '| --- | --- | --- |',
    '| Claude Sonnet 5 | $1 / MTok | $5 / MTok |'].join('\n');
  const r = parsePricingTable([DOC, '', '### Batch processing', '', batch].join('\n'));
  check('reads the model table, not the batch table', r['claude-sonnet-5'].input === 2);
  check('batch rates did not overwrite', r['claude-sonnet-5'].output === 10);
}

header('diff');
{
  const published = parsePricingTable(DOC);
  const clean = { 'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 } };
  check('matching rates -> no drift', diffPricing(clean, published).length === 0);

  // The two real bugs this watcher was built after.
  const sonnetCutover = { 'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } };
  check('the Sonnet 5 cutover bug is caught', diffPricing(sonnetCutover, published).length === 4);

  const haiku = { 'claude-haiku-4-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 } };
  const d = diffPricing(haiku, published);
  check('the Haiku 4.5 bug is caught on all four fields', d.length === 4);
  check('and reports both sides', d.some((x) => x.field === 'input' && x.ours === 0.8 && x.published === 1));

  // A model dario prices that vanished upstream usually means a rename, and a
  // stale key silently falls through to the unknown-model fallback rate.
  const gone = { 'claude-opus-9': { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1.25 } };
  const g = diffPricing(gone, published);
  check('a model missing upstream is drift', g.length === 1 && g[0].published === 'absent');

  // The published table lists models dario does not model. That is not drift.
  check('extra published models are not drift', diffPricing(clean, published).length === 0);
}

header('lapsed promotional windows (the #1047 shape)');
{
  // Checking an intro RATE against the published standard would be permanent
  // noise - a promotional price differs from the standard by definition, so
  // every entry carrying one would report drift forever and the issue would be
  // learned-ignored. What is checkable is the DATE.
  const NOW = Date.parse('2026-08-20T00:00:00Z');
  const withIntro = (until) => ({
    m: { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1.25,
         intro: { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1.25, until } },
  });

  check('no intro block -> nothing to report',
    staleIntroWindows({ m: { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1.25 } }, NOW).length === 0);
  check('a promotion still running is NOT drift',
    staleIntroWindows(withIntro('2026-12-31'), NOW).length === 0);
  check('boundary: the last day of the window is still running',
    staleIntroWindows(withIntro('2026-08-20'), NOW).length === 0);

  const lapsed = staleIntroWindows(withIntro('2026-08-19'), NOW);
  check('a lapsed window is drift', lapsed.length === 1);
  check('and is labelled lapsed', lapsed[0].published === 'lapsed');
  check('and says what to do about it', /remove the intro block|promote its rate/.test(lapsed[0].note));

  // The exact Sonnet 5 bug: an intro whose `until` had been cancelled, still in
  // the table, evaluated the day the cutover would have fired.
  const sonnet5 = staleIntroWindows(withIntro('2026-08-31'), Date.parse('2026-09-01T00:00:00Z'));
  check('the Sonnet 5 shape is caught', sonnet5.length === 1 && sonnet5[0].published === 'lapsed');

  // An unparseable date can never expire, so it would sit forever unnoticed.
  const bad = staleIntroWindows(withIntro('soon'), NOW);
  check('an unparseable until is reported', bad.length === 1 && bad[0].published === 'unparseable');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

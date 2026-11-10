#!/usr/bin/env node
// One-hour cache writes are priced at their own rate.
//
// Anthropic's table has two cache-write columns: a five-minute write at 1.25x
// input and a one-hour write at 2x. A response's usage block says how many of
// its `cache_creation_input_tokens` went to each, under `cache_creation`.
// dario asks for the one-hour cache on subscription traffic, as Claude Code
// does, so pricing every write at the five-minute rate read low.

import {
  Analytics, PRICING, OPENAI_PRICING, cacheCreate1hFromUsage, costOfRequest, costOfTokens,
  costOfTokensFailClosed, highestPublishedRate, pricingRateFor,
} from '../dist/analytics.js';
import { addToLedger, consumerDayUsage, dayKey, emptyLedger, formatLedgerConsumers, parseLedger, priceLedger, summarizeLedger } from '../dist/ledger.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const T = Date.parse('2026-11-09T15:00:00Z');
const rec = (over = {}) => ({
  timestamp: T, account: 'main', model: 'claude-opus-5-5',
  inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 20_000, cacheCreateTokens: 10_000, thinkingTokens: 0,
  claim: 'five_hour', util5h: 0.1, util7d: 0.2, overageUtil: 0, latencyMs: 10, status: 200, isStream: true, isOpenAI: false,
  ...over,
});

header('the rate table: every Claude row carries the one-hour write at 2x input');
{
  for (const [id, row] of Object.entries(PRICING)) {
    check(`${id}: one-hour write is twice input`, near(row.cacheCreate1h, row.input * 2), row.cacheCreate1h);
    if (row.longPrompt) check(`${id} long prompt: one-hour write is twice input`, near(row.longPrompt.cacheCreate1h, row.longPrompt.input * 2), row.longPrompt.cacheCreate1h);
    if (row.intro) check(`${id} intro: one-hour write is twice input`, near(row.intro.cacheCreate1h, row.intro.input * 2), row.intro.cacheCreate1h);
  }
  check('Fable 5.2 at $16, Opus 5.5 at $8, Sonnet 5.5 at $4', PRICING['claude-fable-5-2'].cacheCreate1h === 16 && PRICING['claude-opus-5-5'].cacheCreate1h === 8 && PRICING['claude-sonnet-5-5'].cacheCreate1h === 4);
  check('Haiku 5.5 at $0.20, and $1 over 100,000 prompt tokens', pricingRateFor('claude-haiku-5-5', T).cacheCreate1h === 0.2 && pricingRateFor('claude-haiku-5-5[long]', T).cacheCreate1h === 1);
  check('a dated or [1m] id reads the same row', pricingRateFor('claude-opus-5-5[1m]', T).cacheCreate1h === 8 && pricingRateFor('claude-haiku-4-5-20251001', T).cacheCreate1h === 2);
  check('an unlisted Claude id takes the fallback row\'s', pricingRateFor('claude-mystery-9', T).cacheCreate1h === PRICING['claude-sonnet-4-6'].cacheCreate1h);
  check('OpenAI\'s table has one write price, which a one-hour write takes too', pricingRateFor('gpt-5.6-terra', T).cacheCreate1h === OPENAI_PRICING['gpt-5.6-terra'].cacheCreate && !('cacheCreate1h' in OPENAI_PRICING['gpt-5.6-terra']));
  const top = highestPublishedRate();
  check('the highest published rate has a one-hour write, above the five-minute one', top.cacheCreate1h === 20 && top.cacheCreate1h > top.cacheCreate, JSON.stringify(top));
}

header('reading the usage block');
{
  check('the one-hour share of the breakdown', cacheCreate1hFromUsage({ cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 600 } }) === 600);
  check('no breakdown: 0', cacheCreate1hFromUsage({ cache_creation_input_tokens: 900 }) === 0);
  check('a breakdown with no one-hour field: 0', cacheCreate1hFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 300 } }) === 0);
  check('junk is 0, never a throw', [undefined, null, 'x', 7, { cache_creation: null }, { cache_creation: 'x' }, { cache_creation: { ephemeral_1h_input_tokens: '600' } },
    { cache_creation: { ephemeral_1h_input_tokens: -5 } }, { cache_creation: { ephemeral_1h_input_tokens: NaN } }].every((u) => cacheCreate1hFromUsage(u) === 0));
  const parsed = Analytics.parseUsage({ model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 600 } } });
  check('parseUsage keeps the total and adds the share', parsed.cacheCreateTokens === 900 && parsed.cacheCreate1hTokens === 600);
  check('parseUsage on a response with no breakdown', Analytics.parseUsage({ usage: { cache_creation_input_tokens: 900 } }).cacheCreate1hTokens === 0);
}

header('pricing one request');
{
  const t = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 20_000, cacheCreateTokens: 10_000 };
  // Opus 5.5: $4 in, $20 out, $0.20 read, $5 five-minute write, $8 one-hour write.
  const fixed = (1_000 * 4 + 500 * 20 + 20_000 * 0.2) / 1e6;
  check('no share given: every write at the five-minute rate', near(costOfTokens('claude-opus-5-5', T, t), fixed + (10_000 * 5) / 1e6));
  check('all one-hour: every write at the one-hour rate', near(costOfTokens('claude-opus-5-5', T, { ...t, cacheCreate1hTokens: 10_000 }), fixed + (10_000 * 8) / 1e6));
  check('a mix: each part at its own rate', near(costOfTokens('claude-opus-5-5', T, { ...t, cacheCreate1hTokens: 6_000 }), fixed + (4_000 * 5 + 6_000 * 8) / 1e6));
  check('a share larger than the writes is held to them', near(costOfTokens('claude-opus-5-5', T, { ...t, cacheCreate1hTokens: 50_000 }), fixed + (10_000 * 8) / 1e6));
  check('a share that is not a positive number is 0', [-1, NaN, 0].every((n) => near(costOfTokens('claude-opus-5-5', T, { ...t, cacheCreate1hTokens: n }), fixed + (10_000 * 5) / 1e6)));
  check('Infinity is not a count: priced as no share', near(costOfTokens('claude-opus-5-5', T, { ...t, cacheCreate1hTokens: Infinity }), fixed + (10_000 * 5) / 1e6));
  // Haiku 5.5 over 100,000 prompt tokens: $0.50 in, $2.50 out, $0.05 read, $0.625 and $1 writes.
  const long = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 150_000, cacheCreateTokens: 40_000, cacheCreate1hTokens: 40_000 };
  check('a long Haiku 5.5 request: the long-prompt one-hour rate', near(costOfRequest('claude-haiku-5-5', T, long), (10_000 * 0.5 + 1_000 * 2.5 + 150_000 * 0.05 + 40_000 * 1) / 1e6));
  check('an unlisted model, held at the highest rate: its one-hour write too', near(costOfTokensFailClosed('claude-mystery-9', T, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 1_000_000, cacheCreate1hTokens: 1_000_000 }), 20));
  check('a ChatGPT-plan model: one write price either way', near(costOfTokens('gpt-5.6-terra', T, { ...t, cacheCreate1hTokens: 10_000 }), costOfTokens('gpt-5.6-terra', T, t)));
}

header('the ledger keeps the share and prices it when read');
{
  const f = emptyLedger(T);
  addToLedger(f, rec({ consumer: 'alice', cacheCreate1hTokens: 10_000 }));
  addToLedger(f, rec({ consumer: 'alice', cacheCreate1hTokens: 4_000 }));
  addToLedger(f, rec({ consumer: 'alice' }));
  const day = dayKey(T);
  const cell = f.days[day]['claude-opus-5-5'].covered;
  check('the cell sums the total and the share', cell.cacheCreateTokens === 30_000 && cell.cacheCreate1hTokens === 14_000);
  check('the consumer split too', f.consumers[day].alice['claude-opus-5-5'].covered.cacheCreate1hTokens === 14_000);
  const fixed = 3 * (1_000 * 4 + 500 * 20 + 20_000 * 0.2) / 1e6;
  const want = fixed + (16_000 * 5 + 14_000 * 8) / 1e6;
  const s = summarizeLedger(f, 'p', T);
  check('the summary prices the share at the one-hour rate', near(s.apiEquivalentCost, want, 1e-6), `${s.apiEquivalentCost} vs ${want}`);
  check('and reports it beside the total', s.tokens.cacheCreate === 30_000 && s.tokens.cacheCreate1h === 14_000 && s.perModel['claude-opus-5-5'].cacheCreate1hTokens === 14_000 && s.perConsumer.alice.cacheCreate1hTokens === 14_000);
  check('the per-key number is the same money', near(s.perConsumer.alice.apiEquivalentCost, want, 1e-6));
  check('the priced rows agree', near(priceLedger(f).days[day]['claude-opus-5-5'].covered, want, 1e-6));
  check('a key\'s spend today counts it', near(consumerDayUsage(f, 'alice', T).usd, want, 1e-6));
  const line = formatLedgerConsumers(s).join('\n');
  check('the by-key lines say how much of the cache write was one-hour', line.includes('cache write 30k (14k one-hour)'), line);

  const back = parseLedger(JSON.stringify(f));
  check('the share survives a write and a read', back.days[day]['claude-opus-5-5'].covered.cacheCreate1hTokens === 14_000 && near(summarizeLedger(back, 'p', T).apiEquivalentCost, want, 1e-6));

  // A row written before the field existed.
  const old = emptyLedger(T);
  addToLedger(old, rec());
  check('a record with no share leaves the field off the cell', !('cacheCreate1hTokens' in old.days[day]['claude-opus-5-5'].covered));
  const oldBack = parseLedger(JSON.stringify(old));
  check('a row with no share reads as none, priced at the five-minute rate', !('cacheCreate1hTokens' in oldBack.days[day]['claude-opus-5-5'].covered)
    && near(summarizeLedger(oldBack, 'p', T).apiEquivalentCost, (1_000 * 4 + 500 * 20 + 20_000 * 0.2 + 10_000 * 5) / 1e6, 1e-6));
  check('and its by-key line is as it was', !formatLedgerConsumers(summarizeLedger((() => { const g = emptyLedger(T); addToLedger(g, rec({ consumer: 'bob' })); return g; })(), 'p', T)).join('\n').includes('one-hour'));

  // A file edited by hand, or written by a build with a fault.
  const edited = JSON.parse(JSON.stringify(f));
  edited.days[day]['claude-opus-5-5'].covered.cacheCreate1hTokens = 999_999;
  check('a share above the writes in a file is held to them', parseLedger(JSON.stringify(edited)).days[day]['claude-opus-5-5'].covered.cacheCreate1hTokens === 30_000);
  edited.days[day]['claude-opus-5-5'].covered.cacheCreate1hTokens = 'many';
  check('a share that is not a number is dropped, the row kept', (() => { const c = parseLedger(JSON.stringify(edited)).days[day]['claude-opus-5-5'].covered; return c.cacheCreateTokens === 30_000 && !('cacheCreate1hTokens' in c); })());
  const over = emptyLedger(T);
  addToLedger(over, rec({ cacheCreateTokens: 100, cacheCreate1hTokens: 5_000 }));
  check('a record whose share exceeds its writes adds only the writes', over.days[day]['claude-opus-5-5'].covered.cacheCreate1hTokens === 100);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

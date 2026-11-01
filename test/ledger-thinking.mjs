#!/usr/bin/env node
// Thinking tokens in usage: read from the usage block, kept in the ledger per
// day / model / consumer, priced at the output rate, shown as a share of
// output. In-process; no proxy, no credentials, no network.

import {
  Analytics, thinkingTokensFromUsage, costOfTokens,
} from '../dist/analytics.js';
import {
  addToLedger, emptyLedger, formatLedgerConsumers, formatLedgerSummary, parseLedger,
  summarizeLedger, summarizeLedgerConsumers, thinkingPercent,
} from '../dist/ledger.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const NOW = Date.parse('2026-11-01T12:00:00Z');
const DAY = new Date(NOW).toISOString().slice(0, 10);

header('usage block: the billed count wins, the text estimate is the fallback');
{
  const billed = Analytics.parseUsage({
    model: 'claude-opus-5-5',
    usage: { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 60 } },
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }],
  });
  check('thinking read from output_tokens_details', billed.thinkingTokens === 60, billed.thinkingTokens);
  check('the other counts are untouched', billed.inputTokens === 10 && billed.outputTokens === 100 && billed.model === 'claude-opus-5-5');
  const estimated = Analytics.parseUsage({
    model: 'claude-opus-5-5',
    usage: { input_tokens: 10, output_tokens: 100 },
    content: [{ type: 'thinking', thinking: 'x'.repeat(40) }],
  });
  check('no details: a quarter of the thinking characters', estimated.thinkingTokens === 10, estimated.thinkingTokens);
  const none = Analytics.parseUsage({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 } });
  check('no details, no thinking blocks: 0', none.thinkingTokens === 0);
  check('details with zero thinking beat a non-empty estimate', Analytics.parseUsage({
    model: 'm', usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } },
    content: [{ type: 'thinking', thinking: 'abcdefgh' }],
  }).thinkingTokens === 0);
  check('helper: missing block -> undefined', thinkingTokensFromUsage(undefined) === undefined && thinkingTokensFromUsage({}) === undefined);
  check('helper: malformed counts -> undefined', thinkingTokensFromUsage({ output_tokens_details: { thinking_tokens: 'many' } }) === undefined
    && thinkingTokensFromUsage({ output_tokens_details: { thinking_tokens: -4 } }) === undefined);
  check('helper: a fractional count is rounded', thinkingTokensFromUsage({ output_tokens_details: { thinking_tokens: 12.6 } }) === 13);
}

const rec = (over = {}) => ({
  timestamp: NOW, account: 'main', model: 'claude-opus-5-5',
  inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 800,
  claim: 'five_hour', util5h: 0.1, util7d: 0.2, overageUtil: 0, latencyMs: 10, status: 200, isStream: false, isOpenAI: false,
  ...over,
});

header('ledger: the count rides every row, capped at the output it is a share of');
{
  const file = emptyLedger(NOW);
  addToLedger(file, rec({ consumer: 'alice' }));
  addToLedger(file, rec({ consumer: 'alice', thinkingTokens: 200 }));
  addToLedger(file, rec({ consumer: 'bob', claim: 'api', thinkingTokens: 5_000 }));          // metered, over the cap
  addToLedger(file, rec({ consumer: 'carol', thinkingTokens: Number.NaN }));                  // garbage reads as 0
  addToLedger(file, rec({ consumer: 'carol', thinkingTokens: undefined }));
  addToLedger(file, rec({ model: 'claude-sonnet-5-5', thinkingTokens: 100 }));                // no consumer
  const covered = file.days[DAY]['claude-opus-5-5'].covered;
  check('covered cell sums thinking', covered.thinkingTokens === 1_000, covered.thinkingTokens);
  check('a count above the output is capped at the output', file.days[DAY]['claude-opus-5-5'].metered.thinkingTokens === 1_000, JSON.stringify(file.days[DAY]['claude-opus-5-5'].metered));
  check('per-consumer rows carry it too', file.consumers[DAY].alice['claude-opus-5-5'].covered.thinkingTokens === 1_000
    && file.consumers[DAY].carol['claude-opus-5-5'].covered.thinkingTokens === 0);

  const s = summarizeLedger(file, '/tmp/ledger.json', NOW);
  check('summary: covered thinking total', s.tokens.thinking === 1_100 && s.tokens.output === 5_000, JSON.stringify(s.tokens));
  check('summary: per model', s.perModel['claude-opus-5-5'].thinkingTokens === 1_000 && s.perModel['claude-sonnet-5-5'].thinkingTokens === 100);
  const expected = costOfTokens('claude-opus-5-5', NOW, { inputTokens: 0, outputTokens: 1_000, cacheReadTokens: 0, cacheCreateTokens: 0 })
    + costOfTokens('claude-sonnet-5-5', NOW, { inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 });
  check('summary: thinking priced at each model\'s output rate, covered only', Math.abs(s.thinkingCost - expected) < 1e-6, `${s.thinkingCost} vs ${expected}`);
  check('summary: thinkingCost is inside apiEquivalentCost, never beside it', s.thinkingCost > 0 && s.thinkingCost < s.apiEquivalentCost);

  const c = summarizeLedgerConsumers(file, NOW);
  check('consumers: alice', c.alice.thinkingTokens === 1_000 && Math.abs(c.alice.thinkingCost
    - costOfTokens('claude-opus-5-5', NOW, { inputTokens: 0, outputTokens: 1_000, cacheReadTokens: 0, cacheCreateTokens: 0 })) < 1e-6, JSON.stringify(c.alice));
  check('consumers: bob (metered) counts thinking and its cost too', c.bob.thinkingTokens === 1_000 && c.bob.thinkingCost > 0, JSON.stringify(c.bob));
  check('consumers: carol has none', c.carol.thinkingTokens === 0 && c.carol.thinkingCost === 0);

  const summaryLines = formatLedgerSummary(s);
  const thinkingLine = summaryLines.find((l) => l.includes('Thinking:'));
  check('usage block prints the thinking line with the share', !!thinkingLine && thinkingLine.includes('(22%)') && thinkingLine.includes('of the number above'), thinkingLine);
  const keyLines = formatLedgerConsumers(s);
  const aliceTokens = keyLines[keyLines.findIndex((l) => l.trimStart().startsWith('alice')) + 1];
  check('--by-key shows each key\'s thinking share on the tokens line', aliceTokens.includes('thinking 1.0k (50% of out,'), aliceTokens);
  const carolTokens = keyLines[keyLines.findIndex((l) => l.trimStart().startsWith('carol')) + 1];
  check('--by-key omits the thinking part when there was none', !carolTokens.includes('thinking'), carolTokens);

  const quiet = summarizeLedger(emptyLedger(NOW), '/tmp/x', NOW);
  check('no thinking, no line', !formatLedgerSummary(quiet).some((l) => l.includes('Thinking:')));
  check('thinkingPercent rounds and survives zero output', thinkingPercent(939, 1136) === 83 && thinkingPercent(0, 0) === 0 && thinkingPercent(1, 3) === 33);
}

header('ledger files written before the field read as 0 and keep counting');
{
  const legacy = JSON.stringify({
    version: 1, since: new Date(NOW - 86_400_000).toISOString(), updated: new Date(NOW).toISOString(),
    days: { [DAY]: { 'claude-opus-5-5': { covered: { requests: 2, inputTokens: 10, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0 } } } },
    consumers: { [DAY]: { alice: { 'claude-opus-5-5': { covered: { requests: 2, inputTokens: 10, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0 } } } } },
  });
  const file = parseLedger(legacy);
  check('old cells parse with thinkingTokens 0', file.days[DAY]['claude-opus-5-5'].covered.thinkingTokens === 0
    && file.consumers[DAY].alice['claude-opus-5-5'].covered.thinkingTokens === 0);
  addToLedger(file, rec({ consumer: 'alice', thinkingTokens: 300 }));
  check('a new record adds a finite count to the old cell', file.days[DAY]['claude-opus-5-5'].covered.thinkingTokens === 300
    && file.consumers[DAY].alice['claude-opus-5-5'].covered.thinkingTokens === 300);
  const again = parseLedger(JSON.stringify(file));
  check('round trip keeps the count', again.days[DAY]['claude-opus-5-5'].covered.thinkingTokens === 300);
  const dirty = parseLedger(JSON.stringify({
    version: 1, since: new Date(NOW).toISOString(), updated: new Date(NOW).toISOString(),
    days: { [DAY]: { m: { covered: { requests: 1, inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 99 } } } },
  }));
  check('a count above the output on disk is capped on read', dirty.days[DAY].m.covered.thinkingTokens === 10, dirty.days[DAY].m.covered.thinkingTokens);
  check('a string count on disk reads as 0', parseLedger(JSON.stringify({
    version: 1, since: new Date(NOW).toISOString(), updated: new Date(NOW).toISOString(),
    days: { [DAY]: { m: { covered: { requests: 1, inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 'lots' } } } },
  })).days[DAY].m.covered.thinkingTokens === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

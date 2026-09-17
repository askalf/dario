#!/usr/bin/env node
/**
 * test/ledger-per-key-tokens.mjs
 *
 * The per-key ledger summary carries the tokens behind each key's number
 * (dario#1318): a reporter read "$24 today" against "100k output tokens" and
 * called the estimate wrong; the dollars were mostly input and cache-write.
 * With the four counts on the page the split is visible.
 *
 * Covers:
 *   - summarizeLedgerConsumers sums input/output/cache tokens across days,
 *     models and both buckets (covered + metered) per consumer
 *   - formatLedgerConsumers prints one tokens line under each key
 *   - formatTokenCount: units and rounding
 *
 * Runs in-process on a synthetic ledger file. No proxy, no disk, no network.
 */
import { summarizeLedgerConsumers, formatLedgerConsumers, formatTokenCount } from '../dist/ledger.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const cell = (requests, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens) =>
  ({ requests, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens });

const file = {
  version: 1,
  since: '2026-09-14T00:00:00.000Z',
  updated: '2026-09-16T00:00:00.000Z',
  days: {},
  consumers: {
    '2026-09-14': {
      alice: { 'claude-opus-5': { covered: cell(10, 1_000_000, 50_000, 3_000_000, 200_000) } },
      bob: { 'claude-sonnet-5': { covered: cell(2, 10_000, 1_000, 0, 0) } },
    },
    '2026-09-15': {
      alice: {
        'claude-opus-5': { covered: cell(5, 500_000, 50_000, 1_000_000, 100_000), metered: cell(1, 1_000, 500, 0, 0) },
        'claude-sonnet-5': { covered: cell(3, 30_000, 3_000, 60_000, 6_000) },
      },
    },
  },
};

header('summarizeLedgerConsumers sums tokens per consumer');
{
  const s = summarizeLedgerConsumers(file, Date.parse('2026-09-16T12:00:00Z'));
  const a = s.alice;
  check('alice input = covered + metered across days and models', a.inputTokens === 1_000_000 + 500_000 + 1_000 + 30_000);
  check('alice output', a.outputTokens === 50_000 + 50_000 + 500 + 3_000);
  check('alice cache read', a.cacheReadTokens === 3_000_000 + 1_000_000 + 60_000);
  check('alice cache write', a.cacheCreateTokens === 200_000 + 100_000 + 6_000);
  check('alice requests unchanged by the new fields', a.requests === 10 + 5 + 1 + 3);
  check('bob tokens', s.bob.inputTokens === 10_000 && s.bob.outputTokens === 1_000 && s.bob.cacheReadTokens === 0 && s.bob.cacheCreateTokens === 0);
  check('output alone does not explain the dollars', a.apiEquivalentCost > (a.outputTokens / 1_000_000) * 25);
}

header('formatLedgerConsumers prints a tokens line under each key');
{
  const perConsumer = summarizeLedgerConsumers(file, Date.parse('2026-09-16T12:00:00Z'));
  const lines = formatLedgerConsumers({ perConsumer });
  const aliceIdx = lines.findIndex((l) => l.trimStart().startsWith('alice'));
  check('alice has a spend line', aliceIdx > 0, lines.join('\n'));
  const tokensLine = lines[aliceIdx + 1] ?? '';
  check('the next line carries the four counts', /in 1\.5M · out 104k · cache read 4\.1M · cache write 306k/.test(tokensLine), tokensLine);
  const bobIdx = lines.findIndex((l) => l.trimStart().startsWith('bob'));
  check('bob has one too', /in 10k · out 1\.0k · cache read 0 · cache write 0/.test(lines[bobIdx + 1] ?? ''), lines[bobIdx + 1]);
  check('the header says what the second line is', /tokens behind/.test(lines[0]));
}

header('formatTokenCount');
{
  check('below a thousand is the number', formatTokenCount(999) === '999');
  check('thousands to one decimal', formatTokenCount(1_234) === '1.2k');
  check('ten-thousands drop the decimal', formatTokenCount(12_345) === '12k');
  check('millions to one decimal', formatTokenCount(1_234_567) === '1.2M');
  check('ten-millions drop the decimal', formatTokenCount(12_345_678) === '12M');
  check('zero', formatTokenCount(0) === '0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

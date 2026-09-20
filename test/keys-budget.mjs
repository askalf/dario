#!/usr/bin/env node
// Per-key daily budgets, the pure half (dario#1318 follow-up): the flag
// parsers, normalization, the record shape, the verdict and its headers, and
// the ledger's per-consumer "today" read the verdict consumes.

import {
  createKey, emptyKeysFile, publicKey, rotateKey, setKeyBudget, normalizeBudget, parseKeysFile,
  parseUsdBudget, parseTokenBudget, formatBudget, budgetVerdict, budgetHeaders, nextUtcMidnight,
} from '../dist/keys.js';
import { addToLedger, emptyLedger, consumerDayUsage } from '../dist/ledger.js';
import { costOfTokens } from '../dist/analytics.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const NOW = Date.parse('2026-09-20T15:30:00Z');

header('parsers');
{
  for (const [v, want] of [['5', 5], ['$5', 5], ['5.00', 5], ['$5/day', 5], ['5/d', 5], ['0.25', 0.25], [' $12.5 / day ', 12.5]]) {
    check(`usd "${v}" → ${want}`, parseUsdBudget(v) === want, parseUsdBudget(v));
  }
  for (const v of ['', '0', '-1', 'five', '$', '5/hour', '5.123']) check(`usd "${v}" → null`, parseUsdBudget(v) === null, parseUsdBudget(v));
  for (const [v, want] of [['250000', 250000], ['250k', 250000], ['2M', 2000000], ['1.5m/day', 1500000], ['2M tok/day', 2000000], ['800 tokens', 800]]) {
    check(`tokens "${v}" → ${want}`, parseTokenBudget(v) === want, parseTokenBudget(v));
  }
  for (const v of ['', '0', 'lots', '2G', '-5k']) check(`tokens "${v}" → null`, parseTokenBudget(v) === null, parseTokenBudget(v));
}

header('normalize + format');
{
  check('neither cap → undefined', normalizeBudget({}) === undefined && normalizeBudget(null) === undefined);
  check('usd rounds to cents, tokens to integers', JSON.stringify(normalizeBudget({ usdPerDay: 5.005, tokensPerDay: 1000.4 })) === JSON.stringify({ usdPerDay: 5.01, tokensPerDay: 1000 }));
  let threw = false; try { normalizeBudget({ usdPerDay: 0 }); } catch { threw = true; } check('a zero cap throws', threw);
  threw = false; try { normalizeBudget({ tokensPerDay: -1 }); } catch { threw = true; } check('a negative cap throws', threw);
  check('format both', formatBudget({ usdPerDay: 5, tokensPerDay: 2_000_000 }) === '$5/day · 2M tok/day', formatBudget({ usdPerDay: 5, tokensPerDay: 2_000_000 }));
  check('format cents + k', formatBudget({ usdPerDay: 0.5, tokensPerDay: 250_000 }) === '$0.50/day · 250k tok/day', formatBudget({ usdPerDay: 0.5, tokensPerDay: 250_000 }));
  check('format none', formatBudget(null) === '-' && formatBudget({}) === '-');
}

header('the record');
{
  const file = emptyKeysFile();
  const { record } = createKey(file, 'alice', { budget: { usdPerDay: 5 }, now: NOW });
  check('createKey stores the budget', record.budget?.usdPerDay === 5 && record.budget.tokensPerDay === undefined, record.budget);
  const pub = publicKey(record, NOW);
  check('publicKey exposes usd_per_day / tokens_per_day', pub.budget?.usd_per_day === 5 && pub.budget.tokens_per_day === null, pub.budget);
  const { record: bob } = createKey(file, 'bob', { now: NOW });
  check('a key without a budget has budget: null', publicKey(bob, NOW).budget === null);
  check('setKeyBudget replaces', setKeyBudget(file, 'alice', { tokensPerDay: 100_000 })?.budget?.tokensPerDay === 100_000 && file.keys[0].budget.usdPerDay === undefined, file.keys[0].budget);
  check('setKeyBudget(null) clears', setKeyBudget(file, 'alice', null) !== null && file.keys[0].budget === undefined);
  check('setKeyBudget on an unknown key → null', setKeyBudget(file, 'nobody', { usdPerDay: 1 }) === null);
  setKeyBudget(file, 'alice', { usdPerDay: 2 });
  const rotated = rotateKey(file, 'alice', NOW);
  check('rotate keeps the budget', rotated?.record.budget?.usdPerDay === 2, rotated?.record.budget);
  const reread = parseKeysFile(JSON.stringify(file));
  check('the file round-trips the budget (parseKeysFile keeps it)', reread.keys.find((k) => k.name === 'alice')?.budget?.usdPerDay === 2, reread.keys[0]);
  const junk = parseKeysFile(JSON.stringify({ ...file, keys: [{ ...file.keys[0], budget: { usdPerDay: -4 } }] }));
  check('a malformed budget on disk is dropped, the key kept', junk.keys.length === 1 && junk.keys[0].budget === undefined, junk.keys[0]);
}

header('verdict');
{
  const midnight = nextUtcMidnight(NOW);
  check('next UTC midnight', new Date(midnight).toISOString() === '2026-09-21T00:00:00.000Z', new Date(midnight).toISOString());
  const under = budgetVerdict({ usdPerDay: 5 }, { usd: 4.99, tokens: 10, requests: 3 }, NOW);
  check('under: not over, no reason', !under.over && under.reason === null);
  check('retry-after = seconds to midnight', under.retryAfterSec === Math.ceil((midnight - NOW) / 1000), under.retryAfterSec);
  const at = budgetVerdict({ usdPerDay: 5 }, { usd: 5, tokens: 0, requests: 1 }, NOW);
  check('at the cap counts as over (checked at request start)', at.over && at.reason === 'usd');
  const tok = budgetVerdict({ usdPerDay: 50, tokensPerDay: 1000 }, { usd: 1, tokens: 1000, requests: 1 }, NOW);
  check('tokens cap trips on its own', tok.over && tok.reason === 'tokens');
  const both = budgetVerdict({ usdPerDay: 1, tokensPerDay: 1 }, { usd: 9, tokens: 9, requests: 1 }, NOW);
  check('usd is reported first when both trip', both.reason === 'usd');
  const h = budgetHeaders(tok, 'bob');
  check('headers carry key, caps, use and reset', h['x-dario-budget-key'] === 'bob' && h['x-dario-budget-usd'] === '50' && h['x-dario-budget-used-usd'] === '1.0000' && h['x-dario-budget-tokens'] === '1000' && h['x-dario-budget-used-tokens'] === '1000' && h['x-dario-budget-resets-at'] === '2026-09-21T00:00:00.000Z', h);
  const hu = budgetHeaders(budgetVerdict({ usdPerDay: 5 }, { usd: 0, tokens: 0, requests: 0 }, NOW), 'alice');
  check('a usd-only budget carries no token headers', hu['x-dario-budget-tokens'] === undefined && hu['x-dario-budget-usd'] === '5');
}

header('the ledger read');
{
  const file = emptyLedger(NOW);
  const row = (consumer, model, input, output, claim = 'five_hour') => ({
    timestamp: NOW, consumer, account: 'one', model, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
    claim, util5h: 0.1, util7d: 0.1, overageUtil: 0, latencyMs: 10, status: 200, isStream: false, isOpenAI: false,
  });
  addToLedger(file, row('alice', 'claude-sonnet-5', 100_000, 1_000));
  addToLedger(file, row('alice', 'claude-sonnet-5', 50_000, 500, 'api'));       // metered — still the key's traffic
  addToLedger(file, row('bob', 'claude-sonnet-5', 1_000, 10));
  addToLedger(file, { ...row('alice', 'claude-sonnet-5', 5, 5), timestamp: NOW - 86_400_000 * 2 }); // two days ago
  const a = consumerDayUsage(file, 'alice', NOW);
  const expect = costOfTokens('claude-sonnet-5', NOW, { requests: 2, inputTokens: 150_000, outputTokens: 1_500, cacheReadTokens: 0, cacheCreateTokens: 0 });
  check('today only, covered + metered, priced like the headline', Math.abs(a.usd - expect) < 0.0001 && a.tokens === 151_500 && a.requests === 2, { a, expect });
  check('another consumer is separate', consumerDayUsage(file, 'bob', NOW).tokens === 1_010);
  check('an unknown consumer reads zero', consumerDayUsage(file, 'nobody', NOW).usd === 0);
  check('a 429 row is not counted', (addToLedger(file, { ...row('bob', 'claude-sonnet-5', 9_999, 0), status: 429 }), consumerDayUsage(file, 'bob', NOW).tokens === 1_010));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

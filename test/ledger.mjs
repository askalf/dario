#!/usr/bin/env node
// Unit tests for src/ledger.ts — the lifetime ledger behind "what would this
// have cost on the metered API". Pure functions first (bucket rule, add,
// prune, parse, summarize, formatting, the card), then the Ledger class
// against a temp dir (open, debounced flush, corrupt file moved aside).

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger, LEDGER_VERSION, LEDGER_MAX_DAYS, LEDGER_FLUSH_DELAY_MS,
  addToLedger, dayKey, emptyLedger, formatLedgerSummary, formatUsd, ledgerBucketFor, ledgerPathFor,
  parseLedger, pruneLedger, readLedgerFile, renderLedgerCard, resolveLedgerPath, shortModelName, summarizeLedger,
} from '../dist/ledger.js';
import { OPENAI_PRICING, PRICING, costOfTokens, pricingRateFor, providerOfModel } from '../dist/analytics.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const T = Date.parse('2026-09-11T15:00:00Z');
const rec = (over = {}) => ({
  timestamp: T, account: 'main', model: 'claude-opus-5',
  inputTokens: 1000, outputTokens: 500, cacheReadTokens: 20000, cacheCreateTokens: 2000, thinkingTokens: 0,
  claim: 'five_hour', util5h: 0.1, util7d: 0.2, overageUtil: 0, latencyMs: 10, status: 200, isStream: true, isOpenAI: false,
  ...over,
});

header('pricing: OpenAI rows, provider split, suffixes, fallbacks');
{
  check('gpt-* is the openai provider; claude-* and unknown ids are anthropic',
    providerOfModel('gpt-5.6-terra') === 'openai' && providerOfModel('claude-opus-5') === 'anthropic' && providerOfModel('mystery') === 'anthropic' && providerOfModel('o3') === 'openai');
  const terra = pricingRateFor('gpt-5.6-terra', T);
  check('gpt-5.6-terra is priced from the OpenAI table, not the sonnet fallback', terra.input === 2 && terra.output === 12 && terra.cacheRead === 0.2, JSON.stringify(terra));
  check('an effort suffix is stripped before lookup', JSON.stringify(pricingRateFor('gpt-5.6-sol:high', T)) === JSON.stringify(OPENAI_PRICING['gpt-5.6-sol']));
  check('unknown gpt model → gpt-5.6-terra rate; unknown claude → sonnet-4-6 rate',
    JSON.stringify(pricingRateFor('gpt-9-nova', T)) === JSON.stringify(OPENAI_PRICING['gpt-5.6-terra'])
    && pricingRateFor('claude-mystery-9', T).input === PRICING['claude-sonnet-4-6'].input);
  check('[1m] tag still stripped on the Claude side', pricingRateFor('claude-sonnet-5[1m]', T).input === 2);
  check('the dated id a response echoes prices as its family (live 2026-09-12: claude-haiku-4-5-20251001 was at the sonnet fallback)', pricingRateFor('claude-haiku-4-5-20251001', T).input === 1 && pricingRateFor('claude-haiku-4-5-20251001', T).output === 5);
  check('OpenAI cache writes: 1.25x input on the 5.6 family and astra (the published column), the input rate where the page lists none', OPENAI_PRICING['gpt-5.6-terra'].cacheCreate === 2.5 && OPENAI_PRICING['gpt-6-astra'].cacheCreate === 12.5 && OPENAI_PRICING['gpt-5.5'].cacheCreate === OPENAI_PRICING['gpt-5.5'].input);
  const c = costOfTokens('claude-opus-5', T, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
  check('costOfTokens: 1M opus-5 input tokens = $5', c === 5, c);
}

header('bucket rule: 2xx only; api/extra_usage are metered, everything else covered');
{
  check('five_hour → covered', ledgerBucketFor({ status: 200, claim: 'five_hour' }) === 'covered');
  check('codex claim → covered', ledgerBucketFor({ status: 200, claim: 'chatgpt_subscription' }) === 'covered');
  check('overage-included → covered (it is $0 out of pocket)', ledgerBucketFor({ status: 200, claim: 'seven_day_overage_included' }) === 'covered');
  check('absent claim on a 2xx → covered', ledgerBucketFor({ status: 200, claim: 'unknown' }) === 'covered');
  check('api → metered', ledgerBucketFor({ status: 200, claim: 'api' }) === 'metered');
  check('overage (paid extra usage) → metered', ledgerBucketFor({ status: 200, claim: 'overage' }) === 'metered');
  check('429 / 500 / 0 are not counted', ledgerBucketFor({ status: 429, claim: 'five_hour' }) === null && ledgerBucketFor({ status: 500, claim: 'five_hour' }) === null && ledgerBucketFor({ status: 0, claim: 'five_hour' }) === null);
}

header('addToLedger: per UTC day, per model, per bucket; since moves back');
{
  const f = emptyLedger(T + 60_000);
  check('a 200 is counted', addToLedger(f, rec()) === true);
  check('a 429 is not', addToLedger(f, rec({ status: 429 })) === false);
  addToLedger(f, rec({ inputTokens: 1 }));
  addToLedger(f, rec({ claim: 'api', inputTokens: 7 }));
  addToLedger(f, rec({ model: 'gpt-5.6-terra', claim: 'chatgpt_subscription', timestamp: Date.parse('2026-09-12T01:00:00Z'), cacheReadTokens: 0, cacheCreateTokens: 0 }));
  const day = f.days['2026-09-11'];
  check('two covered opus rows folded into one cell', day['claude-opus-5'].covered.requests === 2 && day['claude-opus-5'].covered.inputTokens === 1001 && day['claude-opus-5'].covered.cacheReadTokens === 40000, JSON.stringify(day));
  check('the api-claimed one sits in metered', day['claude-opus-5'].metered.requests === 1 && day['claude-opus-5'].metered.inputTokens === 7);
  check('the next UTC day is its own key', f.days['2026-09-12']['gpt-5.6-terra'].covered.requests === 1);
  check('since moved back to the first record', f.since === new Date(T).toISOString(), f.since);
  check('dayKey is UTC', dayKey(Date.parse('2026-09-11T23:59:59Z')) === '2026-09-11' && dayKey(Date.parse('2026-09-12T00:00:00Z')) === '2026-09-12');
}

header('prune: the oldest days roll off past the cap');
{
  const f = emptyLedger(T);
  for (let i = 0; i < LEDGER_MAX_DAYS + 5; i++) addToLedger(f, rec({ timestamp: T - i * 86_400_000 }));
  check(`${LEDGER_MAX_DAYS} days kept, the 5 oldest dropped`, Object.keys(f.days).length === LEDGER_MAX_DAYS && !f.days[dayKey(T - (LEDGER_MAX_DAYS + 4) * 86_400_000)] && f.days[dayKey(T)]);
  const g = emptyLedger(T);
  addToLedger(g, rec()); addToLedger(g, rec({ timestamp: T - 86_400_000 })); addToLedger(g, rec({ timestamp: T - 2 * 86_400_000 }));
  pruneLedger(g, 2);
  check('pruneLedger(maxDays) keeps the newest', Object.keys(g.days).sort().join(',') === `${dayKey(T - 86_400_000)},${dayKey(T)}`);
}

header('parseLedger: tolerant of junk rows, strict about the envelope');
{
  const f = emptyLedger(T); addToLedger(f, rec());
  const rt = parseLedger(JSON.stringify(f));
  check('round-trips', JSON.stringify(rt) === JSON.stringify(f));
  const junk = { version: LEDGER_VERSION, since: 'garbage', days: {
    '2026-09-11': { 'claude-opus-5': { covered: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 }, metered: { requests: 'x' } }, 'bad': 'row', 'empty': {} },
    'not-a-day': { 'claude-opus-5': { covered: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 } } },
    '2026-09-10': { 'claude-opus-5': { covered: { requests: -1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 } } },
  } };
  const p = parseLedger(JSON.stringify(junk));
  check('keeps the good cell, drops the malformed metered cell, bad rows, bad day keys, negative counts',
    Object.keys(p.days).join(',') === '2026-09-11' && Object.keys(p.days['2026-09-11']).join(',') === 'claude-opus-5' && p.days['2026-09-11']['claude-opus-5'].metered === undefined && p.days['2026-09-11']['claude-opus-5'].covered.requests === 1, JSON.stringify(p));
  check('an unparseable since becomes now-ish, not NaN', !Number.isNaN(Date.parse(p.since)));
  let threw = null;
  try { parseLedger(JSON.stringify({ version: 99, days: {} })); } catch (e) { threw = e.message; }
  check('wrong version throws', threw === 'not a dario ledger', threw);
  try { threw = null; parseLedger('{"hello":1}'); } catch (e) { threw = e.message; }
  check('not a ledger throws', threw === 'not a dario ledger', threw);
}

header('summarizeLedger: priced at the day, split by provider, trailing windows');
{
  const f = emptyLedger(T);
  // Opus 5 on Sept 11: 1k in, 500 out, 20k cache read, 2k cache write → at $5/$25/$0.5/$6.25 per 1M
  addToLedger(f, rec());
  // Same day, API-keyed: metered, must not count as saved.
  addToLedger(f, rec({ claim: 'api', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  // 8 days ago, ChatGPT: 1M output tokens on terra → $12
  addToLedger(f, rec({ model: 'gpt-5.6-terra', claim: 'chatgpt_subscription', timestamp: T - 8 * 86_400_000, inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  // 40 days ago, Sonnet 5: 1M input → $2
  addToLedger(f, rec({ model: 'claude-sonnet-5', timestamp: T - 40 * 86_400_000, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  const s = summarizeLedger(f, '/tmp/ledger.json', T);
  const opus = (1000 * 5 + 500 * 25 + 20000 * 0.5 + 2000 * 6.25) / 1e6;  // 0.04
  check('apiEquivalentCost = opus + terra + sonnet covered rows', near(s.apiEquivalentCost, opus + 12 + 2, 1e-4), s.apiEquivalentCost);
  const tiny = emptyLedger(T); addToLedger(tiny, rec({ model: 'gpt-5.6-luna', claim: 'chatgpt_subscription', inputTokens: 13, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  check('millionths survive the rounding (13 in + 5 out on luna = $0.0000086, live 2026-09-12)', summarizeLedger(tiny, 'p', T).apiEquivalentCost === 0.000009, summarizeLedger(tiny, 'p', T).apiEquivalentCost);
  check('meteredCost = the API-keyed 1M input at $5', s.meteredCost === 5, s.meteredCost);
  check('requests counts both buckets; days counts distinct days', s.requests === 4 && s.days === 3);
  check('perProvider: anthropic vs openai', near(s.perProvider.anthropic.apiEquivalentCost, opus + 2, 1e-4) && s.perProvider.openai.apiEquivalentCost === 12 && s.perProvider.openai.requests === 1);
  check('perModel carries provider, tokens and both costs', s.perModel['claude-opus-5'].provider === 'anthropic' && s.perModel['claude-opus-5'].meteredCost === 5 && near(s.perModel['claude-opus-5'].apiEquivalentCost, opus, 1e-4) && s.perModel['gpt-5.6-terra'].provider === 'openai' && s.perModel['gpt-5.6-terra'].outputTokens === 1_000_000);
  check('covered tokens exclude the metered row', s.tokens.input === 1000 + 1_000_000 && s.tokens.output === 500 + 1_000_000 && s.tokens.cacheRead === 20000, JSON.stringify(s.tokens));
  check('recent: today = opus only; 7d = same (terra is 8 days back); 30d adds terra; sonnet at 40d in none', near(s.recent.today, opus, 1e-4) && near(s.recent.last7d, opus, 1e-4) && near(s.recent.last30d, opus + 12, 1e-4), JSON.stringify(s.recent));
  check('since and path pass through', s.since === f.since && s.path === '/tmp/ledger.json');
  const empty = summarizeLedger(emptyLedger(T), 'p', T);
  check('an empty ledger summarizes to zeros', empty.apiEquivalentCost === 0 && empty.requests === 0 && empty.days === 0 && Object.keys(empty.perModel).length === 0);
}

header('presentation: formatUsd, model names, the text block, the card');
{
  check('formatUsd scales its precision', formatUsd(0) === '$0' && formatUsd(0.0000086) === '<$0.0001' && formatUsd(0.0042) === '$0.0042' && formatUsd(0.05) === '$0.05' && formatUsd(3.14159) === '$3.14' && formatUsd(1234.5) === '$1,235');
  check('shortModelName', shortModelName('claude-opus-5') === 'Opus 5' && shortModelName('claude-sonnet-4-6') === 'Sonnet 4.6' && shortModelName('claude-haiku-4-5[1m]') === 'Haiku 4.5[1m]' && shortModelName('claude-haiku-4-5-20251001') === 'Haiku 4.5' && shortModelName('gpt-5.6-terra') === 'gpt-5.6-terra');
  const f = emptyLedger(T);
  addToLedger(f, rec({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  addToLedger(f, rec({ model: 'gpt-5.6-terra', claim: 'chatgpt_subscription', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  addToLedger(f, rec({ claim: 'api', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  const s = summarizeLedger(f, 'p', T);
  const lines = formatLedgerSummary(s);
  const text = lines.join('\n');
  check('headline names the total, the day count and the request count', lines[0].includes('since 2026-09-11, 1 day, 3 requests') && lines[1].includes('$32.00 would have been billed on the metered API'), text);
  check('one row per provider with its models, biggest first', lines[2].trim().startsWith('Claude') && lines[2].includes('$30.00') && lines[2].includes('Opus 5 $30.00') && lines[3].trim().startsWith('ChatGPT') && lines[3].includes('gpt-5.6-terra $2.00'), text);
  check('trailing windows and the metered line', text.includes('Today $32.00 · Last 7d $32.00 · Last 30d $32.00') && text.includes('Paid per token on top (API key / extra usage): $5.00'), text);
  const noMetered = formatLedgerSummary(summarizeLedger((() => { const g = emptyLedger(T); addToLedger(g, rec()); return g; })(), 'p', T));
  check('no metered line when nothing was metered', !noMetered.join('\n').includes('Paid per token'));
  const svg = renderLedgerCard(s);
  check('the card is one SVG with the number, both providers and the meta line', svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.includes('>$32.00<') && svg.includes('Claude $30.00   ·   ChatGPT $2.00') && svg.includes('3 requests  ·  since 2026-09-11  ·  1 day') && svg.includes('>dario<'), svg.slice(0, 300));
  const evil = summarizeLedger(f, 'p', T); evil.perProvider.openai.requests = 1; evil.since = '<script>alert(1)</script>';
  check('template-sourced text is escaped', !renderLedgerCard(evil).includes('<script>') && renderLedgerCard(evil).includes('&lt;script&gt;'));
}

header('paths: default port → ledger.json, other ports → ledger-<port>.json, env override');
{
  check('ledgerPathFor', ledgerPathFor(3456, '/h').replace(/\\/g, '/') === '/h/.dario/ledger.json' && ledgerPathFor(3999, '/h').replace(/\\/g, '/') === '/h/.dario/ledger-3999.json');
  check('DARIO_LEDGER_PATH wins', resolveLedgerPath(3456, { DARIO_LEDGER_PATH: '/x/l.json' }) === '/x/l.json' && resolveLedgerPath(3999, { DARIO_LEDGER_PATH: '  ' }).endsWith('ledger-3999.json'));
}

header('Ledger class: open fresh, debounced flush, reopen, corrupt file moved aside');
{
  const dir = await mkdtemp(join(tmpdir(), 'dario-ledger-'));
  const path = join(dir, 'nested', 'ledger.json');
  const logs = [];
  const l = await Ledger.open(path, (line) => logs.push(line));
  check('a missing file opens empty', l.summary(T).requests === 0 && l.path === path);
  check('add counts and schedules a write', l.add(rec()) === true && l.add(rec({ status: 429 })) === false);
  const before = await readLedgerFile(path);
  check('nothing on disk before the debounce fires', before.file === null && before.error === undefined);
  await sleep(LEDGER_FLUSH_DELAY_MS + 400);
  const after = await readLedgerFile(path);
  check('the file appears after the debounce, directory created', after.file !== null && after.file.days['2026-09-11']['claude-opus-5'].covered.requests === 1, JSON.stringify(after));
  l.add(rec());
  await l.close();
  const closed = await readLedgerFile(path);
  check('close() flushes what the debounce still held', closed.file.days['2026-09-11']['claude-opus-5'].covered.requests === 2);
  check('after close, add is refused', l.add(rec()) === false);
  const l2 = await Ledger.open(path);
  check('reopening sees the same totals — the number survives a restart', l2.summary(T).requests === 2 && l2.summary(T).since === closed.file.since);
  check('snapshot is a copy', (() => { const s = l2.snapshot(); s.days = {}; return l2.summary(T).requests === 2; })());
  check('no temp files left behind', (await readdir(join(dir, 'nested'))).join(',') === 'ledger.json');

  await writeFile(path, '{ this is not json');
  const l3 = await Ledger.open(path, (line) => logs.push(line));
  const files = await readdir(join(dir, 'nested'));
  check('a corrupt file is moved aside, not overwritten, and logged', l3.summary(T).requests === 0 && files.some((f) => f.startsWith('ledger.json.corrupt-')) && !files.includes('ledger.json') && logs.some((m) => m.includes('moved aside')), files.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

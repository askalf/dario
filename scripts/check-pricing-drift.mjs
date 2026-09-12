#!/usr/bin/env node
/**
 * Pricing drift watcher.
 *
 * Diffs dario's PRICING table (src/analytics.ts) against Anthropic's published
 * model-pricing table and reports any rate that has moved.
 *
 * WHY THIS EXISTS (#1048). PRICING encodes external facts with no natural
 * expiry. An entry is correct when written, has a passing test, and then goes
 * silently wrong the moment Anthropic changes a price — no error, no failing
 * test, nothing in the output to suggest the number moved. It has already
 * happened twice:
 *
 *   - Sonnet 5's increase to $3/$15 was cancelled and $2/$10 made permanent,
 *     but the dated cutover stayed in the table. From 2026-09-01 every Sonnet 5
 *     record would have priced 50% high (#1047).
 *   - Haiku 4.5 carried Haiku 3.5's rates ($0.80/$4 instead of $1/$5) — found
 *     by writing this watcher.
 *
 * The repo already treats every other external fact this way: cc-drift-watch,
 * cc-drift-template-watch, sdk-drift-watch, npm-drift-watch. Pricing was the
 * one that fed a user-visible number and had nothing watching it.
 *
 * FAILURE MODE IS THE DESIGN POINT. A watcher that silently stops matching is
 * worse than no watcher — it reports "aligned" forever and the first anyone
 * hears is the next wrong invoice. So every way of NOT knowing exits 2, never
 * 0: network failure, a missing table, a renamed column, or an implausibly
 * small parse. Exit 2 is "could not determine", which the workflow treats as a
 * skipped run rather than as clean.
 *
 * Exit codes: 0 = aligned, 1 = drift, 2 = could not fetch (transient — a
 * warning), 3 = fetched but could not read (the page's shape changed — the
 * watcher is blind until someone looks, so the workflow files it).
 * JSON report to stdout in all cases.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Fetch the `.md` variant, not the human page: the HTML is ~1.1MB of app shell
// with the table buried in it, while this serves ~43KB of text/markdown. The
// human URL is reported in the issue so a reader has somewhere to click.
const SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const HUMAN_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

// OpenAI's page has the same `.md` route (per its own llms.txt note). This
// feeds OPENAI_PRICING — the rates behind every ChatGPT-leg row in the ledger
// (v6.6) — which shipped unwatched; a table written from the page one day
// is exactly what this file exists to distrust.
const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/pricing.md';
const OPENAI_HUMAN_SOURCE = 'https://developers.openai.com/api/docs/pricing';

/**
 * Column header -> the PRICING field it feeds. Matched by NAME, never by
 * position: a column reorder upstream would otherwise silently map cache-read
 * prices onto cache-write fields and report "aligned".
 *
 * Names are compared through `headerKey`: lower-cased, `&` read as `and`,
 * whitespace collapsed. On 2026-09-02 Anthropic's column went from "Cache
 * hits & refreshes" to "Cache hits and refreshes" and this watcher spent ten
 * days answering "could not determine" — a warning in a workflow log nobody
 * reads — which is the silent-stop failure its own header warns about. The
 * workflow now files that case too (exit 3, below).
 */
const COLUMNS = {
  'base input tokens': 'input',
  'output tokens': 'output',
  'cache hits and refreshes': 'cacheRead',
  '5m cache writes': 'cacheCreate',
};

/** A table header cell, normalised for matching against COLUMNS / OPENAI_COLUMNS. */
export function headerKey(cell) {
  return String(cell).toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
}

/**
 * OpenAI's standard table, column header -> field. Matched by NAME like the
 * Anthropic one. "Short context" is the <272K tier — the one every codex
 * request dario serves falls in; the long-context premium is not modelled.
 * A `-` in the cache-writes column means no separate write price, which is
 * what OPENAI_PRICING encodes as cacheCreate = input.
 */
const OPENAI_COLUMNS = {
  'short context input': 'input',
  'short context cached input': 'cacheRead',
  'short context cache writes': 'cacheCreate',
  'short context output': 'output',
};

/**
 * A sanity floor on the PUBLISHED table, not a statement about dario. If a
 * parse yields fewer rows than this, the shape changed and a "clean" verdict
 * would be worthless — refuse rather than guess.
 *
 * Deliberately NOT derived from how many models dario prices: those two
 * numbers happen to be close today, and tying them together would silently
 * turn this into "did we parse at least as many as we price", which is a
 * different and much weaker check.
 */
const MIN_PUBLISHED_ROWS = 8;

/**
 * "Claude Opus 4.8" -> "claude-opus-4-8". Strips the trailing markdown link
 * some rows carry ("Claude Opus 4.1 ([retired, …](…))") before normalizing.
 */
export function modelIdFromDisplayName(cell) {
  const name = String(cell)
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '')  // ([text](url))
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')      // [text](url)
    .replace(/\*+/g, '')
    .trim();
  if (!/^claude /i.test(name)) return null;
  return name.toLowerCase().replace(/[\s.]+/g, '-').replace(/-+$/, '');
}

/**
 * "$12.50 / MTok" -> 12.5. Returns null when the cell is not a price. A
 * trailing footnote marker ("$0.25 / MTok1" — the page's superscript "1"
 * flattened into the markdown) is tolerated; the unit itself is not
 * negotiable.
 */
export function priceFromCell(cell) {
  const m = /^\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok(?:\s*\*?\d)?$/i.exec(String(cell).trim());
  return m ? Number(m[1]) : null;
}

/**
 * Pure parse of the published markdown into { modelId: {input, output,
 * cacheRead, cacheCreate} }. Throws on anything that would make a silent
 * wrong answer possible — the caller turns that into exit 2.
 */
export function parsePricingTable(markdown) {
  const lines = String(markdown).split('\n');

  // The model table is the first one carrying every column we need. Scanning
  // for it by header content rather than by position means an added section
  // above it does not shift us onto the batch-pricing or fast-mode table,
  // both of which are also "Model | … | $x / MTok" shaped.
  let headerIdx = -1;
  let colIndex = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    const cells = lines[i].split('|').map(headerKey);
    const found = {};
    for (const [header, field] of Object.entries(COLUMNS)) {
      const at = cells.indexOf(header);
      if (at !== -1) found[field] = at;
    }
    if (Object.keys(found).length === Object.keys(COLUMNS).length) {
      headerIdx = i;
      colIndex = found;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      `could not find a pricing table carrying all of: ${Object.keys(COLUMNS).join(', ')} ` +
      '— the published table shape has probably changed',
    );
  }

  const rates = {};
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) {
      if (Object.keys(rates).length > 0) break;  // table ended
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;  // separator row
    const cells = line.split('|').map((c) => c.trim());
    const id = modelIdFromDisplayName(cells[1] ?? '');
    if (!id) continue;
    const rate = {};
    let ok = true;
    for (const [field, at] of Object.entries(colIndex)) {
      const v = priceFromCell(cells[at] ?? '');
      if (v === null) { ok = false; break; }
      rate[field] = v;
    }
    if (ok) rates[id] = rate;
  }

  if (Object.keys(rates).length < MIN_PUBLISHED_ROWS) {
    throw new Error(
      `parsed only ${Object.keys(rates).length} model rows (expected >= ${MIN_PUBLISHED_ROWS}) ` +
      '— refusing to report "aligned" from a parse this thin',
    );
  }
  return rates;
}

/** "$12.50" -> 12.5; "-" -> null (no price in that cell); anything else -> undefined. */
export function openAiPriceFromCell(cell) {
  const t = String(cell).trim();
  if (t === '-' || t === '—') return null;
  const m = /^\$\s*([0-9]+(?:\.[0-9]+)?)$/.exec(t);
  return m ? Number(m[1]) : undefined;
}

/** "gpt-5.5 (<272K context length)" -> "gpt-5.5". Anything not gpt-/o-shaped -> null. */
export function openAiModelIdFromCell(cell) {
  const id = String(cell).replace(/\([^)]*\)/g, '').replace(/\*+/g, '').trim().toLowerCase();
  return /^(gpt-|o\d|codex)/.test(id) ? id : null;
}

/**
 * Pure parse of OpenAI's pricing markdown into { modelId: {input, output,
 * cacheRead, cacheCreate} } from the STANDARD table only. Batch and fast-mode
 * tables carry the same headers, so the standard one is found by the heading
 * above it, not by header content alone. Throws on anything that would make
 * a silent wrong answer possible.
 */
export function parseOpenAiPricingTable(markdown) {
  const lines = String(markdown).split('\n');
  const headingIdx = lines.findIndex((l) => /^#{2,4}\s+standard pricing/i.test(l.trim()));
  if (headingIdx === -1) {
    throw new Error('could not find the "Standard pricing" heading — the published page shape has probably changed');
  }
  let headerIdx = -1;
  let colIndex = null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i].trim())) break;  // the next section: no table under this heading
    if (!lines[i].includes('|')) continue;
    const cells = lines[i].split('|').map(headerKey);
    const found = {};
    for (const [header, field] of Object.entries(OPENAI_COLUMNS)) {
      const at = cells.indexOf(header);
      if (at !== -1) found[field] = at;
    }
    if (Object.keys(found).length === Object.keys(OPENAI_COLUMNS).length) { headerIdx = i; colIndex = found; break; }
    throw new Error(`the standard table no longer carries all of: ${Object.keys(OPENAI_COLUMNS).join(', ')}`);
  }
  if (headerIdx === -1) throw new Error('no table under the "Standard pricing" heading');

  const rates = {};
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) {
      if (Object.keys(rates).length > 0) break;
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    const id = openAiModelIdFromCell(cells[1] ?? '');
    if (!id) continue;
    const rate = {};
    let ok = true;
    for (const [field, at] of Object.entries(colIndex)) {
      const v = openAiPriceFromCell(cells[at] ?? '');
      if (v === undefined) { ok = false; break; }
      rate[field] = v;
    }
    if (!ok || rate.input === null || rate.output === null) continue;  // a row without a base price
    if (rate.cacheRead === null) rate.cacheRead = rate.input;
    if (rate.cacheCreate === null) rate.cacheCreate = rate.input;
    rates[id] = rate;
  }
  if (Object.keys(rates).length < MIN_PUBLISHED_ROWS) {
    throw new Error(
      `parsed only ${Object.keys(rates).length} OpenAI model rows (expected >= ${MIN_PUBLISHED_ROWS}) ` +
      '— refusing to report "aligned" from a parse this thin',
    );
  }
  return rates;
}

/**
 * Compare dario's table against the published one. Only models dario actually
 * prices are checked; the published table listing models dario does not model
 * is not drift. A model dario prices that has VANISHED upstream is reported —
 * it usually means a rename, and a stale key silently falls through to the
 * unknown-model fallback rate.
 */
export function diffPricing(ours, published) {
  const drift = [];
  for (const [id, mine] of Object.entries(ours)) {
    const theirs = published[id];
    if (!theirs) {
      drift.push({ model: id, field: '*', ours: 'priced', published: 'absent',
        note: 'not in the published table — renamed upstream, or retired' });
      continue;
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreate']) {
      if (typeof mine[field] !== 'number') continue;
      if (mine[field] !== theirs[field]) {
        drift.push({ model: id, field, ours: mine[field], published: theirs[field] });
      }
    }
  }
  return drift.sort((a, b) => a.model.localeCompare(b.model) || a.field.localeCompare(b.field));
}

/** The four rate fields, from an entry or from an `intro` block. */
function comparable(rate) {
  return {
    input: rate.input, output: rate.output,
    cacheRead: rate.cacheRead, cacheCreate: rate.cacheCreate,
  };
}

/**
 * Promotional windows that have LAPSED.
 *
 * This is the Sonnet 5 shape (#1047), and the reason it went unnoticed: the bug
 * was never in the standard rate, it was a dated `intro` block that outlived the
 * promotion it described.
 *
 * Comparing an intro RATE against the published standard would be worse than
 * useless — a promotional price differs from the standard price by definition,
 * so every entry carrying one would report drift forever and the issue would be
 * learned-ignored inside a week. That is how watchers die.
 *
 * What is genuinely checkable is the DATE. An `until` in the past means the
 * entry is either stale (the promotion ended and nobody removed the block) or
 * wrong (the promotion was made permanent and the block should have become the
 * standard rate — exactly what happened to Sonnet 5). Both need a human, and
 * both are invisible today.
 *
 * No entry carries an `intro` right now, so this is dormant by design: it exists
 * so the next promotional window is covered on arrival rather than after the
 * next incident.
 */
export function staleIntroWindows(pricing, nowMs) {
  const stale = [];
  for (const [id, entry] of Object.entries(pricing)) {
    if (!entry.intro || typeof entry.intro.until !== 'string') continue;
    const endsAt = Date.parse(`${entry.intro.until}T23:59:59.999Z`);
    if (!Number.isFinite(endsAt)) {
      stale.push({ model: id, field: 'intro.until', ours: entry.intro.until,
        published: 'unparseable',
        note: 'intro window carries an invalid `until` date, so it can never expire correctly' });
      continue;
    }
    if (endsAt < nowMs) {
      stale.push({ model: id, field: 'intro.until', ours: entry.intro.until,
        published: 'lapsed',
        note: 'promotional window has passed — remove the intro block, or promote its rate to standard if the promotion was made permanent' });
    }
  }
  return stale;
}

/** Fetch one published page as markdown, or throw with a reason that names the failure. */
async function fetchMarkdown(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const markdown = await res.text();
  // If the .md route ever starts serving the app shell, say so rather than
  // failing later with a confusing "table shape changed".
  if (/^\s*<!DOCTYPE/i.test(markdown)) throw new Error('got HTML, not markdown — the .md route may have moved');
  return markdown;
}

/**
 * One provider's check: { status: 'clean' | 'drift' | 'infra_error', ... }.
 * Network failure and an unparseable page are NOT drift — they are "could
 * not determine", and never a quiet "aligned".
 */
async function checkProvider(name, { source, humanSource, table, parse, extraDrift }) {
  const out = { provider: name, source: humanSource, modelsChecked: Object.keys(table).length };
  let markdown;
  try { markdown = await fetchMarkdown(source); }
  catch (err) { return { ...out, status: 'infra_error', kind: 'fetch', error: `could not fetch published pricing: ${err.message}` }; }
  let published;
  try { published = parse(markdown); }
  catch (err) { return { ...out, status: 'infra_error', kind: 'parse', error: `could not parse published pricing: ${err.message}` }; }
  const ours = Object.fromEntries(Object.entries(table).map(([id, e]) => [id, comparable(e)]));
  const drift = [...diffPricing(ours, published), ...(extraDrift ?? [])].map((d) => ({ provider: name, ...d }));
  return { ...out, modelsPublished: Object.keys(published).length, drift, status: drift.length === 0 ? 'clean' : 'drift' };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const report = { checkedAt: new Date().toISOString(), source: HUMAN_SOURCE, openaiSource: OPENAI_HUMAN_SOURCE };

  let PRICING, OPENAI_PRICING;
  try {
    // pathToFileURL, not a bare path: a Windows absolute path ("C:\…") is not
    // a valid ESM specifier and the loader rejects it as an unknown protocol.
    ({ PRICING, OPENAI_PRICING } = await import(pathToFileURL(resolve(join(here, '..', 'dist', 'analytics.js'))).href));
    if (!PRICING || typeof PRICING !== 'object') throw new Error('PRICING is not an object');
    if (!OPENAI_PRICING || typeof OPENAI_PRICING !== 'object') throw new Error('OPENAI_PRICING is not an object');
  } catch (err) {
    console.log(JSON.stringify({ ...report, status: 'infra_error',
      error: `could not load dist/analytics.js — run \`npm run build\` first: ${err.message}` }, null, 2));
    process.exit(2);
  }

  // A rate that no longer matches, and a promotional window that has lapsed,
  // are both "PRICING no longer describes reality" — one report, one exit code.
  const providers = [
    await checkProvider('anthropic', { source: SOURCE, humanSource: HUMAN_SOURCE, table: PRICING, parse: parsePricingTable, extraDrift: staleIntroWindows(PRICING, Date.now()) }),
    await checkProvider('openai', { source: OPENAI_SOURCE, humanSource: OPENAI_HUMAN_SOURCE, table: OPENAI_PRICING, parse: parseOpenAiPricingTable }),
  ];
  const drift = providers.flatMap((p) => p.drift ?? []);
  const undetermined = providers.filter((p) => p.status === 'infra_error');
  const blind = undetermined.some((p) => p.kind === 'parse');
  // Drift anywhere is actionable and wins. A page that was fetched but not
  // understood is next: the watcher is blind on that provider until someone
  // looks, and that is a finding, not a flake. A fetch failure alone is.
  const status = drift.length > 0 ? 'drift' : blind ? 'blind' : undetermined.length > 0 ? 'infra_error' : 'clean';
  console.log(JSON.stringify({
    ...report,
    modelsChecked: providers.reduce((n, p) => n + p.modelsChecked, 0),
    modelsPublished: providers.reduce((n, p) => n + (p.modelsPublished ?? 0), 0),
    providers,
    drift,
    ...(undetermined.length > 0 ? { error: undetermined.map((p) => `${p.provider}: ${p.error}`).join('; ') } : {}),
    status,
  }, null, 2));
  process.exit(status === 'drift' ? 1 : status === 'blind' ? 3 : status === 'infra_error' ? 2 : 0);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) await main();

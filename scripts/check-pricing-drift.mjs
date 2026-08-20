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
 * Exit codes: 0 = aligned, 1 = drift, 2 = could not determine.
 * JSON report to stdout in all cases.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Fetch the `.md` variant, not the human page: the HTML is ~1.1MB of app shell
// with the table buried in it, while this serves ~43KB of text/markdown. The
// human URL is reported in the issue so a reader has somewhere to click.
const SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const HUMAN_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

/**
 * Column header -> the PRICING field it feeds. Matched by NAME, never by
 * position: a column reorder upstream would otherwise silently map cache-read
 * prices onto cache-write fields and report "aligned".
 */
const COLUMNS = {
  'base input tokens': 'input',
  'output tokens': 'output',
  'cache hits & refreshes': 'cacheRead',
  '5m cache writes': 'cacheCreate',
};

/** Fewer rows than this means the table shape changed. Refuse rather than guess. */
const MIN_PLAUSIBLE_ROWS = 8;

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

/** "$12.50 / MTok" -> 12.5. Returns null when the cell is not a price. */
export function priceFromCell(cell) {
  const m = /^\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok$/i.exec(String(cell).trim());
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
    const cells = lines[i].split('|').map((c) => c.trim().toLowerCase());
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

  if (Object.keys(rates).length < MIN_PLAUSIBLE_ROWS) {
    throw new Error(
      `parsed only ${Object.keys(rates).length} model rows (expected >= ${MIN_PLAUSIBLE_ROWS}) ` +
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

/** Flatten a PricingEntry to the four comparable fields (drops any `intro`). */
function comparable(entry) {
  return {
    input: entry.input, output: entry.output,
    cacheRead: entry.cacheRead, cacheCreate: entry.cacheCreate,
  };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const report = { checkedAt: new Date().toISOString(), source: HUMAN_SOURCE };

  let PRICING;
  try {
    // pathToFileURL, not a bare path: a Windows absolute path ("C:\…") is not
    // a valid ESM specifier and the loader rejects it as an unknown protocol.
    ({ PRICING } = await import(pathToFileURL(resolve(join(here, '..', 'dist', 'analytics.js'))).href));
    if (!PRICING || typeof PRICING !== 'object') throw new Error('PRICING is not an object');
  } catch (err) {
    console.log(JSON.stringify({ ...report, status: 'infra_error',
      error: `could not load dist/analytics.js — run \`npm run build\` first: ${err.message}` }, null, 2));
    process.exit(2);
  }

  let markdown;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markdown = await res.text();
    // If the .md route ever starts serving the app shell, say so rather than
    // failing later with a confusing "table shape changed".
    if (/^\s*<!DOCTYPE/i.test(markdown)) {
      throw new Error('got HTML, not markdown — the .md route may have moved');
    }
  } catch (err) {
    // Network failure is NOT drift. Exit 2 so a flaky fetch never churns the
    // issue or, worse, reports "aligned" because nothing came back.
    console.log(JSON.stringify({ ...report, status: 'infra_error',
      error: `could not fetch published pricing: ${err.message}` }, null, 2));
    process.exit(2);
  }

  let published;
  try {
    published = parsePricingTable(markdown);
  } catch (err) {
    console.log(JSON.stringify({ ...report, status: 'infra_error',
      error: `could not parse published pricing: ${err.message}` }, null, 2));
    process.exit(2);
  }

  const ours = Object.fromEntries(
    Object.entries(PRICING).map(([id, e]) => [id, comparable(e)]),
  );
  const drift = diffPricing(ours, published);

  console.log(JSON.stringify({
    ...report,
    modelsChecked: Object.keys(ours).length,
    modelsPublished: Object.keys(published).length,
    drift,
    status: drift.length === 0 ? 'clean' : 'drift',
  }, null, 2));
  process.exit(drift.length === 0 ? 0 : 1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) await main();

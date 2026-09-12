/**
 * The ledger — what the traffic dario has served would have cost on the
 * metered API, kept across restarts.
 *
 * /analytics is a rolling in-memory window: it forgets on every restart and
 * caps at 10k records, so the one number a subscription user actually wants
 * — "what has this saved me" — was never answerable past the last few hours.
 * The ledger keeps one small row per (UTC day, model, bucket): a request
 * count and the four token buckets. It never stores a price. Rows are priced
 * at read time through `costOfTokens` at the day's own timestamp, so a
 * pricing correction (#1047, #1048 — both happened) reprices history instead
 * of freezing the wrong number in.
 *
 * Two buckets per row. `covered` is traffic a subscription paid for — the
 * API-equivalent cost of that is the headline, the invoice that never
 * arrived. `metered` is traffic billed per token anyway (an API key, or
 * Anthropic's paid `extra_usage` overage) — that money was spent, and it is
 * reported separately rather than counted as saved. Only 2xx responses
 * count: a 429 carries no tokens and a 5xx bills nothing.
 *
 * On disk: `~/.dario/ledger.json` for the default port, `ledger-<port>.json`
 * for any other, so two instances sharing a home (the box's live-test rig
 * runs one on :3999 next to production) do not overwrite each other's file.
 * Writes are debounced and durable (`durableWriteFile`); the shutdown hook
 * flushes what the debounce still holds, so at most the last few seconds
 * before a SIGKILL are lost.
 */

import { readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { durableWriteFile } from './durable-write.js';
import { billingBucketFromClaim, costOfTokens, providerOfModel, type PricingProvider, type RequestRecord } from './analytics.js';

export const LEDGER_VERSION = 1;
/** The default proxy port; any other port gets its own ledger file. */
const DEFAULT_PORT = 3456;
/** Days kept before the oldest roll off — two years at one row per model per day. */
export const LEDGER_MAX_DAYS = 730;
/** How long after the last record the file is rewritten. */
export const LEDGER_FLUSH_DELAY_MS = 3_000;

export type LedgerBucket = 'covered' | 'metered';

export interface LedgerCell {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export type LedgerRow = Partial<Record<LedgerBucket, LedgerCell>>;

export interface LedgerFile {
  version: number;
  /** ISO timestamp of the first record the ledger ever saw. */
  since: string;
  /** ISO timestamp of the last write. */
  updated: string;
  /** `YYYY-MM-DD` (UTC) → model id → per-bucket totals. */
  days: Record<string, Record<string, LedgerRow>>;
}

export interface LedgerModelSummary {
  provider: PricingProvider;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** API-equivalent cost of this model's covered traffic, USD. */
  apiEquivalentCost: number;
  /** What this model's metered traffic cost at list price, USD. */
  meteredCost: number;
}

export interface LedgerSummary {
  /** Where the file lives — so `dario usage` can say what it read. */
  path: string;
  since: string;
  /** Distinct UTC days with traffic. */
  days: number;
  /** Covered + metered, 2xx only. */
  requests: number;
  /**
   * The headline: what subscription-covered traffic would have been billed
   * on the metered API at today's list prices, USD.
   */
  apiEquivalentCost: number;
  /** What metered traffic (API key, paid overage) actually cost at list price, USD. */
  meteredCost: number;
  /** Covered token totals. */
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  perProvider: Record<PricingProvider, { requests: number; apiEquivalentCost: number }>;
  perModel: Record<string, LedgerModelSummary>;
  /** apiEquivalentCost over the trailing windows, UTC days. */
  recent: { today: number; last7d: number; last30d: number };
}

export function ledgerPathFor(port: number, home: string = homedir()): string {
  return join(home, '.dario', port === DEFAULT_PORT ? 'ledger.json' : `ledger-${port}.json`);
}

/**
 * `DARIO_LEDGER_PATH` names the file; `DARIO_LEDGER=0` (or `--no-ledger`)
 * turns the ledger off. Off, /analytics reports `lifetime: null` and the
 * usage command says so.
 */
export function resolveLedgerPath(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DARIO_LEDGER_PATH'];
  return explicit && explicit.trim().length > 0 ? explicit.trim() : ledgerPathFor(port);
}

export function ledgerDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['0', 'false', 'no', 'off'].includes((env['DARIO_LEDGER'] ?? '').toLowerCase());
}

const emptyCell = (): LedgerCell => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });

export function emptyLedger(now: number = Date.now()): LedgerFile {
  const iso = new Date(now).toISOString();
  return { version: LEDGER_VERSION, since: iso, updated: iso, days: {} };
}

/** UTC calendar day of an epoch-ms timestamp. */
export function dayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Noon UTC of a day key — inside any intro window that ends that day. */
function dayMs(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}

/**
 * Which bucket a record lands in, or null when it should not be counted.
 * `api` and `extra_usage` are metered; every subscription claim, the codex
 * claim, and an absent claim on a 2xx (stream aborts, api-key mode without
 * the header) are covered — the request was served, and nothing says it was
 * billed per token.
 */
export function ledgerBucketFor(record: Pick<RequestRecord, 'status' | 'claim'>): LedgerBucket | null {
  if (record.status < 200 || record.status >= 300) return null;
  const bucket = billingBucketFromClaim(record.claim);
  return bucket === 'api' || bucket === 'extra_usage' ? 'metered' : 'covered';
}

function isCell(v: unknown): v is LedgerCell {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens']
    .every((k) => typeof c[k] === 'number' && Number.isFinite(c[k] as number) && (c[k] as number) >= 0);
}

/**
 * Parse a ledger file's text, keeping only well-formed rows. A file that is
 * not a ledger at all throws; the caller moves it aside and starts fresh.
 */
export function parseLedger(text: string): LedgerFile {
  const raw = JSON.parse(text) as Partial<LedgerFile>;
  if (!raw || typeof raw !== 'object' || raw.version !== LEDGER_VERSION || !raw.days || typeof raw.days !== 'object') {
    throw new Error('not a dario ledger');
  }
  const days: LedgerFile['days'] = {};
  for (const [day, models] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !models || typeof models !== 'object') continue;
    const clean: Record<string, LedgerRow> = {};
    for (const [model, row] of Object.entries(models as Record<string, LedgerRow>)) {
      if (!row || typeof row !== 'object') continue;
      const r: LedgerRow = {};
      if (isCell(row.covered)) r.covered = { ...row.covered };
      if (isCell(row.metered)) r.metered = { ...row.metered };
      if (r.covered || r.metered) clean[model] = r;
    }
    if (Object.keys(clean).length > 0) days[day] = clean;
  }
  const since = typeof raw.since === 'string' && !Number.isNaN(Date.parse(raw.since)) ? raw.since : new Date().toISOString();
  const updated = typeof raw.updated === 'string' && !Number.isNaN(Date.parse(raw.updated)) ? raw.updated : since;
  return { version: LEDGER_VERSION, since, updated, days };
}

/** Add one record's tokens to the file in place. Returns false when it was not counted. */
export function addToLedger(file: LedgerFile, record: RequestRecord): boolean {
  const bucket = ledgerBucketFor(record);
  if (!bucket) return false;
  const day = dayKey(record.timestamp);
  const model = record.model || 'unknown';
  const models = (file.days[day] ??= {});
  const row = (models[model] ??= {});
  const cell = (row[bucket] ??= emptyCell());
  cell.requests += 1;
  cell.inputTokens += record.inputTokens;
  cell.outputTokens += record.outputTokens;
  cell.cacheReadTokens += record.cacheReadTokens;
  cell.cacheCreateTokens += record.cacheCreateTokens;
  if (Date.parse(file.since) > record.timestamp) file.since = new Date(record.timestamp).toISOString();
  pruneLedger(file);
  return true;
}

/** Drop the oldest days past LEDGER_MAX_DAYS. */
export function pruneLedger(file: LedgerFile, maxDays: number = LEDGER_MAX_DAYS): void {
  const days = Object.keys(file.days).sort();
  for (const day of days.slice(0, Math.max(0, days.length - maxDays))) delete file.days[day];
}

// Six places, not the window's four: a handful of gpt-5.6-luna requests is
// real money in the millionths and "$0 for 2 requests" reads as free.
const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export function summarizeLedger(file: LedgerFile, path: string, now: number = Date.now()): LedgerSummary {
  const today = dayKey(now);
  const cutoff7 = dayKey(now - 6 * 86_400_000);
  const cutoff30 = dayKey(now - 29 * 86_400_000);
  const perModel: Record<string, LedgerModelSummary> = {};
  const perProvider: LedgerSummary['perProvider'] = {
    anthropic: { requests: 0, apiEquivalentCost: 0 },
    openai: { requests: 0, apiEquivalentCost: 0 },
  };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let requests = 0;
  let covered = 0;
  let metered = 0;
  const recent = { today: 0, last7d: 0, last30d: 0 };

  for (const [day, models] of Object.entries(file.days)) {
    const at = dayMs(day);
    for (const [model, row] of Object.entries(models)) {
      const m = (perModel[model] ??= {
        provider: providerOfModel(model), requests: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
        apiEquivalentCost: 0, meteredCost: 0,
      });
      if (row.covered) {
        const cost = costOfTokens(model, at, row.covered);
        covered += cost;
        m.apiEquivalentCost += cost;
        m.requests += row.covered.requests;
        m.inputTokens += row.covered.inputTokens;
        m.outputTokens += row.covered.outputTokens;
        m.cacheReadTokens += row.covered.cacheReadTokens;
        m.cacheCreateTokens += row.covered.cacheCreateTokens;
        tokens.input += row.covered.inputTokens;
        tokens.output += row.covered.outputTokens;
        tokens.cacheRead += row.covered.cacheReadTokens;
        tokens.cacheCreate += row.covered.cacheCreateTokens;
        perProvider[m.provider].requests += row.covered.requests;
        perProvider[m.provider].apiEquivalentCost += cost;
        requests += row.covered.requests;
        if (day === today) recent.today += cost;
        if (day >= cutoff7) recent.last7d += cost;
        if (day >= cutoff30) recent.last30d += cost;
      }
      if (row.metered) {
        const cost = costOfTokens(model, at, row.metered);
        metered += cost;
        m.meteredCost += cost;
        m.requests += row.metered.requests;
        requests += row.metered.requests;
      }
    }
  }
  for (const m of Object.values(perModel)) {
    m.apiEquivalentCost = round(m.apiEquivalentCost);
    m.meteredCost = round(m.meteredCost);
  }
  for (const p of Object.values(perProvider)) p.apiEquivalentCost = round(p.apiEquivalentCost);

  return {
    path,
    since: file.since,
    days: Object.keys(file.days).length,
    requests,
    apiEquivalentCost: round(covered),
    meteredCost: round(metered),
    tokens,
    perProvider,
    perModel,
    recent: { today: round(recent.today), last7d: round(recent.last7d), last30d: round(recent.last30d) },
  };
}

/**
 * Read a ledger file for display without a running proxy (`dario usage`
 * when the proxy is down). Missing file → null; unreadable → null with the
 * reason, never a throw.
 */
export async function readLedgerFile(path: string): Promise<{ file: LedgerFile | null; error?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { file: null } : { file: null, error: (err as Error).message };
  }
  try {
    return { file: parseLedger(text) };
  } catch (err) {
    return { file: null, error: (err as Error).message };
  }
}

export class Ledger {
  private file: LedgerFile;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(readonly path: string, file: LedgerFile, private readonly log: (line: string) => void) {
    this.file = file;
  }

  /**
   * Load the ledger at `path`, or start one. A file that cannot be parsed is
   * moved aside (`<path>.corrupt-<ts>`) rather than overwritten, so a bad
   * write never silently zeroes two years of history.
   */
  static async open(path: string, log: (line: string) => void = () => {}): Promise<Ledger> {
    const { file, error } = await readLedgerFile(path);
    if (file) return new Ledger(path, file, log);
    if (error) {
      const aside = `${path}.corrupt-${Date.now()}`;
      try { await rename(path, aside); } catch { /* best effort — the next flush overwrites */ }
      log(`[dario] ledger: could not read ${path} (${error}); moved aside to ${aside}, starting fresh`);
    }
    return new Ledger(path, emptyLedger(), log);
  }

  /** Count a request. Returns false when it was not ledger material. */
  add(record: RequestRecord): boolean {
    if (this.closed) return false;
    const counted = addToLedger(this.file, record);
    if (counted) this.scheduleFlush();
    return counted;
  }

  summary(now: number = Date.now()): LedgerSummary {
    return summarizeLedger(this.file, this.path, now);
  }

  /** The raw per-day table, for /analytics/ledger. */
  snapshot(): LedgerFile {
    return JSON.parse(JSON.stringify(this.file)) as LedgerFile;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, LEDGER_FLUSH_DELAY_MS);
    this.timer.unref();
  }

  /** Write now if anything changed. Serialized; a failure is logged, not thrown. */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.file.updated = new Date().toISOString();
    const text = JSON.stringify(this.file);
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await durableWriteFile(this.path, text, 0o600);
      } catch (err) {
        this.dirty = true;
        this.log(`[dario] ledger: write to ${this.path} failed: ${(err as Error).message}`);
      }
    });
    return this.writing;
  }

  /** Final flush for the shutdown hook. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Presentation — the number, formatted for a terminal and for a share card
// ─────────────────────────────────────────────────────────────────────────

export function formatUsd(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(usd >= 0.01 ? 2 : 4)}`;
}

/** `claude-opus-5` → `Opus 5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`, `gpt-5.6-terra` → `gpt-5.6-terra`. */
export function shortModelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[[^\]]*\])?$/i.exec(model);
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ?? ''}`;
}

const providerLabel: Record<PricingProvider, string> = { anthropic: 'Claude', openai: 'ChatGPT' };

/**
 * The block `dario usage` prints above the rolling window. Two-space indent
 * to match the rest of that command's output.
 */
export function formatLedgerSummary(s: LedgerSummary): string[] {
  const since = s.since.slice(0, 10);
  const lines: string[] = [];
  lines.push(`  API-equivalent spend (since ${since}, ${s.days} day${s.days === 1 ? '' : 's'}, ${s.requests.toLocaleString('en-US')} request${s.requests === 1 ? '' : 's'}):`);
  lines.push(`    ${formatUsd(s.apiEquivalentCost)} would have been billed on the metered API — covered by subscriptions`);
  const providers = (Object.entries(s.perProvider) as [PricingProvider, { requests: number; apiEquivalentCost: number }][])
    .filter(([, p]) => p.requests > 0)
    .sort((a, b) => b[1].apiEquivalentCost - a[1].apiEquivalentCost);
  for (const [provider, p] of providers) {
    const models = Object.entries(s.perModel)
      .filter(([, m]) => m.provider === provider && m.apiEquivalentCost > 0)
      .sort((a, b) => b[1].apiEquivalentCost - a[1].apiEquivalentCost)
      .slice(0, 4)
      .map(([id, m]) => `${shortModelName(id)} ${formatUsd(m.apiEquivalentCost)}`);
    lines.push(`      ${providerLabel[provider].padEnd(8)} ${formatUsd(p.apiEquivalentCost).padStart(9)}   ${p.requests.toLocaleString('en-US')} req${p.requests === 1 ? '' : 's'}${models.length > 0 ? `   (${models.join(' · ')})` : ''}`);
  }
  lines.push(`    Today ${formatUsd(s.recent.today)} · Last 7d ${formatUsd(s.recent.last7d)} · Last 30d ${formatUsd(s.recent.last30d)}`);
  if (s.meteredCost > 0) lines.push(`    Paid per token on top (API key / extra usage): ${formatUsd(s.meteredCost)}`);
  return lines;
}

const escapeXml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * A share card: one SVG, 640×320, dark, the number in the middle. Plain
 * system monospace so it renders the same in a README, a tweet screenshot
 * and an <img> tag with nothing to fetch.
 */
export function renderLedgerCard(s: LedgerSummary): string {
  const providers = (Object.entries(s.perProvider) as [PricingProvider, { requests: number; apiEquivalentCost: number }][])
    .filter(([, p]) => p.requests > 0)
    .sort((a, b) => b[1].apiEquivalentCost - a[1].apiEquivalentCost)
    .map(([provider, p]) => `${providerLabel[provider]} ${formatUsd(p.apiEquivalentCost)}`)
    .join('   ·   ');
  const since = s.since.slice(0, 10);
  const headline = formatUsd(s.apiEquivalentCost);
  const size = headline.length > 9 ? 56 : headline.length > 7 ? 68 : 80;
  const meta = `${s.requests.toLocaleString('en-US')} requests  ·  since ${since}  ·  ${s.days} day${s.days === 1 ? '' : 's'}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320" role="img" aria-label="${escapeXml(headline)} of API-equivalent usage covered by subscriptions through dario">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#db2777"/>
    </linearGradient>
    <clipPath id="card"><rect width="640" height="320" rx="20"/></clipPath>
  </defs>
  <rect width="640" height="320" rx="20" fill="#0a0a0f"/>
  <rect x="0" y="0" width="640" height="6" fill="url(#accent)" clip-path="url(#card)"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" fill="#e5e7eb">
    <text x="40" y="66" font-size="15" fill="#9ca3af" letter-spacing="2">API-EQUIVALENT SPEND · COVERED BY SUBSCRIPTIONS</text>
    <text x="40" y="160" font-size="${size}" font-weight="700" fill="#ffffff">${escapeXml(headline)}</text>
    <text x="40" y="200" font-size="17" fill="#d1d5db">would have been billed on the metered API</text>
    <text x="40" y="244" font-size="15" fill="#a78bfa">${escapeXml(providers)}</text>
    <text x="40" y="284" font-size="13" fill="#6b7280">${escapeXml(meta)}</text>
    <text x="600" y="284" font-size="13" fill="#6b7280" text-anchor="end">dario</text>
  </g>
</svg>
`;
}

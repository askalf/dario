/**
 * Reading the shadow-compare log.
 *
 * dario has written one JSON record per compared request since v6.0.0 and
 * shipped nothing to read them with. That gap is not cosmetic: a bake-off on
 * the box collected 919 records over a week, every one of them a failed
 * comparison, with the reason sitting inside the files (#1306). Nobody opened
 * them, because opening 919 JSON blobs is not a thing anyone does by hand.
 *
 * So the log gets a reader. `dario compare` answers the question the records
 * were collected for — which model is faster, which returns what you asked
 * for, how often either failed — and prints the skip reasons, so a comparison
 * that is not running says so on the first line instead of in file 700.
 *
 * Pure except for the directory read: the summary is computed from records the
 * caller supplies, so the shapes below are testable without a filesystem.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_COMPARE_DIR = join(homedir(), '.dario', 'compare');

/** One side of a comparison, as written by src/compare.ts. */
export interface CompareSideRecord {
  status: number | null;
  body: string;
  ms: number;
}

export interface CompareRecordShape {
  ts?: string;
  primaryModel?: string;
  comparedModel?: string;
  primary?: CompareSideRecord | null;
  compare?: CompareSideRecord | null;
  skipped?: string;
}

export interface ModelStats {
  model: string;
  calls: number;
  ok: number;
  /** Median latency in ms, or null when nothing recorded one. */
  medianMs: number | null;
  /** Responses whose text parsed as JSON — the thing an extraction caller wants. */
  json: number;
  avgChars: number;
}

export interface CompareSummary {
  records: number;
  /** Records carrying BOTH sides — the only ones that compare anything. */
  pairs: number;
  first: string | null;
  last: string | null;
  perModel: ModelStats[];
  /** Skip reason → count, most common first. */
  skips: Array<{ reason: string; count: number }>;
}

/**
 * The assistant text inside a recorded body, whatever it is wrapped in: an
 * Anthropic message, a legacy completion, or an SSE stream of text deltas.
 * Returns '' when there is nothing quotable — a caller measuring "did this
 * answer with JSON" wants the text, not the envelope.
 */
export function textOfBody(body: string | undefined | null): string {
  if (!body) return '';
  try {
    const j = JSON.parse(body) as { content?: Array<{ type?: string; text?: string }>; completion?: string };
    if (Array.isArray(j.content)) return j.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
    if (typeof j.completion === 'string') return j.completion;
  } catch { /* not JSON — an SSE stream, most likely */ }
  const deltas = [...String(body).matchAll(/"type"\s*:\s*"text_delta"\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")/g)];
  if (deltas.length > 0) {
    return deltas.map((m) => { try { return JSON.parse(m[1]!) as string; } catch { return ''; } }).join('');
  }
  return '';
}

/** Whether text is JSON once a markdown fence is peeled off. */
export function looksLikeJson(text: string): boolean {
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (s.length === 0) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function summarizeCompareRecords(records: readonly CompareRecordShape[]): CompareSummary {
  const acc = new Map<string, { calls: number; ok: number; ms: number[]; json: number; chars: number }>();
  const skips = new Map<string, number>();
  let pairs = 0;
  let first: string | null = null;
  let last: string | null = null;

  const add = (model: string | undefined, side: CompareSideRecord | null | undefined): void => {
    if (!model || !side) return;
    let s = acc.get(model);
    if (!s) { s = { calls: 0, ok: 0, ms: [], json: 0, chars: 0 }; acc.set(model, s); }
    s.calls++;
    if (side.status === 200) s.ok++;
    if (typeof side.ms === 'number' && Number.isFinite(side.ms)) s.ms.push(side.ms);
    const text = textOfBody(side.body);
    s.chars += text.length;
    if (looksLikeJson(text)) s.json++;
  };

  for (const r of records) {
    if (typeof r.ts === 'string') { first ??= r.ts; last = r.ts; }
    add(r.primaryModel, r.primary);
    if (r.skipped) { skips.set(r.skipped, (skips.get(r.skipped) ?? 0) + 1); continue; }
    add(r.comparedModel, r.compare);
    if (r.primary && r.compare) pairs++;
  }

  const perModel: ModelStats[] = [...acc]
    .map(([model, s]) => ({
      model,
      calls: s.calls,
      ok: s.ok,
      medianMs: median(s.ms),
      json: s.json,
      avgChars: Math.round(s.chars / Math.max(1, s.calls)),
    }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));

  return {
    records: records.length,
    pairs,
    first,
    last,
    perModel,
    skips: [...skips].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

/** Read every record in a directory, skipping anything unparseable. */
export function readCompareDir(dir: string): CompareRecordShape[] {
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch { return []; }
  const out: CompareRecordShape[] = [];
  for (const name of names) {
    try { out.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as CompareRecordShape); }
    catch { /* a half-written or hand-edited file is not worth failing the report over */ }
  }
  return out;
}

const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

/** The report `dario compare` prints. Two-space indent, like the other commands. */
export function formatCompareReport(s: CompareSummary, dir: string): string[] {
  const out: string[] = [];
  out.push('');
  out.push('  dario — Shadow compare');
  out.push('  ─────────────────────');
  out.push('');
  if (s.records === 0) {
    out.push(`  No records in ${dir}.`);
    out.push('');
    out.push('  A comparison is requested per-request with the `x-dario-compare: <model>` header,');
    out.push('  and the model has to be one your ChatGPT plan lists. Nothing is compared by default.');
    out.push('');
    return out;
  }
  const span = s.first && s.last && s.first.slice(0, 10) !== s.last.slice(0, 10)
    ? `${s.first.slice(0, 10)} → ${s.last.slice(0, 10)}`
    : (s.first ?? '').slice(0, 10);
  out.push(`  Records: ${s.records.toLocaleString('en-US')}${span ? `  (${span})` : ''}`);
  out.push(`  Compared: ${s.pairs.toLocaleString('en-US')} with both sides`);
  out.push('');
  const width = Math.max(8, ...s.perModel.map((m) => m.model.length));
  out.push(`  ${'model'.padEnd(width)}   calls    200s    median   valid JSON   avg chars`);
  for (const m of s.perModel) {
    out.push(
      `  ${m.model.padEnd(width)} ${String(m.calls).padStart(7)} ${pct(m.ok, m.calls).padStart(7)} `
      + `${(m.medianMs === null ? '—' : `${m.medianMs}ms`).padStart(9)} ${pct(m.json, m.calls).padStart(12)} `
      + `${String(m.avgChars).padStart(11)}`,
    );
  }
  if (s.skips.length > 0) {
    out.push('');
    out.push('  Skipped comparisons:');
    for (const { reason, count } of s.skips) {
      out.push(`    ${String(count).padStart(5)}  ${reason.length > 96 ? `${reason.slice(0, 93)}…` : reason}`);
    }
  }
  if (s.pairs === 0) {
    out.push('');
    out.push('  Nothing has both sides yet, so there is nothing to compare — see the skip reasons above.');
  }
  out.push('');
  return out;
}

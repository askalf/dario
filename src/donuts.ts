/**
 * Spend donuts — where the API-equivalent number comes from, as shares.
 *
 * Three rings from the ledger, no new data: by model, by consumer (named
 * key / `x-dario-consumer`), and covered-vs-metered. Rendered as one SVG
 * (`dario usage --donut`, `GET /analytics/donuts.svg`) and inside the
 * server-rendered `/analytics/view` fragment that the `/analytics/ui` page
 * loaded before 6.17 (still served). Same palette and frame as the share card in ledger.ts.
 *
 * Pure over a LedgerSummary / AnalyticsSummary so the geometry is testable
 * without a proxy.
 */
import { readFileSync } from 'node:fs';
import type { LedgerSummary } from './ledger.js';
import { formatUsd } from './ledger.js';
import type { AnalyticsSummary } from './analytics.js';
import type { QueueSnapshot } from './request-queue.js';

/** What /analytics serves: the summary plus the queue snapshot riding along. */
export type AnalyticsView = AnalyticsSummary & { queue?: QueueSnapshot };

export interface DonutSlice { label: string; value: number; share: number }

const PALETTE = ['#7c3aed', '#db2777', '#2563eb', '#059669', '#d97706', '#0891b2'];
const OTHER = '#6b7280';

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Top `max` entries by value plus one "other" bucket; zero and negative
 * values are dropped. Shares sum to 1 (or the array is empty).
 */
export function donutSlices(entries: Record<string, number>, max = 5): DonutSlice[] {
  const rows = Object.entries(entries).filter(([, v]) => Number.isFinite(v) && v > 0).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  if (total <= 0) return [];
  const head = rows.slice(0, max);
  const rest = rows.slice(max).reduce((n, [, v]) => n + v, 0);
  const slices = head.map(([label, value]) => ({ label, value, share: value / total }));
  if (rest > 0) slices.push({ label: 'other', value: rest, share: rest / total });
  return slices;
}

const polar = (cx: number, cy: number, r: number, angle: number): [number, number] =>
  [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];

/** One ring of arcs. A single slice is drawn as a full circle (an arc from a point to itself is empty). */
export function donutPaths(slices: readonly DonutSlice[], cx: number, cy: number, r: number, width: number): string {
  if (slices.length === 0) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1f2937" stroke-width="${width}"/>`;
  if (slices.length === 1) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${PALETTE[0]}" stroke-width="${width}"/>`;
  let start = -Math.PI / 2;
  const out: string[] = [];
  slices.forEach((s, i) => {
    const sweep = s.share * 2 * Math.PI;
    const end = start + sweep;
    const [x1, y1] = polar(cx, cy, r, start);
    const [x2, y2] = polar(cx, cy, r, end);
    const large = sweep > Math.PI ? 1 : 0;
    const color = s.label === 'other' ? OTHER : PALETTE[i % PALETTE.length];
    out.push(`<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${width}"/>`);
    start = end;
  });
  return out.join('\n    ');
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

function ring(title: string, slices: readonly DonutSlice[], cx: number, empty: string): string {
  const cy = 150; const r = 62; const width = 22;
  const legend = slices.slice(0, 6).map((s, i) => {
    const color = s.label === 'other' ? OTHER : PALETTE[i % PALETTE.length];
    const y = 236 + i * 15;
    const label = s.label.length > 18 ? s.label.slice(0, 17) + '…' : s.label;
    return `<rect x="${cx - 95}" y="${y - 9}" width="9" height="9" rx="2" fill="${color}"/>` +
      `<text x="${cx - 80}" y="${y}" font-size="11" fill="#d1d5db">${escapeHtml(label)}</text>` +
      `<text x="${cx + 95}" y="${y}" font-size="11" fill="#9ca3af" text-anchor="end">${escapeHtml(formatUsd(s.value))} · ${pct(s.share)}</text>`;
  }).join('\n    ');
  const centre = slices.length === 0
    ? `<text x="${cx}" y="${cy + 4}" font-size="11" fill="#6b7280" text-anchor="middle">${escapeHtml(empty)}</text>`
    : `<text x="${cx}" y="${cy + 5}" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeHtml(formatUsd(slices.reduce((n, s) => n + s.value, 0)))}</text>`;
  return `<text x="${cx}" y="58" font-size="12" fill="#9ca3af" text-anchor="middle" letter-spacing="1.5">${escapeHtml(title.toUpperCase())}</text>
    ${donutPaths(slices, cx, cy, r, width)}
    ${centre}
    ${legend}`;
}

/** The three-ring SVG. 640×320, the share card's frame. */
export function renderSpendDonuts(s: LedgerSummary): string {
  const byModel = donutSlices(Object.fromEntries(Object.entries(s.perModel).map(([m, v]) => [m, v.apiEquivalentCost + v.meteredCost])));
  const byConsumer = donutSlices(Object.fromEntries(Object.entries(s.perConsumer).map(([c, v]) => [c, v.apiEquivalentCost + v.meteredCost])));
  // Short on purpose: the legend column is 18 characters wide.
  const byBilling = donutSlices({ 'subscription': s.apiEquivalentCost, 'metered': s.meteredCost });
  const total = formatUsd(s.apiEquivalentCost + s.meteredCost);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320" role="img" aria-label="${escapeHtml(total)} of spend through dario, by model, by key and by billing">
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
    <text x="40" y="34" font-size="12" fill="#9ca3af" letter-spacing="2">SPEND THROUGH DARIO · ${escapeHtml(total)} · since ${escapeHtml(s.since.slice(0, 10))}</text>
    ${ring('by model', byModel, 112, 'no traffic yet')}
    ${ring('by key', byConsumer, 320, 'no named keys')}
    ${ring('by billing', byBilling, 528, 'no traffic yet')}
    <text x="600" y="308" font-size="11" fill="#6b7280" text-anchor="end">dario</text>
  </g>
</svg>
`;
}

/**
 * The server-rendered fragment behind `/analytics/ui`: headline, the three
 * rings, the rolling window, and a per-model table. Same gate as
 * `/analytics`; the page before 6.17 fetched it with the token the viewer typed; it is still served.
 */
export function renderAnalyticsView(summary: AnalyticsView, lifetime: LedgerSummary | null, version: string): string {
  const w = summary.window;
  const stat = (label: string, value: string) => `<div class="stat"><div class="v">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div></div>`;
  const headline = lifetime
    ? `<div class="headline">${escapeHtml(formatUsd(lifetime.apiEquivalentCost))}<span> API-equivalent · covered by subscriptions · since ${escapeHtml(lifetime.since.slice(0, 10))} · ${lifetime.requests.toLocaleString('en-US')} requests</span></div>`
    : '<div class="headline muted">ledger disabled <span>start without --no-ledger to keep lifetime spend</span></div>';
  const rings = lifetime ? renderSpendDonuts(lifetime) : '';
  const models = lifetime
    ? Object.entries(lifetime.perModel).sort((a, b) => (b[1].apiEquivalentCost + b[1].meteredCost) - (a[1].apiEquivalentCost + a[1].meteredCost))
    : [];
  const table = models.length
    ? `<table><thead><tr><th>model</th><th>requests</th><th>in</th><th>out</th><th>cache read</th><th>api-equivalent</th><th>metered</th></tr></thead><tbody>${
      models.map(([m, v]) => `<tr><td>${escapeHtml(m)}</td><td>${v.requests.toLocaleString('en-US')}</td><td>${v.inputTokens.toLocaleString('en-US')}</td><td>${v.outputTokens.toLocaleString('en-US')}</td><td>${v.cacheReadTokens.toLocaleString('en-US')}</td><td>${escapeHtml(formatUsd(v.apiEquivalentCost))}</td><td>${escapeHtml(formatUsd(v.meteredCost))}</td></tr>`).join('')
    }</tbody></table>`
    : '';
  const accounts = Object.entries(summary.perAccount).map(([a, s]) =>
    `<tr><td>${escapeHtml(a)}</td><td>${s.requests.toLocaleString('en-US')}</td><td>${Math.round(s.currentUtil5h * 100)}%</td><td>${Math.round(s.currentUtil7d * 100)}%</td><td>${escapeHtml(s.lastClaim)}</td></tr>`).join('');
  return `${headline}
<div class="stats">
  ${stat(`requests · last ${w.minutes} min`, w.requests.toLocaleString('en-US'))}
  ${stat('avg latency', `${Math.round(w.avgLatencyMs)} ms`)}
  ${stat('error rate', `${(w.errorRate * 100).toFixed(1)}%`)}
  ${stat('cached prompt', `${Math.round(w.cachedPromptPercent)}%`)}
  ${stat('in flight / queued', `${summary.queue?.active ?? 0} / ${summary.queue?.queued ?? 0}`)}
</div>
<div class="rings">${rings}</div>
${table}
${accounts ? `<table><thead><tr><th>seat</th><th>requests</th><th>5h</th><th>7d</th><th>last claim</th></tr></thead><tbody>${accounts}</tbody></table>` : ''}
<div class="foot">dario ${escapeHtml(version)} · rendered ${escapeHtml(new Date().toISOString().slice(0, 19).replace('T', ' '))} UTC</div>`;
}

/** The page served when the build ran tsc without the copy step: say so instead of a 500. */
const ANALYTICS_UI_MISSING = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dario</title></head><body><p>This build is missing <code>analytics-ui.html</code> next to <code>donuts.js</code>; run <code>npm run build</code>.</p></body></html>';

/**
 * A reader of the dashboard page that reads it once: the first read that succeeds is kept for
 * every call after it. A failed read answers with the missing-file page and keeps nothing, so
 * copying the file in takes effect on the next request without a restart. The reader is a
 * parameter so the test can count the reads.
 */
export function analyticsUiLoader(read: () => string): () => string {
  let page: string | null = null;
  return () => {
    if (page !== null) return page;
    try {
      page = read();
      return page;
    } catch {
      return ANALYTICS_UI_MISSING;
    }
  };
}

/**
 * The dashboard behind `/analytics/ui`: `dist/analytics-ui.html`, copied from `src/` by the
 * build and read once, on the first request. It carries no data and no credential. It asks for
 * the analytics token or an API key once (kept in sessionStorage) and reads `/analytics`,
 * `/accounts`, `/codex`, `/health`, `/analytics/ledger` and `/admin/keys` with it, and tails
 * `/analytics/stream`; it loads nothing from outside the proxy. The
 * `window.DARIO_COCKPIT = "served"` line in its head tells the page a proxy is serving it, so it
 * goes live at once; the same file opened from disk runs on sample data, because the page checks
 * the protocol before the marker. `/analytics/view` and the rings above are unchanged for the CLI
 * and for anything that embedded them.
 */
export const analyticsUiPage = analyticsUiLoader(() => readFileSync(new URL('./analytics-ui.html', import.meta.url), 'utf8'));

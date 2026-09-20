#!/usr/bin/env node
/**
 * src/timing.ts — the per-request timing split, hermetic (dario#1341 follow-up).
 *
 * The fold has to be honest about clocks that never ticked: a request
 * rejected before dispatch has no fetch stamp, a stream that died has no
 * done stamp. Every such gap reads 0, never NaN, never negative — a negative
 * overhead would say dario finished before the provider did.
 */
import { foldTiming, overheadMs, timingHeaders, timingStats, timingLogFields, TIMING_HEADERS, TIMING_METRIC_FAMILIES } from '../dist/timing.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

header('foldTiming');
{
  const t = foldTiming({ arrivedAt: 1000, queueMs: 40, pacingMs: 60, fetchStartedAt: 1200, upstreamHeadersAt: 1500, upstreamDoneAt: 2100, endedAt: 2150 });
  check('queue and pacing pass through', t.queueMs === 40 && t.pacingMs === 60, t);
  check('ttfb = headers − fetch', t.upstreamTtfbMs === 300, t.upstreamTtfbMs);
  check('upstream = done − fetch', t.upstreamMs === 900, t.upstreamMs);
  check('total = ended − arrived', t.totalMs === 1150, t.totalMs);
  check('overhead = total − upstream − queue − pacing', overheadMs(t) === 150, overheadMs(t));

  const rejected = foldTiming({ arrivedAt: 1000, queueMs: 5, pacingMs: 0, endedAt: 1020 });
  check('no fetch stamp: upstream legs read 0', rejected.upstreamTtfbMs === 0 && rejected.upstreamMs === 0, rejected);
  check('…total still counts', rejected.totalMs === 20 && overheadMs(rejected) === 15, rejected);

  const died = foldTiming({ arrivedAt: 0, queueMs: 0, pacingMs: 0, fetchStartedAt: 10, upstreamHeadersAt: 50, endedAt: 400 });
  check('no done stamp: upstream = ttfb, not 0', died.upstreamMs === 40 && died.upstreamTtfbMs === 40, died);

  const weird = foldTiming({ arrivedAt: 100, queueMs: -3, pacingMs: NaN, fetchStartedAt: 90, upstreamHeadersAt: 80, upstreamDoneAt: 70, endedAt: 60 });
  check('clocks that ran backwards clamp to 0, never negative or NaN', Object.values(weird).every(v => v === 0), weird);
  const inverted = { queueMs: 500, pacingMs: 500, upstreamTtfbMs: 10, upstreamMs: 10, totalMs: 100 };
  check('overhead never goes negative', overheadMs(inverted) === 0, overheadMs(inverted));
  check('fractional stamps are rounded', foldTiming({ arrivedAt: 0.4, queueMs: 1.6, pacingMs: 0, fetchStartedAt: 2.2, upstreamHeadersAt: 3.7, upstreamDoneAt: 3.7, endedAt: 4.9 }).queueMs === 2);
}

header('timingHeaders');
{
  const h = timingHeaders({ queueMs: 40, pacingMs: 60, upstreamTtfbMs: 300, arrivedAt: 1000, fetchStartedAt: 1200 });
  check('four headers, all x-dario-*', Object.keys(h).length === 4 && Object.keys(h).every(k => k.startsWith('x-dario-')), Object.keys(h));
  check('queue / pacing / ttfb as integers', h[TIMING_HEADERS.queue] === '40' && h[TIMING_HEADERS.pacing] === '60' && h[TIMING_HEADERS.ttfb] === '300', h);
  check('prep = fetch − arrived − queue − pacing', h[TIMING_HEADERS.prep] === '100', h);
  const neg = timingHeaders({ queueMs: 900, pacingMs: 0, upstreamTtfbMs: -5, arrivedAt: 1000, fetchStartedAt: 1200 });
  check('prep and ttfb clamp at 0', neg[TIMING_HEADERS.prep] === '0' && neg[TIMING_HEADERS.ttfb] === '0', neg);
}

header('timingStats');
{
  const a = { queueMs: 10, pacingMs: 0, upstreamTtfbMs: 100, upstreamMs: 400, totalMs: 500 };   // overhead 90
  const b = { queueMs: 30, pacingMs: 200, upstreamTtfbMs: 300, upstreamMs: 600, totalMs: 1000 }; // overhead 170
  const s = timingStats([a, undefined, b, undefined]);
  check('rows without a split are not counted', s.samples === 2, s.samples);
  check('averages over the rows that have one', s.avgQueueMs === 20 && s.avgPacingMs === 100 && s.avgUpstreamTtfbMs === 200 && s.avgUpstreamMs === 500, s);
  check('average overhead uses the per-row overhead', s.avgOverheadMs === 130, s.avgOverheadMs);
  const empty = timingStats([undefined, undefined]);
  check('no rows: zeros, not NaN', empty.samples === 0 && Object.values(empty).every(v => v === 0), empty);
  check('log fields are the snake_case columns', JSON.stringify(timingLogFields(a)) === JSON.stringify({ queue_ms: 10, pacing_ms: 0, upstream_ttfb_ms: 100, upstream_ms: 400, total_ms: 500, overhead_ms: 90 }), timingLogFields(a));
}

header('metric families');
{
  const names = TIMING_METRIC_FAMILIES.map(f => f.name);
  check('five families, dario_ prefixed, _ms suffixed', names.length === 5 && names.every(n => n.startsWith('dario_') && n.endsWith('_ms')), names);
  check('overhead family picks the derived figure', TIMING_METRIC_FAMILIES.find(f => f.name === 'dario_overhead_ms').pick({ queueMs: 1, pacingMs: 2, upstreamTtfbMs: 3, upstreamMs: 10, totalMs: 20 }) === 7);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

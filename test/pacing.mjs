// Unit tests for src/pacing.ts (v3.24, direction #6 — behavioral smoothing).
// Pure delay calculator + config resolver. Both are deterministic over their
// explicit inputs (no clocks, no process.env reads) so every branch is
// exercised without spawning timers.

import { computePacingDelay, resolvePacingConfig } from '../dist/pacing.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ======================================================================
//  computePacingDelay — first request never paced
// ======================================================================
header('computePacingDelay — first request (lastRequestTime=0) → 0');
{
  const d = computePacingDelay(1000, 0, { minGapMs: 500, jitterMs: 0 });
  check('returns 0 when lastRequestTime is 0', d === 0);
  const d2 = computePacingDelay(1000, -1, { minGapMs: 500, jitterMs: 1000 });
  check('returns 0 when lastRequestTime is negative', d2 === 0);
}

// ======================================================================
//  computePacingDelay — enough elapsed → no wait
// ======================================================================
header('computePacingDelay — elapsed ≥ minGap → 0');
{
  const d = computePacingDelay(2000, 1000, { minGapMs: 500, jitterMs: 0 });
  check('elapsed 1000ms > minGap 500ms → 0', d === 0);
  const d2 = computePacingDelay(1500, 1000, { minGapMs: 500, jitterMs: 0 });
  check('elapsed exactly 500ms (== minGap) → 0', d2 === 0);
}

// ======================================================================
//  computePacingDelay — insufficient elapsed → wait the remainder
// ======================================================================
header('computePacingDelay — elapsed < minGap → returns remainder');
{
  const d = computePacingDelay(1100, 1000, { minGapMs: 500, jitterMs: 0 });
  check('elapsed 100ms, minGap 500ms → 400ms', d === 400);
  const d2 = computePacingDelay(1000, 1000, { minGapMs: 500, jitterMs: 0 });
  check('elapsed 0ms, minGap 500ms → 500ms', d2 === 500);
}

// ======================================================================
//  computePacingDelay — jitter with deterministic rng
// ======================================================================
header('computePacingDelay — jitter integrates via injectable rng');
{
  // rng=0 → jitterAdd=0 → effective gap = minGap
  const d0 = computePacingDelay(1000, 1000, { minGapMs: 500, jitterMs: 1000 }, () => 0);
  check('rng=0 → effective gap = minGap (500)', d0 === 500);

  // rng=0.5 → jitterAdd=floor(500)=500 → effective gap = 1000, elapsed=0 → return 1000
  const dHalf = computePacingDelay(1000, 1000, { minGapMs: 500, jitterMs: 1000 }, () => 0.5);
  check('rng=0.5, jitter=1000 → jitterAdd=500, gap=1000', dHalf === 1000);

  // rng=0.999 → jitterAdd=floor(999)=999 → effective gap = 1499
  const dMax = computePacingDelay(1000, 1000, { minGapMs: 500, jitterMs: 1000 }, () => 0.999);
  check('rng→1 boundary → jitterAdd=jitter-1 (never jitter itself)', dMax === 1499);

  // Jitter never produces negative delay
  const dNeg = computePacingDelay(5000, 1000, { minGapMs: 500, jitterMs: 1000 }, () => 0.999);
  check('large elapsed + any jitter → 0 (no negative delay)', dNeg === 0);
}

// ======================================================================
//  computePacingDelay — jitter=0 disables rng call
// ======================================================================
header('computePacingDelay — jitterMs=0 short-circuits the rng');
{
  let rngCalls = 0;
  const d = computePacingDelay(
    1000, 1000,
    { minGapMs: 500, jitterMs: 0 },
    () => { rngCalls++; return 0.5; },
  );
  check('delay = minGap when jitter disabled', d === 500);
  check('rng is not called when jitter=0 (perf matters on hot path)', rngCalls === 0);
}

// ======================================================================
//  computePacingDelay — negative config values clamped to 0
// ======================================================================
header('computePacingDelay — negative config clamped');
{
  const d = computePacingDelay(1000, 1000, { minGapMs: -100, jitterMs: 0 });
  check('negative minGap treated as 0 → no delay', d === 0);

  const d2 = computePacingDelay(1000, 1000, { minGapMs: 500, jitterMs: -100 }, () => 0.9);
  check('negative jitter treated as 0 → no jitter added', d2 === 500);
}

// ======================================================================
//  computePacingDelay — rng defaults to Math.random when omitted
// ======================================================================
header('computePacingDelay — default rng (Math.random) does not crash');
{
  // We can't assert on the random value, but we can assert it runs and
  // produces a number in [minGap, minGap+jitter).
  const d = computePacingDelay(1000, 1000, { minGapMs: 500, jitterMs: 200 });
  check('result is a finite number', Number.isFinite(d));
  check('result in [500, 700)', d >= 500 && d < 700);
}

// ======================================================================
//  resolvePacingConfig — defaults
// ======================================================================
header('resolvePacingConfig — no inputs → 500/0');
{
  const cfg = resolvePacingConfig({}, {});
  check('minGapMs defaults to 500', cfg.minGapMs === 500);
  check('jitterMs defaults to 0', cfg.jitterMs === 0);
}

// ======================================================================
//  resolvePacingConfig — explicit args win
// ======================================================================
header('resolvePacingConfig — explicit args override env');
{
  const cfg = resolvePacingConfig(
    { minGapMs: 1000, jitterMs: 250 },
    { DARIO_PACE_MIN_MS: '2000', DARIO_PACE_JITTER_MS: '500' },
  );
  check('explicit minGap wins over DARIO_PACE_MIN_MS', cfg.minGapMs === 1000);
  check('explicit jitter wins over DARIO_PACE_JITTER_MS', cfg.jitterMs === 250);
}

// ======================================================================
//  resolvePacingConfig — env var precedence
// ======================================================================
header('resolvePacingConfig — DARIO_PACE_*_MS env vars');
{
  const cfg = resolvePacingConfig({}, { DARIO_PACE_MIN_MS: '750', DARIO_PACE_JITTER_MS: '250' });
  check('minGap from env', cfg.minGapMs === 750);
  check('jitter from env', cfg.jitterMs === 250);
}

// ======================================================================
//  resolvePacingConfig — legacy DARIO_MIN_INTERVAL_MS still honored
// ======================================================================
header('resolvePacingConfig — legacy DARIO_MIN_INTERVAL_MS respected for back-compat');
{
  const cfg = resolvePacingConfig({}, { DARIO_MIN_INTERVAL_MS: '1500' });
  check('legacy env var picked up for minGap', cfg.minGapMs === 1500);
  check('jitter still defaults to 0', cfg.jitterMs === 0);

  // New var beats legacy var
  const cfg2 = resolvePacingConfig({}, {
    DARIO_PACE_MIN_MS: '800',
    DARIO_MIN_INTERVAL_MS: '1500',
  });
  check('DARIO_PACE_MIN_MS wins over legacy DARIO_MIN_INTERVAL_MS', cfg2.minGapMs === 800);
}

// ======================================================================
//  resolvePacingConfig — invalid strings ignored, fall through
// ======================================================================
header('resolvePacingConfig — invalid env strings fall through to default');
{
  const cfg = resolvePacingConfig({}, { DARIO_PACE_MIN_MS: 'banana', DARIO_PACE_JITTER_MS: '-5' });
  check('non-numeric env ignored → default 500', cfg.minGapMs === 500);
  check('negative env ignored → default 0', cfg.jitterMs === 0);

  const cfg2 = resolvePacingConfig({}, { DARIO_PACE_MIN_MS: '' });
  check('empty string ignored → default 500', cfg2.minGapMs === 500);
}

// ======================================================================
//  resolvePacingConfig — zero is valid (disables pacing entirely)
// ======================================================================
header('resolvePacingConfig — 0 is a valid explicit value');
{
  const cfg = resolvePacingConfig({ minGapMs: 0, jitterMs: 0 }, {});
  check('explicit 0 minGap honored (pacing disabled)', cfg.minGapMs === 0);
  check('explicit 0 jitter honored', cfg.jitterMs === 0);
}

// ======================================================================
//  resolvePacingConfig — number type explicit arg accepted
// ======================================================================
header('resolvePacingConfig — explicit number args (from CLI parser)');
{
  // CLI parses --pace-min=600 into a number, not a string. Both shapes must
  // work since env vars arrive as strings and CLI args arrive as numbers.
  const cfg = resolvePacingConfig({ minGapMs: 600, jitterMs: 150 }, {});
  check('number minGap passes through', cfg.minGapMs === 600);
  check('number jitter passes through', cfg.jitterMs === 150);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

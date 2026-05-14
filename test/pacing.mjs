// Unit tests for src/pacing.ts (v3.24, direction #6 — behavioral smoothing).
// Pure delay calculator + config resolver. Both are deterministic over their
// explicit inputs (no clocks, no process.env reads) so every branch is
// exercised without spawning timers.

import {
  computePacingDelay,
  resolvePacingConfig,
  computeThinkTimeDelay,
  resolveThinkTimeConfig,
  computeSessionStartDelay,
  resolveSessionStartConfig,
} from '../dist/pacing.js';

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
//  computeThinkTimeDelay — first request returns 0
// ======================================================================
header('computeThinkTimeDelay — no previous response → 0');
{
  const d = computeThinkTimeDelay(1000, 0, 500, { baseMs: 200, perTokenMs: 5, jitterMs: 100, maxMs: 30000 });
  check('lastResponseTime=0 → 0', d === 0);
  const d2 = computeThinkTimeDelay(1000, -1, 500, { baseMs: 200, perTokenMs: 5, jitterMs: 100, maxMs: 30000 });
  check('lastResponseTime=-1 → 0', d2 === 0);
}

// ======================================================================
//  computeThinkTimeDelay — fully-zero config short-circuits
// ======================================================================
header('computeThinkTimeDelay — all-zero config → 0 (no rng call)');
{
  let rngCalls = 0;
  const d = computeThinkTimeDelay(2000, 1000, 500, { baseMs: 0, perTokenMs: 0, jitterMs: 0, maxMs: 30000 }, () => { rngCalls++; return 0.5; });
  check('all-zero config returns 0', d === 0);
  check('rng not called on hot path when disabled', rngCalls === 0);
}

// ======================================================================
//  computeThinkTimeDelay — base only
// ======================================================================
header('computeThinkTimeDelay — base-only think time');
{
  // 0ms elapsed since response, base=1000, perToken=0, jitter=0 → 1000
  const d = computeThinkTimeDelay(1000, 1000, 500, { baseMs: 1000, perTokenMs: 0, jitterMs: 0, maxMs: 30000 });
  check('elapsed=0, base=1000 → 1000', d === 1000);

  // 500ms elapsed, base=1000 → 500 remaining
  const d2 = computeThinkTimeDelay(1500, 1000, 500, { baseMs: 1000, perTokenMs: 0, jitterMs: 0, maxMs: 30000 });
  check('elapsed=500, base=1000 → 500 remaining', d2 === 500);

  // 2000ms elapsed > base=1000 → 0
  const d3 = computeThinkTimeDelay(3000, 1000, 500, { baseMs: 1000, perTokenMs: 0, jitterMs: 0, maxMs: 30000 });
  check('elapsed=2000 > base=1000 → 0', d3 === 0);
}

// ======================================================================
//  computeThinkTimeDelay — per-token scales with response size
// ======================================================================
header('computeThinkTimeDelay — perTokenMs * tokens');
{
  // base=0, perToken=5, tokens=200 → 1000ms target, 0 elapsed → 1000
  const d = computeThinkTimeDelay(1000, 1000, 200, { baseMs: 0, perTokenMs: 5, jitterMs: 0, maxMs: 30000 });
  check('perToken=5, tokens=200 → 1000ms', d === 1000);

  // base=100, perToken=2, tokens=500 → 1100ms
  const d2 = computeThinkTimeDelay(1000, 1000, 500, { baseMs: 100, perTokenMs: 2, jitterMs: 0, maxMs: 30000 });
  check('base=100 + perToken=2 * tokens=500 → 1100', d2 === 1100);

  // tokens=0 falls back to base only
  const d3 = computeThinkTimeDelay(1000, 1000, 0, { baseMs: 800, perTokenMs: 5, jitterMs: 0, maxMs: 30000 });
  check('tokens=0 → base only (800)', d3 === 800);

  // negative tokens clamped to 0
  const d4 = computeThinkTimeDelay(1000, 1000, -100, { baseMs: 500, perTokenMs: 5, jitterMs: 0, maxMs: 30000 });
  check('negative tokens clamped → base only (500)', d4 === 500);
}

// ======================================================================
//  computeThinkTimeDelay — max cap
// ======================================================================
header('computeThinkTimeDelay — maxMs caps the target');
{
  // base=1000, perToken=10, tokens=10000 → would be 101000, capped at maxMs=5000
  const d = computeThinkTimeDelay(1000, 1000, 10000, { baseMs: 1000, perTokenMs: 10, jitterMs: 0, maxMs: 5000 });
  check('huge target capped at maxMs=5000', d === 5000);

  // maxMs=0 disables cap (target wins)
  const d2 = computeThinkTimeDelay(1000, 1000, 100, { baseMs: 500, perTokenMs: 0, jitterMs: 0, maxMs: 0 });
  check('maxMs=0 → no cap, target wins', d2 === 500);
}

// ======================================================================
//  computeThinkTimeDelay — jitter via deterministic rng
// ======================================================================
header('computeThinkTimeDelay — jitter integrates via injectable rng');
{
  // base=500, perToken=0, jitter=1000, rng=0.5 → jitterAdd=500 → target=1000
  const d = computeThinkTimeDelay(1000, 1000, 0, { baseMs: 500, perTokenMs: 0, jitterMs: 1000, maxMs: 30000 }, () => 0.5);
  check('rng=0.5, jitter=1000 → +500 → target=1000', d === 1000);

  // rng=0 → no jitter add
  const d2 = computeThinkTimeDelay(1000, 1000, 0, { baseMs: 500, perTokenMs: 0, jitterMs: 1000, maxMs: 30000 }, () => 0);
  check('rng=0 → target=base=500', d2 === 500);
}

// ======================================================================
//  resolveThinkTimeConfig — defaults
// ======================================================================
header('resolveThinkTimeConfig — no inputs → all-zero except maxMs=30000');
{
  const cfg = resolveThinkTimeConfig({}, {});
  check('baseMs defaults to 0', cfg.baseMs === 0);
  check('perTokenMs defaults to 0', cfg.perTokenMs === 0);
  check('jitterMs defaults to 0', cfg.jitterMs === 0);
  check('maxMs defaults to 30000', cfg.maxMs === 30000);
}

// ======================================================================
//  resolveThinkTimeConfig — env vars
// ======================================================================
header('resolveThinkTimeConfig — DARIO_THINK_TIME_* env vars');
{
  const cfg = resolveThinkTimeConfig({}, {
    DARIO_THINK_TIME_BASE_MS: '300',
    DARIO_THINK_TIME_PER_TOKEN_MS: '4',
    DARIO_THINK_TIME_JITTER_MS: '500',
    DARIO_THINK_TIME_MAX_MS: '15000',
  });
  check('base from env', cfg.baseMs === 300);
  check('perToken from env', cfg.perTokenMs === 4);
  check('jitter from env', cfg.jitterMs === 500);
  check('max from env', cfg.maxMs === 15000);
}

// ======================================================================
//  resolveThinkTimeConfig — explicit overrides env
// ======================================================================
header('resolveThinkTimeConfig — explicit args win over env');
{
  const cfg = resolveThinkTimeConfig(
    { baseMs: 100, perTokenMs: 1, jitterMs: 200, maxMs: 5000 },
    { DARIO_THINK_TIME_BASE_MS: '999', DARIO_THINK_TIME_MAX_MS: '99999' },
  );
  check('explicit base wins', cfg.baseMs === 100);
  check('explicit perToken wins', cfg.perTokenMs === 1);
  check('explicit jitter wins', cfg.jitterMs === 200);
  check('explicit max wins', cfg.maxMs === 5000);
}

// ======================================================================
//  computeSessionStartDelay — basic
// ======================================================================
header('computeSessionStartDelay — sampled startup delay');
{
  // min=0, jitter=0 → short-circuit to 0
  let rngCalls = 0;
  const d = computeSessionStartDelay({ minMs: 0, jitterMs: 0 }, () => { rngCalls++; return 0.5; });
  check('all-zero config returns 0', d === 0);
  check('rng not called when disabled', rngCalls === 0);

  // min=1000, jitter=0 → exactly 1000
  const d2 = computeSessionStartDelay({ minMs: 1000, jitterMs: 0 });
  check('min=1000, jitter=0 → 1000', d2 === 1000);

  // min=500, jitter=2000, rng=0.5 → 500 + 1000 = 1500
  const d3 = computeSessionStartDelay({ minMs: 500, jitterMs: 2000 }, () => 0.5);
  check('min=500 + rng=0.5*jitter=2000 → 1500', d3 === 1500);

  // negative min/jitter clamped
  const d4 = computeSessionStartDelay({ minMs: -100, jitterMs: -50 });
  check('negative config clamped to 0', d4 === 0);
}

// ======================================================================
//  resolveSessionStartConfig — defaults and env
// ======================================================================
header('resolveSessionStartConfig — defaults / env / explicit precedence');
{
  const cfg = resolveSessionStartConfig({}, {});
  check('minMs defaults to 0', cfg.minMs === 0);
  check('jitterMs defaults to 0', cfg.jitterMs === 0);

  const cfg2 = resolveSessionStartConfig({}, {
    DARIO_SESSION_START_MIN_MS: '800',
    DARIO_SESSION_START_JITTER_MS: '3000',
  });
  check('minMs from env', cfg2.minMs === 800);
  check('jitterMs from env', cfg2.jitterMs === 3000);

  const cfg3 = resolveSessionStartConfig(
    { minMs: 100, jitterMs: 200 },
    { DARIO_SESSION_START_MIN_MS: '999' },
  );
  check('explicit minMs wins over env', cfg3.minMs === 100);
  check('explicit jitterMs honored', cfg3.jitterMs === 200);
}

// ======================================================================
//  Stealth preset — pacing
// ======================================================================
header('resolvePacingConfig — stealth preset');
{
  // Stealth on, no explicit / env → jitter=300, minGap stays at 500.
  const cfg = resolvePacingConfig({ stealth: true }, {});
  check('stealth: jitter falls through to 300', cfg.jitterMs === 300);
  check('stealth: minGap unchanged at 500', cfg.minGapMs === 500);

  // Explicit jitter wins over stealth default.
  const cfg2 = resolvePacingConfig({ stealth: true, jitterMs: 50 }, {});
  check('explicit jitter beats stealth default', cfg2.jitterMs === 50);

  // Env jitter wins over stealth default.
  const cfg3 = resolvePacingConfig({ stealth: true }, { DARIO_PACE_JITTER_MS: '100' });
  check('env jitter beats stealth default', cfg3.jitterMs === 100);

  // Stealth off (omitted / false) — defaults still 0.
  const cfg4 = resolvePacingConfig({ stealth: false }, {});
  check('stealth=false keeps jitter at 0', cfg4.jitterMs === 0);
}

// ======================================================================
//  Stealth preset — think-time
// ======================================================================
header('resolveThinkTimeConfig — stealth preset');
{
  const cfg = resolveThinkTimeConfig({ stealth: true }, {});
  check('stealth base=800', cfg.baseMs === 800);
  check('stealth perToken=4', cfg.perTokenMs === 4);
  check('stealth jitter=1500', cfg.jitterMs === 1500);
  check('stealth max=25000', cfg.maxMs === 25000);

  // Explicit one knob overrides; the rest stay at stealth defaults.
  const cfg2 = resolveThinkTimeConfig({ stealth: true, baseMs: 200 }, {});
  check('explicit baseMs overrides stealth', cfg2.baseMs === 200);
  check('perToken still stealth default', cfg2.perTokenMs === 4);

  // Env one knob overrides; the rest stay at stealth defaults.
  const cfg3 = resolveThinkTimeConfig({ stealth: true }, { DARIO_THINK_TIME_MAX_MS: '10000' });
  check('env max overrides stealth', cfg3.maxMs === 10000);
  check('jitter still stealth default', cfg3.jitterMs === 1500);

  // Stealth off — everything 0 except max=30000.
  const cfg4 = resolveThinkTimeConfig({ stealth: false }, {});
  check('stealth off: base=0', cfg4.baseMs === 0);
  check('stealth off: perToken=0', cfg4.perTokenMs === 0);
  check('stealth off: jitter=0', cfg4.jitterMs === 0);
  check('stealth off: max=30000', cfg4.maxMs === 30000);
}

// ======================================================================
//  Stealth preset — session-start
// ======================================================================
header('resolveSessionStartConfig — stealth preset');
{
  const cfg = resolveSessionStartConfig({ stealth: true }, {});
  check('stealth min=1200', cfg.minMs === 1200);
  check('stealth jitter=3000', cfg.jitterMs === 3000);

  // Explicit override.
  const cfg2 = resolveSessionStartConfig({ stealth: true, minMs: 100 }, {});
  check('explicit min wins', cfg2.minMs === 100);
  check('jitter still stealth default', cfg2.jitterMs === 3000);

  // Stealth off — both 0.
  const cfg3 = resolveSessionStartConfig({}, {});
  check('stealth off: min=0', cfg3.minMs === 0);
  check('stealth off: jitter=0', cfg3.jitterMs === 0);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

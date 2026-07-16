// Regression tests for formatUsageLogLine (dario#678 diagnosability).
//
// dario parses cache_read / cache_creation off every response but only ever
// wrote them to --log-file / /analytics, never the console. This one-liner
// surfaces them at -v/-vv so a plain verbose capture shows whether the prompt
// prefix is being served from cache or re-billed. Pure function — no proxy state.

import { formatUsageLogLine } from '../dist/analytics.js';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

header('formatUsageLogLine — shape + cache ratio');
{
  // Warm cache: nearly all prompt tokens read from cache (100 fresh, 9900 cached → 99%).
  const warm = formatUsageLogLine(7, { inputTokens: 100, outputTokens: 500, cacheReadTokens: 9900, cacheCreateTokens: 0 });
  check('includes request number', warm.includes('#7 usage:'));
  check('shows all four token fields', warm.includes('in=100') && warm.includes('out=500') && warm.includes('cache_read=9900') && warm.includes('cache_create=0'));
  check('warm cache → 99% from cache', warm.includes('(99% of prompt from cache)'));

  // Cold / expired: whole prefix re-created, nothing read — the #678 leak signal.
  const cold = formatUsageLogLine(8, { inputTokens: 40, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 27000 });
  check('cold start ≈ 0% from cache', cold.includes('(0% of prompt from cache)'));
  check('cold start shows cache_create=27000', cold.includes('cache_create=27000'));

  // Half and half.
  const half = formatUsageLogLine(9, { inputTokens: 0, outputTokens: 100, cacheReadTokens: 50, cacheCreateTokens: 50 });
  check('50/50 split → 50% from cache', half.includes('(50% of prompt from cache)'));

  // Output tokens excluded from the ratio (not cacheable).
  const bigOut = formatUsageLogLine(10, { inputTokens: 0, outputTokens: 999999, cacheReadTokens: 100, cacheCreateTokens: 0 });
  check('output excluded from ratio → 100%', bigOut.includes('(100% of prompt from cache)'));
}

header('formatUsageLogLine — robustness');
{
  // No prompt tokens at all (e.g. a stub / aborted response) → no divide-by-zero.
  const zero = formatUsageLogLine(1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
  check('all-zero → 0%, no NaN', zero.includes('(0% of prompt from cache)') && !zero.includes('NaN'));

  // Missing fields default to 0.
  const partial = formatUsageLogLine(2, {});
  check('missing fields default to 0', partial.includes('in=0') && partial.includes('out=0') && partial.includes('cache_read=0') && partial.includes('cache_create=0'));
  check('missing fields → 0%, no NaN', partial.includes('(0% of prompt from cache)') && !partial.includes('NaN'));

  // Undefined individual fields.
  const someUndef = formatUsageLogLine(3, { inputTokens: 100, cacheReadTokens: undefined, cacheCreateTokens: 0 });
  check('undefined field treated as 0', someUndef.includes('cache_read=0') && someUndef.includes('in=100'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

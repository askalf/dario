#!/usr/bin/env node
// Unit test for the ANTHROPIC_UPSTREAM_API_KEY upstream-auth override.
// When a per-token API key is configured, dario forwards to api.anthropic.com
// with `x-api-key` (standard API pool) instead of the Pro/Max OAuth bearer —
// and never with both. Used by the self-hosted compat workflow so it can route
// the suite THROUGH dario without tripping the subscription pool's ~3/min cap.

import { upstreamAuthHeaders } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}`); fail++; }
}

console.log('\n=== upstreamAuthHeaders ===');

// API-key mode → x-api-key only, no Authorization bearer
{
  const h = upstreamAuthHeaders('sk-ant-api03-EXAMPLE', 'oauth-token-xyz');
  check('api-key mode sets x-api-key', h['x-api-key'] === 'sk-ant-api03-EXAMPLE');
  check('api-key mode does NOT set Authorization', !('Authorization' in h));
  check('api-key mode ignores the (unused) access token', !JSON.stringify(h).includes('oauth-token-xyz'));
}

// Default (no upstream key) → OAuth bearer, byte-identical to prior behavior
{
  const h = upstreamAuthHeaders('', 'oauth-token-xyz');
  check('default uses Authorization bearer', h['Authorization'] === 'Bearer oauth-token-xyz');
  check('default does NOT set x-api-key', !('x-api-key' in h));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

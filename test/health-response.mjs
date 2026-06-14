// Tests for buildHealthResponse — the /health public-vs-internal disclosure rule.
//
// Public requests (through the Cloudflare tunnel, marked by `cf-ray`) must get
// ONLY the liveness verdict; internal loopback callers get full OAuth detail.
// The HTTP status code is identical for both so external uptime checks still work.

import { buildHealthResponse } from '../dist/health-response.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const healthy = { status: 'valid', expiresIn: '4h 57m', canRefresh: true };
const dead = { status: 'broken', expiresIn: '0s', canRefresh: false };

header('public (via tunnel) — minimal, no OAuth leak');
{
  const { httpStatus, body } = buildHealthResponse(healthy, 167, true);
  check('http 200 when healthy', httpStatus === 200);
  check('status ok', body.status === 'ok');
  check('NO oauth field', !('oauth' in body));
  check('NO expiresIn field', !('expiresIn' in body));
  check('NO requests field', !('requests' in body));
  check('exactly one key (status only)', Object.keys(body).length === 1);
}

header('internal (no cf-ray) — full detail');
{
  const { httpStatus, body } = buildHealthResponse(healthy, 167, false);
  check('http 200', httpStatus === 200);
  check('oauth present', body.oauth === 'valid');
  check('expiresIn present', body.expiresIn === '4h 57m');
  check('requests present', body.requests === 167);
}

header('dead OAuth — 503 + degraded, both surfaces');
{
  const pub = buildHealthResponse(dead, 5, true);
  const int = buildHealthResponse(dead, 5, false);
  check('public 503', pub.httpStatus === 503);
  check('public degraded', pub.body.status === 'degraded');
  check('public still leaks nothing', !('oauth' in pub.body));
  check('internal 503', int.httpStatus === 503);
  check('internal degraded + oauth=broken', int.body.status === 'degraded' && int.body.oauth === 'broken');
}

header('refresh error fields — internal only, never public');
{
  const s = { status: 'expired', canRefresh: true, expiresIn: '0s', refreshFailures: 3, lastRefreshError: 'token endpoint 401' };
  const pub = buildHealthResponse(s, 1, true);
  const int = buildHealthResponse(s, 1, false);
  check('public hides refreshFailures', !('refreshFailures' in pub.body));
  check('public hides lastRefreshError', !('lastRefreshError' in pub.body));
  check('internal shows refreshFailures', int.body.refreshFailures === 3);
  check('internal shows lastRefreshError', int.body.lastRefreshError === 'token endpoint 401');
}

console.log(`\nhealth-response: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

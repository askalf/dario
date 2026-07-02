// Tests for buildHealthResponse — the /health public-vs-internal disclosure rule.
//
// Public requests (through the Cloudflare tunnel, marked by `cf-ray`) must get
// ONLY the liveness verdict; internal loopback callers get full OAuth detail.
// The HTTP status code is identical for both so external uptime checks still work.

import { buildHealthResponse, derivePoolStatus, shouldDiscloseHealthInternals } from '../dist/health-response.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const healthy = { status: 'valid', expiresIn: '4h 57m', canRefresh: true };
const dead = { status: 'broken', expiresIn: '0s', canRefresh: false };

// NOTE: buildHealthResponse's 3rd arg is now `includeInternal` (#642):
//   true  -> full detail (trusted caller)   false -> minimal liveness (public).
// The trust DECISION lives in shouldDiscloseHealthInternals, tested below.
header('minimal (untrusted) — liveness only, no OAuth leak');
{
  const { httpStatus, body } = buildHealthResponse(healthy, 167, false);
  check('http 200 when healthy', httpStatus === 200);
  check('status ok', body.status === 'ok');
  check('NO oauth field', !('oauth' in body));
  check('NO expiresIn field', !('expiresIn' in body));
  check('NO requests field', !('requests' in body));
  check('exactly one key (status only)', Object.keys(body).length === 1);
}

header('internal (trusted) — full detail');
{
  const { httpStatus, body } = buildHealthResponse(healthy, 167, true);
  check('http 200', httpStatus === 200);
  check('oauth present', body.oauth === 'valid');
  check('expiresIn present', body.expiresIn === '4h 57m');
  check('requests present', body.requests === 167);
}

header('dead OAuth — 503 + degraded, both surfaces');
{
  const pub = buildHealthResponse(dead, 5, false);
  const int = buildHealthResponse(dead, 5, true);
  check('public 503', pub.httpStatus === 503);
  check('public degraded', pub.body.status === 'degraded');
  check('public still leaks nothing', !('oauth' in pub.body));
  check('internal 503', int.httpStatus === 503);
  check('internal degraded + oauth=broken', int.body.status === 'degraded' && int.body.oauth === 'broken');
}

header('refresh error fields — lastRefreshError never on /health (#642), refreshFailures internal-only');
{
  const s = { status: 'expired', canRefresh: true, expiresIn: '0s', refreshFailures: 3, lastRefreshError: 'token endpoint 401' };
  const pub = buildHealthResponse(s, 1, false);
  const int = buildHealthResponse(s, 1, true);
  check('public hides refreshFailures', !('refreshFailures' in pub.body));
  check('lastRefreshError never on /health, even internal (#642)', !('lastRefreshError' in int.body) && !('lastRefreshError' in pub.body));
  check('internal shows refreshFailures', int.body.refreshFailures === 3);
}

// ── version field — internal only (#640) ─────────────────────────────────

header('buildHealthResponse — version on internal, hidden from public');
{
  const withVer = { status: 'valid', expiresIn: '4h', canRefresh: true, version: '4.8.118' };
  const int = buildHealthResponse(withVer, 1, true);
  check('internal /health includes version', int.body.version === '4.8.118');
  const pub = buildHealthResponse(withVer, 1, false);
  check('public /health hides version (like OAuth internals)', !('version' in pub.body));
  const noVer = buildHealthResponse({ status: 'valid', canRefresh: true }, 0, true);
  check('version omitted when not supplied', !('version' in noVer.body));
}

// ── shouldDiscloseHealthInternals — the /health trust gate (#642) ─────────

header('shouldDiscloseHealthInternals — closed to the cf-ray fail-open');
{
  const D = shouldDiscloseHealthInternals;
  check('authenticated caller -> internal', D({ authenticated: true, loopback: false, viaCfRay: false }) === true);
  check('authenticated wins even via CF', D({ authenticated: true, loopback: false, viaCfRay: true }) === true);
  check('bare loopback (docker HC / doctor) -> internal', D({ authenticated: false, loopback: true, viaCfRay: false }) === true);
  check('loopback but via CF tunnel -> public (sidecar case)', D({ authenticated: false, loopback: true, viaCfRay: true }) === false);
  check('THE #642 BUG: non-loopback, no cf-ray, unauthed -> public (was fail-open)', D({ authenticated: false, loopback: false, viaCfRay: false }) === false);
  check('public tunnel, unauthed -> public', D({ authenticated: false, loopback: false, viaCfRay: true }) === false);
}

// ── derivePoolStatus — pool-aware /status + /health (#636) ────────────────

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

header('derivePoolStatus — empty admin pool');
{
  const s = derivePoolStatus([], NOW, true);
  check('not authenticated', s.authenticated === false);
  check('status none', s.status === 'none');
  check('mode pool, 0 accounts', s.mode === 'pool' && s.accounts === 0);
  check('hint points at the admin API, not `dario login`', s.expiresIn.includes('POST /admin/login/start'));
  const { httpStatus } = buildHealthResponse(s, 0, false);
  check('empty pool → /health 503 (every LLM call would 503)', httpStatus === 503);
}

header('derivePoolStatus — empty non-admin pool');
{
  const s = derivePoolStatus([], NOW, false);
  check('hint points at accounts add', s.expiresIn.includes('dario accounts add'));
}

header('derivePoolStatus — one healthy account (the #636 repro shape)');
{
  const s = derivePoolStatus([{ expiresAt: NOW + 2 * HOUR, inAuthCooldown: false }], NOW, true);
  check('authenticated', s.authenticated === true);
  check('status healthy', s.status === 'healthy');
  check('1 account reported', s.accounts === 1);
  check('expiresAt = the account expiry', s.expiresAt === NOW + 2 * HOUR);
  check('expiresIn formatted', s.expiresIn === '2h 0m');
  const { httpStatus, body } = buildHealthResponse(s, 5, false);
  check('healthy pool → /health 200 (docker healthcheck passes)', httpStatus === 200);
  check('/health body says ok', body.status === 'ok');
}

header('derivePoolStatus — cooldown accounts excluded from expiry');
{
  const s = derivePoolStatus(
    [
      { expiresAt: NOW + 1 * HOUR, inAuthCooldown: true },   // earlier, but dead
      { expiresAt: NOW + 3 * HOUR, inAuthCooldown: false },
    ],
    NOW,
    false,
  );
  check('still healthy while one usable account remains', s.status === 'healthy');
  check('expiry from the USABLE account, not the cooldown one', s.expiresAt === NOW + 3 * HOUR);
  check('accounts counts all entries', s.accounts === 2);
}

header('derivePoolStatus — all accounts in auth-cooldown');
{
  const s = derivePoolStatus(
    [
      { expiresAt: NOW + 1 * HOUR, inAuthCooldown: true },
      { expiresAt: NOW + 2 * HOUR, inAuthCooldown: true },
    ],
    NOW,
    false,
  );
  check('not authenticated', s.authenticated === false);
  check('status broken', s.status === 'broken');
  check('says why', s.expiresIn === 'all accounts in auth-cooldown');
  check('all-cooldown pool → /health 503', buildHealthResponse(s, 0, false).httpStatus === 503);
}

header('derivePoolStatus — expired-but-usable clamps to 0h 0m');
{
  const s = derivePoolStatus([{ expiresAt: NOW - HOUR, inAuthCooldown: false }], NOW, false);
  check('healthy (background refresh will roll it)', s.status === 'healthy');
  check('expiresIn clamped, not negative', s.expiresIn === '0h 0m');
}

console.log(`\nhealth-response: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

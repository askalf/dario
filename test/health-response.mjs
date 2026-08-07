// Tests for buildHealthResponse — the /health public-vs-internal disclosure rule.
//
// Public requests (through the Cloudflare tunnel, marked by `cf-ray`) must get
// ONLY the liveness verdict; internal loopback callers get full OAuth detail.
// The HTTP status code is identical for both so external uptime checks still work.

import { buildHealthResponse, derivePoolStatus, probeRequested, shouldDiscloseHealthInternals, shouldRunServingProbe } from '../dist/health-response.js';

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

// ── sessions field — live session/sticky counts, internal only ───────────

header('buildHealthResponse — sessions on internal, hidden from public');
{
  const single = { status: 'valid', expiresIn: '4h', canRefresh: true, sessions: { mode: 'single', active: 3 } };
  const int = buildHealthResponse(single, 1, true);
  check('internal /health includes sessions', int.body.sessions?.mode === 'single' && int.body.sessions?.active === 3);
  const pub = buildHealthResponse(single, 1, false);
  check('public /health hides sessions (like OAuth internals)', !('sessions' in pub.body));

  const pool = { status: 'valid', expiresIn: '4h', canRefresh: true, sessions: { mode: 'pool', stickyBindings: 7 } };
  const poolInt = buildHealthResponse(pool, 1, true);
  check('internal /health surfaces pool sticky bindings', poolInt.body.sessions?.mode === 'pool' && poolInt.body.sessions?.stickyBindings === 7);

  const noSess = buildHealthResponse({ status: 'valid', canRefresh: true }, 0, true);
  check('sessions omitted when not supplied', !('sessions' in noSess.body));
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

// ── serving probe on /health (#905) ──────────────────────────────────────
//
// The probe is what turns /health from "state looks fine" into "a request
// actually completed". Its verdict has to be authoritative over the structural
// read — that combination (clean locally, failing upstream) is the entire
// reason the probe exists — and it must stay off the public surface, because a
// probe is a real billed request and /health can be world-readable.

const okProbe   = { ok: true,  reason: 'served',        checkedAt: NOW - 5_000, latencyMs: 812, model: 'claude-haiku-4-5', status: 200 };
const failProbe = { ok: false, reason: 'auth-rejected', checkedAt: NOW - 5_000, latencyMs: 233, model: 'claude-haiku-4-5', status: 401, detail: 'upstream rejected the credential' };

header('probe verdict overrides a clean structural read');
{
  // This is the #905 shape: OAuth valid, refresh fine, nothing structurally
  // wrong — and every real request failing.
  const { httpStatus, body } = buildHealthResponse({ ...healthy, probe: failProbe }, 9, true, NOW);
  check('failed probe → 503 despite healthy OAuth', httpStatus === 503);
  check('body says degraded', body.status === 'degraded');
  check('oauth still reports valid (not masked)', body.oauth === 'valid');
  check('probe reason surfaced', body.probe.reason === 'auth-rejected');
  check('probe status surfaced', body.probe.status === 401);
  check('ageMs computed against the supplied clock', body.probe.ageMs === 5_000);
}

header('a passing probe does not rescue dead OAuth');
{
  const { httpStatus, body } = buildHealthResponse({ ...dead, probe: okProbe }, 1, true, NOW);
  check('structural death still 503', httpStatus === 503);
  check('degraded', body.status === 'degraded');
}

header('passing probe on a healthy proxy — 200, verdict attached');
{
  const { httpStatus, body } = buildHealthResponse({ ...healthy, probe: okProbe }, 1, true, NOW);
  check('200', httpStatus === 200);
  check('status ok', body.status === 'ok');
  check('probe ok', body.probe.ok === true);
  check('latency carried', body.probe.latencyMs === 812);
}

header('a throttled probe is NOT an outage (anti restart-loop)');
{
  const throttled = { ...okProbe, reason: 'rate-limited', status: 429 };
  const { httpStatus, body } = buildHealthResponse({ ...healthy, probe: throttled }, 1, true, NOW);
  check('429 verdict keeps /health at 200', httpStatus === 200);
  check('but the reason is visible to an operator', body.probe.reason === 'rate-limited');
}

header('probe is internal-only, and absent means "not asked for"');
{
  const pub = buildHealthResponse({ ...healthy, probe: failProbe }, 1, false, NOW);
  check('public body carries no probe detail', !('probe' in pub.body));
  check('public STILL 503 so uptime monitors see the outage', pub.httpStatus === 503);

  const noProbe = buildHealthResponse(healthy, 1, true, NOW);
  check('no probe field when none was run', !('probe' in noProbe.body));
  check('and that is not treated as a failure', noProbe.httpStatus === 200);
}

// ── queue stall rendering (#905) ─────────────────────────────────────────

header('queue.stalledSince renders an elapsed duration too');
{
  const q = { active: 10, queued: 4, maxConcurrent: 10, maxQueued: 128, stalledSince: NOW - 8 * HOUR };
  const { body } = buildHealthResponse({ ...healthy, queue: q }, 1, true, NOW);
  check('raw stamp preserved', body.queue.stalledSince === NOW - 8 * HOUR);
  check('elapsed precomputed for shell healthchecks', body.queue.stalledForMs === 8 * HOUR);
  check('depth fields untouched', body.queue.active === 10 && body.queue.queued === 4);
}

header('a flowing queue reports no stall');
{
  const q = { active: 10, queued: 4, maxConcurrent: 10, maxQueued: 128, stalledSince: null };
  const { body } = buildHealthResponse({ ...healthy, queue: q }, 1, true, NOW);
  check('stalledSince null', body.queue.stalledSince === null);
  check('no stalledForMs to misread', !('stalledForMs' in body.queue));
  check('saturated depth alone never sets 503', buildHealthResponse({ ...healthy, queue: q }, 1, true, NOW).httpStatus === 200);
}

header('queue stays internal-only');
{
  const q = { active: 10, queued: 4, maxConcurrent: 10, maxQueued: 128, stalledSince: NOW - 1000 };
  const pub = buildHealthResponse({ ...healthy, queue: q }, 1, false, NOW);
  check('public body hides queue', !('queue' in pub.body));
}

// ── probeRequested — the opt-in gate (#905) ──────────────────────────────

header('probeRequested — off by default, and off on falsey spellings');
{
  const P = probeRequested;
  check('no url → false', P(undefined) === false);
  check('no query → false', P('/health') === false);
  check('unrelated query → false', P('/health?verbose=1') === false);
  check('probe=1 → true', P('/health?probe=1') === true);
  check('probe=true → true', P('/health?probe=true') === true);
  check('probe=TRUE → true', P('/health?probe=TRUE') === true);
  check('bare ?probe → true', P('/health?probe') === true);
  check('probe=0 → false (templated boolean must mean what it says)', P('/health?probe=0') === false);
  check('probe=false → false', P('/health?probe=false') === false);
  check('probe=yes → false (unparseable defaults OFF — it spends tokens)', P('/health?probe=yes') === false);
  check('works alongside other params', P('/health?foo=bar&probe=1') === true);
}

header('shouldRunServingProbe — stricter than disclosure, because it spends money');
{
  const R = shouldRunServingProbe;
  check('not requested → never runs', R({ requested: false, discloseInternals: true, viaCfRay: false }) === false);
  check('trusted loopback + requested → runs', R({ requested: true, discloseInternals: true, viaCfRay: false }) === true);
  check('untrusted caller → refused', R({ requested: true, discloseInternals: false, viaCfRay: false }) === false);
  // The case the disclosure gate alone gets wrong: authenticateRequest returns
  // true when NO api key is configured, so discloseInternals can be true for a
  // caller off the public internet. Disclosing a field is survivable; billing
  // the operator on demand is not.
  check('via CF tunnel → refused EVEN when disclosure says internal',
    R({ requested: true, discloseInternals: true, viaCfRay: true }) === false);
  check('via CF tunnel and untrusted → refused', R({ requested: true, discloseInternals: false, viaCfRay: true }) === false);
  check('gate can only ever deny, never widen',
    [true, false].every((d) => [true, false].every((c) =>
      R({ requested: true, discloseInternals: d, viaCfRay: c }) === (d && !c))));
}

console.log(`\nhealth-response: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

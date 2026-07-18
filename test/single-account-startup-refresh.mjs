#!/usr/bin/env node
/**
 * resolveSingleAccountStartupStatus — single-account startup self-heal.
 *
 * Regression guard for the 2026-07-02 outage-hardening gap #1. In
 * single-account mode dario's proxy startup used to read getStatus() once and,
 * on ANY un-authenticated result, log "Not authenticated" and process.exit(1)
 * WITHOUT attempting a refresh. Because Docker restarts the container, that
 * turned a routine access-token expiry into a CRASH LOOP even when the refresh
 * token was still valid and one refresh would have recovered.
 *
 * The helper now attempts a refresh (via the injected getAccessToken) for an
 * expired-but-refreshable token, then RE-READS getStatus() and lets its
 * `authenticated` flag decide start-vs-exit. getAccessToken() swallows a failed
 * refresh in production (returns the stale token, throws only when there are no
 * credentials at all), so the re-read — not getAccessToken's throw — is the
 * authority. These tests inject fakes so no real credentials touch disk.
 *
 * Covers the four acceptance scenarios:
 *   1. expired access token + VALID refresh token → refreshes → authenticated
 *      (proxy starts, no exit).
 *   2. dead refresh token (invalid_grant) → still un-authenticated on re-read
 *      → caller exits 1 (no infinite loop).
 *   3. no credentials at all ('none') → unchanged, un-authenticated → exit 1,
 *      and no refresh is even attempted.
 *   4. already-authenticated (healthy/expiring) → returned untouched, no
 *      refresh attempted.
 */

import { resolveSingleAccountStartupStatus } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const NOW = Date.now();
const HOUR = 3_600_000;

// Build a getStatus fake that returns the queued results in order; the last
// entry is repeated for any further calls. Records how many times it ran so we
// can assert the re-read did (or did not) happen.
function fakeGetStatus(...results) {
  const calls = { count: 0 };
  const fn = async () => {
    const idx = Math.min(calls.count, results.length - 1);
    calls.count++;
    return results[idx];
  };
  fn.calls = calls;
  return fn;
}

// getAccessToken fake — records invocation and optionally throws (production
// getAccessToken throws only when there are no credentials at all).
function fakeGetAccessToken({ throws = null, token = 'ak-refreshed' } = {}) {
  const calls = { count: 0 };
  const fn = async () => {
    calls.count++;
    if (throws) throw throws;
    return token;
  };
  fn.calls = calls;
  return fn;
}

// ────────────────────────────────────────────────────────────────────
header('1. expired access token + VALID refresh token → refreshes → starts');
{
  // First read: expired but refreshable. getAccessToken refreshes in place.
  // Re-read: healthy + authenticated (saveCredentials updated the cache).
  const getStatus = fakeGetStatus(
    { authenticated: false, status: 'expired', expiresAt: NOW - HOUR, canRefresh: true },
    { authenticated: true, status: 'healthy', expiresAt: NOW + 8 * HOUR, expiresIn: '8h 0m' },
  );
  const getAccessToken = fakeGetAccessToken();
  const result = await resolveSingleAccountStartupStatus({ getStatus, getAccessToken });

  check('result.authenticated === true (proxy starts, no exit)', result.authenticated === true);
  check('result.status === "healthy" (post-refresh)', result.status === 'healthy');
  check('getAccessToken was called exactly once (refresh attempted)', getAccessToken.calls.count === 1);
  check('getStatus was called twice (initial + re-read)', getStatus.calls.count === 2);
}

// ────────────────────────────────────────────────────────────────────
header('2. dead refresh token (invalid_grant) → still exits (no loop)');
{
  // First read: expired + refreshable (not yet known-broken). getAccessToken
  // ATTEMPTS the refresh but it fails; in production that failure is swallowed
  // and the stale token returned, so the re-read is still un-authenticated.
  const getStatus = fakeGetStatus(
    { authenticated: false, status: 'expired', expiresAt: NOW - HOUR, canRefresh: true },
    { authenticated: false, status: 'expired', expiresAt: NOW - HOUR, canRefresh: true, refreshFailures: 1 },
  );
  // Model production's swallow: getAccessToken returns the stale token (no throw).
  const getAccessToken = fakeGetAccessToken({ token: 'ak-stale' });
  const result = await resolveSingleAccountStartupStatus({ getStatus, getAccessToken });

  check('result.authenticated === false (caller exits 1)', result.authenticated === false);
  check('getAccessToken was called once (one attempt, no retry loop)', getAccessToken.calls.count === 1);
  check('getStatus was called twice (attempt + re-read, no loop)', getStatus.calls.count === 2);
}

// ────────────────────────────────────────────────────────────────────
header('2b. broken refresh (already-dead) → no attempt, exits');
{
  // status 'broken' means REFRESH_BROKEN_THRESHOLD consecutive failures already
  // happened, so canRefresh is false — don't waste an attempt, just exit.
  const getStatus = fakeGetStatus(
    { authenticated: false, status: 'broken', expiresAt: NOW - HOUR, canRefresh: false, refreshFailures: 3 },
  );
  const getAccessToken = fakeGetAccessToken();
  const result = await resolveSingleAccountStartupStatus({ getStatus, getAccessToken });

  check('result.authenticated === false (caller exits 1)', result.authenticated === false);
  check('getAccessToken was NOT called (no doomed attempt)', getAccessToken.calls.count === 0);
  check('getStatus was called once (no re-read when no attempt)', getStatus.calls.count === 1);
}

// ────────────────────────────────────────────────────────────────────
header('3. no credentials at all ("none") → unchanged, exits, no attempt');
{
  const getStatus = fakeGetStatus(
    { authenticated: false, status: 'none' },
  );
  const getAccessToken = fakeGetAccessToken({ throws: new Error('Not authenticated. Run `dario login` first.') });
  const result = await resolveSingleAccountStartupStatus({ getStatus, getAccessToken });

  check('result.authenticated === false (caller exits 1)', result.authenticated === false);
  check('result.status === "none"', result.status === 'none');
  check('getAccessToken was NOT called (no creds → nothing to refresh)', getAccessToken.calls.count === 0);
  check('getStatus was called once (no re-read)', getStatus.calls.count === 1);
}

// ────────────────────────────────────────────────────────────────────
header('4. already-authenticated → returned untouched, no refresh attempted');
{
  for (const st of ['healthy', 'expiring']) {
    const getStatus = fakeGetStatus(
      { authenticated: true, status: st, expiresAt: NOW + 8 * HOUR, expiresIn: '8h 0m' },
    );
    const getAccessToken = fakeGetAccessToken();
    const result = await resolveSingleAccountStartupStatus({ getStatus, getAccessToken });

    check(`status "${st}": result.authenticated === true`, result.authenticated === true);
    check(`status "${st}": getAccessToken NOT called (already valid)`, getAccessToken.calls.count === 0);
    check(`status "${st}": getStatus called once (no re-read)`, getStatus.calls.count === 1);
  }
}

// ────────────────────────────────────────────────────────────────────
header('5. getAccessToken throwing does not break start when re-read recovers');
{
  // Defensive: even if getAccessToken throws (e.g. a transient no-creds race),
  // a successful re-read should still start the proxy — the re-read is the
  // authority, and the throw is caught.
  const getStatus = fakeGetStatus(
    { authenticated: false, status: 'expired', expiresAt: NOW - HOUR, canRefresh: true },
    { authenticated: true, status: 'healthy', expiresAt: NOW + 8 * HOUR, expiresIn: '8h 0m' },
  );
  const getAccessToken = fakeGetAccessToken({ throws: new Error('transient') });
  const result = await resolveSingleAccountStartupStatus({ getStatus, getAccessToken });

  check('throw is caught; re-read authority wins → authenticated', result.authenticated === true);
  check('getAccessToken was attempted once', getAccessToken.calls.count === 1);
}

// ────────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

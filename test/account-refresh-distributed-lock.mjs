// Unit test for the distributed refresh lock layer (dario#993) in
// refreshAccountToken. Same monkeypatch-fetch strategy as
// account-refresh-singleflight.mjs — no real network, no real Cloudflare
// call. The stub distinguishes lock calls (URL contains "/lock/") from
// the real OAuth refresh call (URL contains "/oauth/token") so each test
// can assert exactly which path fired.

import { refreshAccountToken, removeAccount } from '../dist/accounts.js';

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

const originalFetch = globalThis.fetch;
function restoreFetch() { globalThis.fetch = originalFetch; }

const fixture = {
  alias: 'test-lock-account',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1000,
  scopes: [],
  deviceId: 'd-1',
  accountUuid: 'u-1',
};

// ======================================================================
//  DARIO_REFRESH_LOCK_URL unset → byte-identical to before, no lock calls
// ======================================================================
header('unset DARIO_REFRESH_LOCK_URL — no lock traffic at all, refreshes directly');
{
  delete process.env.DARIO_REFRESH_LOCK_URL;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updated = await refreshAccountToken(fixture);
  check('exactly one fetch (the real refresh, no lock calls)', calls.length === 1);
  check('that one fetch went to the oauth token endpoint', calls[0].includes('/oauth/token'));
  check('refresh actually happened', updated.accessToken === 'a');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  Lock acquired → refreshes, then releases with the new credentials
// ======================================================================
header('lock acquired — real refresh happens, release carries the new credentials');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  process.env.DARIO_REFRESH_LOCK_TOKEN = 'tok';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { /* form-encoded oauth body, not JSON */ }
    calls.push({ url: u, body });
    if (u.includes('/acquire')) return new Response(JSON.stringify({ acquired: true }), { status: 200 });
    if (u.includes('/release')) return new Response(JSON.stringify({ released: true }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updated = await refreshAccountToken(fixture);
  check('three calls: acquire, real refresh, release', calls.length === 3);
  check('first call is acquire', calls[0].url.includes('/acquire'));
  check('second call is the real oauth refresh', calls[1].url.includes('/oauth/token'));
  check('third call is release', calls[2].url.includes('/release'));
  check('release body carries the NEW access token, not the old one', calls[2].body.credentials.accessToken === 'new-a');
  check('caller receives the refreshed credentials', updated.accessToken === 'new-a');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  Lock NOT acquired but fresher credentials handed back → adopt them,
//  NEVER call the real refresh endpoint at all
// ======================================================================
header('lock lost, but fresher credentials came back — adopts them, zero refresh calls');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const winnerCreds = { ...fixture, accessToken: 'winner-access', refreshToken: 'winner-refresh', expiresAt: 999999 };
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) return new Response(JSON.stringify({ acquired: false, credentials: winnerCreds }), { status: 200 });
    throw new Error(`unexpected call to ${u} — should have adopted cached credentials instead`);
  };
  const updated = await refreshAccountToken(fixture);
  check('exactly one call (acquire) — no refresh, no release', calls.length === 1);
  check('adopted the WINNER credentials, not a fresh refresh of our own', updated.accessToken === 'winner-access');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  Lock service unreachable → fails OPEN, refreshes directly
// ======================================================================
header('lock service network error — fails open, refreshes exactly as if unconfigured');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify({ access_token: 'fallback-a', refresh_token: 'fallback-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updated = await refreshAccountToken(fixture);
  check('attempted acquire, then fell back to a real refresh (2 calls)', calls.length === 2);
  check('the fallback refresh actually completed', updated.accessToken === 'fallback-a');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  Lock acquired but the real refresh THROWS → release carries NO
//  credentials, so the next acquirer is forced to attempt a real refresh
//  rather than adopting a failure as if it were success
// ======================================================================
header('acquired, but refresh fails — release happens with no credentials, error still propagates');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { /* form-encoded oauth body, not JSON */ }
    calls.push({ url: u, body });
    if (u.includes('/acquire')) return new Response(JSON.stringify({ acquired: true }), { status: 200 });
    if (u.includes('/release')) return new Response(JSON.stringify({ released: true }), { status: 200 });
    return new Response('invalid_grant', { status: 400 });
  };
  let threw = false;
  try {
    await refreshAccountToken(fixture);
  } catch {
    threw = true;
  }
  check('the refresh failure still propagates to the caller', threw);
  const release = calls.find((c) => c.url.includes('/release'));
  check('release was still called (lock not left dangling)', !!release);
  check('release body carries NO credentials on failure', !('credentials' in (release?.body || { credentials: 1 })));
  await removeAccount(fixture.alias);
}

// ----- cleanup ---------------------------------------------------------
restoreFetch();
delete process.env.DARIO_REFRESH_LOCK_URL;
delete process.env.DARIO_REFRESH_LOCK_TOKEN;

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

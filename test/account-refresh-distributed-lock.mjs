// Unit test for the distributed refresh lock layer (dario#993) in
// refreshAccountToken. Same monkeypatch-fetch strategy as
// account-refresh-singleflight.mjs — no real network, no real Cloudflare
// call. The stub distinguishes lock calls (URL contains "/lock/") from
// the real OAuth refresh call (URL contains "/oauth/token") so each test
// can assert exactly which path fired.

import { refreshAccountToken, removeAccount, adoptSharedCredentials, loadAccount, saveAccount } from '../dist/accounts.js';

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
    if (u.includes('/acquire')) return new Response(JSON.stringify({ acquired: true, lockId: 'srv-lock-1' }), { status: 200 });
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
  // redis-lock/server.mjs rejects a release without the server-issued
  // lockId (400 'lockId required'), so failing to echo it back would leave
  // every lock to expire on TTL instead of on release.
  check('release echoes the server-issued lockId back', calls[2].body.lockId === 'srv-lock-1');
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
  // A live expiry: adopted credentials that are already expired are refreshed
  // on the spot instead (covered below), not handed back.
  const winnerCreds = { ...fixture, accessToken: 'winner-access', refreshToken: 'winner-refresh', expiresAt: Date.now() + 8 * 3_600_000 };
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
    if (u.includes('/acquire')) return new Response(JSON.stringify({ acquired: true, lockId: 'srv-lock-2' }), { status: 200 });
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
  // The lockId is what makes that release actually land. Dropping it on the
  // error path would strand the lock for its full TTL precisely when the
  // next acquirer most needs a turn — a failed refresh means the account is
  // already in trouble.
  check('failure-path release still echoes the lockId', release?.body?.lockId === 'srv-lock-2');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  No-lockId backend compatibility: both bundled backends (redis-lock
//  and the Cloudflare Worker) now issue a lockId, but an un-upgraded
//  server or a third-party implementation of the contract may not. The
//  client must not invent one or refuse to release — its release body
//  has to stay byte-identical to the pre-lockId shape.
// ======================================================================
header('backend issues no lockId (un-upgraded/third-party) — release still goes out, with no lockId key');
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
    return new Response(JSON.stringify({ access_token: 'cf-a', refresh_token: 'cf-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updated = await refreshAccountToken(fixture);
  const release = calls.find((c) => c.url.includes('/release'));
  check('release was still called', !!release);
  check('release still carries the holder', typeof release?.body?.holder === 'string');
  check('no lockId key at all — undefined is dropped by JSON.stringify', !('lockId' in (release?.body || { lockId: 1 })));
  check('refresh completed normally', updated.accessToken === 'cf-a');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  dario#1733: the acquire carries the grant time, so the lock service can
//  tell a re-login from a peer still refreshing the old grant
// ======================================================================
header('acquire body carries currentGrantedAt');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/acquire')) { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ acquired: true, lockId: 'l' }), { status: 200 }); }
    if (u.includes('/release')) return new Response(JSON.stringify({ released: true }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'g-a', refresh_token: 'g-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await refreshAccountToken({ ...fixture, grantedAt: 1234 });
  check('currentGrantedAt is the record\'s grantedAt', bodies[0]?.currentGrantedAt === 1234);
  check('currentExpiresAt still sent', bodies[0]?.currentExpiresAt === fixture.expiresAt);
  await removeAccount(fixture.alias);
}

// ======================================================================
//  dario#1733: adopted credentials that are already expired. A peer that
//  went quiet leaves its last access token cached past its expiry, but its
//  refresh token is still the live one: refresh with THAT, never with ours.
// ======================================================================
header('adopted credentials already expired: refreshes with the ADOPTED refresh token');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const peer = { ...fixture, accessToken: 'peer-access', refreshToken: 'peer-refresh', expiresAt: Date.now() - 60_000 };
  const calls = [];
  let acquires = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body });
    if (u.includes('/acquire')) {
      acquires++;
      const b = JSON.parse(init.body);
      // Hands the peer's credentials to anyone older, as both backends do.
      if (b.currentExpiresAt < peer.expiresAt) return new Response(JSON.stringify({ acquired: false, credentials: peer }), { status: 200 });
      return new Response(JSON.stringify({ acquired: true, lockId: 'l2' }), { status: 200 });
    }
    if (u.includes('/release')) return new Response(JSON.stringify({ released: true }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'after-a', refresh_token: 'after-r', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updated = await refreshAccountToken(fixture);
  const oauth = calls.filter((c) => c.url.includes('/oauth/token'));
  check('two acquires: the adoption, then the lock', acquires === 2);
  check('exactly one real refresh', oauth.length === 1);
  check('the refresh presented the ADOPTED refresh token', String(oauth[0]?.body).includes('refresh_token=peer-refresh'));
  check('never presented our own rotated-away token', !String(oauth[0]?.body).includes('old-refresh'));
  check('caller gets the new pair', updated.accessToken === 'after-a');
  await removeAccount(fixture.alias);
}

// ======================================================================
//  dario#1733: lock service down. Uncoordinated refreshes can rotate the
//  token out from under a peer, so they wait while the token has life left.
// ======================================================================
header('lock service down, token has 40 minutes left: deferred, no refresh');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let err = null;
  try { await refreshAccountToken({ ...fixture, expiresAt: Date.now() + 40 * 60_000 }); } catch (e) { err = e; }
  check('throws so the tick logs it and tries again later', err !== null);
  check('the error says it was deferred', /deferring/.test(String(err?.message)));
  check('no call reached the token endpoint', !calls.some((u) => u.includes('/oauth/token')));
  await removeAccount(fixture.alias);
}

header('lock service down, token has 10 minutes left: refreshes uncoordinated');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) return new Response('bad gateway', { status: 502 });
    return new Response(JSON.stringify({ access_token: 'late-a', refresh_token: 'late-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updated = await refreshAccountToken({ ...fixture, expiresAt: Date.now() + 10 * 60_000 });
  check('refreshed directly', updated.accessToken === 'late-a');
  check('one acquire, one refresh', calls.length === 2 && calls[1].includes('/oauth/token'));
  await removeAccount(fixture.alias);
}

// ======================================================================
//  adoptSharedCredentials: the read-only /peek the proxy runs every tick
// ======================================================================
header('adoptSharedCredentials: peek, never refresh, never lock');
{
  delete process.env.DARIO_REFRESH_LOCK_URL;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no network expected'); };
  check('no lock service configured: null, no traffic', (await adoptSharedCredentials(fixture)) === null && calls === 0);

  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const peer = { ...fixture, accessToken: 'peek-a', refreshToken: 'peek-r', expiresAt: Date.now() + 8 * 3_600_000 };
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ credentials: peer }), { status: 200 });
  };
  await saveAccount(fixture);
  const got = await adoptSharedCredentials({ alias: fixture.alias, expiresAt: fixture.expiresAt, grantedAt: 77 });
  check('one call, to /peek', seen.length === 1 && seen[0].url === `http://lock.test/lock/${fixture.alias}/peek`);
  check('peek carries expiry and grant time', seen[0].body.currentExpiresAt === fixture.expiresAt && seen[0].body.currentGrantedAt === 77);
  check('returns the shared credentials', got?.refreshToken === 'peek-r');
  check('and saved them', (await loadAccount(fixture.alias))?.refreshToken === 'peek-r');
  await removeAccount(fixture.alias);

  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  check('nothing newer shared: null', (await adoptSharedCredentials(fixture)) === null);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  check('lock service without /peek (404): null', (await adoptSharedCredentials(fixture)) === null);
  globalThis.fetch = async () => new Response(JSON.stringify({ credentials: { ...peer, alias: 'someone-else' } }), { status: 200 });
  check('credentials for another alias are refused', (await adoptSharedCredentials(fixture)) === null);
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  check('unreachable: null, no throw', (await adoptSharedCredentials(fixture)) === null);
}

header('adoptSharedCredentials: a login saved while /peek is out survives');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  // The peer still refreshes the old grant, so its token expires LATER than
  // the new login's; the service judged it newer than the pre-login state.
  const oldGrant = { ...fixture, accessToken: 'g1-a', refreshToken: 'g1-r', expiresAt: Date.now() + 8 * 3_600_000, grantedAt: 1_000 };
  const login = { ...fixture, accessToken: 'g2-a', refreshToken: 'g2-r', expiresAt: Date.now() + 2 * 3_600_000, grantedAt: 2_000 };
  let answer;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  const pending = adoptSharedCredentials({ alias: fixture.alias, expiresAt: 1_000, grantedAt: 1_000 });
  while (!answer) await new Promise((r) => setImmediate(r));
  await saveAccount(login);
  answer(new Response(JSON.stringify({ credentials: oldGrant }), { status: 200 }));
  check('stale peek answer is not adopted; the newer login on disk comes back', (await pending)?.refreshToken === 'g2-r');
  check('the new login is still on disk', (await loadAccount(fixture.alias))?.refreshToken === 'g2-r');

  // Same race, but the answer really is newer than what landed meanwhile.
  answer = undefined;
  const newer = { ...login, accessToken: 'g2b-a', refreshToken: 'g2b-r', expiresAt: login.expiresAt + 3_600_000 };
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  const pending2 = adoptSharedCredentials({ alias: fixture.alias, expiresAt: 1_000, grantedAt: 1_000 });
  while (!answer) await new Promise((r) => setImmediate(r));
  answer(new Response(JSON.stringify({ credentials: newer }), { status: 200 }));
  check('a newer answer is still adopted', (await pending2)?.refreshToken === 'g2b-r'
    && (await loadAccount(fixture.alias))?.refreshToken === 'g2b-r');
  await removeAccount(fixture.alias);
}

header('adoptSharedCredentials: an old seat catches up when the file already has the rotation');
{
  // Replicas on one accounts volume: the peer saved its rotation before the
  // caller's seat, still on the old pair, asked the lock service.
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  const seat = { alias: fixture.alias, expiresAt: Date.now() + 30 * 60_000, grantedAt: 1_000 };
  const rotated = { ...fixture, accessToken: 'rot-a', refreshToken: 'rot-r', expiresAt: Date.now() + 8 * 3_600_000, grantedAt: 1_000 };
  await saveAccount(rotated);
  globalThis.fetch = async () => new Response(JSON.stringify({ credentials: rotated }), { status: 200 });
  check('same rotation already on disk: handed back', (await adoptSharedCredentials(seat))?.refreshToken === 'rot-r');

  // A newer grant that expires earlier is already on disk; the service still
  // answers with an older grant that expires later.
  const relogin = { ...fixture, accessToken: 'g2-a', refreshToken: 'g2-r', expiresAt: Date.now() + 2 * 3_600_000, grantedAt: 2_000 };
  await saveAccount(relogin);
  globalThis.fetch = async () => new Response(JSON.stringify({ credentials: rotated }), { status: 200 });
  const got = await adoptSharedCredentials(seat);
  check('newer grant on disk: the file is handed back, not the answer', got?.refreshToken === 'g2-r' && got?.grantedAt === 2_000);
  check('the file is not rewritten with the older answer', (await loadAccount(fixture.alias))?.refreshToken === 'g2-r');

  // Nothing newer than the caller anywhere: nothing to adopt.
  check('caller already current: null', (await adoptSharedCredentials(relogin)) === null);
  await removeAccount(fixture.alias);
}

header('adoptSharedCredentials: an account removed while /peek is out stays removed');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  await saveAccount(fixture);
  const peer = { ...fixture, accessToken: 'gone-a', refreshToken: 'gone-r', expiresAt: Date.now() + 8 * 3_600_000 };
  let answer;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  const pending = adoptSharedCredentials(fixture);
  while (!answer) await new Promise((r) => setImmediate(r));
  check('removal goes through', (await removeAccount(fixture.alias)) === true);
  answer(new Response(JSON.stringify({ credentials: peer }), { status: 200 }));
  check('newer answer for a removed account is not adopted', (await pending) === null);
  check('no account file written back', (await loadAccount(fixture.alias)) === null);

  // A removal queued behind an adoption write still lands after it.
  await saveAccount(fixture);
  answer = undefined;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  const pending2 = adoptSharedCredentials(fixture);
  while (!answer) await new Promise((r) => setImmediate(r));
  answer(new Response(JSON.stringify({ credentials: peer }), { status: 200 }));
  const removal = removeAccount(fixture.alias);
  await pending2;
  check('removal after the adoption write wins', (await removal) === true && (await loadAccount(fixture.alias)) === null);
}

// ----- cleanup ---------------------------------------------------------
restoreFetch();
delete process.env.DARIO_REFRESH_LOCK_URL;
delete process.env.DARIO_REFRESH_LOCK_TOKEN;

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

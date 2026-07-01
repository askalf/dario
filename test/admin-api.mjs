#!/usr/bin/env node
// Tests for the headless admin API (#599), src/admin-api.ts.
//
// Exercises the request handler with mock req/res — no network, no real OAuth.
// The token-exchange path (completeAddAccount) is a thin wrapper over the
// already-tested accounts.ts exchange and needs a live OAuth server, so it's
// covered by the headless live test, not here. Everything else — auth gating,
// PKCE login/start, alias validation, pending-login TTL, list, delete, method
// + path routing — is asserted offline.

import { EventEmitter } from 'node:events';
import { handleAdminRequest, _resetAdminStateForTest } from '../dist/admin-api.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const TOKEN = 's3cret-admin-token';
const TOKEN_BUF = Buffer.from(TOKEN);

function mockReq(method, url, headers = {}, bodyObj = undefined) {
  const r = new EventEmitter();
  r.method = method;
  r.url = url;
  r.headers = headers;
  r.destroy = () => {};
  // Emit the body after the handler has attached its 'data'/'end' listeners.
  setImmediate(() => {
    if (bodyObj !== undefined) r.emit('data', Buffer.from(JSON.stringify(bodyObj)));
    r.emit('end');
  });
  return r;
}
function mockRes() {
  return {
    statusCode: 0, headers: null, body: '', ended: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    end(b) { this.body = b || ''; this.ended = true; return this; },
  };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
async function call(method, url, { token, body, path } = {}) {
  const headers = token ? bearer(token) : {};
  const req = mockReq(method, url, headers, body);
  const res = mockRes();
  const urlPath = path ?? url.split('?')[0];
  const handled = await handleAdminRequest(req, res, urlPath, { adminTokenBuf: TOKEN_BUF });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* leave null */ }
  return { handled, status: res.statusCode, json, ended: res.ended };
}

// ─────────────────────────────────────────────────────────────
header('Routing — non-admin-API paths are not owned');
{
  const req = mockReq('POST', '/admin/resume', bearer(TOKEN));
  const res = mockRes();
  const handled = await handleAdminRequest(req, res, '/admin/resume', { adminTokenBuf: TOKEN_BUF });
  check('/admin/resume returns false (left to existing handler)', handled === false);
  check('/admin/resume: response untouched', res.ended === false && res.statusCode === 0);

  const req2 = mockReq('GET', '/v1/models', bearer(TOKEN));
  const res2 = mockRes();
  const h2 = await handleAdminRequest(req2, res2, '/v1/models', { adminTokenBuf: TOKEN_BUF });
  check('/v1/models returns false', h2 === false);
}

// ─────────────────────────────────────────────────────────────
header('Auth — always required, even on loopback');
{
  // No token configured at all → fail closed with 403.
  const reqNoTok = mockReq('GET', '/admin/accounts', {});
  const resNoTok = mockRes();
  await handleAdminRequest(reqNoTok, resNoTok, '/admin/accounts', { adminTokenBuf: null });
  check('no token configured → 403', resNoTok.statusCode === 403);

  // Token configured, none provided → 401.
  const r1 = await call('GET', '/admin/accounts', {});
  check('token set, none provided → 401', r1.status === 401);

  // Wrong token → 401.
  const r2 = await call('GET', '/admin/accounts', { token: 'wrong' });
  check('wrong token → 401', r2.status === 401);

  // Correct token → 200.
  const r3 = await call('GET', '/admin/accounts', { token: TOKEN });
  check('correct token → 200', r3.status === 200);
}

// ─────────────────────────────────────────────────────────────
header('GET /admin/accounts — shape');
{
  const r = await call('GET', '/admin/accounts', { token: TOKEN });
  check('200', r.status === 200);
  check('accounts is an array', Array.isArray(r.json?.accounts));
  check('count matches accounts length', r.json?.count === r.json?.accounts?.length);
}

// ─────────────────────────────────────────────────────────────
header('GET /admin/accounts — live pool status merged onto persisted metadata');
{
  const now = Date.now();
  // Injected inventory + live snapshot — no disk, no real pool.
  const listAccounts = async () => [
    { alias: 'acct1', scopes: ['user:inference'], expiresAt: now + 3_600_000 },
    { alias: 'acct2', scopes: ['user:inference'], expiresAt: now + 7_200_000 },
  ];
  const poolStatus = () => new Map([
    ['acct1', { util5h: 0.12, util7d: 0.34, claim: 'subscription', status: 'active', requestCount: 7 }],
    // acct2 deliberately absent — persisted but not (yet) in the live pool.
  ]);
  const req = mockReq('GET', '/admin/accounts', bearer(TOKEN));
  const res = mockRes();
  await handleAdminRequest(req, res, '/admin/accounts', { adminTokenBuf: TOKEN_BUF, listAccounts, poolStatus });
  const json = JSON.parse(res.body);
  const a1 = json.accounts.find(a => a.alias === 'acct1');
  const a2 = json.accounts.find(a => a.alias === 'acct2');
  check('200', res.statusCode === 200);
  check('count = 2', json.count === 2);
  check('persisted scopes retained', Array.isArray(a1?.scopes) && a1.scopes[0] === 'user:inference');
  check('persisted expires_in_ms retained', typeof a1?.expires_in_ms === 'number' && a1.expires_in_ms > 0);
  check('live util5h/util7d merged in', a1?.util5h === 0.12 && a1?.util7d === 0.34);
  check('live claim + status merged in', a1?.claim === 'subscription' && a1?.status === 'active');
  check('live request_count merged in', a1?.request_count === 7);
  check('account absent from pool snapshot omits live fields', a2 && a2.util5h === undefined && a2.claim === undefined);
  check('no /accounts note when pool status present', json.note === undefined);
}

// ─────────────────────────────────────────────────────────────
header('GET /admin/accounts — single-account mode keeps the pool-view pointer');
{
  const listAccounts = async () => [];
  const req = mockReq('GET', '/admin/accounts', bearer(TOKEN));
  const res = mockRes();
  // No poolStatus dep → single-account mode → retain the pointer to GET /accounts.
  await handleAdminRequest(req, res, '/admin/accounts', { adminTokenBuf: TOKEN_BUF, listAccounts });
  const json = JSON.parse(res.body);
  check('200', res.statusCode === 200);
  check('accounts empty', Array.isArray(json.accounts) && json.accounts.length === 0);
  check('note present without pool status', typeof json.note === 'string');
}

// ─────────────────────────────────────────────────────────────
header('POST /admin/login/start — PKCE authorize URL');
{
  _resetAdminStateForTest();
  const r = await call('POST', '/admin/login/start', { token: TOKEN, body: { alias: 'test-alias' } });
  check('200', r.status === 200);
  check('no login_id (keyed by alias)', r.json?.login_id === undefined);
  check('returns an authorize_url', typeof r.json?.authorize_url === 'string');
  check('authorize_url is the oauth authorize endpoint', (r.json?.authorize_url || '').includes('oauth/authorize'));
  check('authorize_url carries a PKCE challenge', (r.json?.authorize_url || '').includes('code_challenge'));
  check('authorize_url asks for a code', (r.json?.authorize_url || '').includes('response_type=code'));
  check('returns an expires_at', typeof r.json?.expires_at === 'string');

  // Invalid alias (path traversal) is rejected BEFORE any auth code is issued.
  const bad = await call('POST', '/admin/login/start', { token: TOKEN, body: { alias: '../evil' } });
  check('invalid alias → 400', bad.status === 400);

  // Alias is now optional — omitting it auto-generates one (dedicated block
  // below), so it no longer 400s.
  const omitted = await call('POST', '/admin/login/start', { token: TOKEN, body: {} });
  check('omitted alias → 200 (auto-generated)', omitted.status === 200 && typeof omitted.json?.alias === 'string');

  // Wrong method on a known path.
  const wrongMethod = await call('GET', '/admin/login/start', { token: TOKEN });
  check('GET /admin/login/start → 405', wrongMethod.status === 405);
}

// ─────────────────────────────────────────────────────────────
header('POST /admin/login/start — alias optional (auto-generated)');
{
  _resetAdminStateForTest();
  const listAccounts = async () => []; // no existing accounts on disk

  // First omit → account-1
  const req1 = mockReq('POST', '/admin/login/start', bearer(TOKEN), {});
  const res1 = mockRes();
  await handleAdminRequest(req1, res1, '/admin/login/start', { adminTokenBuf: TOKEN_BUF, listAccounts });
  const j1 = JSON.parse(res1.body);
  check('omitted alias → 200', res1.statusCode === 200);
  check('returns a generated alias', typeof j1.alias === 'string' && /^account-\d+$/.test(j1.alias));
  check('first generated alias is account-1', j1.alias === 'account-1');
  check('still returns an authorize_url', typeof j1.authorize_url === 'string');
  check('instructions reference the generated alias', (j1.instructions || '').includes('account-1'));

  // Second omit → account-2 (skips the pending account-1)
  const req2 = mockReq('POST', '/admin/login/start', bearer(TOKEN), {});
  const res2 = mockRes();
  await handleAdminRequest(req2, res2, '/admin/login/start', { adminTokenBuf: TOKEN_BUF, listAccounts });
  const j2 = JSON.parse(res2.body);
  check('second generated alias is account-2', j2.alias === 'account-2');

  // A pre-existing account-1 on disk is skipped when generating.
  _resetAdminStateForTest();
  const listAccounts2 = async () => [{ alias: 'account-1', scopes: [], expiresAt: 0 }];
  const req3 = mockReq('POST', '/admin/login/start', bearer(TOKEN), {});
  const res3 = mockRes();
  await handleAdminRequest(req3, res3, '/admin/login/start', { adminTokenBuf: TOKEN_BUF, listAccounts: listAccounts2 });
  const j3 = JSON.parse(res3.body);
  check('generated alias skips an existing account-1 → account-2', j3.alias === 'account-2');

  // An explicit alias is still honored and echoed back.
  _resetAdminStateForTest();
  const r = await call('POST', '/admin/login/start', { token: TOKEN, body: { alias: 'named-acct' } });
  check('explicit alias honored + echoed', r.json?.alias === 'named-acct');
}

// ─────────────────────────────────────────────────────────────
header('POST /admin/login/complete — pending-login guards');
{
  const unknown = await call('POST', '/admin/login/complete', { token: TOKEN, body: { alias: 'no-pending-alias-zzz', code: 'abc' } });
  check('unknown alias → 410', unknown.status === 410);

  const missingCode = await call('POST', '/admin/login/complete', { token: TOKEN, body: { alias: 'x' } });
  check('missing code → 400', missingCode.status === 400);

  const missingAlias = await call('POST', '/admin/login/complete', { token: TOKEN, body: { code: 'abc' } });
  check('missing alias → 400', missingAlias.status === 400);
}

// ─────────────────────────────────────────────────────────────
header('DELETE /admin/accounts/<alias>');
{
  // A definitely-nonexistent alias — never deletes a real account.
  const r = await call('DELETE', '/admin/accounts/admin-api-test-does-not-exist-zzz', { token: TOKEN });
  check('nonexistent alias → 404', r.status === 404);
  check('removed=false', r.json?.removed === false);
}

// ─────────────────────────────────────────────────────────────
header('Audit — mutations + auth rejects are recorded');
{
  const events = [];
  const audit = (e) => events.push(e);

  // Wrong token → audited auth_reject (401). (login_complete needs live OAuth,
  // so it's covered by the headless live test, not here.)
  {
    const req = mockReq('GET', '/admin/accounts', bearer('wrong'));
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/accounts', { adminTokenBuf: TOKEN_BUF, audit });
  }
  check('auth_reject audited (wrong token, 401)',
    events.some(e => e.action === 'auth_reject' && e.ok === false && e.status === 401));

  // No token configured at all → audited auth_reject (403).
  {
    const req = mockReq('GET', '/admin/accounts', {});
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/accounts', { adminTokenBuf: null, audit });
  }
  check('auth_reject audited (no token configured, 403)',
    events.some(e => e.action === 'auth_reject' && e.status === 403));

  // Successful login/start → audited login_start with the alias.
  _resetAdminStateForTest();
  events.length = 0;
  {
    const req = mockReq('POST', '/admin/login/start', bearer(TOKEN), { alias: 'audit-alias' });
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/login/start', { adminTokenBuf: TOKEN_BUF, audit });
  }
  check('login_start audited with alias',
    events.some(e => e.action === 'login_start' && e.ok === true && e.status === 200 && e.alias === 'audit-alias'));

  // Delete of a nonexistent account → audited account_remove with ok=false.
  events.length = 0;
  {
    const req = mockReq('DELETE', '/admin/accounts/audit-remove-does-not-exist-zzz', bearer(TOKEN));
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/accounts/audit-remove-does-not-exist-zzz', { adminTokenBuf: TOKEN_BUF, audit });
  }
  check('account_remove audited (not found, 404, ok=false)',
    events.some(e => e.action === 'account_remove' && e.ok === false && e.status === 404 && e.alias === 'audit-remove-does-not-exist-zzz'));

  // A GET that succeeds is not a mutation — no audit event for it.
  events.length = 0;
  {
    const req = mockReq('GET', '/admin/accounts', bearer(TOKEN));
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/accounts', { adminTokenBuf: TOKEN_BUF, listAccounts: async () => [], audit });
  }
  check('successful GET /admin/accounts is not audited', events.length === 0);
}

// ─────────────────────────────────────────────────────────────
header('Rate limiting — mutations + auth failures return 429');
{
  // A throttled auth failure returns 429 (not 401) with Retry-After, audited.
  {
    const events = [];
    const rateLimit = (cat) => (cat === 'auth' ? 3000 : 0);
    const req = mockReq('GET', '/admin/accounts', bearer('wrong'));
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/accounts',
      { adminTokenBuf: TOKEN_BUF, rateLimit, audit: (e) => events.push(e) });
    check('throttled auth → 429', res.statusCode === 429);
    check('429 carries Retry-After', res.headers?.['Retry-After'] === '3');
    check('throttle audited as rate_limited/auth',
      events.some(e => e.action === 'rate_limited' && e.status === 429 && e.detail === 'auth'));
  }

  // A throttled mutation (valid token) returns 429 without acting.
  {
    _resetAdminStateForTest();
    const events = [];
    const rateLimit = (cat) => (cat === 'mutation' ? 4000 : 0);
    const req = mockReq('POST', '/admin/login/start', bearer(TOKEN), { alias: 'rl-alias' });
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/login/start',
      { adminTokenBuf: TOKEN_BUF, rateLimit, audit: (e) => events.push(e) });
    check('throttled mutation → 429', res.statusCode === 429);
    check('throttle audited as rate_limited/mutation',
      events.some(e => e.action === 'rate_limited' && e.detail === 'mutation'));
    // It must not have issued an authorize URL / started a login.
    const body = res.body ? JSON.parse(res.body) : {};
    check('no authorize_url on a throttled start', body.authorize_url === undefined);
  }

  // Reads are exempt: a valid-token GET is not gated even if the limiter would
  // throttle every category it's asked about.
  {
    const rateLimit = () => 5000; // would throttle any category consulted
    const req = mockReq('GET', '/admin/accounts', bearer(TOKEN));
    const res = mockRes();
    await handleAdminRequest(req, res, '/admin/accounts',
      { adminTokenBuf: TOKEN_BUF, listAccounts: async () => [], rateLimit });
    check('GET /admin/accounts is not rate-limited → 200', res.statusCode === 200);
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

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

  const missing = await call('POST', '/admin/login/start', { token: TOKEN, body: {} });
  check('missing alias → 400', missing.status === 400);

  // Wrong method on a known path.
  const wrongMethod = await call('GET', '/admin/login/start', { token: TOKEN });
  check('GET /admin/login/start → 405', wrongMethod.status === 405);
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

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

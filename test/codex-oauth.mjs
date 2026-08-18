// Unit tests for the "altman" Codex OAuth engine (dario#1009).
// No real network calls (monkeypatched global fetch, same strategy as
// account-refresh-distributed-lock.mjs) and no real ~/.dario writes for
// the storage tests (HOME/USERPROFILE overridden to a temp dir).
//
// What this does NOT test: whether OpenAI invalidates the previous
// refresh_token on refresh (the actual open question — see
// codex-oauth.ts's header comment). That requires a live account and
// lives in test/manual/codex-refresh-race.mjs instead.

import {
  generateCodexPKCE,
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  refreshCodexAccessToken,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
} from '../dist/codex-oauth.js';

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

// ======================================================================
//  PKCE
// ======================================================================
header('generateCodexPKCE — verifier/challenge shape');
{
  const { codeVerifier, codeChallenge } = generateCodexPKCE();
  check('codeVerifier is base64url (no +/=)', /^[A-Za-z0-9_-]+$/.test(codeVerifier));
  check('codeChallenge is base64url (no +/=)', /^[A-Za-z0-9_-]+$/.test(codeChallenge));
  check('codeChallenge derived from codeVerifier (differs, both present)', codeChallenge !== codeVerifier && codeChallenge.length > 0);
  const second = generateCodexPKCE();
  check('two calls produce different verifiers (not reusing entropy)', second.codeVerifier !== codeVerifier);
}

// ======================================================================
//  Authorize URL
// ======================================================================
header('buildCodexAuthorizeUrl — required params present');
{
  const url = new URL(buildCodexAuthorizeUrl('test-challenge', 'test-state'));
  check('response_type=code', url.searchParams.get('response_type') === 'code');
  check('client_id matches CODEX_CLIENT_ID', url.searchParams.get('client_id') === CODEX_CLIENT_ID);
  check('code_challenge passed through', url.searchParams.get('code_challenge') === 'test-challenge');
  check('code_challenge_method=S256', url.searchParams.get('code_challenge_method') === 'S256');
  check('state passed through', url.searchParams.get('state') === 'test-state');
  check('scope includes offline_access (required for a refresh_token)', (url.searchParams.get('scope') || '').includes('offline_access'));
  check('authorize host is auth.openai.com', url.hostname === 'auth.openai.com');
}

// ======================================================================
//  Code exchange — success and failure shapes
// ======================================================================
header('exchangeCodexAuthorizationCode');
{
  globalThis.fetch = async (url, opts) => {
    check('exchange POSTs to CODEX_TOKEN_URL', String(url) === CODEX_TOKEN_URL);
    const body = new URLSearchParams(opts.body);
    check('grant_type=authorization_code', body.get('grant_type') === 'authorization_code');
    check('code_verifier forwarded', body.get('code_verifier') === 'verifier-abc');
    return new Response(JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tokens = await exchangeCodexAuthorizationCode('code-abc', 'verifier-abc');
  check('returns accessToken', tokens.accessToken === 'a1');
  check('returns refreshToken', tokens.refreshToken === 'r1');
  check('expiresAt is ~3600s out', tokens.expiresAt > Date.now() + 3500_000 && tokens.expiresAt <= Date.now() + 3600_000);
  restoreFetch();
}

header('exchangeCodexAuthorizationCode — non-2xx throws, does not swallow');
{
  globalThis.fetch = async () => new Response('invalid_grant', { status: 400 });
  let threw = false;
  try { await exchangeCodexAuthorizationCode('bad-code', 'v'); } catch { threw = true; }
  check('throws on 400', threw);
  restoreFetch();
}

header('exchangeCodexAuthorizationCode — missing fields in 200 response throws');
{
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'a1' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  let threw = false;
  try { await exchangeCodexAuthorizationCode('code-abc', 'v'); } catch { threw = true; }
  check('throws when refresh_token/expires_in missing (would otherwise store a broken account)', threw);
  restoreFetch();
}

// ======================================================================
//  Refresh
// ======================================================================
header('refreshCodexAccessToken — request shape and response parsing');
{
  globalThis.fetch = async (url, opts) => {
    check('refresh POSTs to CODEX_TOKEN_URL', String(url) === CODEX_TOKEN_URL);
    const body = new URLSearchParams(opts.body);
    check('grant_type=refresh_token', body.get('grant_type') === 'refresh_token');
    check('refresh_token forwarded', body.get('refresh_token') === 'old-refresh');
    check('client_id included', body.get('client_id') === CODEX_CLIENT_ID);
    return new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 1800 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tokens = await refreshCodexAccessToken('old-refresh');
  check('returns the NEW refreshToken (rotation — caller must persist this, not reuse old-refresh)', tokens.refreshToken === 'r2');
  restoreFetch();
}

header('refreshCodexAccessToken — non-2xx throws');
{
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  let threw = false;
  try { await refreshCodexAccessToken('dead-token'); } catch { threw = true; }
  check('throws on 400 (this is the response we expect IF OpenAI rotates like Anthropic — see manual race test)', threw);
  restoreFetch();
}

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

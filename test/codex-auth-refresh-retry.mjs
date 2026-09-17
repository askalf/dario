#!/usr/bin/env node
/**
 * test/codex-auth-refresh-retry.mjs
 *
 * A Codex token the backend rejects is refreshed once and retried, and a seat
 * that still cannot serve is reported unavailable instead of handing the
 * client a 401.
 *
 * 2026-09-17: the fleet's only fallback seat answered 401 to every request for
 * six hours. Its stored token was valid for another day, so the clock-based
 * `getFreshCodexAccount` never refreshed it; 401 was not in the "unavailable"
 * set, so the seat was never cooled and never failed over; and each request
 * relayed `Upstream Codex backend error` to Claude Code, which reads as an
 * outage.
 *
 * Covers:
 *   - isCodexAuthFailure: 401/403 yes, 429/500/200 no
 *   - 401 → forced refresh → retry with the NEW token → served
 *   - 401 twice (refresh worked, upstream still refuses) → declined, not relayed
 *   - a seat with no refresh token → no token call, declined once
 *   - a refresh that returns the same token → no pointless retry
 *   - deferOnUnavailable: an auth-dead seat returns false so the chain moves on
 *
 * Hermetic: HOME in a mkdtemp dir (the account store), the token endpoint on
 * loopback, the upstream a function. No network, no proxy, no OAuth.
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-authretry-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// The token endpoint. `mint` decides what the next exchange returns.
let tokenCalls = 0;
let mint = () => ({ access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 3600, id_token: 'id-new' });
const tokenServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    tokenCalls++;
    const out = mint();
    if (!out) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
process.env.DARIO_CODEX_TOKEN_URL = `http://127.0.0.1:${tokenServer.address().port}/token`;

const { forwardToCodex, isCodexAuthFailure } = await import('../dist/codex-backend.js');

function fakeRes() {
  return {
    statusCode: null, headers: null, chunks: [], ended: false, headersSent: false, listeners: {},
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs; this.headersSent = true; },
    write(s) { this.chunks.push(s); return true; },
    end(s) { if (s !== undefined) this.chunks.push(s); this.ended = true; },
    on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; },
    removeListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); return this; },
    get body() { return this.chunks.join(''); },
  };
}

const BODY = Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }));
const creds = (alias, over = {}) => ({
  alias,
  accessToken: 'tok-old',
  refreshToken: 'ref-old',
  expiresAt: Date.now() + 24 * 3600_000,   // the clock says fine — only upstream disagrees
  idToken: undefined,
  ...over,
});

/** An upstream that answers from `statuses` in order and records each Authorization header. */
function upstreamSeq(statuses, seenAuth) {
  let i = 0;
  return async (_url, init) => {
    seenAuth.push(init.headers.Authorization ?? init.headers.authorization ?? null);
    const status = statuses[Math.min(i++, statuses.length - 1)];
    if (status === 200) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        body: null,           // no stream body: the forward returns after the error/no-body branch
        text: async () => '',
      };
    }
    return { ok: false, status, headers: { get: () => null }, text: async () => `refused ${status}` };
  };
}

header('isCodexAuthFailure');
{
  check('401 is an auth failure', isCodexAuthFailure(401) === true);
  check('403 is an auth failure', isCodexAuthFailure(403) === true);
  check('429 is not', isCodexAuthFailure(429) === false);
  check('500 is not', isCodexAuthFailure(500) === false);
  check('200 is not', isCodexAuthFailure(200) === false);
}

header('401 on a clock-fresh token: refresh once, retry with the new token');
{
  tokenCalls = 0;
  mint = () => ({ access_token: 'tok-fresh-a', refresh_token: 'ref-a', expires_in: 3600 });
  const seen = [];
  const declines = [];
  const res = fakeRes();
  await forwardToCodex({}, res, BODY, creds('seat-a'), '*', {}, 5000, false, 'anthropic',
    upstreamSeq([401, 200], seen), false, undefined, (d) => declines.push(d));
  check('the token endpoint was called exactly once', tokenCalls === 1, `calls=${tokenCalls}`);
  check('the upstream was asked twice', seen.length === 2, `calls=${seen.length}`);
  check('the first attempt carried the stored token', seen[0] === 'Bearer tok-old', String(seen[0]));
  check('the retry carried the refreshed token', seen[1] === 'Bearer tok-fresh-a', String(seen[1]));
  check('nothing was declined — the seat served', declines.length === 0, JSON.stringify(declines));
  check('no 401 reached the client', res.statusCode !== 401, String(res.statusCode));
}

header('still refused after the refresh: declined and cooled, not relayed');
{
  tokenCalls = 0;
  mint = () => ({ access_token: 'tok-fresh-b', refresh_token: 'ref-b', expires_in: 3600 });
  const seen = [];
  const declines = [];
  const res = fakeRes();
  const served = await forwardToCodex({}, res, BODY, creds('seat-b'), '*', {}, 5000, false, 'anthropic',
    upstreamSeq([401, 401], seen), true, undefined, (d) => declines.push(d));
  check('one refresh, one retry', tokenCalls === 1 && seen.length === 2, `tokens=${tokenCalls} calls=${seen.length}`);
  check('the seat was declined with its status', declines.length === 1 && declines[0].status === 401 && declines[0].alias === 'seat-b', JSON.stringify(declines));
  check('deferOnUnavailable returns false so the chain moves on', served === false);
  check('nothing was written to the client', res.ended === false && res.statusCode === null, `status=${res.statusCode}`);
}

header('no refresh token: no token call, one decline');
{
  tokenCalls = 0;
  const seen = [];
  const declines = [];
  const res = fakeRes();
  await forwardToCodex({}, res, BODY, creds('seat-c', { refreshToken: undefined }), '*', {}, 5000, false, 'anthropic',
    upstreamSeq([401], seen), false, undefined, (d) => declines.push(d));
  check('the token endpoint was never called', tokenCalls === 0, `calls=${tokenCalls}`);
  check('the upstream was asked once', seen.length === 1, `calls=${seen.length}`);
  check('the seat was still declined, so selection cools it', declines.length === 1 && declines[0].status === 401, JSON.stringify(declines));
  check('with no peer to defer to the client learns the status', res.statusCode === 401);
}

header('a refresh that changes nothing does not buy a retry');
{
  tokenCalls = 0;
  mint = () => ({ access_token: 'tok-old', refresh_token: 'ref-old', expires_in: 3600 });
  const seen = [];
  const res = fakeRes();
  await forwardToCodex({}, res, BODY, creds('seat-d'), '*', {}, 5000, false, 'anthropic',
    upstreamSeq([401, 200], seen), false, undefined, () => {});
  check('the refresh was attempted', tokenCalls === 1, `calls=${tokenCalls}`);
  check('the upstream was asked once — the same token would only 401 again', seen.length === 1, `calls=${seen.length}`);
}

header('a refresh that fails leaves the seat declined, once');
{
  tokenCalls = 0;
  mint = () => null;   // the token endpoint refuses: a dead refresh token
  const seen = [];
  const declines = [];
  const res = fakeRes();
  const served = await forwardToCodex({}, res, BODY, creds('seat-e'), '*', {}, 5000, false, 'anthropic',
    upstreamSeq([401], seen), true, undefined, (d) => declines.push(d));
  check('one refresh attempt', tokenCalls === 1, `calls=${tokenCalls}`);
  check('no retry — there is no new token to try', seen.length === 1, `calls=${seen.length}`);
  check('declined so the chain moves on', served === false && declines.length === 1 && declines[0].status === 401, JSON.stringify(declines));
}

header('429 still behaves exactly as before');
{
  tokenCalls = 0;
  const seen = [];
  const declines = [];
  const res = fakeRes();
  await forwardToCodex({}, res, BODY, creds('seat-f'), '*', {}, 5000, false, 'anthropic',
    upstreamSeq([429], seen), false, undefined, (d) => declines.push(d));
  check('no refresh on a rate limit', tokenCalls === 0 && seen.length === 1);
  check('declined with 429 and relayed', declines[0]?.status === 429 && res.statusCode === 429);
}

tokenServer.close();
await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

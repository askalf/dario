#!/usr/bin/env node
/**
 * test/admin-codex-accounts.mjs
 *
 * ChatGPT (altman) seats over the admin API (dario#1009): start, complete,
 * list, delete — the four routes a Claude seat already had, for a proxy that
 * never sees a terminal.
 *
 * Hermetic: HOME points at a mkdtemp'd dir (the codex account store lives
 * under it), the OAuth token exchange goes to a local stub, no proxy, no
 * network. Same mock request/response harness as admin-api.mjs.
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};
const header = (n) => console.log(`\n=== ${n} ===`);

// --- isolation: store + token endpoint, before the module loads ----------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-admin-codex-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

let exchanges = 0;
let failNextExchange = false;
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    exchanges++;
    const form = new URLSearchParams(body);
    if (failNextExchange || form.get('code') !== 'good-code') {
      failNextExchange = false;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: 'id-1' }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.DARIO_CODEX_TOKEN_URL = `http://127.0.0.1:${stub.address().port}/token`;

const { handleAdminRequest, _resetAdminStateForTest } = await import('../dist/admin-api.js');
const { listCodexAccountAliases } = await import('../dist/codex-accounts.js');

// --- harness (as admin-api.mjs) -----------------------------------------------
const TOKEN = 's3cret-admin-token';
function mockReq(method, url, headers = {}, bodyObj = undefined) {
  const r = new EventEmitter();
  r.method = method; r.url = url; r.headers = headers; r.destroy = () => {};
  r.socket = { remoteAddress: '127.0.0.1' };
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
const audit = [];
let codexChanged = 0;
const deps = {
  adminTokenBuf: Buffer.from(TOKEN),
  audit: (e) => audit.push(e),
  onCodexAccountsChanged: async () => { codexChanged++; },
};
async function call(method, url, { token = TOKEN, body } = {}) {
  const req = mockReq(method, url, token ? { authorization: `Bearer ${token}` } : {}, body);
  const res = mockRes();
  const handled = await handleAdminRequest(req, res, url.split('?')[0], deps);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not json */ }
  return { handled, status: res.statusCode, json };
}

header('routes are owned and gated');
{
  const r = await call('POST', '/admin/codex/login/start', { token: null, body: {} });
  check('unauthenticated start is 401', r.handled && r.status === 401, JSON.stringify(r));
  const g = await call('GET', '/admin/codex/accounts', { token: 'wrong' });
  check('wrong token on list is 401', g.status === 401);
  const m = await call('GET', '/admin/codex/login/start');
  check('GET on start is 405', m.status === 405);
}

let state = '';
header('start: default alias, authorize url, pending state');
{
  _resetAdminStateForTest();
  const r = await call('POST', '/admin/codex/login/start', { body: {} });
  check('200', r.status === 200, JSON.stringify(r.json));
  check('default alias is altman-1', r.json?.alias === 'altman-1');
  const u = r.json?.authorize_url ? new URL(r.json.authorize_url) : null;
  check('authorize_url is the OpenAI authorize endpoint with PKCE', !!u && u.searchParams.get('code_challenge_method') === 'S256' && !!u.searchParams.get('state'));
  state = u?.searchParams.get('state') ?? '';
  check('instructions mention the localhost page', /localhost/.test(r.json?.instructions ?? ''));
  check('audit names the codex engine', audit.some((e) => e.action === 'login_start' && e.engine === 'codex' && e.alias === 'altman-1'));
  const again = await call('POST', '/admin/codex/login/start', { body: {} });
  check('a second default alias skips the pending one', again.json?.alias === 'altman-2', JSON.stringify(again.json));
}

header('complete: state mismatch, unknown alias, exchange failure, success');
{
  const wrong = await call('POST', '/admin/codex/login/complete', { body: { alias: 'altman-1', code: 'http://localhost:1455/auth/callback?code=good-code&state=not-this-one' } });
  check('a redirect from another login is 400', wrong.status === 400 && /state mismatch/.test(wrong.json?.error ?? ''), JSON.stringify(wrong.json));
  const unknown = await call('POST', '/admin/codex/login/complete', { body: { alias: 'nobody', code: 'good-code' } });
  check('an alias with no pending login is 410', unknown.status === 410);
  failNextExchange = true;
  const bad = await call('POST', '/admin/codex/login/complete', { body: { alias: 'altman-2', code: 'good-code' } });
  check('a failed exchange is 400 and the pending login is spent', bad.status === 400 && /exchange failed/.test(bad.json?.error ?? ''), JSON.stringify(bad.json));
  const spent = await call('POST', '/admin/codex/login/complete', { body: { alias: 'altman-2', code: 'good-code' } });
  check('retrying the spent alias is 410', spent.status === 410);
  const ok = await call('POST', '/admin/codex/login/complete', { body: { alias: 'altman-1', code: `http://localhost:1455/auth/callback?code=good-code&state=${state}` } });
  check('the whole redirect URL with the right state adds the seat', ok.status === 200 && ok.json?.status === 'added' && ok.json?.alias === 'altman-1', JSON.stringify(ok.json));
  check('the seat is in the CLI store', (await listCodexAccountAliases()).includes('altman-1'));
  check('the proxy was told', codexChanged === 1);
  check('the exchange happened over the stub', exchanges >= 2);
}

header('list and delete');
{
  const l = await call('GET', '/admin/codex/accounts');
  check('list shows the seat with its expiry and refresh state', l.status === 200 && l.json?.count === 1 && l.json.accounts[0].alias === 'altman-1' && l.json.accounts[0].needsRefresh === false && typeof l.json.accounts[0].expiresAt === 'number', JSON.stringify(l.json));
  const dup = await call('POST', '/admin/codex/login/start', { body: { alias: 'altman-1' } });
  check('starting a login for an alias that holds a seat is 409', dup.status === 409, JSON.stringify(dup.json));
  const d = await call('DELETE', '/admin/codex/accounts/altman-1');
  check('delete removes it', d.status === 200 && d.json?.removed === true);
  check('the proxy was told again', codexChanged === 2);
  const d2 = await call('DELETE', '/admin/codex/accounts/altman-1');
  check('deleting again is 404', d2.status === 404);
  const l2 = await call('GET', '/admin/codex/accounts');
  check('list is empty', l2.json?.count === 0);
  check('audit carries the remove with the codex engine', audit.some((e) => e.action === 'account_remove' && e.engine === 'codex' && e.ok === true));
}

stub.close();
await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

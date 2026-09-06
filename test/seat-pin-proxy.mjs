#!/usr/bin/env node
// In-process proxy test for the seat pin (x-dario-account): a pinned request
// goes to the named seat and NEVER fails over — not to a peer on 401, not to
// the Codex leg — while an unpinned request on the same pool still does.
// Two seats: `good` (upstream 200) and `dead` (upstream 401). A fake upstream
// records which bearer each call carried.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const ADMIN_TOKEN = 'seat-pin-admin-token';

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-seatpin-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
delete process.env.DARIO_CODEX_BASE_URL;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
const seat = (alias, token) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
});
await writeFile(join(tmpHome, '.dario', 'accounts', 'good.json'), seat('good', 'good-token'));
await writeFile(join(tmpHome, '.dario', 'accounts', 'dead.json'), seat('dead', 'dead-token'));

const calls = [];
const fetchImpl = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // dario hands the injected fetch its headers as [name, value] pairs.
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const auth = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]);
  const bearer = auth.replace(/^Bearer\s+/i, '');
  calls.push(bearer);
  if (bearer === 'dead-token') {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid bearer' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// The codex backend base URL is captured at module load, so the stub and the
// env var must exist BEFORE dist/proxy.js is imported.
const CODEX_PORT = await freePort();
const CODEX_SLUG = 'gpt-5.6-sol';
const codexSeen = { models: 0, responses: 0 };
const codexStub = createServer((req, res) => {
  if ((req.url || '').startsWith('/models')) {
    codexSeen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: CODEX_SLUG, visibility: 'list' }] }));
    return;
  }
  if ((req.url || '').startsWith('/responses')) {
    codexSeen.responses++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    res.write('data: {"type":"response.output_text.delta","delta":"hi from codex"}\n\n');
    res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    res.end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;

const { startProxy } = await import('../dist/proxy.js');
await startProxy({ host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (extra = {}, content = 'ping') => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const pin = (alias, token = ADMIN_TOKEN) => ({ 'x-dario-account': alias, ...(token === null ? {} : { 'x-dario-admin-token': token }) });

header('pinned to the good seat → served by that seat');
{
  calls.length = 0;
  const r = await messages(pin('good'), `good ${Math.random()}`);
  check('HTTP 200', r.status === 200, String(r.status));
  check('exactly one upstream call, with the good bearer', calls.length === 1 && calls[0] === 'good-token', JSON.stringify(calls));
}

header('pinned to the dead seat → its 401 comes back, no peer retry');
{
  calls.length = 0;
  const r = await messages(pin('dead'), `dead ${Math.random()}`);
  check('HTTP 401 passthrough', r.status === 401, String(r.status));
  check('exactly one upstream call, with the dead bearer', calls.length === 1 && calls[0] === 'dead-token', JSON.stringify(calls));
  check('no x-dario-pool-fallback header', !r.headers.get('x-dario-pool-fallback'));
}

header('unpinned request on the same pool still fails over from dead to good');
{
  // The dead seat is in auth-cooldown from the pinned probe above; clear the
  // comparison by asking many times with distinct sticky keys — every answer
  // must be 200 and the good bearer must have served each one.
  calls.length = 0;
  let all200 = true;
  for (let i = 0; i < 4; i++) {
    const r = await messages({}, `unpinned ${i} ${Math.random()}`);
    if (r.status !== 200) all200 = false;
  }
  check('4/4 HTTP 200 unpinned', all200);
  check('the good bearer served the last call', calls[calls.length - 1] === 'good-token', JSON.stringify(calls));
}

header('pin without the admin token → 403, request not served');
{
  calls.length = 0;
  const r = await messages(pin('good', null), `noauth ${Math.random()}`);
  check('HTTP 403', r.status === 403, String(r.status));
  check('no upstream call', calls.length === 0, JSON.stringify(calls));
  const r2 = await messages(pin('good', 'wrong-token'), `badauth ${Math.random()}`);
  check('wrong token → 403', r2.status === 403, String(r2.status));
  check('still no upstream call', calls.length === 0);
}

header('pin to an unknown alias → 404; malformed alias → 400');
{
  calls.length = 0;
  const r = await messages(pin('nobody'), `unknown ${Math.random()}`);
  check('HTTP 404', r.status === 404, String(r.status));
  const r2 = await messages(pin('../etc'), `bad ${Math.random()}`);
  check('HTTP 400', r2.status === 400, String(r2.status));
  check('no upstream call', calls.length === 0);
}

header('upstream API-key mode → pin refused with 409, never served by the key');
{
  const PORT2 = await freePort();
  const keyCalls = [];
  const keyFetch = async (url, init) => {
    if (String(url).includes('/v1/models')) return fetchImpl(url, init);
    const h = init?.headers;
    const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
    keyCalls.push(Object.fromEntries(pairs.map(([k, v]) => [String(k).toLowerCase(), String(v)])));
    return new Response(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await startProxy({ host: '127.0.0.1', port: PORT2, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl: keyFetch, upstreamApiKey: 'sk-ant-api-test-key' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT2}/health`); break; } catch { await sleep(100); } }
  const post = (extra) => fetch(`http://127.0.0.1:${PORT2}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: `key ${Math.random()}` }] }),
  });
  const r = await post(pin('good'));
  check('valid pin in API-key mode → HTTP 409', r.status === 409, String(r.status));
  check('no upstream call was made for the pinned request', keyCalls.length === 0, JSON.stringify(keyCalls));
  const body = await r.json().catch(() => ({}));
  check('error names API-key mode', /API-key mode/.test(body?.error?.message ?? ''));
  const r2 = await post({});
  check('an unpinned request in API-key mode still serves (200)', r2.status === 200, String(r2.status));
  check('and went out on x-api-key, not a seat bearer', keyCalls.length === 1 && 'x-api-key' in keyCalls[0] && !('authorization' in keyCalls[0]), JSON.stringify(keyCalls));
}

header('a request routed to another provider refuses the pin (409), Codex never sees it');
{
  // A pin names a Claude POOL seat. Provider routing runs before pool
  // selection, so without the guard a pinned request naming a Codex model
  // would be answered by Codex and report the wrong leg healthy.
  const PORT3 = await freePort();
  await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
  await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({
    alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token',
    expiresAt: Date.now() + 6 * 3_600_000,
  }));
  // The earlier proxies served requests with no codex account present, which
  // arms the negative presence cache; drop it now that one exists.
  const { _resetCodexPresenceCacheForTest } = await import('../dist/codex-accounts.js');
  _resetCodexPresenceCacheForTest();
  await startProxy({ host: '127.0.0.1', port: PORT3, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT3}/health`); break; } catch { await sleep(100); } }

  const ask = (model, extra) => fetch(`http://127.0.0.1:${PORT3}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: `codex ${Math.random()}` }] }),
  });

  // Prime the model cache: routing only learns the slug belongs to codex after
  // one request has fetched /models (getCodexModelSlugs is lazy).
  const r2 = await ask(CODEX_SLUG, {});
  check('unpinned codex-named request reaches codex (200)', r2.status === 200, String(r2.status));
  check('codex served it', codexSeen.responses >= 1, String(codexSeen.responses));

  const before = codexSeen.responses;
  const r = await ask(CODEX_SLUG, pin('good'));
  check('pin + codex-routed model -> HTTP 409', r.status === 409, String(r.status));
  check('codex was never called for the pinned request', codexSeen.responses === before, `${codexSeen.responses} vs ${before}`);
  const body = await r.json().catch(() => ({}));
  check('error says the request routes elsewhere', /routes to codex/.test(body?.error?.message ?? ''), JSON.stringify(body).slice(0, 160));

  const r3 = await ask('claude-sonnet-5', pin('good'));
  check('a pinned CLAUDE model on the same proxy is unaffected (200)', r3.status === 200, String(r3.status));

  codexStub.close();
}


console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

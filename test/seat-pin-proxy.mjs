#!/usr/bin/env node
// In-process proxy test for the seat pin (x-dario-account): a pinned request
// goes to the named seat and NEVER fails over — not to a peer on 401, not to
// the Codex leg — while an unpinned request on the same pool still does.
// Two seats: `good` (upstream 200) and `dead` (upstream 401). A fake upstream
// records which bearer each call carried.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 38851;
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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

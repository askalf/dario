// Unit test for the refresh-lock Worker's auth and body cap
// (cloudflare/refresh-lock/worker.mjs). No Cloudflare runtime: the Durable
// Object namespace is a stub that counts how often the Worker routes to it,
// backed by a real RefreshLock over an in-memory storage Map, so a
// pass-through call exercises the actual acquire path.

import worker, { RefreshLock } from '../cloudflare/refresh-lock/worker.mjs';

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

function makeEnv(token) {
  const env = { routed: 0 };
  if (token !== undefined) env.LOCK_TOKEN = token;
  const storage = new Map();
  const state = {
    storage: {
      get: async (k) => storage.get(k),
      put: async (k, v) => { storage.set(k, v); },
      delete: async (k) => storage.delete(k),
      list: async ({ prefix }) => new Map([...storage].filter(([k]) => k.startsWith(prefix))),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new RefreshLock(state, env);
  env.REFRESH_LOCK = {
    idFromName: (name) => { env.routed++; return name; },
    get: () => ({ fetch: (req) => obj.fetch(req) }),
  };
  return env;
}

function call(env, path, { auth, body = '{"holder":"h"}' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth !== undefined) headers.authorization = auth;
  return worker.fetch(new Request(`https://lock.example${path}`, { method: 'POST', headers, body }), env);
}

header('no Authorization header: 401 at the Worker, no Durable Object touched');
{
  const env = makeEnv('s3cret');
  const lock = await call(env, '/lock/acct/acquire');
  const pool = await call(env, '/pool/seats');
  check('lock route returns 401', lock.status === 401);
  check('pool route returns 401', pool.status === 401);
  check('idFromName never called', env.routed === 0);
}

header('wrong token: 401, no Durable Object touched');
{
  const env = makeEnv('s3cret');
  const res = await call(env, '/lock/acct/acquire', { auth: 'Bearer s3cre' });
  check('returns 401', res.status === 401);
  check('idFromName never called', env.routed === 0);
}

header('LOCK_TOKEN unset: `Bearer undefined` is refused');
{
  const env = makeEnv(undefined);
  const res = await call(env, '/lock/acct/acquire', { auth: 'Bearer undefined' });
  check('returns 503 (not configured), not 200', res.status === 503);
  check('idFromName never called', env.routed === 0);
  const empty = makeEnv('');
  const res2 = await call(empty, '/lock/acct/acquire', { auth: 'Bearer ' });
  check('empty LOCK_TOKEN also refused with `Bearer `', res2.status === 503);
}

header('right token: passes through to the Durable Object');
{
  const env = makeEnv('s3cret');
  const res = await call(env, '/lock/acct/acquire', { auth: 'Bearer s3cret' });
  const body = await res.json();
  check('returns 200', res.status === 200);
  check('lock acquired with a lockId', body.acquired === true && typeof body.lockId === 'string');
  check('routed to exactly one object', env.routed === 1);
}

header('Durable Object checks auth on its own too');
{
  const env = makeEnv('s3cret');
  const obj = new RefreshLock({ storage: new Map() }, env);
  const res = await obj.fetch(new Request('https://lock.example/lock/acct/acquire', { method: 'POST', body: '{}' }));
  check('direct object call without a token returns 401', res.status === 401);
}

header('body cap');
{
  const env = makeEnv('s3cret');
  const big = JSON.stringify({ holder: 'h', pad: 'x'.repeat(70 * 1024) });
  const res = await call(env, '/lock/acct/acquire', { auth: 'Bearer s3cret', body: big });
  check('body over 64 KB returns 413', res.status === 413);
  const chunked = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); },
  });
  const res2 = await worker.fetch(new Request('https://lock.example/pool/seat/a', {
    method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: chunked, duplex: 'half',
  }), env);
  check('streamed body without content-length over 64 KB returns 413', res2.status === 413);
  const bad = await call(env, '/lock/acct/acquire', { auth: 'Bearer s3cret', body: 'not json' });
  check('malformed JSON returns 400', bad.status === 400);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

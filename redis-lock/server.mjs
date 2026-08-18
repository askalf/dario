// Redis-backed reference implementation of the SAME lock contract
// cloudflare/refresh-lock/worker.mjs speaks — dario's client code
// (src/accounts.ts doRefreshAccountTokenDistributed) doesn't know or care
// which backend is behind DARIO_REFRESH_LOCK_URL, so this is a drop-in
// alternative for operators who can't or don't want to depend on
// Cloudflare (airgapped environments, or just already running Redis in
// their own k8s cluster — dario#993 discussion, 2026-08-18).
//
// Same two-part correctness property as the Cloudflare version: a bare
// mutex isn't enough, because Anthropic invalidates the previous
// refresh_token on every refresh — a caller that loses the lock race
// must adopt the WINNER's fresh credentials, not just wait its turn to
// attempt its own (guaranteed-stale) refresh. `creds:<alias>` carries
// that handoff, with Redis's own PX expiry doing the "how recent is
// recent enough" bookkeeping the DO version had to track by hand.
//
// Auth: same shared-bearer-token shape as the Cloudflare Worker
// (LOCK_TOKEN env var here instead of a Worker secret) — this process
// holds OAuth refresh tokens in transit, treat it like any other
// credential-bearing internal service.
import { createServer } from 'node:http';
import { RespClient } from './resp-client.mjs';

const PORT = Number(process.env.PORT || 8080);
const LOCK_TOKEN = process.env.LOCK_TOKEN;
if (!LOCK_TOKEN) {
  console.error('LOCK_TOKEN is required (shared bearer secret — must match DARIO_REFRESH_LOCK_TOKEN on every dario instance).');
  process.exit(1);
}

const redis = new RespClient({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
});

// Safe release: only delete the lock if the caller is still the holder.
// Without this, a slow caller whose lease already expired-and-was-
// reassigned would delete the NEW holder's lock out from under them.
const RELEASE_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

async function handleAcquire(alias, body, res) {
  const { holder, ttlMs, currentExpiresAt } = body;
  if (!holder || typeof holder !== 'string') return json(res, 400, { error: 'holder required' });
  const ttl = Number.isFinite(ttlMs) ? Math.min(Math.max(ttlMs, 1000), 60_000) : 20_000;

  // Checked BEFORE the lock, unconditionally — the fix for the bug the
  // Cloudflare version's first draft had: a caller arriving just AFTER
  // the winner already released must adopt the fresh credentials, not
  // just see the lock free and redundantly refresh. Redis's own PX TTL
  // on creds:<alias> means an expired cache entry is simply absent here
  // — no separate "how recent" bookkeeping needed, unlike the DO version.
  const cachedRaw = await redis.send('GET', `creds:${alias}`);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw);
    if (!currentExpiresAt || cached.expiresAt > currentExpiresAt) {
      return json(res, 200, { acquired: false, credentials: cached });
    }
  }

  const setResult = await redis.send('SET', `lock:${alias}`, holder, 'NX', 'PX', String(ttl));
  if (setResult === 'OK') return json(res, 200, { acquired: true });

  const remaining = await redis.send('PTTL', `lock:${alias}`);
  return json(res, 200, { acquired: false, retryAfterMs: typeof remaining === 'number' && remaining > 0 ? remaining : ttl });
}

async function handleRelease(alias, body, res) {
  const { holder, credentials } = body;
  if (!holder || typeof holder !== 'string') return json(res, 400, { error: 'holder required' });

  const deleted = await redis.send('EVAL', RELEASE_SCRIPT, '1', `lock:${alias}`, holder);
  if (deleted !== 1) return json(res, 409, { released: false, reason: 'not holder' });

  if (credentials && typeof credentials === 'object') {
    await redis.send('SET', `creds:${alias}`, JSON.stringify(credentials), 'PX', '300000');
  }
  return json(res, 200, { released: true });
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${LOCK_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  const m = req.url.match(/^\/lock\/([^/]+)\/(acquire|release)$/);
  if (!m) return json(res, 404, { error: 'not found' });
  const [, aliasRaw, action] = m;
  const alias = decodeURIComponent(aliasRaw);

  try {
    const body = await readBody(req);
    if (action === 'acquire') await handleAcquire(alias, body, res);
    else await handleRelease(alias, body, res);
  } catch (e) {
    console.error('[redis-lock] request failed', { method: req.method, url: req.url, error: e });
    json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[redis-lock] listening on :${PORT}, redis=${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`);
});

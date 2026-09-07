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
import { randomUUID } from 'node:crypto';
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

  const lockId = randomUUID();
  const setResult = await redis.send('SET', `lock:${alias}`, lockId, 'NX', 'PX', String(ttl));
  if (setResult === 'OK') return json(res, 200, { acquired: true, lockId });

  const remaining = await redis.send('PTTL', `lock:${alias}`);
  return json(res, 200, { acquired: false, retryAfterMs: typeof remaining === 'number' && remaining > 0 ? remaining : ttl });
}

async function handleRelease(alias, body, res) {
  const { holder, lockId, credentials } = body;
  if (!holder || typeof holder !== 'string') return json(res, 400, { error: 'holder required' });
  if (!lockId || typeof lockId !== 'string') return json(res, 400, { error: 'lockId required' });

  const deleted = await redis.send('EVAL', RELEASE_SCRIPT, '1', `lock:${alias}`, lockId);
  if (deleted !== 1) return json(res, 409, { released: false, reason: 'not holder' });

  if (credentials && typeof credentials === 'object') {
    await redis.send('SET', `creds:${alias}`, JSON.stringify(credentials), 'PX', '300000');
  }
  return json(res, 200, { released: true });
}

// Shared pool state (dario's src/pool-sync.ts): the readings and sticky
// bindings instances exchange. Seats live in one hash so a pull is a single
// HGETALL; the client ignores readings older than its 6h horizon, so no
// per-field TTL is needed and the hash is bounded by the alias set. Sticky
// bindings are plain keys with the TTL the client asked for.
const SEATS_KEY = 'pool:seats';
const STICKY_MAX_TTL_MS = 24 * 3_600_000;
// Compare-and-set on the reading's `at`: a report only replaces the stored
// record when it is strictly newer. Reports from different instances can
// arrive out of order (a stalled POST resuming after a peer's fresher one),
// and an unconditional write would put an older, non-rejected reading back
// over a newer 429. Atomic in Redis; returns 1 when stored, 0 when ignored.
const SEAT_CAS_SCRIPT =
  "local cur = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "if cur then local c = cjson.decode(cur) if c.at and tonumber(c.at) >= tonumber(ARGV[2]) then return 0 end end " +
  "redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) return 1";
async function handlePool(m, body, res) {
  const [, kind, seatAlias, stickyKey, stickyAction] = m;
  if (kind.startsWith('seat/')) {
    const alias = decodeURIComponent(seatAlias);
    if (!body || typeof body.instance !== 'string' || typeof body.at !== 'number' || !body.snapshot || typeof body.snapshot !== 'object') {
      return json(res, 400, { error: 'instance, at, snapshot required' });
    }
    const record = JSON.stringify({ instance: body.instance, at: body.at, snapshot: body.snapshot, rejected: body.rejected === true });
    const stored = await redis.send('EVAL', SEAT_CAS_SCRIPT, '1', SEATS_KEY, alias, String(body.at), record);
    return json(res, 200, { ok: true, stored: stored === 1 });
  }
  if (kind === 'seats') {
    const flat = await redis.send('HGETALL', SEATS_KEY);
    const seats = {};
    for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) {
      try { seats[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* a corrupt field is skipped, not fatal */ }
    }
    return json(res, 200, { seats });
  }
  const key = decodeURIComponent(stickyKey);
  if (stickyAction === 'bind') {
    if (!body || typeof body.alias !== 'string' || body.alias.length === 0) return json(res, 400, { error: 'alias required' });
    const ttl = Number.isFinite(body.ttlMs) ? Math.min(Math.max(body.ttlMs, 1000), STICKY_MAX_TTL_MS) : 6 * 3_600_000;
    await redis.send('SET', `sticky:${key}`, body.alias, 'PX', String(ttl));
    return json(res, 200, { ok: true });
  }
  const alias = await redis.send('GET', `sticky:${key}`);
  return json(res, 200, { alias: typeof alias === 'string' && alias.length > 0 ? alias : null });
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${LOCK_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  const pool = req.url.match(/^\/pool\/(seat\/([^/]+)|seats|sticky\/([^/]+)\/(bind|get))$/);
  const m = req.url.match(/^\/lock\/([^/]+)\/(acquire|release)$/);
  if (!m && !pool) return json(res, 404, { error: 'not found' });
  const [, aliasRaw, action] = m ?? [];
  const alias = aliasRaw ? decodeURIComponent(aliasRaw) : '';

  try {
    const body = await readBody(req);
    if (pool) { await handlePool(pool, body, res); return; }
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

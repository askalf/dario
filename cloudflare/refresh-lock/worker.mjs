// Durable Object refresh lock — one instance per account alias (via
// idFromName), so state is strongly consistent and globally serialized
// regardless of how many dario processes/pods call in. See dario#993.
//
// Why a lock alone isn't enough: Anthropic invalidates the previous
// refresh_token on every refresh. Two dario instances refreshing the SAME
// account back-to-back (never overlapping, lock-serialized) would still
// break — instance B's refresh_token was already burned by instance A's
// refresh before B ever got a turn. So the lock also relays the WINNER's
// fresh credentials to the loser: a caller that fails to acquire gets
// back the latest known-good credentials if a refresh just completed,
// and adopts them instead of attempting its own (guaranteed-stale) one.
//
// Auth: a single shared bearer token (DARIO_REFRESH_LOCK_TOKEN on both
// sides) — this Worker holds OAuth refresh tokens in transit, treat it
// like any other credential-bearing internal service.

export class RefreshLock {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    // The Worker already checked this before routing here. Checked again so
    // the object never trusts that every path into it went through fetch().
    const denied = await checkAuth(request, this.env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    // Matched first: an alias may itself be named `acquire`, `release` or `peek`.
    if (url.pathname.startsWith('/accounts/')) return this.accounts(request, url);
    if (url.pathname.endsWith('/acquire')) return this.acquire(request);
    if (url.pathname.endsWith('/release')) return this.release(request);
    if (url.pathname.endsWith('/peek')) return this.peek(request);
    if (url.pathname.startsWith('/pool/')) return this.pool(request, url);
    return json({ error: 'not found' }, 404);
  }

  async acquire(request) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const { holder, ttlMs, currentExpiresAt, currentGrantedAt } = body;
    if (!holder || typeof holder !== 'string') return json({ error: 'holder required' }, 400);
    const ttl = Number.isFinite(ttlMs) ? Math.min(Math.max(ttlMs, 1000), 60_000) : 20_000;
    const now = Date.now();

    // Checked BEFORE the lock, on every call regardless of lock state —
    // this is what makes the handoff work for a caller that arrives right
    // AFTER the winner already released, not just one that arrives while
    // the winner is mid-refresh. Without this check here, that caller's
    // acquire() would simply succeed (lock is free) and it would refresh
    // redundantly, never knowing fresher credentials were sitting cached
    // one call away.
    const cached = await this.cachedCredentials(now);
    if (isNewer(cached, currentExpiresAt, currentGrantedAt)) {
      return json({ acquired: false, credentials: cached });
    }

    const lock = (await this.state.storage.get('lock')) || null;

    if (lock && lock.expiresAt > now) {
      // Someone holds it, and (per the check above) nothing cached is
      // fresher than what this caller already has — genuinely wait it out.
      //
      // Deliberately NO same-holder re-acquire here (removed with the
      // lockId change): `holder` is client-supplied and guessable, so
      // "we already hold it" was an assertion the server couldn't verify
      // — anyone with the shared token could overwrite a live lock by
      // echoing its holder. A caller that lost the acquire response can't
      // resume anyway (it has no lockId to release with), so waiting out
      // the short TTL is the correct recovery, exactly as it is against
      // redis-lock/server.mjs, whose SET NX never allowed re-acquire.
      return json({ acquired: false, retryAfterMs: lock.expiresAt - now });
    }

    // Free or expired. Ownership is the server-generated lockId, not the
    // caller-picked holder — every dario instance shares one LOCK_TOKEN,
    // so a holder string proves nothing (same reasoning as
    // redis-lock/server.mjs). `holder` is kept for logs and diagnostics.
    const lockId = crypto.randomUUID();
    await this.state.storage.put('lock', { holder, lockId, expiresAt: now + ttl });
    return json({ acquired: true, lockId });
  }

  async release(request) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const { holder, lockId, credentials } = body;
    if (!holder || typeof holder !== 'string') return json({ error: 'holder required' }, 400);
    if (!lockId || typeof lockId !== 'string') return json({ error: 'lockId required' }, 400);

    const lock = await this.state.storage.get('lock');
    if (!lock || lock.lockId !== lockId) {
      // Not the current holder — our lease likely expired and someone
      // else already took over. Releasing here would steal their lock.
      // (A lock written before this Worker issued lockIds also lands
      // here and simply expires on its own TTL — a one-time, <=60s
      // window on upgrade.)
      return json({ released: false, reason: 'not holder' }, 409);
    }
    await this.state.storage.delete('lock');
    if (credentials && typeof credentials === 'object') {
      // Cache the fresh credentials for every other instance, for
      // CREDS_KEEP_MS (see there for why that is not a few minutes).
      await this.state.storage.put('credentials', credentials);
      await this.state.storage.put('credentialsAt', Date.now());
    }
    return json({ released: true });
  }

  // Read-only: the cached credentials when they are newer than the caller's,
  // else none. Never takes the lock. Each instance asks on every refresh
  // tick so a replica picks up a peer's rotation within one tick, not at its
  // own refresh window hours later.
  async peek(request) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const { currentExpiresAt, currentGrantedAt } = body;
    const cached = await this.cachedCredentials(Date.now());
    return json(isNewer(cached, currentExpiresAt, currentGrantedAt) ? { credentials: cached } : {});
  }

  async cachedCredentials(now) {
    const cached = await this.state.storage.get('credentials');
    const cachedAt = await this.state.storage.get('credentialsAt');
    return cached && cachedAt && now - cachedAt < CREDS_KEEP_MS ? cached : null;
  }

  // Shared pool state (dario's src/pool-sync.ts) — served by the single
  // `__pool__` object, since a pull needs every seat at once. Seats are
  // `seat:<alias>` entries; the client ignores readings older than its 6h
  // horizon. Sticky bindings carry their own expiry.
  async pool(request, url) {
    const m = url.pathname.match(/^\/pool\/(seat\/([^/]+)|seats|sticky\/([^/]+)\/(bind|get))$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, kind, seatAlias, stickyKey, stickyAction] = m;
    if (kind.startsWith('seat/')) {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      if (typeof body.instance !== 'string' || typeof body.at !== 'number' || !body.snapshot || typeof body.snapshot !== 'object') {
        return json({ error: 'instance, at, snapshot required' }, 400);
      }
      // Compare-and-set on `at`: only a strictly newer reading replaces the
      // stored one — reports from different instances can arrive out of
      // order. blockConcurrencyWhile keeps the read and the write from
      // interleaving with another request to this object.
      const key = `seat:${decodeURIComponent(seatAlias)}`;
      const stored = await this.state.blockConcurrencyWhile(async () => {
        const current = await this.state.storage.get(key);
        if (current && typeof current.at === 'number' && current.at >= body.at) return false;
        await this.state.storage.put(key, { instance: body.instance, at: body.at, snapshot: body.snapshot, rejected: body.rejected === true });
        return true;
      });
      return json({ ok: true, stored });
    }
    if (kind === 'seats') {
      const entries = await this.state.storage.list({ prefix: 'seat:' });
      const seats = {};
      for (const [k, v] of entries) seats[k.slice('seat:'.length)] = v;
      return json({ seats });
    }
    const key = decodeURIComponent(stickyKey);
    if (stickyAction === 'bind') {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      if (typeof body.alias !== 'string' || body.alias.length === 0) return json({ error: 'alias required' }, 400);
      const ttl = Number.isFinite(body.ttlMs) ? Math.min(Math.max(body.ttlMs, 1000), 24 * 3_600_000) : 6 * 3_600_000;
      await this.state.storage.put(`sticky:${key}`, { alias: body.alias, expiresAt: Date.now() + ttl });
      return json({ ok: true });
    }
    const bound = await this.state.storage.get(`sticky:${key}`);
    if (!bound || bound.expiresAt <= Date.now()) {
      if (bound) await this.state.storage.delete(`sticky:${key}`);
      return json({ alias: null });
    }
    return json({ alias: bound.alias });
  }

  // Shared account registry (dario's src/account-sync.ts), also on the single
  // `__pool__` object: every seat's credentials as `account:<alias>`, and a
  // removal marker as `removed:<alias>`. Neither expires: a record is the
  // current credential for its alias until a newer one or a removal replaces
  // it, and a marker is what stops a replica that was offline from pushing
  // the removed account back. Same rules as redis-lock/server.mjs.
  async accounts(request, url) {
    const m = url.pathname.match(/^\/accounts\/(list|([^/]+)\/(put|remove))$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, kind, aliasRaw, action] = m;
    if (kind === 'list') {
      const accounts = {};
      for (const [k, v] of await this.state.storage.list({ prefix: 'account:' })) accounts[k.slice('account:'.length)] = v;
      const removed = {};
      for (const [k, v] of await this.state.storage.list({ prefix: 'removed:' })) removed[k.slice('removed:'.length)] = v;
      return json({ accounts, removed });
    }
    const alias = decodeURIComponent(aliasRaw);
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const recordKey = `account:${alias}`, removedKey = `removed:${alias}`;
    if (action === 'put') {
      const c = body.credentials;
      if (!c || typeof c !== 'object' || c.alias !== alias || typeof c.accessToken !== 'string'
          || typeof c.refreshToken !== 'string' || typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)) {
        return json({ error: 'credentials for this alias required' }, 400);
      }
      // Stored only when newer than the stored record (isNewer: a newer
      // grant, or the same grant with a later expiry) and, under a removal
      // marker, only when granted after that removal. Storing clears it.
      const stored = await this.state.blockConcurrencyWhile(async () => {
        const removedAt = await this.state.storage.get(removedKey);
        if (typeof removedAt === 'number' && !(Number.isFinite(c.grantedAt) && c.grantedAt > removedAt)) return false;
        const current = await this.state.storage.get(recordKey);
        if (current && !isNewer(c, current.expiresAt, current.grantedAt)) return false;
        await this.state.storage.put(recordKey, c);
        if (removedAt !== undefined) await this.state.storage.delete(removedKey);
        return true;
      });
      return json({ stored });
    }
    if (typeof body.removedAt !== 'number' || !Number.isFinite(body.removedAt)) return json({ error: 'removedAt required' }, 400);
    // A record granted after the removal is a later login and is kept.
    // Otherwise it goes, and the marker keeps the latest removal time.
    const removed = await this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get(recordKey);
      if (current && Number.isFinite(current.grantedAt) && current.grantedAt > body.removedAt) return false;
      if (current) await this.state.storage.delete(recordKey);
      const prior = await this.state.storage.get(removedKey);
      if (typeof prior !== 'number' || body.removedAt > prior) await this.state.storage.put(removedKey, body.removedAt);
      return true;
    });
    return json({ removed });
  }
}

// How long a released credential is handed out. It is the latest member of
// the account's token family, and only a caller holding an OLDER member is
// ever handed it, so its age never makes it worse than what that caller has:
// the caller's own refresh token was rotated away by the refresh that wrote
// it. It must outlast the longest gap between two replicas' refreshes
// (dario#1733), so it is kept past the ~28-day grant wall, after which the
// family is dead anyway.
const CREDS_KEEP_MS = 30 * 86_400_000;

// Whether the cached credentials are newer than the caller's. A newer GRANT
// wins outright: a re-login on one replica must not be overwritten by
// another replica still refreshing the old grant, whose access tokens can
// expire later. Same grant, or a grant time missing on either side: the
// later expiry wins, as it always has. Same rule in redis-lock/server.mjs.
function isNewer(cached, currentExpiresAt, currentGrantedAt) {
  if (!cached || typeof cached !== 'object' || typeof cached.expiresAt !== 'number') return false;
  if (Number.isFinite(cached.grantedAt) && Number.isFinite(currentGrantedAt) && cached.grantedAt !== currentGrantedAt) {
    return cached.grantedAt > currentGrantedAt;
  }
  return !currentExpiresAt || cached.expiresAt > currentExpiresAt;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Returns null when the request carries the shared bearer, else the error
// Response. An unset LOCK_TOKEN refuses everything: comparing against it
// would otherwise accept the literal header `Bearer undefined`.
// Both sides are hashed to 32-byte SHA-256 digests, which are compared with
// an XOR loop over every byte and no early exit, so the comparison does not
// stop at the first mismatching byte. Encoding and hashing the header still
// take time that grows with its length.
async function checkAuth(request, env) {
  if (typeof env.LOCK_TOKEN !== 'string' || env.LOCK_TOKEN.length === 0) {
    return json({ error: 'LOCK_TOKEN not configured' }, 503);
  }
  const given = request.headers.get('authorization') ?? '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${env.LOCK_TOKEN}`)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 ? null : json({ error: 'unauthorized' }, 401);
}

// Every body this service accepts is a small JSON object (a lock call, one
// seat reading, one sticky binding, one account record). Reading stops at MAX_BODY_BYTES so a
// caller cannot make the object buffer and parse an arbitrarily large body;
// content-length is not trusted alone because a chunked body has none.
const MAX_BODY_BYTES = 64 * 1024;

// Returns the parsed object, or the error Response to send back.
async function readJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: 'body too large' }, 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'JSON object required' }, 400);
  }
  return body;
}

export default {
  async fetch(request, env) {
    // Auth before routing: an unauthenticated call is refused here and never
    // reaches a Durable Object, so it cannot create an object per alias in
    // the URL or queue work on the single `__pool__` object.
    const denied = await checkAuth(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    // /lock/<alias>/acquire|release|peek
    // Shared pool state and the account registry live in one object for the
    // whole pool, since a pull or a list needs every seat at once.
    if (url.pathname.startsWith('/pool/') || url.pathname.startsWith('/accounts/')) {
      const id = env.REFRESH_LOCK.idFromName('__pool__');
      return env.REFRESH_LOCK.get(id).fetch(request);
    }
    const m = url.pathname.match(/^\/lock\/([^/]+)\/(acquire|release|peek)$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, alias, _action] = m;
    const id = env.REFRESH_LOCK.idFromName(decodeURIComponent(alias));
    const stub = env.REFRESH_LOCK.get(id);
    return stub.fetch(request);
  },
};

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
    if (request.headers.get('authorization') !== `Bearer ${this.env.LOCK_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    if (url.pathname.endsWith('/acquire')) return this.acquire(request);
    if (url.pathname.endsWith('/release')) return this.release(request);
    return json({ error: 'not found' }, 404);
  }

  async acquire(request) {
    const { holder, ttlMs, currentExpiresAt } = await request.json();
    if (!holder || typeof holder !== 'string') return json({ error: 'holder required' }, 400);
    const ttl = Number.isFinite(ttlMs) ? Math.min(Math.max(ttlMs, 1000), 60_000) : 20_000;
    const now = Date.now();

    // Checked BEFORE the lock, on every call regardless of lock state —
    // this is what makes the handoff work for a caller that arrives right
    // AFTER the winner already released, not just one that arrives while
    // the winner is mid-refresh. Without this check here, that caller's
    // acquire() would simply succeed (lock is free) and it would refresh
    // redundantly, never knowing fresher credentials were sitting cached
    // one call away. Bounded to 5 minutes — past that, a cached credential
    // is stale enough that a real refresh is more trustworthy than reusing it.
    const cached = await this.state.storage.get('credentials');
    const cachedAt = await this.state.storage.get('credentialsAt');
    if (cached && cachedAt && now - cachedAt < 5 * 60_000
        && (!currentExpiresAt || cached.expiresAt > currentExpiresAt)) {
      return json({ acquired: false, credentials: cached });
    }

    const lock = (await this.state.storage.get('lock')) || null;

    if (lock && lock.expiresAt > now && lock.holder !== holder) {
      // Someone else holds it, and (per the check above) nothing cached is
      // fresher than what this caller already has — genuinely wait it out.
      return json({ acquired: false, retryAfterMs: lock.expiresAt - now });
    }

    // Free, expired, or we already hold it (idempotent re-acquire).
    await this.state.storage.put('lock', { holder, expiresAt: now + ttl });
    return json({ acquired: true });
  }

  async release(request) {
    const { holder, credentials } = await request.json();
    if (!holder || typeof holder !== 'string') return json({ error: 'holder required' }, 400);

    const lock = await this.state.storage.get('lock');
    if (!lock || lock.holder !== holder) {
      // Not the current holder — our lease likely expired and someone
      // else already took over. Releasing here would steal their lock.
      return json({ released: false, reason: 'not holder' }, 409);
    }
    await this.state.storage.delete('lock');
    if (credentials && typeof credentials === 'object') {
      // Cache the fresh credentials for whoever was waiting, with their
      // own short TTL — stale-but-cached creds are worse than none once
      // they're old enough that a waiter should just refresh for real.
      await this.state.storage.put('credentials', credentials);
      await this.state.storage.put('credentialsAt', Date.now());
    }
    return json({ released: true });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /lock/<alias>/acquire|release
    const m = url.pathname.match(/^\/lock\/([^/]+)\/(acquire|release)$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, alias, _action] = m;
    const id = env.REFRESH_LOCK.idFromName(decodeURIComponent(alias));
    const stub = env.REFRESH_LOCK.get(id);
    return stub.fetch(request);
  },
};

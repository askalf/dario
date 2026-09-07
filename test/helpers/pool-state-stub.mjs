// In-memory stand-in for the refresh-lock service's shared-pool-state
// endpoints (src/pool-sync.ts). Same contract as redis-lock/server.mjs and
// cloudflare/refresh-lock/worker.mjs: bearer-gated, POST only, three routes.
// Records every call so a test can assert who reported, who pulled, and who
// bound what. Lock routes answer 404 (a refresh in a test falls open).

import { createServer } from 'node:http';

export async function startPoolStateStub({ token = 'stub-token' } = {}) {
  const seats = new Map();     // alias → SharedSeat
  const sticky = new Map();    // key → { alias, expiresAt }
  const calls = [];            // { path, body }
  let down = false;

  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (down) { req.socket.destroy(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' });
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, body });
    let m;
    if ((m = req.url.match(/^\/pool\/seat\/([^/]+)$/))) {
      const alias = decodeURIComponent(m[1]);
      if (!body || typeof body.instance !== 'string' || typeof body.at !== 'number' || !body.snapshot) return json(400, { error: 'instance, at, snapshot required' });
      seats.set(alias, { instance: body.instance, at: body.at, snapshot: body.snapshot, rejected: body.rejected === true });
      return json(200, { ok: true });
    }
    if (req.url === '/pool/seats') {
      return json(200, { seats: Object.fromEntries(seats) });
    }
    if ((m = req.url.match(/^\/pool\/sticky\/([^/]+)\/(bind|get)$/))) {
      const key = decodeURIComponent(m[1]);
      if (m[2] === 'bind') {
        if (!body || typeof body.alias !== 'string') return json(400, { error: 'alias required' });
        const ttl = Number.isFinite(body.ttlMs) ? body.ttlMs : 6 * 3_600_000;
        sticky.set(key, { alias: body.alias, expiresAt: Date.now() + ttl });
        return json(200, { ok: true });
      }
      const b = sticky.get(key);
      if (!b || b.expiresAt <= Date.now()) { sticky.delete(key); return json(200, { alias: null }); }
      return json(200, { alias: b.alias });
    }
    return json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    seats,
    sticky,
    calls,
    /** Simulate an outage: every connection is dropped until `up()`. */
    down() { down = true; },
    up() { down = false; },
    close: () => new Promise((r) => server.close(r)),
  };
}

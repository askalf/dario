// Mock Anthropic OAuth token endpoint for live multi-process integration
// testing (test/integration/dual-instance-race.mjs). Deliberately enforces
// the ONE real-world behavior this whole fix depends on: Anthropic
// invalidates the previous refresh_token on every refresh, so reusing an
// already-consumed token must 400 exactly like the real API does. Without
// this, a mock that just always succeeds would validate nothing — the race
// #993 describes only exists because of this exact invalidation behavior.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_OAUTH_PORT || 8912);

// alias -> current valid refresh_token. Seeded via /seed before the test
// starts, mutated on every successful refresh.
const validTokens = new Map();
const usedTokens = new Set();
const refreshLog = [];

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf-8');

  if (req.method === 'POST' && req.url === '/seed') {
    const { alias, refreshToken } = JSON.parse(body);
    validTokens.set(alias, refreshToken);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refreshLog));
    return;
  }

  if (req.method === 'POST' && req.url === '/oauth/token') {
    const params = new URLSearchParams(body);
    const presented = params.get('refresh_token');
    const entry = { presented, at: Date.now() };

    // Find which alias this token belongs to (by CURRENT valid value —
    // an already-used token won't match anything, which is the point).
    let alias = null;
    for (const [a, tok] of validTokens) if (tok === presented) alias = a;

    if (!alias) {
      entry.result = usedTokens.has(presented) ? 'REJECTED (already used)' : 'REJECTED (unknown token)';
      refreshLog.push(entry);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }));
      return;
    }

    // Consume it — this IS Anthropic's real behavior being modeled.
    usedTokens.add(presented);
    const newAccess = `mock-access-${randomUUID()}`;
    const newRefresh = `mock-refresh-${randomUUID()}`;
    validTokens.set(alias, newRefresh);
    entry.result = `OK (alias=${alias}, issued new refresh)`;
    refreshLog.push(entry);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: newAccess, refresh_token: newRefresh, expires_in: 28800 }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[mock-oauth] listening on :${PORT}`);
});

#!/usr/bin/env node
// DEV-179a412f — a codex account whose refresh_token is dead must cost ONE
// token-endpoint attempt per minute, not one per request, and the client must
// be told about the CODEX account rather than the Claude one.
//
// The reported symptom, with a stored codex account whose refresh_token was
// dead and whose access token had expired: 5 inbound requests produced 6 POSTs
// to the token endpoint, ZERO log lines, and the client got
// `503 {"error":"No account configured", ... "Run dario login"}` — because
// getFreshCodexAccount remembered nothing about a failure, and proxy.ts awaited
// it inside the JSON-peek `try` whose `catch { /* not JSON */ }` swallowed the
// throw, so the codex route silently disappeared.
//
// Two layers, same file:
//   1. codex-accounts.ts — the failure TTL itself: N sequential calls, ONE
//      upstream attempt; recovery clears it.
//   2. a real proxy on loopback — a codex-bound request answers 503 naming the
//      codex alias, in the client's wire shape, with no further token POST.
//
// Hermetic: HOME in a mkdtemp'd dir, both codex URLs pointed at local stubs,
// no Claude login (`noClaudeAuth`), no network.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clear of dario's 3456-3460 range and the other test files' ports.
const PROXY_PORT = 38801;
const TOKEN_PORT = 38802;
const BACKEND_PORT = 38803;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

const ALIAS = 'fleet';
const LISTED_SLUG = 'gpt-5.6-sol';

// The token endpoint: always 401 invalid_grant, and it COUNTS. That count is
// the whole assertion — the defect was one POST per inbound request.
let tokenPosts = 0;
const tokenStub = createServer((req, res) => {
  tokenPosts++;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token is dead' }));
});
await new Promise((r) => tokenStub.listen(TOKEN_PORT, '127.0.0.1', r));

// The codex backend. A credential known to be bad must never reach it.
let backendHits = 0;
const backendStub = createServer((req, res) => {
  backendHits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
});
await new Promise((r) => backendStub.listen(BACKEND_PORT, '127.0.0.1', r));

// Env BEFORE the imports: codex-accounts.ts resolves its directory and
// codex-oauth.ts its token URL at module-evaluation time.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-refresh-fail-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_TOKEN_URL = `http://127.0.0.1:${TOKEN_PORT}/oauth/token`;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
delete process.env.DARIO_CODEX_ACCOUNT;

const {
  saveCodexAccount,
  loadCodexAccount,
  getFreshCodexAccount,
  getCodexRefreshFailure,
  CodexCredentialsUnavailableError,
  _resetCodexPresenceCacheForTest,
  _resetCodexRefreshFailuresForTest,
} = await import('../dist/codex-accounts.js');

const accountsDir = join(tmpHome, '.dario', 'codex-accounts');
const writeAccountFile = async (expiresAt) => {
  await mkdir(accountsDir, { recursive: true });
  await writeFile(join(accountsDir, `${ALIAS}.json`), JSON.stringify({
    alias: ALIAS,
    accessToken: `${ALIAS}-access-token`,
    refreshToken: `${ALIAS}-dead-refresh-token`,
    expiresAt,
  }));
};

header('a dead refresh token costs ONE attempt, not one per call');
{
  await writeAccountFile(Date.now() - 1000); // expired → every call wants a refresh
  const creds = await loadCodexAccount(ALIAS);

  const errors = [];
  for (let i = 0; i < 5; i++) {
    try {
      await getFreshCodexAccount(creds);
      errors.push(null);
    } catch (err) {
      errors.push(err);
    }
  }

  check('all 5 sequential calls threw', errors.every((e) => e !== null),
    JSON.stringify(errors.map((e) => (e ? e.name : 'resolved'))));
  check('the throw is the typed CodexCredentialsUnavailableError',
    errors.every((e) => e instanceof CodexCredentialsUnavailableError), errors[0]?.name);
  check('the error names the codex alias', errors[0]?.alias === ALIAS, String(errors[0]?.alias));
  check('the error carries the upstream status', errors[0]?.status === 401, String(errors[0]?.status));
  // The defect: 5 requests -> 5+ POSTs. The fix: the failure is remembered.
  check('exactly ONE token-endpoint POST for 5 calls', tokenPosts === 1, `tokenPosts=${tokenPosts}`);

  const failure = getCodexRefreshFailure(ALIAS);
  check('the failure is readable for the admin surface', failure !== null);
  check('it records the status', failure?.status === 401, String(failure?.status));
  check('it records a bounded body snippet', typeof failure?.message === 'string' && failure.message.length <= 120,
    JSON.stringify(failure?.message));
  check('the snippet is the upstream error, not a token',
    failure?.message.includes('invalid_grant') && !failure.message.includes('dead-refresh-token'),
    JSON.stringify(failure?.message));
  check('an unknown alias has no failure', getCodexRefreshFailure('nobody') === null);
}

header('recovery — fresh credentials on disk clear the memory');
{
  const before = tokenPosts;
  await saveCodexAccount({
    alias: ALIAS,
    accessToken: 'recovered-access-token',
    refreshToken: 'recovered-refresh-token',
    expiresAt: Date.now() + 2 * 3600_000,
  });
  const fresh = await getFreshCodexAccount(await loadCodexAccount(ALIAS));
  check('fresh credentials are returned', fresh.accessToken === 'recovered-access-token');
  check('no refresh attempt was needed', tokenPosts === before, `tokenPosts=${tokenPosts}`);
  check('the remembered failure is gone', getCodexRefreshFailure(ALIAS) === null,
    JSON.stringify(getCodexRefreshFailure(ALIAS)));
}

// ---------------------------------------------------------------------------
// Proxy level: the client must hear about the CODEX account.
// ---------------------------------------------------------------------------
_resetCodexRefreshFailuresForTest();
await writeAccountFile(Date.now() - 1000);
_resetCodexPresenceCacheForTest();

const { startProxy } = await import('../dist/proxy.js');

const noNetwork = async (url) => { throw new Error(`unexpected upstream fetch: ${url}`); };
await startProxy({
  port: PROXY_PORT,
  host: '127.0.0.1',
  passthrough: true,
  verbose: false,
  noLiveCapture: true,
  noClaudeAuth: true,
  fetchImpl: noNetwork,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

header('codex-bound request with unrefreshable credentials → codex-specific 503');
{
  const postsBefore = tokenPosts;
  const bodies = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The `codex:` prefix is the unambiguous "this request is the
      // subscription's" signal; a bare listed slug needs a warm discovery
      // cache, which a never-authenticated account does not have.
      body: JSON.stringify({ model: `codex:${LISTED_SLUG}`, messages: [{ role: 'user', content: 'ping' }] }),
    });
    bodies.push({ status: res.status, rejection: res.headers.get('x-dario-upstream-rejection'), json: await res.json() });
  }

  const first = bodies[0];
  check('answered 503', bodies.every((b) => b.status === 503), JSON.stringify(bodies.map((b) => b.status)));
  check('marked as a credential rejection', first.rejection === 'credential_rejected', String(first.rejection));
  check('the message names the codex account', String(first.json.error ?? '').includes(`"${ALIAS}"`),
    JSON.stringify(first.json));
  check('it points at `dario codex add`, not `dario login`',
    String(first.json.error ?? '').includes('dario codex add')
    && !String(first.json.error ?? '').includes('dario login'),
    JSON.stringify(first.json));
  check('it is NOT the Claude "No account configured" answer',
    !JSON.stringify(first.json).includes('No account configured'), JSON.stringify(first.json));
  check('OpenAI wire shape (flat `error` string)', typeof first.json.error === 'string', JSON.stringify(first.json));
  check('the account is named as a field too', first.json.account === ALIAS, JSON.stringify(first.json));
  // At most one attempt for the whole burst — the point of the ticket.
  check('5 requests cost at most ONE token-endpoint POST', tokenPosts - postsBefore <= 1,
    `posts=${tokenPosts - postsBefore}`);
  check('the codex backend was never called with a bad credential', backendHits === 0, `backendHits=${backendHits}`);
}

header('same request in Anthropic shape → Anthropic-shaped error');
{
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `codex:${LISTED_SLUG}`, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const json = await res.json();
  check('answered 503', res.status === 503, String(res.status));
  check('Anthropic error envelope', json.type === 'error' && json.error?.type === 'authentication_error',
    JSON.stringify(json));
  check('the message names the codex account', String(json.error?.message ?? '').includes(`"${ALIAS}"`),
    JSON.stringify(json));
}

tokenStub.close();
backendStub.close();
await rm(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

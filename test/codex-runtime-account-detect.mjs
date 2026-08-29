#!/usr/bin/env node
// dario#1138 — a codex account stored while the proxy is ALREADY RUNNING must
// route without a restart. The live symptom on the Hetzner deploy: the proxy
// booted with zero codex accounts, `dario codex add fleet` stored one two
// minutes later, and until `docker restart` /v1/models advertised no gpt slugs
// and a listed slug fell through to the Claude path as an unknown model —
// because `hasCodexAccount` was computed once at startup and only ever flipped
// FALSE, never TRUE.
//
// Two layers here:
//   1. hasAnyCodexAccount() itself — presence is re-read, the ABSENT answer is
//      cached ~30s, the present one is not.
//   2. a real proxy on loopback with no codex account at boot: the account
//      file appears mid-run and the very next request routes to the codex
//      backend stub.
//
// Hermetic: HOME in a mkdtemp'd dir, DARIO_CODEX_BASE_URL at a local stub, no
// Claude login (`noClaudeAuth`), no network.

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
const PROXY_PORT = 38795;
const STUB_PORT = 38796;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

// Deliberately not a name isOpenAIModel would recognise on its own — routing
// has to come from this account's discovery.
const LISTED_SLUG = 'gpt-5.6-sol';

const seen = { models: 0, responses: 0 };
const stub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    seen.models++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    seen.responses++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_abc"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"hi from codex"}\n\n');
      res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

// HOME set BEFORE the imports: codex-accounts.ts resolves its directory at
// module-evaluation time (same strategy as test/codex-accounts.mjs).
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-codex-runtime-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
delete process.env.DARIO_CODEX_ACCOUNT;

const {
  hasAnyCodexAccount,
  saveCodexAccount,
  removeCodexAccount,
  _resetCodexPresenceCacheForTest,
} = await import('../dist/codex-accounts.js');

const accountsDir = join(tmpHome, '.dario', 'codex-accounts');
const writeAccountFile = async (alias) => {
  await mkdir(accountsDir, { recursive: true });
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias,
    accessToken: `${alias}-access-token`,
    refreshToken: `${alias}-refresh-token`,
    expiresAt: Date.now() + 3_600_000,
  }));
};

header('hasAnyCodexAccount — presence is re-read, absence is cached');
{
  const t0 = 1_000_000;
  check('no accounts → false', (await hasAnyCodexAccount(t0)) === false);

  // Another process (`dario codex add`) drops a file in. Within the negative
  // TTL the cached "absent" still stands — that is the deliberate cost of not
  // stat-ing per request on an idle proxy.
  await writeAccountFile('fleet');
  check('added out-of-process → still absent inside the 30s negative TTL',
    (await hasAnyCodexAccount(t0 + 5_000)) === false);
  check('past the TTL → present, with no restart',
    (await hasAnyCodexAccount(t0 + 31_000)) === true);

  // Presence is never cached, so a removal takes effect on the next call.
  await removeCodexAccount('fleet');
  check('removed → false again immediately', (await hasAnyCodexAccount(t0 + 31_001)) === false);

  // A save inside THIS process must not be hidden by the negative entry the
  // line above just armed.
  await saveCodexAccount({
    alias: 'inproc', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
  });
  check('in-process save clears the negative cache', (await hasAnyCodexAccount(t0 + 31_002)) === true);
  await removeCodexAccount('inproc');
  _resetCodexPresenceCacheForTest();
  check('back to empty for the proxy run below', (await hasAnyCodexAccount()) === false);
}

// ---------------------------------------------------------------------------
// The regression itself: proxy boots with ZERO codex accounts.
// ---------------------------------------------------------------------------
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

header('booted with no codex account → no gpt slugs advertised');
{
  const res = await fetch(`${BASE}/v1/models`);
  const json = await res.json();
  check('/v1/models answers', res.status === 200, String(res.status));
  check('the codex slug is not advertised', !json.data.some((m) => m.id === LISTED_SLUG));
  check('the codex backend was not consulted', seen.models === 0, `models=${seen.models}`);
}

header('account added mid-run → next request routes to codex, no restart');
{
  await writeAccountFile('fleet');
  // The /v1/models call above armed the negative cache; a real operator waits
  // out its ~30s, the test skips the wait rather than sleeping for it.
  _resetCodexPresenceCacheForTest();

  const models = await (await fetch(`${BASE}/v1/models`)).json();
  const entry = models.data.find((m) => m.id === LISTED_SLUG);
  check('the slug is now advertised on the SAME process', entry !== undefined,
    JSON.stringify(models.data?.slice(0, 5)));
  check('advertised as owned_by openai', entry?.owned_by === 'openai', JSON.stringify(entry));

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LISTED_SLUG, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const json = await res.json();
  check('the request is served, not 404/503 off the Claude path', res.status === 200,
    `${res.status} ${JSON.stringify(json)}`);
  check('it reached the codex backend', seen.responses === 1, `responses=${seen.responses}`);
  check('content came back translated', json.choices?.[0]?.message?.content === 'hi from codex',
    JSON.stringify(json));
}

stub.close();
await rm(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

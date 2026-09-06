#!/usr/bin/env node
// /health under --no-claude-auth: the empty Claude pool is deliberate, but the
// FLAG is not evidence that anything serves — a present Codex account is.
//
// Found by codex-drift-watch.yml (2026-09-06): its proxy booted with
// --no-claude-auth and a loaded Codex account, and /health 503'd for the whole
// 30s readiness window because the Claude pool was 'none'. The first fix on
// #1224 exempted the flag alone; review pointed out that `--no-claude-auth`
// with no account and no API key starts fine (requiresClaudeLogin permits it)
// and would then report 200 with nothing able to serve. So the exemption is
// flag AND account presence — the same presence check the codex router asks
// per request (#1138), which means an account added or removed mid-run is
// reflected on /health without a restart.
//
// Hermetic: HOME in a mkdtemp'd dir, no Claude login, no network (fetchImpl
// throws). Same harness as test/codex-runtime-account-detect.mjs.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kernel-assigned so no other process or test file can hold it (helpers/free-port.mjs).
const PROXY_PORT = await freePort();
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

// HOME set BEFORE the imports: codex-accounts.ts resolves its directory at
// module-evaluation time.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-health-codex-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.DARIO_CODEX_ACCOUNT;
delete process.env.ANTHROPIC_UPSTREAM_API_KEY;

const { saveCodexAccount, removeCodexAccount, _resetCodexPresenceCacheForTest } =
  await import('../dist/codex-accounts.js');
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
const health = async () => {
  const res = await fetch(`${BASE}/health`);
  return { status: res.status, body: await res.json() };
};

header('--no-claude-auth, NO codex account → 503 (the flag alone is not evidence)');
{
  const { status, body } = await health();
  check('503', status === 503, `${status} ${JSON.stringify(body)}`);
  check('reports degraded', body.status === 'degraded', JSON.stringify(body));
}

header('account stored mid-run → 200 on the SAME process, no restart');
{
  await saveCodexAccount({
    alias: 'fleet', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
  });
  // The /health above armed the ~30s negative presence cache; a real operator
  // waits it out, the test skips the wait rather than sleeping for it.
  _resetCodexPresenceCacheForTest();
  const { status, body } = await health();
  check('200', status === 200, `${status} ${JSON.stringify(body)}`);
  check('reports ok', body.status === 'ok', JSON.stringify(body));
}

header('account removed → 503 again immediately (presence is never cached)');
{
  await removeCodexAccount('fleet');
  const { status } = await health();
  check('503', status === 503, String(status));
}

await rm(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

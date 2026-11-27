#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODEX_PORT = await freePort();
const PROXY_PORT = await freePort();
const BASE = 'gpt-eff';
const SUFFIXED = 'gpt-eff:high';
const CATALOGS = { alpha: [BASE], bravo: [SUFFIXED] };

const state = { seen: [], refreshes: 0 };
const bearerAlias = (req) => /codex-at-([a-z]+)/i.exec(req.headers['authorization'] || '')?.[1] ?? null;

const codexStub = createServer((req, res) => {
  const alias = bearerAlias(req);
  if (req.url.startsWith('/oauth/token')) {
    state.refreshes++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token revoked' }));
    return;
  }
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: (CATALOGS[alias] ?? []).map((slug) => ({ slug, visibility: 'list' })) }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.seen.push({ alias, model: JSON.parse(raw || '{}').model ?? null });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
      res.write('data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-repick-bad-creds-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_CODEX_TOKEN_URL = `http://127.0.0.1:${CODEX_PORT}/oauth/token`;
delete process.env.DARIO_CODEX_ACCOUNT;
delete process.env.DARIO_CODEX_MAX_INFLIGHT_PER_SEAT;

const SIX_HOURS = Date.now() + 6 * 3_600_000;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-at', refreshToken: 'claude-rt',
  expiresAt: SIX_HOURS, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
const seat = (alias, expiresAt) => ({ alias, accessToken: `codex-at-${alias}`, refreshToken: `codex-rt-${alias}`, expiresAt });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'alpha.json'), JSON.stringify(seat('alpha', SIX_HOURS)));
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'bravo.json'), JSON.stringify(seat('bravo', Date.now() - 60_000)));

const { startProxy } = await import('../dist/proxy.js');
const accounts = await import('../dist/codex-accounts.js');
const backend = await import('../dist/codex-backend.js');

const anthropicFetch = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: { message: 'claude should not be reached' } }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });
};

await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, noLiveCapture: true, fetchImpl: anthropicFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch { await sleep(100); }
}

header('a better-fitting seat whose credentials cannot load gives the request back to the seat that loaded');
{
  await backend.getCodexModelSlugs(seat('bravo', SIX_HOURS));
  const text = 'a conversation that starts on alpha';
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: SUFFIXED, stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    }),
  });
  await r.text().catch(() => '');
  check('bravo was tried and its refresh failed', state.refreshes >= 1, state.refreshes);
  check('the request is served', r.status === 200, r.status);
  check('by alpha, whose credentials loaded', state.seen.at(-1)?.alias === 'alpha', state.seen.at(-1)?.alias);
  check('with the effort suffix read off for alpha', state.seen.at(-1)?.model === BASE, state.seen.at(-1)?.model);
  check('no seat is left held or in flight',
    ['alpha', 'bravo'].every((a) => accounts.codexInFlightFor(a) === 0),
    ['alpha', 'bravo'].map((a) => `${a}=${accounts.codexInFlightFor(a)}`).join(' '));
}

codexStub.close();
await rm(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

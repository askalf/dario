#!/usr/bin/env node
// A request body that is not a JSON object is answered locally with 400 in
// the endpoint's own wire shape — never forwarded.
//
// Found by codex-drift-watch.yml's wire-contract check on its first armed run
// (2026-09-06, run 34044346444): `POST /v1/chat/completions` with body `{`
// must fail with `.error.message` present, the way OpenAI answers. dario
// instead let it fall through every `.model` peek (each swallows its parse
// error) to the Claude pool, which on a --no-claude-auth proxy answered 503
// `{"error":"No account configured", ...}` — `error` a string, so an OpenAI
// SDK sees no message at all. With a Claude login the same bytes went all the
// way to Anthropic for it to reject.
//
// Hermetic: HOME in a mkdtemp'd dir, a stored codex account so the proxy has
// a serving backend, no Claude login, fetchImpl throws (nothing may go out).

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-invalid-body-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.DARIO_CODEX_ACCOUNT;
delete process.env.ANTHROPIC_UPSTREAM_API_KEY;
const accountsDir = join(tmpHome, '.dario', 'codex-accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'fleet.json'), JSON.stringify({
  alias: 'fleet', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
}));

const { startProxy } = await import('../dist/proxy.js');
let upstreamCalls = 0;
await startProxy({
  port: PROXY_PORT,
  host: '127.0.0.1',
  passthrough: true,
  verbose: false,
  noLiveCapture: true,
  noClaudeAuth: true,
  fetchImpl: async (url) => { upstreamCalls++; throw new Error(`unexpected upstream fetch: ${url}`); },
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dario' },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — the checks below report it */ }
  return { status: res.status, json, text };
};

header('/v1/chat/completions — OpenAI error shape');
// The malformed-UTF-8 case (review on #1231): a lenient decode turns 0xff into
// U+FFFD and yields a parseable object while the original bytes go upstream.
const badUtf8 = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
for (const [label, body] of [['truncated {', '{'], ['empty body', ''], ['JSON array', '[]'], ['JSON string', '"hi"'], ['malformed UTF-8 byte', badUtf8]]) {
  const r = await post('/v1/chat/completions', body);
  check(`${label} -> 400`, r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);
  check(`${label} -> .error.message is a string`, typeof r.json?.error?.message === 'string', r.text.slice(0, 200));
  check(`${label} -> .error.type invalid_request_error`, r.json?.error?.type === 'invalid_request_error', r.text.slice(0, 200));
}

header('/v1/messages — Anthropic error shape');
{
  const r = await post('/v1/messages', '{');
  check('truncated { -> 400', r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);
  check('type: error envelope', r.json?.type === 'error', r.text.slice(0, 200));
  check('.error.type invalid_request_error + message',
    r.json?.error?.type === 'invalid_request_error' && typeof r.json?.error?.message === 'string',
    r.text.slice(0, 200));
}

header('nothing went upstream');
check('fetchImpl never called', upstreamCalls === 0, `calls=${upstreamCalls}`);

await rm(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

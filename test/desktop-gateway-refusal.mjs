#!/usr/bin/env node
// dario#1363 — Claude Desktop's third-party inference mode is refused on a
// Claude plan login with 403 and `x-dario-upstream-rejection:
// desktop_gateway_on_plan`, in the endpoint's own wire shape, before a seat is
// picked. Before this the request passed as Claude Code's own (its identity
// block names the Claude Agent SDK), so the app's body and identity headers
// went upstream on the subscription token.
//
// The refusal is narrow, and each edge is asserted here: either signal alone
// (billing line, user-agent) is enough; `--passthrough` is not an exemption;
// count_tokens is refused too; upstream API-key mode forwards the request on
// the key; and Claude Code, the Agent SDK and a plain API client on the same
// plan-login proxy are served as before.
//
// Hermetic: real proxies on loopback, HOME in a mkdtemp'd dir with one pool
// seat, fetchImpl for Anthropic. The detector's own cases are in
// test/desktop-gateway-detect.mjs.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
const PLAN_PORT = await freePort();
const PASSTHROUGH_PORT = await freePort();
const KEY_PORT = await freePort();

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-desktop-gateway-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.ANTHROPIC_UPSTREAM_API_KEY;
delete process.env.DARIO_CREDITS_API_KEY;

await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));

const { startProxy } = await import('../dist/proxy.js');

// ── fake Anthropic: a catalog, and a 200 for every messages call it is sent ──
const CATALOG = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const anthropic = { calls: 0, last: null };
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: CATALOG.map((id) => ({ id, type: 'model' })) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (!target.includes('/v1/messages')) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  anthropic.calls++;
  const h = {};
  const raw = init?.headers;
  if (Array.isArray(raw)) for (const [k, v] of raw) h[String(k).toLowerCase()] = String(v);
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) h[String(k).toLowerCase()] = String(v);
  anthropic.last = { url: target, headers: h };
  if (target.includes('/count_tokens')) {
    return new Response(JSON.stringify({ input_tokens: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const common = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl: fakeFetch };
await startProxy({ ...common, port: PLAN_PORT });
await startProxy({ ...common, port: PASSTHROUGH_PORT, passthrough: true });
await startProxy({ ...common, port: KEY_PORT, upstreamApiKey: 'sk-ant-test-key' });
for (const port of [PLAN_PORT, PASSTHROUGH_PORT, KEY_PORT]) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
}

const SDK_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const DESKTOP_UA = 'claude-cli/2.1.284 (external, claude-desktop-3p, agent-sdk/0.3.284)';
const ccBody = (entrypoint, identity) => ({
  model: 'claude-sonnet-5', max_tokens: 16,
  system: [
    { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.281.721; cc_entrypoint=${entrypoint};` },
    { type: 'text', text: identity },
  ],
  messages: [{ role: 'user', content: 'ping' }],
});
const desktopBody = ccBody('claude-desktop-3p', SDK_IDENTITY);

const post = async (port, path, body, userAgent) => {
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (userAgent) headers['User-Agent'] = userAgent;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* the checks report it */ }
  return { status: res.status, marker: res.headers.get('x-dario-upstream-rejection'), json, text };
};
const refused = (r) => r.status === 403 && r.marker === 'desktop_gateway_on_plan';
const show = (r) => `${r.status} ${r.marker} ${r.text.slice(0, 160)}`;

header('refused on a plan login, in the Anthropic wire shape');
{
  const before = anthropic.calls;
  const r = await post(PLAN_PORT, '/v1/messages', desktopBody, DESKTOP_UA);
  check('/v1/messages → 403', r.status === 403, show(r));
  check('marker header names the verdict', r.marker === 'desktop_gateway_on_plan', String(r.marker));
  check('{type:"error", error:{type:"permission_error", message}}',
    r.json?.type === 'error' && r.json?.error?.type === 'permission_error' && typeof r.json?.error?.message === 'string', r.text.slice(0, 200));
  check('message names the mode and the page that explains it',
    (r.json?.error?.message ?? '').includes("Claude Desktop's third-party inference mode") && (r.json?.error?.message ?? '').includes('docs/account-risk.md'), r.json?.error?.message);
  check('nothing went upstream', anthropic.calls === before, `calls ${before} → ${anthropic.calls}`);
}

header('either signal alone is enough');
{
  const before = anthropic.calls;
  const b = await post(PLAN_PORT, '/v1/messages', desktopBody, 'node');
  check('billing line alone (a hop replaced the user-agent)', refused(b), show(b));
  const u = await post(PLAN_PORT, '/v1/messages', { model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }, DESKTOP_UA);
  check('user-agent alone (the body carries no billing line)', refused(u), show(u));
  check('nothing went upstream', anthropic.calls === before, `calls ${before} → ${anthropic.calls}`);
}

header('refused on the other paths a plan login serves');
{
  const before = anthropic.calls;
  const c = await post(PLAN_PORT, '/v1/messages/count_tokens', { model: desktopBody.model, system: desktopBody.system, messages: desktopBody.messages }, DESKTOP_UA);
  check('count_tokens → 403 with the marker', refused(c), show(c));
  const o = await post(PLAN_PORT, '/v1/chat/completions', { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'ping' }] }, DESKTOP_UA);
  check('/v1/chat/completions → 403 with the marker', refused(o), show(o));
  check('OpenAI wire shape: {error:{message, type, code}}',
    typeof o.json?.error?.message === 'string' && o.json?.error?.type === 'permission_error' && o.json?.error?.code === 'desktop_gateway_on_plan', o.text.slice(0, 200));
  const p = await post(PASSTHROUGH_PORT, '/v1/messages', desktopBody, DESKTOP_UA);
  check('--passthrough is not an exemption', refused(p), show(p));
  check('nothing went upstream', anthropic.calls === before, `calls ${before} → ${anthropic.calls}`);
}

header('served: upstream API-key mode forwards it on the key');
{
  const before = anthropic.calls;
  const r = await post(KEY_PORT, '/v1/messages', desktopBody, DESKTOP_UA);
  check('→ 200, no marker', r.status === 200 && r.marker === null, show(r));
  check('the request went upstream', anthropic.calls === before + 1, `calls ${before} → ${anthropic.calls}`);
  check('on the API key, with no bearer token',
    anthropic.last?.headers['x-api-key'] === 'sk-ant-test-key' && anthropic.last?.headers.authorization === undefined,
    JSON.stringify({ key: anthropic.last?.headers['x-api-key'], auth: anthropic.last?.headers.authorization }));
}

header('served: every other client on the same plan-login proxy');
{
  const cases = [
    ['Claude Code, cli entrypoint', ccBody('cli', CLI_IDENTITY), 'claude-cli/2.1.280 (external, cli)'],
    ['the Agent SDK, sdk-cli entrypoint', ccBody('sdk-cli', SDK_IDENTITY), 'claude-cli/2.1.280 (external, sdk-cli)'],
    ["Desktop's own Code tab, claude-desktop entrypoint", ccBody('claude-desktop', CLI_IDENTITY), 'claude-cli/2.1.284 (external, claude-desktop)'],
    ['a plain API client', { model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }, 'anthropic-sdk-python/0.60.0'],
  ];
  for (const [name, body, ua] of cases) {
    const before = anthropic.calls;
    const r = await post(PLAN_PORT, '/v1/messages', body, ua);
    check(`${name} → 200`, r.status === 200 && r.marker === null, show(r));
    check(`${name} reached the pool on the plan token`,
      anthropic.calls === before + 1 && anthropic.last?.headers.authorization === 'Bearer claude-access-token',
      `calls ${before} → ${anthropic.calls} auth=${anthropic.last?.headers.authorization}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

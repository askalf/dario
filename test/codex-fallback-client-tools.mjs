#!/usr/bin/env node
// A /v1/messages client's own tools on the Claude-to-Codex fallback leg
// (askalf/dario#1429). The Redline reviewer declares list_files, read_file, grep
// and submit_review and forces submit_review; when the Claude pool cannot serve,
// the codex backend must receive all four as function tools with the forced
// choice intact, and the client must get the model's call back under its own
// tool name.
//
// Both fallback entries are covered: the mid-flight 429 (Claude answered 429,
// no peer) and the pre-selection path (the pool is parked, nothing is sent to
// Claude).
//
// Hermetic: mkdtemp HOME, one Claude account behind an injected fetch that
// always 429s, one codex seat against a local stub backend. No network, no real
// credentials.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
const LISTED_SLUG = 'gpt-5.6-sol';

// Every /responses body the stub received, parsed.
const bodies = [];
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: LISTED_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }
      const args = '{"verdict":"APPROVE"}';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse([
        { type: 'response.created', response: { id: 'resp_1', model: LISTED_SLUG } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'submit_review', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: args },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: args },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'submit_review', arguments: args, status: 'completed' } },
        { type: 'response.completed', response: { id: 'resp_1', model: LISTED_SLUG, status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } },
      ]));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// HOME before importing proxy.js: the accounts modules resolve dirs at load.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-fallback-tools-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
delete process.env.DARIO_CODEX_ACCOUNT;

const SIX_HOURS = Date.now() + 6 * 3_600_000;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-at', refreshToken: 'claude-rt',
  expiresAt: SIX_HOURS, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'fleet.json'), JSON.stringify({
  alias: 'fleet', accessToken: 'codex-at-fleet', refreshToken: 'codex-rt-fleet', expiresAt: SIX_HOURS,
}));

const { startProxy } = await import('../dist/proxy.js');

const claudeCalls = { total: 0 };
const anthropicFetch = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  claudeCalls.total++;
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 300),
    },
  });
};

const server = await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, noLiveCapture: true,
  poolFallbackModel: LISTED_SLUG,
  fetchImpl: anthropicFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch { await sleep(100); }
}

const TOOL_NAMES = ['list_files', 'read_file', 'grep', 'submit_review'];
const TOOLS = TOOL_NAMES.map((name) => ({
  name,
  description: `${name} over the PR checkout`,
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
}));

const ask = async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 64,
      system: 'You review pull requests.',
      tools: TOOLS,
      tool_choice: { type: 'tool', name: 'submit_review' },
      messages: [{ role: 'user', content: `review probe ${Math.random()}` }],
    }),
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below */ }
  return { status: r.status, fallback: r.headers.get('x-dario-pool-fallback'), json, text };
};

const assertLeg = (label, reply, sent) => {
  check(`${label}: the client got a 200`, reply.status === 200, `${reply.status} ${reply.text.slice(0, 200)}`);
  check(`${label}: the fallback is announced`, reply.fallback === LISTED_SLUG, String(reply.fallback));
  check(`${label}: the codex backend was asked`, sent !== undefined && sent !== null);
  const fnTools = (sent?.tools ?? []).filter((t) => t.type === 'function').map((t) => t.name);
  check(`${label}: all four client tools reach codex under their own names`,
    fnTools.join(',') === TOOL_NAMES.join(','), fnTools.join(','));
  check(`${label}: each tool keeps its schema`,
    (sent?.tools ?? []).every((t) => t.parameters?.properties?.path?.type === 'string'));
  check(`${label}: the forced submit_review reaches codex`,
    sent?.tool_choice?.type === 'function' && sent?.tool_choice?.name === 'submit_review', JSON.stringify(sent?.tool_choice));
  const uses = (reply.json?.content ?? []).filter((b) => b.type === 'tool_use');
  check(`${label}: the model's call comes back as a tool_use for submit_review`,
    uses.length === 1 && uses[0].name === 'submit_review' && uses[0].input?.verdict === 'APPROVE', JSON.stringify(reply.json?.content));
  check(`${label}: stop_reason is tool_use`, reply.json?.stop_reason === 'tool_use', String(reply.json?.stop_reason));
};

header('mid-flight: Claude answers 429, no peer, the request fails over to codex');
{
  bodies.length = 0;
  const reply = await ask();
  check('claude was tried first', claudeCalls.total === 1, String(claudeCalls.total));
  assertLeg('mid-flight', reply, bodies.at(-1));
}

header('pre-selection: the pool is parked, the request goes straight to codex');
{
  bodies.length = 0;
  const before = claudeCalls.total;
  const reply = await ask();
  check('claude was not asked again', claudeCalls.total === before, `${before} -> ${claudeCalls.total}`);
  assertLeg('parked', reply, bodies.at(-1));
}

server?.close?.();
codexStub.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

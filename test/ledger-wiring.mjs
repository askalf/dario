#!/usr/bin/env node
// The ledger through a real startProxy: Claude pool traffic (stubbed
// upstream, subscription and api claims), codex traffic (stubbed backend),
// /analytics.lifetime, /analytics/ledger, the file on disk, the number
// surviving a restart, `dario usage` reading it with and without a proxy,
// --card, and --no-ledger / DARIO_LEDGER=0.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');

const PROXY_PORT = await freePort();
const CODEX_PORT = await freePort();
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const CODEX_SLUG = 'gpt-5.6-terra';
const CLAUDE_MODEL = 'claude-opus-5';
const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

// ---- codex stub: one buffered response with 1M output tokens ---------------
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ slug: CODEX_SLUG, visibility: 'list' }] })); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, obj, seq) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...obj })}\n\n`);
    const msg = { id: 'msg_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] };
    const full = { id: 'resp_x', object: 'response', created_at: 1, status: 'completed', model: CODEX_SLUG, output: [msg], usage: { input_tokens: 0, output_tokens: 1_000_000, total_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    ev('response.created', { response: { ...full, status: 'in_progress', output: [] } }, 0);
    ev('response.output_item.added', { output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }, 1);
    ev('response.content_part.added', { item_id: 'msg_x', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, 2);
    ev('response.output_text.delta', { item_id: 'msg_x', output_index: 0, content_index: 0, delta: 'hi' }, 3);
    ev('response.output_text.done', { item_id: 'msg_x', output_index: 0, content_index: 0, text: 'hi' }, 4);
    ev('response.content_part.done', { item_id: 'msg_x', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'hi', annotations: [] } }, 5);
    ev('response.output_item.done', { output_index: 0, item: msg }, 6);
    ev('response.completed', { response: full }, 7);
    res.end();
  });
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// ---- Claude stub: the claim header decides the bucket ----------------------
// 1M input tokens per request so the numbers are round: opus-5 → $5 each.
let claudeClaim = 'five_hour';
let claudeStatus = 200;
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: CLAUDE_MODEL, type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const body = JSON.parse(typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf-8'));
  const headers = { 'content-type': body.stream ? 'text/event-stream' : 'application/json', 'anthropic-ratelimit-unified-representative-claim': claudeClaim, 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-7d-utilization': '0.2' };
  if (claudeStatus !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: claudeStatus, headers: { ...headers, 'content-type': 'application/json' } });
  if (!body.stream) {
    return new Response(JSON.stringify({ id: 'msg_buf', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [{ type: 'text', text: 'buffered' }], stop_reason: 'end_turn', usage: { input_tokens: 1_000_000, output_tokens: 0 } }), { status: 200, headers });
  }
  const text = [
    sse('message_start', { message: { id: 'msg_01A', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [], stop_reason: null, usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'streamed' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }),
    sse('message_stop', {}),
  ].join('');
  return new Response(text, { status: 200, headers });
};

// ---- home + proxy --------------------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-ledger-wiring-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const LEDGER = join(tmpHome, '.dario', `ledger-${PROXY_PORT}.json`);
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({ alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token', expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1' }));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({ alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000 }));
const { startProxy } = await import('../dist/proxy.js');
const { LEDGER_FLUSH_DELAY_MS } = await import('../dist/ledger.js');
// The overage guard (#288) halts the proxy on an `api` claim by design; this
// test needs one api-claimed request to land in the metered column.
const proxyOpts = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl: fakeFetch, overageGuardEnabled: false };
await startProxy({ ...proxyOpts, port: PROXY_PORT });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const post = (model, stream) => fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 64, stream, messages: [{ role: 'user', content: 'hello' }] }) });
const analytics = async () => (await fetch(`${BASE}/analytics`)).json();
const runCli = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: tmpHome });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

header('before any traffic');
{
  const a = await analytics();
  check('/analytics.lifetime is present and empty', a.lifetime && a.lifetime.requests === 0 && a.lifetime.apiEquivalentCost === 0 && a.lifetime.path === LEDGER, JSON.stringify(a.lifetime));
  let exists = true; try { await stat(LEDGER); } catch { exists = false; }
  check('no file yet — nothing to write', !exists);
}

header('traffic: two covered Claude requests, one api-keyed, one 5xx, one codex');
{
  const r1 = await post(CLAUDE_MODEL, true); await r1.text();
  const r2 = await post(CLAUDE_MODEL, false); await r2.text();
  claudeClaim = 'api';
  const r3 = await post(CLAUDE_MODEL, false); await r3.text();
  claudeClaim = 'five_hour'; claudeStatus = 529;
  const r4 = await post(CLAUDE_MODEL, false); await r4.text();
  claudeStatus = 200;
  const r5 = await post(CODEX_SLUG, false); const j5 = await r5.json();
  if (r5.status !== 200) console.log('codex leg:', JSON.stringify(j5).slice(0, 400));
  check('the requests went through as expected', r1.status === 200 && r2.status === 200 && r3.status === 200 && r4.status >= 500 && r5.status === 200 && j5.usage.output_tokens === 1_000_000, [r1.status, r2.status, r3.status, r4.status, r5.status].join(','));
  const a = await analytics();
  const l = a.lifetime;
  check('lifetime: 4 counted (the 5xx is not), $22 API-equivalent = 2 × $5 opus + $12 terra, $5 metered', l.requests === 4 && l.apiEquivalentCost === 22 && l.meteredCost === 5, JSON.stringify(l));
  check('perProvider splits Claude $10 / ChatGPT $12', l.perProvider.anthropic.apiEquivalentCost === 10 && l.perProvider.anthropic.requests === 2 && l.perProvider.openai.apiEquivalentCost === 12 && l.perProvider.openai.requests === 1, JSON.stringify(l.perProvider));
  check('perModel: opus-5 carries the metered $5 too; terra is openai', l.perModel[CLAUDE_MODEL].meteredCost === 5 && l.perModel[CLAUDE_MODEL].apiEquivalentCost === 10 && l.perModel[CODEX_SLUG].provider === 'openai', JSON.stringify(l.perModel));
  check('recent.today carries all of it', l.recent.today === 22 && l.recent.last7d === 22 && l.recent.last30d === 22, JSON.stringify(l.recent));
  check('the rolling window still prices the same records (window estimatedCost = 27 incl. the api-keyed one)', a.window.estimatedCost === 27, a.window.estimatedCost);
}

header('/analytics/ledger and the file on disk');
{
  await sleep(LEDGER_FLUSH_DELAY_MS + 500);
  const raw = JSON.parse(await readFile(LEDGER, 'utf8'));
  const day = new Date().toISOString().slice(0, 10);
  check('the file holds per-day, per-model, per-bucket token totals — no prices', raw.version === 1 && raw.days[day][CLAUDE_MODEL].covered.requests === 2 && raw.days[day][CLAUDE_MODEL].covered.inputTokens === 2_000_000 && raw.days[day][CLAUDE_MODEL].metered.requests === 1 && raw.days[day][CODEX_SLUG].covered.outputTokens === 1_000_000 && !JSON.stringify(raw).includes('cost'), JSON.stringify(raw));
  const res = await fetch(`${BASE}/analytics/ledger`);
  const j = await res.json();
  check('GET /analytics/ledger returns the same table with its path', res.status === 200 && j.path === LEDGER && JSON.stringify(j.days) === JSON.stringify(raw.days), JSON.stringify(j).slice(0, 200));
}

header('dario usage: the headline above the window, --card, --json');
{
  const { code, out } = await runCli(['usage', `--port=${PROXY_PORT}`]);
  check('prints the API-equivalent block first', code === 0 && out.includes('API-equivalent spend (since') && out.includes('$22.00 would have been billed on the metered API') && out.includes('Claude') && out.includes('$10.00') && out.includes('ChatGPT') && out.includes('$12.00') && out.includes('Paid per token on top (API key / extra usage): $5.00'), out);
  check('the block precedes the rolling window', out.indexOf('API-equivalent spend') < out.indexOf('Window:'), out);
  const card = await runCli(['usage', `--port=${PROXY_PORT}`, '--card=card.svg']);
  const svg = await readFile(join(tmpHome, 'card.svg'), 'utf8');
  check('--card writes the SVG with the number', card.code === 0 && card.out.includes('Wrote card.svg — $22.00 API-equivalent') && svg.includes('>$22.00<') && svg.includes('Claude $10.00') && svg.includes('ChatGPT $12.00'), card.out + svg.slice(0, 200));
  const json = await runCli(['usage', `--port=${PROXY_PORT}`, '--json']);
  check('--json carries lifetime', json.code === 0 && JSON.parse(json.out).lifetime.apiEquivalentCost === 22, json.out.slice(0, 200));
}

header('restart: the number survives; a proxy that is down still answers from the file');
{
  const deadPort = await freePort();
  const { code, out } = await runCli(['usage', `--port=${deadPort}`]);
  check('no proxy on that port, no ledger for it: says so, exits 1', code === 1 && out.includes(`no ledger at ${join(tmpHome, '.dario', `ledger-${deadPort}.json`)} yet`) && out.includes('Proxy not reachable'), out);
  const viaFile = await runCli(['usage', `--port=${deadPort}`], { DARIO_LEDGER_PATH: LEDGER });
  check('with the file named, the lifetime block prints from disk even though the proxy is unreachable', viaFile.code === 1 && viaFile.out.includes('$22.00 would have been billed') && viaFile.out.includes('Proxy not reachable'), viaFile.out);
  const cardDown = await runCli(['usage', `--port=${deadPort}`, '--card=down.svg'], { DARIO_LEDGER_PATH: LEDGER });
  check('--card works from the file too', (await readFile(join(tmpHome, 'down.svg'), 'utf8')).includes('>$22.00<'), cardDown.out);
  // A second proxy on a fresh port, pointed at the same file, opens with the totals.
  const port2 = await freePort();
  process.env.DARIO_LEDGER_PATH = LEDGER;
  await startProxy({ ...proxyOpts, port: port2 });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port2}/health`); break; } catch { await sleep(100); } }
  const a2 = await (await fetch(`http://127.0.0.1:${port2}/analytics`)).json();
  check('a fresh proxy reading the file starts from $22, not $0 — the window is empty, the ledger is not', a2.lifetime.apiEquivalentCost === 22 && a2.lifetime.requests === 4 && a2.window.requests === 0, JSON.stringify({ lifetime: a2.lifetime.apiEquivalentCost, window: a2.window.requests }));
  delete process.env.DARIO_LEDGER_PATH;
}

header('off: --no-ledger / DARIO_LEDGER=0');
{
  const port3 = await freePort();
  await startProxy({ ...proxyOpts, port: port3, ledger: false });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port3}/health`); break; } catch { await sleep(100); } }
  const r = await fetch(`http://127.0.0.1:${port3}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) }); await r.text();
  const a3 = await (await fetch(`http://127.0.0.1:${port3}/analytics`)).json();
  const lg = await fetch(`http://127.0.0.1:${port3}/analytics/ledger`);
  check('lifetime is null, /analytics/ledger is 404, the window still counts', a3.lifetime === null && lg.status === 404 && a3.window.requests === 1, JSON.stringify({ lifetime: a3.lifetime, status: lg.status }));
  await sleep(LEDGER_FLUSH_DELAY_MS + 300);
  let exists = true; try { await stat(join(tmpHome, '.dario', `ledger-${port3}.json`)); } catch { exists = false; }
  check('no file written', !exists);
  const { out } = await runCli(['usage', `--port=${port3}`]);
  check('dario usage says the ledger is disabled', out.includes('ledger disabled on this proxy (--no-ledger)'), out);
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

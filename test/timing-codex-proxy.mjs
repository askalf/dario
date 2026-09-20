#!/usr/bin/env node
/**
 * The timing split on the ChatGPT (codex) leg, through a real proxy with a
 * stub backend (dario#1341 follow-up; review of #1372).
 *
 * A Claude-path response carries `x-dario-queue-ms`, `x-dario-pacing-ms`,
 * `x-dario-upstream-ttfb-ms` and `x-dario-prep-ms`. A request served by a
 * codex seat is written by the codex backend itself, so the same four have to
 * be threaded through that write path — for the translated Messages shape,
 * streamed and buffered, and for the Responses passthrough. The governor
 * never runs for codex, so `x-dario-pacing-ms` is 0 there by construction.
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROXY_PORT = await freePort();
const CODEX_PORT = await freePort();
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const SLUG = 'gpt-5.6-terra';
const BACKEND_DELAY_MS = 120;

const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ slug: SLUG, visibility: 'list' }] })); return; }
  if (!req.url.startsWith('/responses')) { res.writeHead(404).end(); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', async () => {
    await sleep(BACKEND_DELAY_MS); // the seat's time to first byte
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let seq = 0;
    const ev = (type, obj) => res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...obj })}\n\n`);
    ev('response.created', { response: { id: 'resp_t', status: 'in_progress', model: SLUG, output: [] } });
    ev('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    ev('response.content_part.added', { output_index: 0, item_id: 'msg_1', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const t of ['PO', 'NG']) { ev('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: t }); await sleep(5); }
    ev('response.output_text.done', { output_index: 0, item_id: 'msg_1', content_index: 0, text: 'PONG' });
    ev('response.output_item.done', { output_index: 0, item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'PONG', annotations: [] }] } });
    ev('response.completed', { response: { id: 'resp_t', status: 'completed', model: SLUG, output: [], usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22, input_tokens_details: { cached_tokens: 0 } } } });
    res.end();
  });
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-timing-codex-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_API_KEY; delete process.env.DARIO_ANALYTICS_TOKEN;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({ alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 3_600_000, accountId: 'acct_live' }));

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const { startProxy } = await import('../dist/proxy.js');
await startProxy({ port: PROXY_PORT, host: '127.0.0.1', verbose: false, noLiveCapture: true, noClaudeAuth: true });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const HDR = ['x-dario-queue-ms', 'x-dario-pacing-ms', 'x-dario-upstream-ttfb-ms', 'x-dario-prep-ms'];
const ms = (r, h) => Number(r.headers.get(h));
const assertSplit = (label, r) => {
  for (const h of HDR) check(`${label}: ${h} is a non-negative integer`, /^\d+$/.test(r.headers.get(h) ?? ''), r.headers.get(h));
  check(`${label}: ttfb reflects the backend delay`, ms(r, 'x-dario-upstream-ttfb-ms') >= BACKEND_DELAY_MS - 20, ms(r, 'x-dario-upstream-ttfb-ms'));
  check(`${label}: the governor never runs for codex, pacing is 0`, ms(r, 'x-dario-pacing-ms') === 0, ms(r, 'x-dario-pacing-ms'));
  check(`${label}: prep is dario's own work, under the backend's time`, ms(r, 'x-dario-prep-ms') < BACKEND_DELAY_MS, ms(r, 'x-dario-prep-ms'));
};
const messages = (stream) => ({ model: SLUG, max_tokens: 50, stream, messages: [{ role: 'user', content: 'ping' }] });

out('=== Messages shape, buffered, served by the codex seat ===');
{
  const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messages(false)) });
  const j = await r.json();
  check('200 JSON from the codex leg', r.status === 200 && j.type === 'message' && j.content?.[0]?.text === 'PONG', `${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  assertSplit('buffered', r);
}

out('=== Messages shape, streamed ===');
{
  const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messages(true)) });
  check('200 SSE from the codex leg', r.status === 200 && (r.headers.get('content-type') || '').startsWith('text/event-stream'), `${r.status} ${r.headers.get('content-type')}`);
  assertSplit('streamed', r);
  const body = await r.text();
  check('…and the stream still ends', body.includes('message_stop'), body.slice(-80));
}

out('=== Responses passthrough (Codex CLI shape) ===');
{
  const r = await fetch(`${BASE}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: SLUG, input: 'ping', stream: true }) });
  check('200 SSE passthrough', r.status === 200 && (r.headers.get('content-type') || '').startsWith('text/event-stream'), `${r.status} ${r.headers.get('content-type')}`);
  assertSplit('responses', r);
  await r.text();
}
await sleep(100);

out('=== /analytics: codex rows carry the split too ===');
{
  const r = await fetch(`${BASE}/analytics`);
  const a = await r.json();
  const t = a.window?.timing;
  check('three codex rows with a split', t?.samples === 3, JSON.stringify(t));
  check('their avg ttfb reflects the backend delay', t.avgUpstreamTtfbMs >= BACKEND_DELAY_MS - 20, t.avgUpstreamTtfbMs);
  check('their avg pacing is 0', t.avgPacingMs === 0, t.avgPacingMs);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-25).join('\n'));
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Codex reasoning in the thinking count. The ChatGPT-subscription backend
// reports `output_tokens_details.reasoning_tokens` inside `output_tokens`, the
// way Anthropic reports thinking; dario recorded 0 for every Codex row, so the
// ledger's thinking share was blind on GPT lanes. Pure checks on the reader,
// then a real startProxy with a loopback Codex stub on both GPT routes (the
// translated Messages route and the Responses passthrough). Hermetic: HOME in
// a mkdtemp dir, no credentials, no network. The proxy reads the Codex base
// URL and the accounts folder once per process, so the environment is set
// here, before anything from dist/ loads.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);

const CODEX_PORT = await freePort();
const home = await mkdtemp(join(tmpdir(), 'dario-ledger-thinking-codex-'));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
await mkdir(join(home, '.dario', 'accounts'), { recursive: true });
await writeFile(join(home, '.dario', 'accounts', 'main.json'), JSON.stringify({ alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token', expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1' }));
await mkdir(join(home, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(home, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({ alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000 }));

const { reasoningTokensFromResponses, splitResponsesUsage } = await import('../dist/codex-backend.js');
const { startProxy } = await import('../dist/proxy.js');
const { LEDGER_FLUSH_DELAY_MS, formatLedgerSummary, parseLedger, summarizeLedger, summarizeLedgerConsumers, thinkingPercent } = await import('../dist/ledger.js');

header('Codex usage: reasoning_tokens is the GPT side of the thinking count');
{
  check('read from output_tokens_details', reasoningTokensFromResponses({ output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } }, 100) === 60);
  check('absent block, absent field, null: 0', reasoningTokensFromResponses({ output_tokens: 5 }, 5) === 0
    && reasoningTokensFromResponses({ output_tokens_details: {} }, 5) === 0 && reasoningTokensFromResponses(null, 5) === 0);
  check('malformed counts: 0', reasoningTokensFromResponses({ output_tokens_details: { reasoning_tokens: 'lots' } }, 5) === 0
    && reasoningTokensFromResponses({ output_tokens_details: { reasoning_tokens: -3 } }, 5) === 0
    && reasoningTokensFromResponses({ output_tokens_details: { reasoning_tokens: Infinity } }, 5) === 0);
  check('rounded, and capped at the output it is part of', reasoningTokensFromResponses({ output_tokens_details: { reasoning_tokens: 12.6 } }, 50) === 13
    && reasoningTokensFromResponses({ output_tokens_details: { reasoning_tokens: 900 } }, 400) === 400);
  const split = splitResponsesUsage({ input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 50 } });
  check('splitResponsesUsage carries it beside the netted input', split.reasoning === 50 && split.output === 80 && split.input === 20 && split.cacheRead === 100, JSON.stringify(split));
}

header('Codex through a real proxy: both GPT routes record their reasoning');
{
  // The ChatGPT-subscription backend is a loopback stub whose terminal
  // usage is set per request; the Claude seat exists only so the proxy
  // starts. Same hermetic shape as the streaming section above.
  const SLUG = 'gpt-5.6-sol';
  let usage = { input_tokens: 10, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 300 } };
  const codexStub = createServer((req, res) => {
    if (req.url.startsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ slug: SLUG, visibility: 'list' }] })); return; }
    if (!req.url.startsWith('/responses')) { res.writeHead(404).end(); return; }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type, obj, seq) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...obj })}\n\n`);
      const msg = { id: 'msg_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] };
      const full = { id: 'resp_x', object: 'response', created_at: 1, status: 'completed', model: SLUG, output: [msg], usage: { total_tokens: 0, ...usage } };
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
  const fakeFetch = async (url) => {
    if (String(url).includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'the Claude seat is not part of this test' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await startProxy({ host: '127.0.0.1', port, verbose: false, noLiveCapture: true, fetchImpl: fakeFetch, overageGuardEnabled: false });
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const headers = { 'content-type': 'application/json', 'x-dario-consumer': 'bob' };
  const viaMessages = async () => {
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ model: SLUG, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    return { status: r.status, text: await r.text() };
  };
  const viaResponses = async () => {
    const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: SLUG, stream: true, store: false, instructions: 'Be brief.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }) });
    return { status: r.status, text: await r.text() };
  };
  const win = async () => (await (await fetch(`${base}/analytics`)).json()).window;
  const counts = (w) => JSON.stringify({ thinking: w.totalThinkingTokens, output: w.totalOutputTokens });

  let r = await viaMessages();
  let w = await win();
  check('translated route: 300 of 1000 recorded as thinking', r.status === 200 && w.totalThinkingTokens === 300 && w.totalOutputTokens === 1000, `${r.status} ${counts(w)} ${r.text.slice(0, 160)}`);
  r = await viaResponses();
  w = await win();
  check('Responses passthrough: another 300 of 1000', r.status === 200 && w.totalThinkingTokens === 600 && w.totalOutputTokens === 2000, `${r.status} ${counts(w)}`);
  usage = { input_tokens: 10, output_tokens: 1000 };
  r = await viaMessages();
  w = await win();
  check('no details: nothing added', r.status === 200 && w.totalThinkingTokens === 600 && w.totalOutputTokens === 3000, counts(w));
  usage = { input_tokens: 10, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 5000 } };
  r = await viaResponses();
  w = await win();
  check('a count above the output is capped at it', r.status === 200 && w.totalThinkingTokens === 1600 && w.totalOutputTokens === 4000, counts(w));

  await new Promise((res) => setTimeout(res, LEDGER_FLUSH_DELAY_MS + 500));
  const ledgerPath = join(home, '.dario', `ledger-${port}.json`);
  const raw = await readFile(ledgerPath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const cell = JSON.parse(raw).days[today]?.[SLUG]?.covered;
  check('the ledger cell holds 1600 of 4000 for the GPT model', cell && cell.thinkingTokens === 1600 && cell.outputTokens === 4000 && cell.requests === 4, JSON.stringify(cell));
  const file = parseLedger(raw);
  const bob = summarizeLedgerConsumers(file).bob;
  check('the consumer carries it, priced', bob !== undefined && bob.thinkingTokens === 1600 && bob.thinkingCost > 0 && bob.thinkingCost < bob.apiEquivalentCost, JSON.stringify(bob));
  const line = formatLedgerSummary(summarizeLedger(file, ledgerPath)).find((l) => l.includes('Thinking:'));
  check('dario usage prints the GPT share', line !== undefined && line.includes(`(${thinkingPercent(1600, 4000)}%)`), line);
  codexStub.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Live-request proof of hosted web search on the codex leg (v6.4): an
// Anthropic-shape client declares Anthropic's `web_search_20260209` server
// tool, the request is served by a ChatGPT-subscription model, and the
// client gets Anthropic's own blocks back — server_tool_use with the query,
// web_search_tool_result with the searched pages, a text block with
// web_search_result_location citations — streamed and buffered.
//
// Hermetic: temp HOME with one fake codex account, the ChatGPT backend is a
// local stub speaking the shapes probed on the real backend on 2026-09-12.
// What is real: the handler, the codex route, both translators, the folded
// non-streaming body, and every byte the client receives.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROXY_PORT = await freePort();
const CODEX_PORT = await freePort();
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const SLUG = 'gpt-5.6-terra';

const codexSeen = { bodies: [] };
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ slug: SLUG, visibility: 'list' }] })); return; }
  if (!req.url.startsWith('/responses')) { res.writeHead(404).end(); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', async () => {
    const body = JSON.parse(Buffer.concat(parts).toString());
    codexSeen.bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let seq = 0;
    const ev = (type, obj) => res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...obj })}\n\n`);
    ev('response.created', { response: { id: 'resp_ws', status: 'in_progress', model: SLUG, output: [] } });
    ev('response.output_item.added', { output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } });
    ev('response.web_search_call.in_progress', { output_index: 0, item_id: 'ws_1' });
    ev('response.web_search_call.searching', { output_index: 0, item_id: 'ws_1' });
    await sleep(5);
    ev('response.web_search_call.completed', { output_index: 0, item_id: 'ws_1' });
    ev('response.output_item.done', { output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'openai newsroom', queries: ['openai newsroom'], sources: [{ type: 'url', url: 'https://openai.com/news/' }, { type: 'url', url: 'https://openai.com/news/research/' }] } } });
    ev('response.output_item.added', { output_index: 1, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    ev('response.content_part.added', { output_index: 1, item_id: 'msg_1', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const t of ['The latest ', 'post is about ', 'storage.']) { ev('response.output_text.delta', { output_index: 1, item_id: 'msg_1', content_index: 0, delta: t }); await sleep(2); }
    ev('response.output_text.annotation.added', { output_index: 1, item_id: 'msg_1', content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: 'https://openai.com/news/', title: 'OpenAI News', start_index: 11, end_index: 33 } });
    ev('response.output_text.done', { output_index: 1, item_id: 'msg_1', content_index: 0, text: 'The latest post is about storage.' });
    ev('response.output_item.done', { output_index: 1, item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'The latest post is about storage.', annotations: [] }] } });
    ev('response.completed', { response: { id: 'resp_ws', status: 'completed', model: SLUG, output: [], usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29, input_tokens_details: { cached_tokens: 0 } } } });
    res.end();
  });
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-websearch-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({ alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000 }));
const { startProxy } = await import('../dist/proxy.js');
await startProxy({ port: PROXY_PORT, host: '127.0.0.1', verbose: false, noLiveCapture: true, noClaudeAuth: true });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const request = (stream) => ({ model: SLUG, max_tokens: 200, stream, system: 'Cite sources.',
  messages: [{ role: 'user', content: 'What is new on the OpenAI newsroom?' }],
  tools: [{ type: 'web_search_20260209', name: 'web_search', allowed_domains: ['openai.com'], max_uses: 2, user_location: { type: 'approximate', country: 'US' } }] });
const parse = (text) => text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);

header('streamed: Anthropic web search on the ChatGPT plan');
{
  const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request(true)) });
  const events = parse(await res.text());
  const sent = codexSeen.bodies.at(-1);
  check('200 stream, one backend request', res.status === 200 && codexSeen.bodies.length === 1, res.status);
  check('the backend got the hosted tool with allowed_domains as filters and the location; max_uses dropped; sources asked for', JSON.stringify(sent.tools) === JSON.stringify([{ type: 'web_search', filters: { allowed_domains: ['openai.com'] }, user_location: { type: 'approximate', country: 'US' } }]) && JSON.stringify(sent.include) === JSON.stringify(['web_search_call.action.sources']) && !JSON.stringify(sent).includes('max_uses'), JSON.stringify({ tools: sent.tools, include: sent.include }));
  const blocks = events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block);
  check('blocks: server_tool_use, web_search_tool_result, text — indices 0,1,2', blocks.map((b) => b.type).join(',') === 'server_tool_use,web_search_tool_result,text' && events.filter((e) => e.type === 'content_block_start').map((e) => e.index).join(',') === '0,1,2', blocks.map((b) => b.type).join(','));
  check('server_tool_use carries the backend item id and name web_search; its input arrives as one input_json_delta', blocks[0].id === 'ws_1' && blocks[0].name === 'web_search' && events.some((e) => e.type === 'content_block_delta' && e.index === 0 && e.delta.partial_json === '{"query":"openai newsroom"}'));
  check('web_search_tool_result references it and lists the two searched pages', blocks[1].tool_use_id === 'ws_1' && blocks[1].content.map((r) => r.url).join(',') === 'https://openai.com/news/,https://openai.com/news/research/' && blocks[1].content[0].type === 'web_search_result');
  const cit = events.find((e) => e.type === 'content_block_delta' && e.delta.type === 'citations_delta');
  check('the citation lands on the text block with the cited span cut from the streamed text', cit && cit.index === 2 && cit.delta.citation.type === 'web_search_result_location' && cit.delta.citation.url === 'https://openai.com/news/' && cit.delta.citation.cited_text === 'post is about storage.', JSON.stringify(cit));
  check('one message_delta with end_turn and one message_stop', events.filter((e) => e.type === 'message_delta').length === 1 && events.find((e) => e.type === 'message_delta').delta.stop_reason === 'end_turn' && events.filter((e) => e.type === 'message_stop').length === 1);
  const opens = []; let bad = false;
  for (const e of events) { if (e.type === 'content_block_start') { if (opens.length) bad = true; opens.push(e.index); } if (e.type === 'content_block_stop') opens.pop(); }
  check('one block open at a time', !bad && opens.length === 0);
}

header('buffered: the folded message carries the same blocks and the citation');
{
  const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request(false)) });
  const j = await res.json();
  check('200 JSON', res.status === 200 && j.type === 'message', res.status);
  check('content: server_tool_use (input parsed), web_search_tool_result, text', j.content.map((b) => b.type).join(',') === 'server_tool_use,web_search_tool_result,text' && j.content[0].input.query === 'openai newsroom' && j.content[1].content.length === 2, JSON.stringify(j.content).slice(0, 300));
  check('text block carries the citation', Array.isArray(j.content[2].citations) && j.content[2].citations[0].url === 'https://openai.com/news/' && j.content[2].text === 'The latest post is about storage.', JSON.stringify(j.content[2]).slice(0, 300));
  check('stop_reason end_turn, usage from the terminal event', j.stop_reason === 'end_turn' && j.usage.output_tokens === 9);
}

header('forced: tool_choice on the hosted tool reaches the backend as the hosted-tool choice');
{
  // Live (2026-09-11): the backend 400s a {type:'function', name:'web_search'}
  // choice ("Tool choice 'function' not found in 'tools' parameter") and runs
  // the search on {type:'web_search'} — alone or next to function tools.
  const body = { ...request(false), tools: [...request(false).tools, { name: 'lookup', description: 'd', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'web_search' } };
  const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const sent = codexSeen.bodies.at(-1);
  check('200 with the hosted-tool choice on the wire, next to the function tool', res.status === 200 && JSON.stringify(sent.tool_choice) === JSON.stringify({ type: 'web_search' }) && sent.tools.length === 2 && sent.tools[1].type === 'function', JSON.stringify({ status: res.status, tool_choice: sent.tool_choice, tools: sent.tools.map((t) => t.type) }));
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

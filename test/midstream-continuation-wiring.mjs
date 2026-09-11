#!/usr/bin/env node
// Live-request proof of mid-stream continuation (v6.1, src/midstream.ts):
// a real startProxy whose upstream dies part-way through a streamed answer
// finishes the SAME client stream from the other subscription.
//
// Hermetic, the same technique as pool-exhaustion-midflight-429-wiring.mjs:
// HOME is a mkdtemp'd dir with one fake Claude seat and one fake codex
// account, the ChatGPT backend is a local stub, the Anthropic upstream is
// ProxyOptions.fetchImpl. No network. What is real: the request handler, both
// dispatch sites, the loopback the continuation makes through dario's own
// front door, the translators, and the bytes the client receives.
//
// Scenarios:
//   A. Claude stream dies (socket reset) → resumed on codex, Anthropic shape
//   B. codex stream fails (response.failed) → resumed on the Claude pool
//   C. Claude stream dies → resumed on codex, OpenAI shape (/v1/chat/completions)
//   D. in-band overloaded_error after content → withheld, resumed on codex
//   E. cut inside an open tool_use → NOT continued, the stream ends as before
//   F. --no-midstream-continue → the stream ends as before
// Every continued stream is replayed through a strict Anthropic/OpenAI SSE
// grammar check — what an SDK stream parser enforces.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROXY_PORT = await freePort();
const PROXY_OFF_PORT = await freePort();
const CODEX_PORT = await freePort();
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const CODEX_SLUG = 'gpt-5.6-sol';
const CLAUDE_MODEL = 'claude-sonnet-5';

const PARTIAL_CLAUDE = 'The three-way handshake exists because both sides must prove they can send and receive before either trusts a byte. Client sends SYN with its sequence num';
const CONT_CODEX = 'ber, the server replies with SYN-ACK, and the client acknowledges that.';
const PARTIAL_CODEX = 'A two-way handshake fails because the server cannot know whether its own SYN-ACK arriv';
const CONT_CLAUDE = 'ed, so half-open connections pile up on stale duplicates.';

const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
const findAnchor = (obj) => {
  const s = JSON.stringify(obj);
  const m = /<resume-anchor>(.*?)<\/resume-anchor>/s.exec(s);
  return m ? JSON.parse(`"${m[1]}"`) : null;
};
const chunks = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'gs')) ?? [];

// ---- the ChatGPT backend stub -------------------------------------------
const codexSeen = { responses: 0, bodies: [] };
let codexMode = 'serve';   // 'serve' = answer (repeating the anchor); 'fail' = stream then response.failed
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: CODEX_SLUG, visibility: 'list' }] }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    codexSeen.responses++;
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(parts).toString());
      codexSeen.bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
      const anchor = findAnchor(body);
      if (codexMode === 'fail') {
        for (const t of chunks(PARTIAL_CODEX, 9)) { res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`); await sleep(2); }
        res.write('data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"server_error","message":"upstream fell over"}}}\n\n');
        res.end();
        return;
      }
      const text = (anchor ?? '') + CONT_CODEX;
      for (const t of chunks(text, 9)) { res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`); await sleep(2); }
      res.write('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":9}}}\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// ---- the fake Anthropic upstream ----------------------------------------
const anthropicSeen = { calls: 0, bodies: [] };
let anthropicMode = 'die';   // 'die' = stream then error the body; 'error-event' = in-band overloaded_error; 'tool' = die inside tool_use
const anthropicStream = (mode, body) => new ReadableStream({
  async start(c) {
    const enc = new TextEncoder();
    const put = (s) => c.enqueue(enc.encode(s));
    const resume = Array.isArray(body.messages) && body.messages.length >= 3;
    put(sse('message_start', { message: { id: 'msg_claude', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } }));
    put(sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }));
    put(sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
    put(sse('content_block_stop', { index: 0 }));
    put(sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }));
    if (resume) {
      // The Claude pool serving a continuation: repeat the anchor, then finish.
      const anchor = findAnchor(body) ?? '';
      for (const t of chunks(anchor + CONT_CLAUDE, 8)) { put(sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })); await sleep(2); }
      put(sse('content_block_stop', { index: 1 }));
      put(sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 11 } }));
      put(sse('message_stop', {}));
      c.close();
      return;
    }
    for (const t of chunks(PARTIAL_CLAUDE, 8)) { put(sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })); await sleep(2); }
    if (mode === 'error-event') {
      put(sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }));
      c.close();
      return;
    }
    if (mode === 'tool') {
      put(sse('content_block_stop', { index: 1 }));
      put(sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }));
      put(sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } }));
    }
    // controller.error() discards anything still queued — let the reader drain first.
    await sleep(20);
    c.error(new Error('read ECONNRESET'));
  },
});
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: CLAUDE_MODEL, type: 'model' }, { id: 'claude-opus-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  anthropicSeen.calls++;
  const raw = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf-8');
  const body = JSON.parse(raw);
  anthropicSeen.bodies.push(body);
  return new Response(anthropicStream(anthropicMode, body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

// ---- home + proxies -----------------------------------------------------
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-midstream-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({
  alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000,
}));

const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };

const { startProxy } = await import('../dist/proxy.js');
const common = { host: '127.0.0.1', verbose: false, noLiveCapture: true, poolFallbackModel: `${CODEX_SLUG},claude:${CLAUDE_MODEL}`, fetchImpl: fakeFetch, maxConcurrent: 1 };
await startProxy({ ...common, port: PROXY_PORT });
await startProxy({ ...common, port: PROXY_OFF_PORT, midstreamContinue: false });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); await fetch(`http://127.0.0.1:${PROXY_OFF_PORT}/health`); break; } catch { await sleep(100); } }

// ---- client side ----------------------------------------------------------
async function streamMessages(model, base = BASE, path = '/v1/messages', extra = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Explain the TCP handshake.' }], ...extra }),
  });
  const text = await res.text();
  return { res, text, frames: text.split(/(?<=\n\n)/).filter(Boolean) };
}
const parse = (raw) => {
  let event = '', data = null, comment = true;
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    comment = false;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) { const t = line.slice(5).trim(); try { data = JSON.parse(t); } catch { data = t; } }
  }
  return { event, data, comment, raw };
};
function assembleAnthropic(frames) {
  const errors = []; let started = false, stopped = false, delta = false; const blocks = [];
  for (const raw of frames) {
    const f = parse(raw); if (f.comment) continue; const d = f.data;
    if (!d || typeof d !== 'object') { errors.push(`non-json ${raw.slice(0, 30)}`); continue; }
    if (stopped) errors.push(`${d.type} after message_stop`);
    switch (d.type) {
      case 'ping': break;
      case 'message_start': if (started) errors.push('second message_start'); started = true; break;
      case 'content_block_start': if (d.index !== blocks.length) errors.push(`index ${d.index} != ${blocks.length}`); blocks[d.index] = { type: d.content_block.type, open: true, text: '' }; break;
      case 'content_block_delta': { const b = blocks[d.index]; if (!b || !b.open) errors.push(`delta on ${d.index}`); else if (d.delta.type === 'text_delta') b.text += d.delta.text; break; }
      case 'content_block_stop': { const b = blocks[d.index]; if (!b || !b.open) errors.push(`stop on ${d.index}`); else b.open = false; break; }
      case 'message_delta': if (blocks.some((b) => b.open)) errors.push('message_delta with open block'); delta = true; break;
      case 'message_stop': if (!delta) errors.push('stop without delta'); stopped = true; break;
      case 'error': errors.push(`error event ${JSON.stringify(d.error).slice(0, 60)}`); break;
      default: errors.push(`unknown ${d.type}`);
    }
  }
  if (!started) errors.push('no message_start'); if (!stopped) errors.push('no message_stop');
  return { ok: errors.length === 0, errors, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), blocks };
}
function assembleOpenAI(frames) {
  const errors = []; let done = false, finish = null, text = '', chunksN = 0;
  for (const raw of frames) {
    const f = parse(raw); if (f.comment) continue; const d = f.data;
    if (done) errors.push('frame after [DONE]');
    if (d === '[DONE]') { done = true; continue; }
    if (!d || typeof d !== 'object') { errors.push(`non-json ${raw.slice(0, 30)}`); continue; }
    if (d.error) { errors.push(`error chunk ${JSON.stringify(d.error).slice(0, 60)}`); continue; }
    if (d.object !== 'chat.completion.chunk') { errors.push(`unexpected object ${d.object}`); continue; }
    chunksN++;
    const c = d.choices?.[0]; if (!c) continue;
    if (typeof c.delta?.content === 'string') text += c.delta.content;
    if (c.finish_reason) { if (finish) errors.push('second finish'); finish = c.finish_reason; }
  }
  if (!done) errors.push('no [DONE]'); if (!finish) errors.push('no finish_reason');
  return { ok: errors.length === 0, errors, text, chunksN };
}
const health = async (base = BASE) => (await (await fetch(`${base}/health`)).json()).queue;

// ---------------------------------------------------------------------------
header('A. Claude stream dies mid-answer → finished on codex (Anthropic shape)');
{
  anthropicMode = 'die'; codexMode = 'serve';
  const before = { a: anthropicSeen.calls, c: codexSeen.responses };
  const { res, frames, text } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream', res.status === 200, res.status);
  check('the Claude upstream was dispatched to once', anthropicSeen.calls === before.a + 1, anthropicSeen.calls);
  check('exactly one codex request — the continuation', codexSeen.responses === before.c + 1, codexSeen.responses);
  check('the client stream is ONE grammatically valid message', a.ok, a.errors.join('; '));
  check('text = partial + continuation, anchor trimmed, seam invisible', a.text === PARTIAL_CLAUDE + CONT_CODEX, a.text.slice(PARTIAL_CLAUDE.length - 20));
  check('message_start names the model the client asked for', frames[0].includes(`"model":"${CLAUDE_MODEL}"`));
  check('an SSE comment marks the takeover', text.includes(`: dario continuation ${CODEX_SLUG} (codex live) after ${PARTIAL_CLAUDE.length} chars`), text.split('\n').find((l) => l.startsWith(': dario')));
  const resumeBody = codexSeen.bodies.at(-1) ?? {};
  const flat = JSON.stringify(resumeBody);
  check('the codex resume carried the partial as the assistant turn and the notice with the anchor', flat.includes(PARTIAL_CLAUDE) && flat.includes('<resume-anchor>') && flat.includes('[transport notice]'));
  check('the resume asked for the codex slug', resumeBody.model === CODEX_SLUG, resumeBody.model);
  check('log line names the takeover', logs.some((l) => /stream died after \d+ chars → continuing as gpt-5\.6-sol \(codex live\)/.test(l)), logs.filter((l) => l.includes('continu')).join(' | '));
  check('log line reports the trim', logs.some((l) => /continuation done: \+\d+ chars in \d+ms \(anchor exact, trimmed \d+\)/.test(l)));
  await sleep(50);
  const q = await health();
  check('queue slot accounting back to zero (the loopback used the released slot on a 1-slot proxy)', q.active === 0 && q.queued === 0, JSON.stringify(q));
}

header('B. codex stream fails (response.failed) → finished on the Claude pool');
{
  anthropicMode = 'die'; codexMode = 'fail';
  const before = { a: anthropicSeen.calls, c: codexSeen.responses };
  const { res, frames, text } = await streamMessages(CODEX_SLUG);
  const a = assembleAnthropic(frames);
  check('200 stream', res.status === 200, res.status);
  check('codex dispatched once, the Claude pool once (the continuation)', codexSeen.responses === before.c + 1 && anthropicSeen.calls === before.a + 1, `codex=${codexSeen.responses - before.c} claude=${anthropicSeen.calls - before.a}`);
  check('ONE valid message', a.ok, a.errors.join('; '));
  check('text = codex partial + Claude continuation', a.text === PARTIAL_CODEX + CONT_CLAUDE, a.text);
  check('the polite close the translator emits for a failed turn never reached the client before the resume', frames.filter((f) => f.includes('message_stop')).length === 1);
  check('takeover comment names the Claude target', text.includes(`: dario continuation ${CLAUDE_MODEL} (claude pool)`));
  const resume = anthropicSeen.bodies.at(-1) ?? { messages: [] };
  check('the Claude resume is the CLIENT request re-pointed (assistant partial + notice appended)', resume.messages.length === 3 && JSON.stringify(resume.messages[1]).includes(PARTIAL_CODEX) && JSON.stringify(resume.messages[2]).includes('<resume-anchor>'), JSON.stringify(resume.messages).slice(0, 200));
}

header('C. Claude stream dies → finished on codex, OpenAI shape');
{
  anthropicMode = 'die'; codexMode = 'serve';
  const before = { c: codexSeen.responses };
  const { res, frames } = await streamMessages(CLAUDE_MODEL, BASE, '/v1/chat/completions');
  const o = assembleOpenAI(frames);
  check('200 stream', res.status === 200, res.status);
  check('one codex continuation', codexSeen.responses === before.c + 1);
  check('ONE valid chat.completion.chunk stream: one finish_reason, one [DONE], no error chunk', o.ok, o.errors.join('; '));
  check('text = partial + continuation', o.text === PARTIAL_CLAUDE + CONT_CODEX, o.text.slice(PARTIAL_CLAUDE.length - 20));
  const body = codexSeen.bodies.at(-1) ?? {};
  check('the codex resume carried the partial + notice in the chat shape', JSON.stringify(body).includes(PARTIAL_CLAUDE) && JSON.stringify(body).includes('<resume-anchor>'));
}

header('D. in-band overloaded_error after content → withheld, finished on codex');
{
  anthropicMode = 'error-event'; codexMode = 'serve';
  const { res, frames, text } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream, ONE valid message, no error event reached the client', res.status === 200 && a.ok && !text.includes('overloaded_error'), a.errors.join('; '));
  check('text = partial + continuation', a.text === PARTIAL_CLAUDE + CONT_CODEX);
}

header('E. cut inside an open tool_use → not continuable, ends as before');
{
  anthropicMode = 'tool'; codexMode = 'serve';
  const before = { c: codexSeen.responses };
  const { res, frames } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream that is truncated (no message_stop) — today\'s behaviour', res.status === 200 && !a.ok && a.errors.includes('no message_stop'), a.errors.join('; '));
  check('no codex request was made', codexSeen.responses === before.c);
  check('the tool_use frames reached the client as they were', frames.some((f) => f.includes('input_json_delta')));
}

header('F. --no-midstream-continue → ends as before');
{
  anthropicMode = 'die'; codexMode = 'serve';
  const before = { c: codexSeen.responses };
  const { res, frames } = await streamMessages(CLAUDE_MODEL, `http://127.0.0.1:${PROXY_OFF_PORT}`);
  const a = assembleAnthropic(frames);
  check('truncated stream, no continuation, no codex request', res.status === 200 && !a.ok && codexSeen.responses === before.c, a.errors.join('; '));
  check('startup announced the switch', logs.some((l) => l.includes('mid-stream continuation: disabled')));
}

header('G. a request carrying the continuation marker is never resumed itself');
{
  anthropicMode = 'die'; codexMode = 'serve';
  const before = { c: codexSeen.responses, a: anthropicSeen.calls };
  const direct = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dario-continuation': '1' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'x' }] }),
  });
  const t = await direct.text();
  const a = assembleAnthropic(t.split(/(?<=\n\n)/).filter(Boolean));
  check('marked request: truncated, no second hop', !a.ok && codexSeen.responses === before.c && anthropicSeen.calls === before.a + 1, `codex=${codexSeen.responses - before.c} claude=${anthropicSeen.calls - before.a}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Live-request proof of mid-stream continuation (src/midstream.ts): a real
// startProxy whose upstream dies part-way through a streamed answer finishes
// the SAME client stream — on the same model first, on the other subscription
// when that delivers nothing or dies too.
//
// Hermetic, the same technique as pool-exhaustion-midflight-429-wiring.mjs:
// HOME is a mkdtemp'd dir with one fake Claude seat and one fake codex
// account, the ChatGPT backend is a local stub, the Anthropic upstream is
// ProxyOptions.fetchImpl. No network. What is real: the request handler, both
// dispatch sites, the loopbacks the continuation makes through dario's own
// front door, the translators, and the bytes the client receives.
//
// Each fake takes a PLAN — one behaviour per request it will see, in order —
// so a scenario states exactly what the primary does, what the same-model
// resume does, and what the other provider does:
//   Anthropic: die (partial, then reset) | serve | error-event | tool | refuse (502 before any byte)
//   codex:     serve | fail (content, then response.failed) | die (content, then socket drop) | refuse (503)
// A resume (body carries the anchor quote) answers with the anchor repeated.

import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const CONT_CLAUDE = 'ber, the server replies with SYN-ACK, and the client acknowledges that.';
const CONT_CODEX = 'ber; the server answers SYN-ACK; the client ACKs; and only then does data flow.';
const PARTIAL_CODEX = 'A two-way handshake fails because the server cannot know whether its own SYN-ACK arriv';
const CONT_CODEX_2 = 'ed at all, so half-open connections pile up on stale duplicates.';
const CONT_CLAUDE_2 = 'ed, and stale duplicates from an old connection can open a new one by accident.';
const DIE_AFTER = 30;   // chars of continuation a dying resume manages before it drops
const PROMPT = 'Explain the TCP handshake.';

const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
// The LAST quote in the body: a second hop's request carries the first hop's resume turn too.
const anchorIn = (obj) => { const ms = [...JSON.stringify(obj).matchAll(/«(.*?)»/gs)]; return ms.length ? JSON.parse(`"${ms.at(-1)[1]}"`) : null; };
const chunks = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'gs')) ?? [];

// ---- the ChatGPT backend stub -------------------------------------------
const codexSeen = { responses: 0, bodies: [] };
let codexPlan = [];
const codexStub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: CODEX_SLUG, visibility: 'list' }] }));
    return;
  }
  if (!req.url.startsWith('/responses')) { res.writeHead(404).end(); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', async () => {
    const body = JSON.parse(Buffer.concat(parts).toString());
    const ours = JSON.stringify(body).includes(PROMPT);
    if (ours) { codexSeen.responses++; codexSeen.bodies.push(body); }
    const mode = ours ? (codexPlan.shift() ?? 'serve') : 'serve';
    if (mode === 'refuse') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"down"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
    const anchor = anchorIn(body);
    const cont = anchor ? (JSON.stringify(body).includes(PARTIAL_CODEX) ? CONT_CODEX_2 : CONT_CODEX) : PARTIAL_CODEX;
    const full = anchor ? anchor + cont : cont;
    const text = mode === 'serve' ? full : (anchor ? anchor + cont.slice(0, DIE_AFTER) : full);
    for (const t of chunks(text, 9)) { res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`); await sleep(2); }
    await sleep(20);
    if (mode === 'fail') { res.write('data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"server_error","message":"upstream fell over"}}}\n\n'); res.end(); return; }
    if (mode === 'die') { res.destroy(); return; }
    res.write('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":9}}}\n\n');
    res.end();
  });
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

// ---- the fake Anthropic upstream ----------------------------------------
const anthropicSeen = { calls: 0, bodies: [] };
let anthropicPlan = [];
const anthropicStream = (mode, body) => new ReadableStream({
  async start(c) {
    const enc = new TextEncoder();
    const put = (s) => c.enqueue(enc.encode(s));
    const anchor = anchorIn(body);
    put(sse('message_start', { message: { id: 'msg_claude', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } }));
    put(sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }));
    put(sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
    put(sse('content_block_stop', { index: 0 }));
    put(sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }));
    const cont = anchor ? (JSON.stringify(body.messages).includes(PARTIAL_CODEX) ? CONT_CLAUDE_2 : CONT_CLAUDE) : PARTIAL_CLAUDE;
    const full = anchor ? anchor + cont : cont;
    const text = mode === 'serve' ? full : (anchor ? anchor + cont.slice(0, DIE_AFTER) : full);
    for (const t of chunks(text, 8)) { put(sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })); await sleep(2); }
    if (mode === 'serve') {
      put(sse('content_block_stop', { index: 1 }));
      put(sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 11 } }));
      put(sse('message_stop', {}));
      c.close();
      return;
    }
    if (mode === 'error-event') { put(sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })); c.close(); return; }
    if (mode === 'tool') {
      put(sse('content_block_stop', { index: 1 }));
      put(sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }));
      put(sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } }));
    }
    await sleep(20);   // controller.error() discards anything still queued — let the reader drain first
    c.error(new Error('read ECONNRESET'));
  },
});
const fakeFetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: CLAUDE_MODEL, type: 'model' }, { id: 'claude-opus-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const raw = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf-8');
  const body = JSON.parse(raw);
  // Only this test's own requests take a plan entry and count; a serving
  // probe or anything else dario sends on its own is served and ignored.
  const ours = raw.includes(PROMPT);
  if (ours) { anthropicSeen.calls++; anthropicSeen.bodies.push(body); }
  const mode = ours ? (anthropicPlan.shift() ?? 'serve') : 'serve';
  if (mode === 'refuse') return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } }), { status: 502, headers: { 'content-type': 'application/json' } });
  return new Response(anthropicStream(mode, body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
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
const origWarn = console.warn;
console.warn = (...a) => { logs.push(a.join(' ')); origWarn(...a); };

const { startProxy } = await import('../dist/proxy.js');
const common = { host: '127.0.0.1', verbose: false, noLiveCapture: true, poolFallbackModel: `${CODEX_SLUG},claude:${CLAUDE_MODEL}`, fetchImpl: fakeFetch, maxConcurrent: 1 };
const LOG_FILE = join(tmpHome, 'proxy.log');
await startProxy({ ...common, port: PROXY_PORT, logFile: LOG_FILE });
await startProxy({ ...common, port: PROXY_OFF_PORT, midstreamContinue: false });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); await fetch(`http://127.0.0.1:${PROXY_OFF_PORT}/health`); break; } catch { await sleep(100); } }

// ---- client side ----------------------------------------------------------
async function streamMessages(model, base = BASE, path = '/v1/messages', headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: PROMPT }] }),
  });
  const text = await res.text();
  return { res, text, frames: text.split(/(?<=\n\n)/).filter(Boolean), seams: text.split('\n').filter((l) => l.startsWith(': dario continuation')) };
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
  const errors = []; let done = false, finish = null, text = '';
  for (const raw of frames) {
    const f = parse(raw); if (f.comment) continue; const d = f.data;
    if (done) errors.push('frame after [DONE]');
    if (d === '[DONE]') { done = true; continue; }
    if (!d || typeof d !== 'object') { errors.push(`non-json ${raw.slice(0, 30)}`); continue; }
    if (d.error) { errors.push(`error chunk ${JSON.stringify(d.error).slice(0, 60)}`); continue; }
    if (d.object !== 'chat.completion.chunk') { errors.push(`unexpected object ${d.object}`); continue; }
    const c = d.choices?.[0]; if (!c) continue;
    if (typeof c.delta?.content === 'string') text += c.delta.content;
    if (c.finish_reason) { if (finish) errors.push('second finish'); finish = c.finish_reason; }
  }
  if (!done) errors.push('no [DONE]'); if (!finish) errors.push('no finish_reason');
  return { ok: errors.length === 0, errors, text };
}
const health = async (base = BASE) => (await (await fetch(`${base}/health`)).json()).queue;
const counts = () => ({ a: anthropicSeen.calls, c: codexSeen.responses });
const delta = (b) => ({ a: anthropicSeen.calls - b.a, c: codexSeen.responses - b.c });
// The /analytics window's continuation tally and the last log line that
// carries one — what an operator sees of a dying stream after the fact.
const continuations = async (base = BASE) => (await (await fetch(`${base}/analytics`)).json()).window.continuations;
const contDelta = (before, after) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const logRows = async () => {
  await sleep(50);
  let text = '';
  try { text = await readFile(LOG_FILE, 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const lastContinuedLog = async () => (await logRows()).filter((l) => l.continued).at(-1) ?? null;
// The rows one client request produced: its own and every resume leg's.
const rowsAfter = async (count) => (await logRows()).slice(count);
// "#N stream died after …" — the guard's request number, what a resume leg's continuation_of names.
const diedAs = (from) => logs.slice(from).map((l) => /#(\d+) stream died after/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
const lastLogs = (n) => logs.slice(-n).join(' | ');

// ---------------------------------------------------------------------------
header('A. Claude stream dies → finished on the SAME model (a fresh request through the front door)');
{
  anthropicPlan = ['die', 'serve']; codexPlan = [];
  const b = counts();
  const c0 = await continuations();
  const rows0 = (await logRows()).length; const logs0 = logs.length;
  const { res, frames, seams } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream', res.status === 200, res.status);
  check('two Claude requests (primary + resume), zero codex', delta(b).a === 2 && delta(b).c === 0, JSON.stringify(delta(b)));
  check('ONE grammatically valid message', a.ok, a.errors.join('; '));
  check('text = partial + continuation, anchor trimmed, seam invisible', a.text === PARTIAL_CLAUDE + CONT_CLAUDE, a.text.slice(PARTIAL_CLAUDE.length - 20));
  check('message_start names the model the client asked for', frames[0].includes(`"model":"${CLAUDE_MODEL}"`));
  check('seam comment names the same model', seams.length === 1 && seams[0] === `: dario continuation ${CLAUDE_MODEL} (same model) after ${PARTIAL_CLAUDE.length} chars`, seams.join(' / '));
  const resume = anthropicSeen.bodies.at(-1);
  check('the resume is the client request re-pointed at its own model, partial + request appended', resume.model === CLAUDE_MODEL && resume.messages.length === 3 && JSON.stringify(resume.messages[1]).includes(PARTIAL_CLAUDE) && JSON.stringify(resume.messages[2]).includes('My connection dropped'), JSON.stringify(resume.messages).slice(0, 160));
  check('log names the takeover and the trim', logs.some((l) => /stream died after \d+ chars → continuing as claude-sonnet-5 \(same model\)/.test(l)) && logs.some((l) => /continuation done by claude-sonnet-5: \+\d+ chars in \d+ms \(anchor exact, trimmed \d+\)/.test(l)), lastLogs(4));
  await sleep(50);
  const q = await health();
  check('queue slot accounting back to zero on a 1-slot proxy', q.active === 0 && q.queued === 0, JSON.stringify(q));
  const c = contDelta(c0, await continuations());
  check('/analytics counts it: +1 attempted, +1 finished', c.attempted === 1 && c.finished === 1 && c.unfinished === 0 && c.failed === 0 && c.noTarget === 0, JSON.stringify(c));
  const line = await lastContinuedLog();
  check('the request log line carries the outcome, the leg and where the seam sat', line && line.continued === 'continued' && line.continued_by === `${CLAUDE_MODEL} (same model)` && line.continued_after === PARTIAL_CLAUDE.length && line.model === CLAUDE_MODEL, JSON.stringify(line));
  const rows = await rowsAfter(rows0);
  const leg = rows.find((r) => r.continuation_depth === 1);
  check('the resume leg has its own row: depth 1, pointing at the request whose stream died', rows.length === 2 && leg && leg.continuation_of === diedAs(logs0)[0] && leg.continued === undefined && leg.model === CLAUDE_MODEL, JSON.stringify({ rows, died: diedAs(logs0) }));
}

header('B. Claude dies, the same-model resume is refused before any byte → the other provider serves');
{
  anthropicPlan = ['die', 'refuse']; codexPlan = ['serve'];
  const b = counts();
  const { res, frames, seams } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream; Claude ×2 (primary, refused resume); codex ×1', res.status === 200 && delta(b).a === 2 && delta(b).c === 1, JSON.stringify(delta(b)));
  check('ONE valid message', a.ok, a.errors.join('; '));
  check('text = partial + codex continuation', a.text === PARTIAL_CLAUDE + CONT_CODEX, a.text.slice(PARTIAL_CLAUDE.length - 20));
  check('one seam comment, naming codex', seams.length === 1 && seams[0].includes(`${CODEX_SLUG} (codex live)`), seams.join(' / '));
  check('log records the hand-over', logs.some((l) => /continuation as claude-sonnet-5 \(same model\) delivered nothing — trying the next choice/.test(l)), lastLogs(6));
  const line = await lastContinuedLog();
  check('the log line names the codex leg that served the rest', line && line.continued === 'continued' && line.continued_by === `${CODEX_SLUG} (codex live)`, JSON.stringify(line));
}

header('C. Claude dies, the same-model resume dies too → second hop to the other provider, inside the resume');
{
  anthropicPlan = ['die', 'die']; codexPlan = ['serve'];
  const b = counts();
  const rows0 = (await logRows()).length; const logs0 = logs.length;
  const { res, frames, seams } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream; Claude ×2; codex ×1', res.status === 200 && delta(b).a === 2 && delta(b).c === 1, JSON.stringify(delta(b)));
  check('ONE valid message', a.ok, a.errors.join('; '));
  check('text = primary partial + what the dying resume managed + codex finishing it', a.text === PARTIAL_CLAUDE + CONT_CLAUDE.slice(0, DIE_AFTER) + CONT_CODEX, a.text.slice(PARTIAL_CLAUDE.length - 10));
  check('the second hop\'s request carries the primary partial AND the first hop\'s text as two assistant turns', (() => { const b = JSON.stringify(codexSeen.bodies.at(-1)); return b.includes(PARTIAL_CLAUDE) && b.includes(CONT_CLAUDE.slice(0, DIE_AFTER)) && (b.match(/My connection dropped/g) ?? []).length === 2; })());
  check('two seam comments reach the client: same model, then codex', seams.length === 2 && seams[0].includes('(same model)') && seams[1].includes('(codex live)'), seams.join(' / '));
  const rows = await rowsAfter(rows0);
  const outer = rows.find((r) => !r.continuation_depth);
  const hop1 = rows.find((r) => r.continuation_depth === 1);
  const hop2 = rows.find((r) => r.continuation_depth === 2);
  const died = diedAs(logs0);
  check('three rows: the client request (continued by the same model), the first hop (itself continued by codex, pointing at the client request), the second hop (codex, pointing at the first hop)',
    rows.length === 3 && outer && hop1 && hop2
      && outer.continued === 'continued' && outer.continued_by === `${CLAUDE_MODEL} (same model)`
      && hop1.continued === 'continued' && hop1.continued_by === `${CODEX_SLUG} (codex live)` && hop1.continuation_of === died[0]
      && hop2.continued === undefined && hop2.continuation_of === died[1] && hop2.model === CODEX_SLUG,
    JSON.stringify({ rows, died }));
}

header('D. codex stream fails (response.failed) → finished on the same model (codex again)');
{
  anthropicPlan = []; codexPlan = ['fail', 'serve'];
  const b = counts();
  const { res, frames, seams } = await streamMessages(CODEX_SLUG);
  const a = assembleAnthropic(frames);
  check('200 stream; codex ×2; Claude ×0', res.status === 200 && delta(b).c === 2 && delta(b).a === 0, JSON.stringify(delta(b)));
  check('ONE valid message', a.ok, a.errors.join('; '));
  check('text = codex partial + codex continuation', a.text === PARTIAL_CODEX + CONT_CODEX_2, a.text);
  check('the polite close the translator emits for a failed turn never reached the client early', frames.filter((f) => f.includes('message_stop')).length === 1);
  check('seam comment names the same model', seams.length === 1 && seams[0].includes(`${CODEX_SLUG} (same model)`), seams.join(' / '));
}

header('E. codex fails twice → second hop to the Claude pool');
{
  anthropicPlan = ['serve']; codexPlan = ['fail', 'fail'];
  const b = counts();
  const { res, frames, seams } = await streamMessages(CODEX_SLUG);
  const a = assembleAnthropic(frames);
  check('200 stream; codex ×2; Claude ×1', res.status === 200 && delta(b).c === 2 && delta(b).a === 1, JSON.stringify(delta(b)));
  check('ONE valid message', a.ok, a.errors.join('; '));
  check('text = codex partial + what the failing resume managed + Claude finishing it', a.text === PARTIAL_CODEX + CONT_CODEX_2.slice(0, DIE_AFTER) + CONT_CLAUDE_2, a.text.slice(PARTIAL_CODEX.length - 10));
  check('seams: same model, then claude pool', seams.length === 2 && seams[0].includes('(same model)') && seams[1].includes('(claude pool)'), seams.join(' / '));
}

header('F. Claude dies → same model, OpenAI shape');
{
  anthropicPlan = ['die', 'serve']; codexPlan = [];
  const b = counts();
  const { res, frames } = await streamMessages(CLAUDE_MODEL, BASE, '/v1/chat/completions');
  const o = assembleOpenAI(frames);
  check('200 stream; Claude ×2; codex ×0', res.status === 200 && delta(b).a === 2 && delta(b).c === 0, JSON.stringify(delta(b)));
  check('ONE valid chat.completion.chunk stream', o.ok, o.errors.join('; '));
  check('text = partial + continuation', o.text === PARTIAL_CLAUDE + CONT_CLAUDE, o.text.slice(PARTIAL_CLAUDE.length - 20));
  const resume = anthropicSeen.bodies.at(-1);
  check('the resume carried the partial + request in the chat shape (translated to Anthropic upstream)', JSON.stringify(resume.messages).includes(PARTIAL_CLAUDE) && JSON.stringify(resume.messages).includes('My connection dropped'));
}

header('G. in-band overloaded_error after content → withheld, resumed');
{
  anthropicPlan = ['error-event', 'serve']; codexPlan = [];
  const { res, frames, text } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream, ONE valid message, no error event reached the client', res.status === 200 && a.ok && !text.includes('overloaded_error'), a.errors.join('; '));
  check('text = partial + continuation', a.text === PARTIAL_CLAUDE + CONT_CLAUDE, a.text.slice(PARTIAL_CLAUDE.length - 20));
}

header('H. the resume dies and nobody can take the second hop → left unfinished, never closed as complete');
{
  // codex refuses the second hop; its own request-level failover then hands
  // that loopback to the Claude pool, which refuses too. Nothing else to try.
  anthropicPlan = ['die', 'die', 'refuse']; codexPlan = ['refuse'];
  const b = counts();
  const c0 = await continuations();
  const { res, frames, text } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('200 stream; Claude ×3 (primary, dying resume, refused deferral); codex ×1 (refused)', res.status === 200 && delta(b).a === 3 && delta(b).c === 1, JSON.stringify(delta(b)));
  check('what the dying resume managed reached the client', a.text === PARTIAL_CLAUDE + CONT_CLAUDE.slice(0, DIE_AFTER), a.text.slice(PARTIAL_CLAUDE.length - 10));
  check('but the message was NOT closed: no message_stop, no message_delta, text block left open', !a.ok && a.errors.includes('no message_stop') && !text.includes('message_delta') && frames.filter((f) => f.includes('content_block_stop')).length === 1, a.errors.join('; '));
  check('log says so', logs.some((l) => /continuation ended without its terminal event after \+\d+ chars — stream left unfinished/.test(l)), lastLogs(6));
  const c = contDelta(c0, await continuations());
  const line = await lastContinuedLog();
  check('/analytics counts the unfinished one; the log line says continued-unfinished', c.attempted === 1 && c.unfinished === 1 && c.finished === 0 && line && line.continued === 'continued-unfinished' && line.continued_by === `${CLAUDE_MODEL} (same model)`, JSON.stringify({ c, line }));
}

header('I. cut inside an open tool_use → not continuable, ends as before');
{
  anthropicPlan = ['tool']; codexPlan = [];
  const b = counts();
  const c0 = await continuations();
  const { res, frames } = await streamMessages(CLAUDE_MODEL);
  const a = assembleAnthropic(frames);
  check('truncated (no message_stop) — today\'s behaviour; no resume at all', res.status === 200 && !a.ok && a.errors.includes('no message_stop') && delta(b).a === 1 && delta(b).c === 0, a.errors.join('; '));
  check('the tool_use frames reached the client as they were', frames.some((f) => f.includes('input_json_delta')));
  const c = contDelta(c0, await continuations());
  check('not an attempt: the tally did not move', c.attempted === 0, JSON.stringify(c));
}

header('J. --no-midstream-continue → ends as before');
{
  anthropicPlan = ['die']; codexPlan = [];
  const b = counts();
  const { res, frames } = await streamMessages(CLAUDE_MODEL, `http://127.0.0.1:${PROXY_OFF_PORT}`);
  const a = assembleAnthropic(frames);
  check('truncated stream, no resume', res.status === 200 && !a.ok && delta(b).a === 1 && delta(b).c === 0, a.errors.join('; '));
  check('startup announced the switch', logs.some((l) => l.includes('mid-stream continuation: disabled')));
}

header('K. a request at the maximum continuation depth is never resumed');
{
  anthropicPlan = ['die']; codexPlan = [];
  const b = counts();
  const { res, frames } = await streamMessages(CLAUDE_MODEL, BASE, '/v1/messages', { 'x-dario-continuation': '2' });
  const a = assembleAnthropic(frames);
  check('depth-2 request: truncated, no further hop', res.status === 200 && !a.ok && delta(b).a === 1 && delta(b).c === 0, JSON.stringify(delta(b)));
}

header('L. DARIO_CHAOS_CUT_AFTER — a stream dies on demand and is finished by the continuation');
{
  const CHAOS_PORT = await freePort();
  process.env.DARIO_CHAOS_CUT_AFTER = '60';
  await startProxy({ ...common, port: CHAOS_PORT });
  delete process.env.DARIO_CHAOS_CUT_AFTER;
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${CHAOS_PORT}/health`); break; } catch { await sleep(100); } }
  anthropicPlan = ['serve', 'serve']; codexPlan = [];
  const b = counts();
  const { res, frames, seams } = await streamMessages(CLAUDE_MODEL, `http://127.0.0.1:${CHAOS_PORT}`);
  const a = assembleAnthropic(frames);
  check('startup warned', logs.some((l) => /CHAOS: the first 1 streamed answer will be cut after 60 chars/.test(l)));
  check('the tap cut the healthy stream, the continuation finished it: ONE valid message, Claude ×2', res.status === 200 && a.ok && delta(b).a === 2, a.errors.join('; ') + ' ' + JSON.stringify(delta(b)));
  check('text = the cut prefix + the resume (anchor trimmed)', a.text.startsWith(PARTIAL_CLAUDE.slice(0, 60)) && a.text.endsWith(CONT_CLAUDE) && !a.text.includes(PARTIAL_CLAUDE.slice(0, 40) + PARTIAL_CLAUDE.slice(0, 40)), a.text);
  check('one seam, same model', seams.length === 1 && seams[0].includes('(same model)'), seams.join(' / '));
  const again = await streamMessages(CLAUDE_MODEL, `http://127.0.0.1:${CHAOS_PORT}`);
  check('the next stream is untouched (one cut, then quiet)', assembleAnthropic(again.frames).ok && again.seams.length === 0, again.seams.join(' / '));
}

header('M. dario usage reports the tally');
{
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, 'usage', `--port=${PROXY_PORT}`], { env: process.env });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', () => resolve(o));
  });
  const c = await continuations();
  const line = out.split('\n').find((l) => l.includes('Continuations:')) ?? '';
  check('one line: how many streams died mid-answer and how the continuations went', line.includes(`${c.attempted} streams died mid-answer: ${c.finished} finished`) && line.includes(`${c.unfinished} unfinished`), line || out);
}

console.log(`\n${pass} passed, ${fail} failed`);
codexStub.close();
process.exit(fail === 0 ? 0 : 1);

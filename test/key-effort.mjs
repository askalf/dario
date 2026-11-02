#!/usr/bin/env node
// Per-key default effort. First the pure half: the vocabulary, the record,
// create / set / clear / rotate, the file parser's tolerance, the public shape,
// the request-side test that decides whether a key's default applies (a
// request that named its own effort is never overruled) and the Responses
// passthrough helper. Then a real startProxy with stubbed Claude and Codex
// upstreams (no credentials, no network) reads the level each wire carries.

import {
  KEY_EFFORT_VALUES, isKeyEffort, createKey, emptyKeysFile, publicKey, rotateKey, setKeyEffort, parseKeysFile,
} from '../dist/keys.js';
import { requestNamesEffort, parseEffortSuffix, effortForCodex, withResponsesEffort } from '../dist/effort.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const NOW = Date.parse('2026-11-01T22:00:00Z');

header('vocabulary: the wire-valid levels and nothing else');
{
  check('five levels', KEY_EFFORT_VALUES.join(',') === 'low,medium,high,xhigh,max');
  for (const v of KEY_EFFORT_VALUES) check(`isKeyEffort(${v})`, isKeyEffort(v));
  for (const v of ['client', 'ultracode', 'LOW', 'turbo', '', 7, null, undefined, {}]) check(`not a key effort: ${JSON.stringify(v)}`, !isKeyEffort(v));
  check('every key effort maps straight through to the Codex level', KEY_EFFORT_VALUES.every((v) => effortForCodex(v) === v));
}

header('record: create, set, clear, rotate, public shape');
{
  const file = emptyKeysFile();
  const alice = createKey(file, 'alice', { effort: 'low', now: NOW });
  check('create carries the effort', alice.record.effort === 'low');
  check('public shape exposes it', publicKey(alice.record, NOW).effort === 'low');
  const bob = createKey(file, 'bob', { now: NOW });
  check('no effort: absent on the record, null in public', bob.record.effort === undefined && publicKey(bob.record, NOW).effort === null);
  let threw = null;
  try { createKey(file, 'carol', { effort: 'turbo', now: NOW }); } catch (e) { threw = e.message; }
  check('create refuses an unknown level', /invalid effort "turbo"/.test(threw ?? ''), threw);
  threw = null;
  try { createKey(file, 'dave', { effort: 'client', now: NOW }); } catch (e) { threw = e.message; }
  check('create refuses client (that is the pin vocabulary, not a key default)', /invalid effort/.test(threw ?? ''), threw);
  check('an empty effort string means none', createKey(file, 'erin', { effort: '', now: NOW }).record.effort === undefined);
  check('set on an existing key', setKeyEffort(file, 'bob', 'xhigh')?.effort === 'xhigh');
  check('set returns null for an unknown key', setKeyEffort(file, 'nobody', 'low') === null);
  threw = null;
  try { setKeyEffort(file, 'bob', 'ultracode'); } catch (e) { threw = e.message; }
  check('set refuses a client mode', /invalid effort/.test(threw ?? ''), threw);
  check('the refused set left the old value', file.keys.find((k) => k.name === 'bob').effort === 'xhigh');
  check('clear with null', setKeyEffort(file, 'bob', null)?.effort === undefined);
  setKeyEffort(file, 'bob', 'max');
  check('clear with an empty string', setKeyEffort(file, 'bob', '')?.effort === undefined);
  setKeyEffort(file, 'alice', 'medium');
  const rotated = rotateKey(file, 'alice', NOW);
  check('rotate keeps the effort', rotated.record.effort === 'medium' && rotated.secret !== alice.secret);
}

header('file: a default survives a round trip; an unknown level on disk is dropped');
{
  const file = emptyKeysFile();
  createKey(file, 'alice', { effort: 'low', now: NOW });
  createKey(file, 'bob', { now: NOW });
  const text = JSON.stringify({ version: file.version, keys: file.keys });
  const back = parseKeysFile(text);
  check('round trip keeps the level', back.keys.find((k) => k.name === 'alice').effort === 'low');
  check('round trip keeps the absence', back.keys.find((k) => k.name === 'bob').effort === undefined);
  const dirty = JSON.parse(text);
  dirty.keys[1].effort = 'turbo';
  dirty.keys[0].effort = 'client';
  const cleaned = parseKeysFile(JSON.stringify(dirty));
  check('unknown and pin-only levels are dropped, the keys stay', cleaned.keys.length === 2 && cleaned.keys.every((k) => k.effort === undefined));
  const typed = JSON.parse(text);
  typed.keys[1].effort = 42;
  check('a non-string level is dropped', parseKeysFile(JSON.stringify(typed)).keys[1].effort === undefined);
}

header('request side: when does a key default apply?');
{
  check('empty body: no effort named', !requestNamesEffort({}));
  check('null body: no effort named', !requestNamesEffort(null) && !requestNamesEffort(undefined));
  check('Messages shape output_config.effort counts', requestNamesEffort({ output_config: { effort: 'low' } }));
  check('output_config without effort does not', !requestNamesEffort({ output_config: { format: { type: 'json_schema' } } }));
  check('a non-string effort does not', !requestNamesEffort({ output_config: { effort: 3 } }));
  check('chat completions reasoning_effort counts', requestNamesEffort({ reasoning_effort: 'high' }));
  check('an empty reasoning_effort does not', !requestNamesEffort({ reasoning_effort: '' }));
  check('Responses reasoning.effort counts', requestNamesEffort({ reasoning: { effort: 'medium' } }));
  check('reasoning without effort does not', !requestNamesEffort({ reasoning: { summary: 'auto' } }));
  check('a thinking block alone is not an effort choice', !requestNamesEffort({ thinking: { type: 'enabled', budget_tokens: 2048 } }));
  // The suffix is the caller's job: parsed off the model before the body test runs.
  check('suffix still parses beside this', parseEffortSuffix('claude-opus-5-5:low').effort === 'low');
}

header('responses passthrough helper: fill reasoning.effort only when the client set none');
{
  const body = { model: 'gpt-5.6-sol', reasoning: { summary: 'auto' }, input: [] };
  const filled = withResponsesEffort(body, 'low');
  check('adds the level and keeps summary', filled.reasoning.effort === 'low' && filled.reasoning.summary === 'auto');
  check('never mutates the client body', body.reasoning.effort === undefined && filled !== body);
  const chosen = { model: 'm', reasoning: { effort: 'high', summary: 'auto' } };
  check('a client level is left alone (same object back)', withResponsesEffort(chosen, 'low') === chosen);
  check('no effort to add: same object back', withResponsesEffort(body, undefined) === body);
  check('no reasoning field: one is created', withResponsesEffort({ model: 'm' }, 'medium').reasoning.effort === 'medium');
  check('a malformed reasoning field is replaced', withResponsesEffort({ model: 'm', reasoning: 'x' }, 'low').reasoning.effort === 'low');
  check('an empty client level counts as none', withResponsesEffort({ model: 'm', reasoning: { effort: '' } }, 'low').reasoning.effort === 'low');
}

header('through a real proxy: the level each wire carries');
{
  // Hermetic: HOME in a mkdtemp dir with one Claude seat, one Codex account and
  // a keys file; the Anthropic upstream is a fetch stub and the Codex backend a
  // loopback stub, both recording the bodies dario sends. Every check reads a
  // recorded outbound body, so deleting a propagation site fails this file.
  const { createServer } = await import('node:http');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { freePort } = await import('./helpers/free-port.mjs');
  const { writeKeysFile } = await import('../dist/keys.js');
  const CLAUDE = 'claude-sonnet-5';
  const CODEX = 'gpt-5.6-sol';
  const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

  const codexBodies = [];
  const codexStub = createServer((req, res) => {
    if (req.url.startsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ slug: CODEX, visibility: 'list' }] })); return; }
    if (!req.url.startsWith('/responses')) { res.writeHead(404).end(); return; }
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      try { codexBodies.push(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { codexBodies.push(null); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type, obj, seq) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...obj })}\n\n`);
      const msg = { id: 'msg_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] };
      const full = { id: 'resp_x', object: 'response', created_at: 1, status: 'completed', model: CODEX, output: [msg], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
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
  const codexPort = await freePort();
  await new Promise((r) => codexStub.listen(codexPort, '127.0.0.1', r));

  const claudeBodies = [];
  const fakeFetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: CLAUDE, type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf-8'));
    claudeBodies.push(body);
    const headers = { 'content-type': body.stream ? 'text/event-stream' : 'application/json', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-7d-utilization': '0.2' };
    if (!body.stream) return new Response(JSON.stringify({ id: 'msg_b', type: 'message', role: 'assistant', model: CLAUDE, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers });
    return new Response([
      sse('message_start', { message: { id: 'msg_s', type: 'message', role: 'assistant', model: CLAUDE, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
      sse('message_stop', {}),
    ].join(''), { status: 200, headers });
  };

  const home = await mkdtemp(join(tmpdir(), 'dario-key-effort-proxy-'));
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${codexPort}`;
  process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
  process.env.DARIO_LEDGER = '0';
  for (const k of ['DARIO_API_KEY', 'DARIO_KEYS', 'DARIO_KEYS_PATH', 'DARIO_EFFORT', 'DARIO_ADMIN', 'DARIO_ADMIN_TOKEN', 'ANTHROPIC_UPSTREAM_API_KEY', 'DARIO_MODEL_ALIASES']) delete process.env[k];
  await mkdir(join(home, '.dario', 'accounts'), { recursive: true });
  await writeFile(join(home, '.dario', 'accounts', 'main.json'), JSON.stringify({ alias: 'main', accessToken: 'claude-access-token', refreshToken: 'claude-refresh-token', expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1' }));
  await mkdir(join(home, '.dario', 'codex-accounts'), { recursive: true });
  await writeFile(join(home, '.dario', 'codex-accounts', 'live.json'), JSON.stringify({ alias: 'live', accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', expiresAt: Date.now() + 6 * 3_600_000 }));
  const keys = emptyKeysFile();
  const LOW = createKey(keys, 'lowlane', { effort: 'low' }).secret;
  const PLAIN = createKey(keys, 'plain').secret;
  writeKeysFile(join(home, '.dario', 'keys.json'), keys);

  const { startProxy } = await import('../dist/proxy.js');
  const boot = async (extra) => {
    const port = await freePort();
    await startProxy({ host: '127.0.0.1', port, verbose: false, noLiveCapture: true, fetchImpl: fakeFetch, overageGuardEnabled: false, keys: true, ...extra });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    return base;
  };
  const OPEN = await boot({});
  const PINNED = await boot({ effort: 'medium' });
  const CLIENT_PIN = await boot({ effort: 'client' });

  const messages = async (base, key, body) => {
    const headers = { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) };
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], ...body }) });
    return { status: r.status, text: await r.text() };
  };
  const responses = async (base, key, body) => {
    const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const r = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ stream: true, store: false, instructions: 'Be brief.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }], ...body }) });
    return { status: r.status, text: await r.text() };
  };
  const claudeEffort = () => claudeBodies.at(-1)?.output_config?.effort;
  const codexLast = () => codexBodies.at(-1);
  const show = (r, wire) => `${r.status} ${JSON.stringify(wire)} ${r.text.slice(0, 160)}`;

  // Claude path, Messages shape.
  let r = await messages(OPEN, null, { model: CLAUDE });
  const control = claudeEffort();
  check('control: a request with no key goes out at the proxy fallback', r.status === 200 && control === 'high', show(r, control));
  r = await messages(OPEN, LOW, { model: CLAUDE });
  check('Claude: the key default goes out as output_config.effort', r.status === 200 && claudeEffort() === 'low', show(r, claudeEffort()));
  r = await messages(OPEN, LOW, { model: CLAUDE, output_config: { effort: 'medium' } });
  check('Claude: the client field beats the key default', r.status === 200 && claudeEffort() === 'medium', show(r, claudeEffort()));
  r = await messages(OPEN, LOW, { model: `${CLAUDE}:medium` });
  check('Claude: the model-name suffix beats the key default', r.status === 200 && claudeEffort() === 'medium', show(r, claudeEffort()));
  r = await messages(OPEN, PLAIN, { model: CLAUDE });
  check('Claude: a key with no default changes nothing', r.status === 200 && claudeEffort() === control, show(r, claudeEffort()));
  r = await messages(PINNED, LOW, { model: CLAUDE });
  check('Claude: a level pin beats the key default', r.status === 200 && claudeEffort() === 'medium', show(r, claudeEffort()));
  r = await messages(CLIENT_PIN, LOW, { model: CLAUDE });
  check('Claude: under the client pin the key default still fills in', r.status === 200 && claudeEffort() === 'low', show(r, claudeEffort()));
  r = await messages(CLIENT_PIN, LOW, { model: CLAUDE, output_config: { effort: 'medium' } });
  check('Claude: under the client pin a client field still wins', r.status === 200 && claudeEffort() === 'medium', show(r, claudeEffort()));

  // Claude path, Responses shape (reasoning.effort is translated to a suffix).
  r = await responses(OPEN, LOW, { model: CLAUDE, reasoning: { summary: 'auto' } });
  check('Responses to Claude: the key default applies', r.status === 200 && claudeEffort() === 'low', show(r, claudeEffort()));
  r = await responses(OPEN, LOW, { model: CLAUDE, reasoning: { effort: 'high', summary: 'auto' } });
  check('Responses to Claude: the client reasoning.effort wins', r.status === 200 && claudeEffort() === 'high', show(r, claudeEffort()));

  // Codex, translated from the Messages shape.
  r = await messages(OPEN, null, { model: CODEX });
  check('Codex translated: no key, no level forced', r.status === 200 && codexLast()?.reasoning?.effort === undefined, show(r, codexLast()?.reasoning));
  r = await messages(OPEN, LOW, { model: CODEX });
  check('Codex translated: the key default goes out as reasoning.effort', r.status === 200 && codexLast()?.reasoning?.effort === 'low', show(r, codexLast()?.reasoning));
  const budget = { type: 'enabled', budget_tokens: 30_000 };
  r = await messages(OPEN, null, { model: CODEX, max_tokens: 40_000, thinking: budget });
  const budgetLevel = codexLast()?.reasoning?.effort;
  r = await messages(OPEN, LOW, { model: CODEX, max_tokens: 40_000, thinking: budget });
  check('Codex translated: a client thinking budget beats the key default', r.status === 200 && budgetLevel !== undefined && budgetLevel !== 'low' && codexLast()?.reasoning?.effort === budgetLevel, show(r, { budgetLevel, got: codexLast()?.reasoning }));
  r = await messages(OPEN, LOW, { model: `${CODEX}:medium` });
  check('Codex translated: the suffix beats the key default', r.status === 200 && codexLast()?.reasoning?.effort === 'medium', show(r, codexLast()?.reasoning));
  r = await messages(PINNED, null, { model: CODEX });
  check('Codex translated: the proxy pin does not reach the Codex backend', r.status === 200 && codexLast()?.reasoning?.effort === undefined, show(r, codexLast()?.reasoning));

  // Codex, the direct Responses passthrough (the route Codex CLI uses).
  r = await responses(OPEN, null, { model: CODEX, reasoning: { summary: 'auto' } });
  check('Responses passthrough: no key, the body goes as written', r.status === 200 && JSON.stringify(codexLast()?.reasoning) === '{"summary":"auto"}', show(r, codexLast()?.reasoning));
  r = await responses(OPEN, LOW, { model: CODEX, reasoning: { summary: 'auto' } });
  check('Responses passthrough: the key default is added, summary kept', r.status === 200 && codexLast()?.reasoning?.effort === 'low' && codexLast()?.reasoning?.summary === 'auto', show(r, codexLast()?.reasoning));
  r = await responses(OPEN, LOW, { model: CODEX, reasoning: { effort: 'high', summary: 'auto' } });
  check('Responses passthrough: the client reasoning.effort wins', r.status === 200 && codexLast()?.reasoning?.effort === 'high' && codexLast()?.reasoning?.summary === 'auto', show(r, codexLast()?.reasoning));
  r = await responses(OPEN, LOW, { model: CODEX });
  check('Responses passthrough: no reasoning field, one is added', r.status === 200 && codexLast()?.reasoning?.effort === 'low', show(r, codexLast()?.reasoning));
  r = await responses(OPEN, LOW, { model: `${CODEX}:medium` });
  check('Responses passthrough: the suffix beats the key default, bare slug on the wire', r.status === 200 && codexLast()?.reasoning?.effort === 'medium' && codexLast()?.model === CODEX, show(r, { model: codexLast()?.model, reasoning: codexLast()?.reasoning }));
  r = await responses(OPEN, null, { model: `${CODEX}:medium` });
  check('Responses passthrough: a suffix with no key now reaches the wire too', r.status === 200 && codexLast()?.reasoning?.effort === 'medium', show(r, codexLast()?.reasoning));

  codexStub.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

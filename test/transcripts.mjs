#!/usr/bin/env node
/**
 * Transcripts: a named key's requests and answers kept for a short while, first
 * as the store alone, then through a real proxy with a scripted upstream.
 *
 * The properties under test: only an armed key leaves a file, walking `next`
 * reads every record exactly once, records leave on time whether read or not,
 * and the route answers to its own token and to nothing else.
 */
import { mkdtemp, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

// Set before the modules load: TRANSCRIPT_DIR and the keys path read the home folder.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-transcripts-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  writeTranscript, readTranscripts, pruneTranscripts, parseTranscriptQuery,
  TRANSCRIPT_DIR, TRANSCRIPT_KEEP_MS, TRANSCRIPT_MAX_BYTES,
} = await import('../dist/transcripts.js');
const { setKeyTranscript, publicKey, createKey } = await import('../dist/keys.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; process.stdout.write(`  ok  ${name}
`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? `: ${detail}` : ''}
`); }
}

// Relative to now: a record past its time is not served, so a fixed date would rot this file.
const base = Date.now() - 60_000;
const nameAt = (ms, n = 0) => `${String(n).padStart(12, '0')}-${new Date(ms).toISOString().replace(/[:.]/g, '-')}.json`;
const rec = (n, over = {}) => ({
  ts: new Date(base + n).toISOString(), tag: n, consumer: 'lane', path: '/v1/messages', status: 200, ms: 5,
  request: { model: 'm', messages: [{ role: 'user', content: `hello ${n}` }] }, response: `answer ${n}`, ...over,
});

// ---- the store ----
{
  const dir = join(tmpHome, 'store');
  const empty = await readTranscripts(dir);
  check('no folder is an empty page', empty.records.length === 0 && empty.next === '' && empty.left === 0, JSON.stringify(empty));

  const names = [0, 1, 2].map((n) => writeTranscript(rec(n), dir));
  check('a write returns its name', names.every((n) => /\.json$/.test(n ?? '')), JSON.stringify(names));

  const same = [writeTranscript(rec(3), dir), writeTranscript(rec(3), dir)];
  check('two records in one millisecond get two names', same[0] !== same[1] && same.every(Boolean), JSON.stringify(same));

  const left = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
  check('no write leaves a working file', left.length === 0, JSON.stringify(left));

  if (process.platform !== 'win32') {
    const mode = (await stat(join(dir, names[0]))).mode & 0o777;
    check('a record is private to its user', mode === 0o600, mode.toString(8));
    const dirMode = (await stat(dir)).mode & 0o777;
    check('and so is the folder', dirMode === 0o700, dirMode.toString(8));
  }

  let page = await readTranscripts(dir);
  check('a page is oldest first', page.records.map((r) => r.tag).join() === '0,1,2,3,3', JSON.stringify(page.records.map((r) => r.tag)));
  check('each record carries its name', page.records[0].id === names[0], page.records[0].id);
  check('and keeps its text', page.records[0].response === 'answer 0' && page.records[0].request.messages[0].content === 'hello 0');

  const again = await readTranscripts(dir, page.next);
  check('past the end is an empty page that holds its place', again.records.length === 0 && again.next === page.next, JSON.stringify(again));

  // Walk with a page that fits one small record at a time.
  const seen = [];
  let after = '';
  for (let i = 0; i < 20; i++) {
    const p = await readTranscripts(dir, after, 1);
    if (p.records.length === 0) break;
    check(`a page always carries a record (${i})`, p.records.length === 1);
    seen.push(p.records[0].id);
    after = p.next;
  }
  check('walking next reads every record exactly once', seen.length === 5 && new Set(seen).size === 5, JSON.stringify(seen));

  const part = await readTranscripts(dir, '', 1);
  check('left counts what the page did not carry', part.left === 4, JSON.stringify(part.left));

  // A file that will not parse is passed over and counted, not a wall.
  const badName = nameAt(base + 500, 6);
  await writeFile(join(dir, badName), '{ not json');
  writeTranscript(rec(600), dir);
  page = await readTranscripts(dir, page.next);
  check('a broken file is counted', page.unreadable === 1, JSON.stringify(page.unreadable));
  check('and does not stop the record behind it', page.records.length === 1 && page.records[0].tag === 600, JSON.stringify(page.records.map((r) => r.tag)));

  // A half-written file never reaches a reader.
  await writeFile(join(dir, `${nameAt(base + 9000, 99)}.tmp`), '{"ts":');
  page = await readTranscripts(dir, page.next);
  check('a working file is not a record', page.records.length === 0 && page.unreadable === 0, JSON.stringify(page));

  // Too large keeps the facts and loses the text.
  const bigName = writeTranscript(rec(700, { response: 'x'.repeat(TRANSCRIPT_MAX_BYTES + 1) }), dir);
  const big = JSON.parse(await readFile(join(dir, bigName), 'utf-8'));
  check('a record too large keeps its facts', big.tag === 700 && big.consumer === 'lane' && big.status === 200, JSON.stringify(big).slice(0, 200));
  check('and loses its text', big.request === null && big.response === null && big.dropped === 'too large');

  // A write that cannot happen is an answer, not a throw.
  const blocked = join(tmpHome, 'a-file');
  await writeFile(blocked, 'x');
  check('a failed write returns null', writeTranscript(rec(1), join(blocked, 'sub')) === null);
}

// ---- pruning ----
{
  const dir = join(tmpHome, 'prune');
  await mkdir(dir, { recursive: true });
  const now = base + TRANSCRIPT_KEEP_MS + 1000;
  const old = writeTranscript(rec(1), dir);
  const fresh = writeTranscript(rec(2, { ts: new Date(now - 1000).toISOString() }), dir);
  await writeFile(join(dir, `${nameAt(base, 9)}.tmp`), 'x');
  await writeFile(join(dir, 'notes.txt'), 'not ours');
  await writeFile(join(dir, '1999-not-a-record.json'), 'not ours');
  const late = await readTranscripts(dir, '', undefined, now);
  check('a record past its time is not served, removed or not', late.records.length === 1 && late.records[0].id === fresh && late.left === 0, JSON.stringify(late.records.map((r) => r.id)));
  const onTime = await readTranscripts(dir, '', undefined, base + TRANSCRIPT_KEEP_MS);
  check('a record at its time still is', onTime.records.some((r) => r.id === old), JSON.stringify(onTime.records.map((r) => r.id)));
  const removed = pruneTranscripts(dir, now);
  const names = await readdir(dir);
  check('a record past its time goes', !names.includes(old), JSON.stringify(names));
  check('so does a write that never finished', !names.some((n) => n.endsWith('.tmp')), JSON.stringify(names));
  check('a record inside its time stays', names.includes(fresh), JSON.stringify(names));
  check('a file that is not ours stays', names.includes('notes.txt') && names.includes('1999-not-a-record.json'), JSON.stringify(names));
  check('and so does the counter', names.includes('.counter'), JSON.stringify(names));
  check('it reports what it removed', removed === 2, String(removed));
  check('no folder removes nothing', pruneTranscripts(join(tmpHome, 'nowhere')) === 0);

  // A reader whose place has been pruned away still finds what came after it.
  const page = await readTranscripts(dir, old, undefined, now);
  check('a place that was pruned still holds', page.records.length === 1 && page.records[0].id === fresh, JSON.stringify(page.records.map((r) => r.id)));
}

// ---- the place, when the clock or the folder moves ----
{
  const dir = join(tmpHome, 'clock');
  const ahead = writeTranscript(rec(1, { ts: new Date(base + 3_600_000).toISOString() }), dir);
  let page = await readTranscripts(dir);
  check('a reader takes the record', page.next === ahead && page.records.length === 1, JSON.stringify(page.records.map((r) => r.id)));

  const behind = writeTranscript(rec(2, { ts: new Date(base).toISOString() }), dir);
  page = await readTranscripts(dir, page.next);
  check('a record written after the clock went back is still ahead of the reader', page.records.length === 1 && page.records[0].id === behind, JSON.stringify([ahead, behind]));

  // A new process has only the folder to go on.
  const fresh = await import('../dist/transcripts.js?restart');
  const after = fresh.writeTranscript(rec(3, { ts: new Date(base - 3_600_000).toISOString() }), dir);
  page = await readTranscripts(dir, page.next);
  check('and after a restart too', page.records.length === 1 && page.records[0].id === after, JSON.stringify(after));

  // Every record pruned: the counter still knows how far it got.
  pruneTranscripts(dir, base + 3_600_000 + TRANSCRIPT_KEEP_MS + 1000);
  check('pruning empties the folder of records', (await readdir(dir)).filter((n) => n.endsWith('.json')).length === 0);
  const held = page.next;
  const later = writeTranscript(rec(4, { ts: new Date(base - 7_200_000).toISOString() }), dir);
  page = await readTranscripts(dir, held);
  check('the count goes on from where it was', page.records.length === 1 && page.records[0].id === later, JSON.stringify(later));

  // The counter's file lost: the names on disk still say how far it got.
  await unlink(join(dir, '.counter'));
  const named = writeTranscript(rec(5), dir);
  check('a lost counter picks up from the names', named > later, JSON.stringify([later, named]));

  // The whole folder replaced: a place past anything given out goes back to the start.
  const replaced = join(tmpHome, 'replaced');
  const first = writeTranscript(rec(1), replaced);
  page = await readTranscripts(replaced, nameAt(base, 9000));
  check('a place from a folder that is gone starts over', page.records.length === 1 && page.records[0].id === first && page.next === first, JSON.stringify(page.next));
}

// ---- the query ----
{
  const good = '000000000001-2026-11-07T10-00-00-000Z.json';
  check('a record name is a place', parseTranscriptQuery(`/analytics/transcripts?after=${good}`).after === good);
  check('no place is the start', parseTranscriptQuery('/analytics/transcripts').after === '');
  check('a path is not a place', parseTranscriptQuery('/analytics/transcripts?after=../../credentials.json').after === '');
  check('a working file is not a place', parseTranscriptQuery(`/analytics/transcripts?after=${good}.tmp`).after === '');
}

// ---- the key ----
{
  const file = { version: 1, keys: [] };
  file.keys.push(createKey(file, 'lane').record);
  check('a key starts with nothing kept', publicKey(file.keys[0]).transcript === false, JSON.stringify(publicKey(file.keys[0])));
  check('arming names a key', setKeyTranscript(file, 'lane', true)?.transcript === true);
  check('list shows it armed', publicKey(file.keys[0]).transcript === true);
  check('no such key is null', setKeyTranscript(file, 'nobody', true) === null);
  setKeyTranscript(file, 'lane', false);
  check('off removes it', !('transcript' in file.keys[0]));
}

// ---- through a real proxy ----
const ROOT_KEY = 'root-secret-for-the-test';
const ANALYTICS_TOKEN = 'read-only-analytics-token';
const TRANSCRIPT_TOKEN = 'transcript-token-for-the-test';
const PROMPT = 'the words a key chose to keep';
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_ANALYTICS_TOKEN = ANALYTICS_TOKEN;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_LOG_FILE;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_TRANSCRIPT_TOKEN;
process.env.DARIO_LEDGER = '0';
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const sent = typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body ?? new Uint8Array());
  if (sent.includes('split a character')) {
    const event = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    const bytes = new TextEncoder().encode([
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it costs 5\u20ac today' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ].map(event).join(''));
    const cut = bytes.indexOf(0xe2) + 1; // inside the euro sign
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, cut)); c.enqueue(bytes.subarray(cut)); c.close(); } }), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-7d-utilization': '0.05',
      },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
    },
  });
};

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
for (const m of ['log', 'error', 'warn']) console[m] = () => {};

const { KeyStore } = await import('../dist/keys.js');
const keysPath = join(tmpHome, 'keys.json');
const store = new KeyStore(keysPath);
const armed = store.mutate((file) => { const made = createKey(file, 'kept'); setKeyTranscript(file, 'kept', true); return made; });
const plain = store.mutate((file) => createKey(file, 'not-kept'));

const { startProxy } = await import('../dist/proxy.js');
const proxyOpts = { host: '127.0.0.1', verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false };
const start = async (extra) => {
  const port = await freePort();
  await startProxy({ ...proxyOpts, ...extra, port });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/health`); break; } catch { await sleep(100); } }
  return base;
};
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const ask = (base, key, text) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: text }] }),
});
const files = async () => { try { return (await readdir(TRANSCRIPT_DIR)).filter((n) => n.endsWith('.json')); } catch { return []; } };

out('\n=== through the proxy, token set ===');
{
  const base = await start({ keys: true, keysPath, transcriptToken: TRANSCRIPT_TOKEN });

  let r = await ask(base, plain.secret, 'a key that was never armed');
  check('a plain key is served', r.status === 200, r.status);
  await r.text();
  r = await ask(base, ROOT_KEY, 'the root key is never armed');
  check('the root key is served', r.status === 200, r.status);
  await r.text();
  await sleep(100);
  check('and neither leaves a file', (await files()).length === 0, JSON.stringify(await files()));

  r = await ask(base, armed.secret, PROMPT);
  check('an armed key is served', r.status === 200, r.status);
  const body = await r.json();
  check('and its answer is untouched', body.content?.[0]?.text === 'PONG', JSON.stringify(body));

  let page = null;
  for (let i = 0; i < 50 && !page?.records?.length; i++) {
    page = await (await fetch(`${base}/analytics/transcripts`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    if (!page.records.length) await sleep(50);
  }
  const one = page.records?.[0];
  check('the record is there', page.records?.length === 1, JSON.stringify(page).slice(0, 300));
  check('with who it was for', one?.consumer === 'kept' && one?.path === '/v1/messages' && one?.status === 200, JSON.stringify(one).slice(0, 300));
  check('with what was asked', JSON.stringify(one?.request).includes(PROMPT), JSON.stringify(one?.request).slice(0, 300));
  check('and what came back', String(one?.response).includes('PONG'), String(one?.response).slice(0, 300));

  r = await fetch(`${base}/analytics/transcripts?after=${page.next}`, { headers: bearer(TRANSCRIPT_TOKEN) });
  const next = await r.json();
  check('from next there is nothing new', next.records.length === 0 && next.next === page.next, JSON.stringify(next));

  // Kept as the client sent it: routing rewrites the body after this point.
  const responses = { model: 'claude-sonnet-5', input: 'a Responses request', previous_response_id: 'resp_earlier', max_output_tokens: 10 };
  r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': armed.secret },
    body: JSON.stringify(responses),
  });
  await r.text();
  let kept = null;
  for (let i = 0; i < 50 && !kept; i++) {
    const p = await (await fetch(`${base}/analytics/transcripts?after=${page.next}`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    kept = p.records[0];
    if (!kept) await sleep(50);
  }
  check('a Responses request is kept as it was sent', JSON.stringify(kept?.request) === JSON.stringify(responses), JSON.stringify(kept?.request));
  check('on its own path', kept?.path === '/v1/responses', kept?.path);

  // A tee set through the Responses wrapper called itself until the process died.
  const stateless = { model: 'claude-sonnet-5', input: 'no state this time', max_output_tokens: 10 };
  r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': plain.secret, 'x-dario-compare': 'no-such-model' },
    body: JSON.stringify(stateless),
  });
  check('a comparison on the Responses route answers', r.status === 200 && (await r.text()).includes('PONG'), r.status);

  r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': armed.secret },
    body: JSON.stringify(stateless),
  });
  const delivered = await r.text();
  let served = null;
  for (let i = 0; i < 50 && !served; i++) {
    const p = await (await fetch(`${base}/analytics/transcripts?after=${kept?.id ?? ''}`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    served = p.records[0];
    if (!served) await sleep(50);
  }
  check('an armed key is served on the Responses route', r.status === 200 && delivered.includes('PONG'), r.status);
  check('and its record holds what the client got', served?.response === delivered, String(served?.response).slice(0, 300));
  kept = served;

  r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': armed.secret },
    body: JSON.stringify({ model: 'sonnet', max_tokens: 10, messages: [{ role: 'user', content: 'an alias' }] }),
  });
  await r.text();
  let aliased = null;
  for (let i = 0; i < 50 && !aliased; i++) {
    const p = await (await fetch(`${base}/analytics/transcripts?after=${kept?.id ?? ''}`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    aliased = p.records[0];
    if (!aliased) await sleep(50);
  }
  check('a model alias is kept as the client wrote it', aliased?.request?.model === 'sonnet', JSON.stringify(aliased?.request));

  // A chunk that ends inside a character. This path decodes and writes text, so it holds with or
  // without the byte handling in the tee: the OpenAI backend below is the one that needs it.
  r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': armed.secret },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'split a character' }] }),
  });
  const streamed = await r.text();
  let split = null;
  for (let i = 0; i < 50 && !split; i++) {
    const p = await (await fetch(`${base}/analytics/transcripts?after=${aliased?.id ?? ''}`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    split = p.records[0];
    if (!split) await sleep(50);
  }
  check('a stream cut inside a character reaches the client whole', streamed.includes('5\u20ac'), streamed.slice(0, 300));
  check('and its record is what the client got', split?.response === streamed, String(split?.response).slice(0, 300));
  check('with no broken character in it', !String(split?.response).includes('\ufffd'));

  for (const [name, headers] of [
    ['no credential', {}],
    ['a wrong token', bearer('wrong')],
    ['the root key', { 'x-api-key': ROOT_KEY }],
    ['the analytics token', bearer(ANALYTICS_TOKEN)],
    ['an armed key', { 'x-api-key': armed.secret }],
  ]) {
    r = await fetch(`${base}/analytics/transcripts`, { headers });
    const text = await r.text();
    check(`${name} is 401`, r.status === 401, r.status);
    check(`and reads nothing`, !text.includes(PROMPT), text.slice(0, 200));
  }
  r = await fetch(`${base}/analytics/transcripts`, { method: 'POST', headers: bearer(TRANSCRIPT_TOKEN), body: '{}' });
  check('and only by GET', r.status === 401, r.status);
  r = await fetch(`${base}/analytics/transcripts/`, { headers: { 'x-api-key': ROOT_KEY } });
  check('a trailing slash is no way round', !(await r.text()).includes(PROMPT));
  r = await fetch(`${base}/analytics/requests`, { headers: { 'x-api-key': ROOT_KEY } });
  check('the request log route is unchanged', r.status === 404, r.status);
}

out('\n=== through the proxy, no token ===');
{
  const base = await start({ keys: true, keysPath });
  const r = await fetch(`${base}/analytics/transcripts`, { headers: { 'x-api-key': ROOT_KEY } });
  check('the route says it is off', r.status === 404, r.status);
  const body = await r.json();
  check('and how to turn it on', String(body.hint).includes('--transcript-token'), JSON.stringify(body));
  check('and shows no record', !JSON.stringify(body).includes(PROMPT));
}

out('\n=== through the OpenAI backend, which writes upstream bytes as they come ===');
{
  const upstream = createHttpServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"it costs 5\u20ac today"}}]}\n\ndata: [DONE]\n\n');
      const cut = bytes.indexOf(0xe2) + 1; // inside the euro sign
      res.write(bytes.subarray(0, cut));
      await sleep(100);
      res.end(bytes.subarray(cut));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { saveBackend } = await import('../dist/openai-backend.js');
  await saveBackend({ provider: 'openai', name: 'local', apiKey: 'backend-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });

  const base = await start({ keys: true, keysPath, transcriptToken: TRANSCRIPT_TOKEN });
  let place = '';
  for (let i = 0; i < 50; i++) {
    const p = await (await fetch(`${base}/analytics/transcripts?after=${place}`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    place = p.next;
    if (!p.left) break;
  }
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': armed.secret },
    body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'a chunk ends inside a character' }] }),
  });
  const delivered = await r.text();
  let record = null;
  for (let i = 0; i < 50 && !record; i++) {
    const p = await (await fetch(`${base}/analytics/transcripts?after=${place}`, { headers: bearer(TRANSCRIPT_TOKEN) })).json();
    record = p.records[0];
    if (!record) await sleep(50);
  }
  check('the backend served it', r.status === 200 && delivered.includes('5\u20ac'), delivered.slice(0, 300));
  check('and the record is byte for byte what the client got', record?.response === delivered, String(record?.response).slice(0, 300));
  check('with no broken character', !String(record?.response).includes('\ufffd'));
  upstream.close();
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

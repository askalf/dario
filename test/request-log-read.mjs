#!/usr/bin/env node
/**
 * GET /analytics/requests: the request log read back by byte offset, first as
 * the reader alone, then through a real proxy with a scripted upstream.
 *
 * The properties under test: a page is whole lines, walking `next` reads every
 * record exactly once, and the route sits behind the read-only gate and holds
 * no request body.
 */
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-request-log-'));
const {
  parseRequestLogQuery, readRequestLog,
  REQUEST_LOG_PAGE_BYTES, REQUEST_LOG_MIN_PAGE_BYTES, REQUEST_LOG_MAX_PAGE_BYTES,
} = await import('../dist/request-log.js');

console.log('\n=== the reader ===');
{
  const file = join(tmpHome, 'requests.jsonl');
  const line = (req) => JSON.stringify({ ts: '2026-11-07T00:00:00.000Z', req, path: '/v1/messages' }) + '\n';

  let page = await readRequestLog(join(tmpHome, 'not-there.jsonl'));
  check('a log with nothing in it yet is an empty page', page.size === 0 && page.next === 0 && page.records.length === 0, JSON.stringify(page));

  await writeFile(file, line(1) + line(2));
  page = await readRequestLog(file);
  check('reads every whole line', page.records.length === 2 && page.records[1].req === 2, JSON.stringify(page));
  check('next is the end of what it read', page.next === page.size, JSON.stringify(page));

  const whole = page.next;
  await appendFile(file, line(3).slice(0, 10));
  page = await readRequestLog(file, whole);
  check('a line still on its way to disk waits', page.records.length === 0 && page.next === whole, JSON.stringify(page));
  check('and size shows it is there', page.size > whole, JSON.stringify(page));

  await appendFile(file, line(3).slice(10));
  page = await readRequestLog(file, whole);
  check('and arrives once it is whole', page.records.length === 1 && page.records[0].req === 3, JSON.stringify(page));

  const again = await readRequestLog(file, page.next);
  check('nothing new is an empty page at the same offset', again.records.length === 0 && again.next === page.next, JSON.stringify(again));

  page = await readRequestLog(file, page.size + 100);
  check('an offset past the end sends the reader back to the start', page.next === 0 && page.records.length === 0, JSON.stringify(page));

  const bad = join(tmpHome, 'bad.jsonl');
  await writeFile(bad, line(1) + 'not json\n' + line(2));
  page = await readRequestLog(bad);
  check('a line that does not parse is passed over and counted', page.records.length === 2 && page.unreadable === 1 && page.next === page.size, JSON.stringify(page));

  const paged = join(tmpHome, 'paged.jsonl');
  await writeFile(paged, Array.from({ length: 500 }, (_, i) => line(i + 1)).join(''));
  const seen = [];
  let after = 0;
  let reads = 0;
  for (;;) {
    const p = await readRequestLog(paged, after, 2000);
    if (p.next === after) break;
    seen.push(...p.records.map((r) => r.req));
    after = p.next;
    reads++;
  }
  check('walking next reads every record once, in order', seen.length === 500 && seen.every((r, i) => r === i + 1), `${seen.length} in ${reads}`);
  check('over more than one page', reads > 1, reads);

  check('after and limit are read from the URL', JSON.stringify(parseRequestLogQuery(`/analytics/requests?after=42&limit=${REQUEST_LOG_MIN_PAGE_BYTES}`)) === JSON.stringify({ after: 42, limit: REQUEST_LOG_MIN_PAGE_BYTES }));
  check('no query is the start and a default page', JSON.stringify(parseRequestLogQuery('/analytics/requests')) === JSON.stringify({ after: 0, limit: REQUEST_LOG_PAGE_BYTES }));
  check('junk is the same', JSON.stringify(parseRequestLogQuery('/analytics/requests?after=-5&limit=nope')) === JSON.stringify({ after: 0, limit: REQUEST_LOG_PAGE_BYTES }));
  check('a page has a floor and a ceiling', parseRequestLogQuery('/x?limit=1').limit === REQUEST_LOG_MIN_PAGE_BYTES && parseRequestLogQuery('/x?limit=999999999999').limit === REQUEST_LOG_MAX_PAGE_BYTES);
}

const ROOT_KEY = 'root-secret-for-the-test';
const ANALYTICS_TOKEN = 'read-only-analytics-token';
const SECRET_PROMPT = 'the words of the prompt stay out of the log';
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_ANALYTICS_TOKEN = ANALYTICS_TOKEN;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_LOG_FILE;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
process.env.DARIO_LEDGER = '0';
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
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

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
for (const m of ['log', 'error', 'warn']) console[m] = () => {};
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
const report = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};

out('\n=== through the proxy, log on ===');
{
  const logFile = join(tmpHome, 'proxy-requests.jsonl');
  const base = await start({ logFile });

  const sent = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ROOT_KEY, 'x-dario-consumer': 'lane-one' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: SECRET_PROMPT }] }),
  });
  report('the request was served', sent.status === 200, sent.status);
  await sent.text();

  let page = null;
  let call = null;
  for (let i = 0; i < 50 && !call; i++) {
    const r = await fetch(`${base}/analytics/requests`, { headers: { 'x-api-key': ROOT_KEY } });
    page = await r.json();
    call = page.records?.find((x) => x.path === '/v1/messages');
    if (!call) await sleep(50);
  }
  report('the request is in the log', !!call, JSON.stringify(page));
  report('with who it was for and what it used', call?.consumer === 'lane-one' && call?.status === 200 && call?.in_tokens === 1200 && call?.out_tokens === 30, JSON.stringify(call));
  report('and no word of its body', !JSON.stringify(page).includes(SECRET_PROMPT), JSON.stringify(page));

  let r = await fetch(`${base}/analytics/requests?after=${page.next}`, { headers: { 'x-api-key': ROOT_KEY } });
  const next = await r.json();
  report('from next there is nothing new', next.records.length === 0 && next.next === page.next, JSON.stringify(next));

  r = await fetch(`${base}/analytics/requests`);
  report('no credential is 401', r.status === 401, r.status);
  r = await fetch(`${base}/analytics/requests`, { headers: bearer('wrong') });
  report('a wrong token is 401', r.status === 401, r.status);
  r = await fetch(`${base}/analytics/requests`, { headers: bearer(ANALYTICS_TOKEN) });
  report('the read-only token reads it', r.status === 200, r.status);
  r = await fetch(`${base}/analytics/requests`, { method: 'POST', headers: bearer(ANALYTICS_TOKEN), body: '{}' });
  report('and only by GET', r.status === 401, r.status);
}

out('\n=== through the proxy, log off ===');
{
  const base = await start({});
  const r = await fetch(`${base}/analytics/requests`, { headers: { 'x-api-key': ROOT_KEY } });
  report('the route says the log is off', r.status === 404, r.status);
  const body = await r.json();
  report('and how to turn it on', String(body.hint).includes('--log-file'), JSON.stringify(body));
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
const EVERY_SEAT = 'gpt-target';
const BRAVO_AND_CHARLIE = 'gpt-bc';
const CATALOGS = {
  alpha: [EVERY_SEAT],
  bravo: [EVERY_SEAT, BRAVO_AND_CHARLIE],
  charlie: [EVERY_SEAT, BRAVO_AND_CHARLIE],
};

const state = { rateLimit: new Set(), seen: [], catalogReads: [], responses: 0 };
const bearerAlias = (req) => {
  const m = /codex-at-([a-z]+)/i.exec(req.headers['authorization'] || '');
  return m ? m[1] : null;
};

const codexStub = createServer((req, res) => {
  const alias = bearerAlias(req);
  if (req.url.startsWith('/models')) {
    state.catalogReads.push(alias);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: (CATALOGS[alias] ?? []).map((slug) => ({ slug, visibility: 'list' })) }));
    return;
  }
  if (req.url.startsWith('/responses')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      state.seen.push({ alias, previous: body.previous_response_id ?? null });
      if (state.rateLimit.has(alias)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '120' });
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
        return;
      }
      const id = `resp_${alias}_${++state.responses}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: {"type":"response.created","response":{"id":"${id}"}}\n\n`);
      res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
      res.write(`data: {"type":"response.completed","response":{"id":"${id}","usage":{"input_tokens":1,"output_tokens":1}}}\n\n`);
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => codexStub.listen(CODEX_PORT, '127.0.0.1', r));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-least-busy-proxy-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${CODEX_PORT}`;
delete process.env.DARIO_CODEX_ACCOUNT;
delete process.env.DARIO_CODEX_MAX_INFLIGHT_PER_SEAT;

const SIX_HOURS = Date.now() + 6 * 3_600_000;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'main.json'), JSON.stringify({
  alias: 'main', accessToken: 'claude-at', refreshToken: 'claude-rt',
  expiresAt: SIX_HOURS, scopes: ['user:inference'], deviceId: 'dev-1', accountUuid: 'uuid-1',
}));
await mkdir(join(tmpHome, '.dario', 'codex-accounts'), { recursive: true });
const seat = (alias) => ({ alias, accessToken: `codex-at-${alias}`, refreshToken: `codex-rt-${alias}`, expiresAt: SIX_HOURS });
for (const alias of Object.keys(CATALOGS)) {
  await writeFile(join(tmpHome, '.dario', 'codex-accounts', `${alias}.json`), JSON.stringify(seat(alias)));
}

const { startProxy } = await import('../dist/proxy.js');
const accounts = await import('../dist/codex-accounts.js');
const backend = await import('../dist/codex-backend.js');
const usage = await import('../dist/codex-usage.js');

const anthropicFetch = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: { message: 'claude should not be reached' } }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });
};

await startProxy({
  port: PROXY_PORT, host: '127.0.0.1', verbose: false,
  passthrough: false, noLiveCapture: true, fetchImpl: anthropicFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch { await sleep(100); }
}

const busy = (alias, n) => { for (let i = 0; i < n; i++) accounts.codexInFlightStart(alias); };
const idle = (alias, n) => { for (let i = 0; i < n; i++) accounts.codexInFlightEnd(alias); };
const headroom = (alias, usedPercent) => usage.recordCodexUsage(alias, {
  primary: { usedPercent, windowMinutes: 7 * 24 * 60, resetAt: Date.now() + 5 * 864e5 },
  secondary: null, limitReached: null, observedAt: Date.now(), source: 'headers',
});
const servedBy = () => state.seen.at(-1)?.alias ?? null;

const askResponses = async (model, { text = `probe ${Math.random()}`, previous } = {}) => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: true,
      ...(previous ? { previous_response_id: previous } : {}),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    }),
  });
  const sse = await r.text().catch(() => '');
  const id = /"id":"(resp_[a-z]+_\d+)"/.exec(sse)?.[1] ?? null;
  return { status: r.status, id };
};

const askMessages = async (model, messages) => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16, messages }),
  });
  await r.text().catch(() => '');
  return r.status;
};

header('an unprobed seat that turns out not to list the model gives way before routing');
{
  await backend.getCodexModelSlugs(seat('bravo'));
  busy('bravo', 2);
  busy('charlie', 2);
  state.seen.length = 0;
  const { status } = await askResponses(BRAVO_AND_CHARLIE);
  check('the request is served', status === 200, status);
  check('alpha, idle but without the model, was read and passed over', state.catalogReads.includes('alpha'), state.catalogReads.join(','));
  check('a seat that lists the model served it', ['bravo', 'charlie'].includes(servedBy()), servedBy());
  check('alpha never received the request', !state.seen.some((s) => s.alias === 'alpha'));
  idle('bravo', 2);
  idle('charlie', 2);
}

header('the one seat that lists the model serves it from below the floor');
{
  accounts._resetCodexPoolForTest();
  await backend.getCodexModelSlugs(seat('charlie'));
  headroom('bravo', 100);
  accounts.noteCodexDecline('charlie', 60_000);
  state.seen.length = 0;
  const { status } = await askResponses(BRAVO_AND_CHARLIE);
  check('the request is served', status === 200, status);
  check('by bravo, under the floor, not alpha above it', servedBy() === 'bravo', servedBy());
  headroom('bravo', 0);
  accounts._resetCodexPoolForTest();
}

header('a decline on the overflow seat does not move the conversation');
{
  const first = { role: 'user', content: `conversation ${Math.random()}` };
  state.seen.length = 0;
  await askMessages(EVERY_SEAT, [first]);
  const home = servedBy();
  check('turn one binds a seat', home !== null, home);
  busy(home, 4);
  const overflowTo = ['alpha', 'bravo', 'charlie'].find((a) => a !== home);
  state.rateLimit.add(overflowTo);
  for (const a of ['alpha', 'bravo', 'charlie']) if (a !== home && a !== overflowTo) busy(a, 1);
  state.seen.length = 0;
  const turnTwo = await askMessages(EVERY_SEAT, [first, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'turn two' }]);
  check('turn two is served', turnTwo === 200, turnTwo);
  check('turn two overflowed, was declined, and retried elsewhere',
    state.seen.length === 2 && state.seen[0].alias === overflowTo && state.seen[1].alias !== home,
    state.seen.map((s) => s.alias).join(','));
  idle(home, 4);
  for (const a of ['alpha', 'bravo', 'charlie']) if (a !== home && a !== overflowTo) idle(a, 1);
  state.rateLimit.clear();
  state.seen.length = 0;
  await askMessages(EVERY_SEAT, [first, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'turn two' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'turn three' }]);
  check('turn three is back on the seat it was bound to', servedBy() === home, `${servedBy()} vs ${home}`);
  accounts._resetCodexPoolForTest();
}

header('a Responses follow-up goes to the account that issued the response it names');
{
  state.seen.length = 0;
  const opened = await askResponses(EVERY_SEAT, { text: 'open a stored thread' });
  const issuer = servedBy();
  check('the opening turn is served', opened.status === 200 && opened.id !== null, `${opened.status} ${opened.id}`);
  busy(issuer, 3);
  state.seen.length = 0;
  const followUp = await askResponses(EVERY_SEAT, { text: 'and then?', previous: opened.id });
  check('the follow-up is served', followUp.status === 200, followUp.status);
  check('by the issuing account although it is the busiest', servedBy() === issuer, `${servedBy()} vs ${issuer}`);
  state.rateLimit.add(issuer);
  state.seen.length = 0;
  const limited = await askResponses(EVERY_SEAT, { text: 'and now?', previous: opened.id });
  check('a decline from the issuer reaches the client', limited.status === 429, limited.status);
  check('and no other account was asked', state.seen.length === 1 && state.seen[0].alias === issuer,
    state.seen.map((s) => s.alias).join(','));
  idle(issuer, 3);
  state.rateLimit.clear();
  accounts._resetCodexPoolForTest();
}

header('/v1/models lists the same seat\'s catalog however busy it is');
{
  await backend.getCodexModelSlugs(seat('alpha'));
  const listed = async () => {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`);
    const body = await r.json();
    return (body.data ?? []).map((m) => m.id);
  };
  const quiet = await listed();
  busy('alpha', 3);
  const loaded = await listed();
  idle('alpha', 3);
  check('the catalog does not change with load', JSON.stringify(quiet) === JSON.stringify(loaded),
    `${quiet.filter((m) => m.startsWith('gpt'))} vs ${loaded.filter((m) => m.startsWith('gpt'))}`);
}

header('no seat is left held or in flight once the requests are done');
{
  await sleep(50);
  check('every pick was released or forwarded',
    ['alpha', 'bravo', 'charlie'].every((a) => accounts.codexInFlightFor(a) === 0),
    ['alpha', 'bravo', 'charlie'].map((a) => `${a}=${accounts.codexInFlightFor(a)}`).join(' '));
}

codexStub.close();
await rm(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

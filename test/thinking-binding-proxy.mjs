#!/usr/bin/env node
/**
 * test/thinking-binding-proxy.mjs
 *
 * A conversation that leaves its seat, end to end through a real proxy on a
 * fake upstream. Three seats under fill-first: a-home and c-peer share an
 * organization, b-other sorts between them and is in another one.
 *
 *   - a genuine Claude Code conversation that forwards thinking moves to the
 *     seat of its own organization, though another seat is next in fill order
 *   - a client whose thinking is stripped keeps the ordinary fill order, and
 *     no thinking block of either kind goes upstream for it
 *   - with no usable seat left in the organization the conversation crosses
 *     to the other one, and the proxy says so once
 *   - what the upstream reports in `input_transformations` lands in the
 *     request log, buffered and streamed, and on the console once
 *   - under passthrough, where no sticky key exists, two conversations on
 *     one seat are each reported once
 *
 * HOME is a temp dir and the upstream is a stub: no credentials are read and
 * nothing leaves the process.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = await mkdtemp(join(tmpdir(), 'dario-thinking-binding-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_POOL_FALLBACK;
delete process.env.DARIO_POOL_STRATEGY;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_PORT;

const ORG_A = '11111111-0000-4000-8000-00000000000a';
const ORG_B = '22222222-0000-4000-8000-00000000000b';
const SEATS = {
  'a-home': { token: 'a-home-token', org: ORG_A },
  'b-other': { token: 'b-other-token', org: ORG_B },
  'c-peer': { token: 'c-peer-token', org: ORG_A },
};
const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
for (const [alias, s] of Object.entries(SEATS)) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias, accessToken: s.token, refreshToken: `${s.token}-refresh`,
    expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
    deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
    accountId: `acct-${alias}`, organizationId: s.org,
  }));
}
const aliasOf = (token) => Object.entries(SEATS).find(([, s]) => s.token === token)?.[0];

// What each seat reports as its five-hour utilization. The pool learns a
// reading from the response that carries it, so a seat set to 0.99 here is
// drained for routing only after it has served one more request.
const util5h = { 'a-home': 0.10, 'b-other': 0.10, 'c-peer': 0.10 };
// Seats on which the stub upstream leaves thinking out.
let dropOn = new Set(['b-other']);
const RESET = Math.floor(Date.now() / 1000) + 4 * 3600;

const thinkingBlocksIn = (body) => (body.messages ?? [])
  .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
  .flatMap((m) => m.content)
  .filter((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');

const calls = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const auth = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]);
  const alias = aliasOf(auth.replace(/^Bearer\s+/i, ''));
  const raw = init?.body;
  const body = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  calls.push({ alias, body });

  // The stub upstream binds thinking to ORG_A: sent through the other
  // organization it leaves each block out and lists it. `dropOn` widens that
  // to other seats for the passthrough section.
  const sent = thinkingBlocksIn(body);
  const transformations = dropOn.has(alias)
    ? sent.map((_, i) => ({ type: 'thinking_dropped', path: `messages.1.content.${i}`, reason: 'organization_binding_mismatch' }))
    : [];
  const headers = {
    'anthropic-organization-id': SEATS[alias].org,
    'request-id': `req_${calls.length}`,
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': String(util5h[alias]),
    'anthropic-ratelimit-unified-7d-utilization': '0.10',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(RESET),
  };
  const message = {
    id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
    input_transformations: transformations,
  };
  if (body.stream) {
    const events = [
      ['message_start', { message }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PONG' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
      ['message_stop', {}],
    ];
    const sse = events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
  }
  return new Response(JSON.stringify({ ...message, content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn' }), {
    status: 200, headers: { 'content-type': 'application/json', ...headers },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const moveLines = () => log.filter((l) => l.includes('which is in another organization'));
const dropLines = () => log.filter((l) => l.includes('out of this request'));

const logFile = join(home, 'proxy.log');
const { startProxy } = await import('../dist/proxy.js');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
await startProxy({
  host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true,
  poolStrategy: 'fill-first', overageGuardEnabled: false, pacingMinMs: 0, pacingJitterMs: 0,
  fetchImpl, logFile,
});
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const THINKING_TURN = [
  { type: 'thinking', thinking: '', signature: 'signed-by-the-first-seat' },
  { type: 'redacted_thinking', data: 'opaque' },
  { type: 'text', text: 'first answer' },
];
// A conversation is its first user message; a later turn adds the assistant
// turn, with or without thinking, and a follow-up.
const turns = (first, later) => [
  { role: 'user', content: [{ type: 'text', text: first }] },
  ...(later ? [{ role: 'assistant', content: THINKING_TURN }, { role: 'user', content: [{ type: 'text', text: 'go on' }] }] : []),
];
const claudeCodeBody = (first, later, extra = {}) => ({
  model: 'claude-sonnet-5', max_tokens: 64,
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.202.abc; cc_entrypoint=cli;' },
    { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
    { type: 'text', text: 'Client system prompt.' },
  ],
  tools: [],
  messages: turns(first, later),
  ...extra,
});
const plainBody = (first, later) => ({ model: 'claude-sonnet-5', max_tokens: 64, messages: turns(first, later) });
const send = async (body, base = BASE) => {
  const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, upstream: calls[calls.length - 1] };
};

header('three conversations start on the first seat in fill order');
{
  const x = await send(claudeCodeBody('conversation X'));
  const y = await send(plainBody('conversation Y'));
  const w = await send(claudeCodeBody('conversation W'));
  check('all three answered', x.status === 200 && y.status === 200 && w.status === 200, `${x.status} ${y.status} ${w.status} ${x.text.slice(0, 200)}`);
  check('all three on a-home', calls.length === 3 && calls.every((c) => c.alias === 'a-home'), calls.map((c) => c.alias).join(','));
}

header('a-home drains');
{
  util5h['a-home'] = 0.99;
  util5h['c-peer'] = 0.99;
  const z = await send(plainBody('conversation Z'));
  check('the request that carries the reading is still served by a-home', z.status === 200 && z.upstream.alias === 'a-home', z.upstream.alias);
}

header('thinking forwarded: the conversation moves inside its organization');
{
  const x2 = await send(claudeCodeBody('conversation X', true));
  check('served', x2.status === 200, `${x2.status} ${x2.text.slice(0, 200)}`);
  check('by c-peer, not by b-other which is next in fill order', x2.upstream.alias === 'c-peer', x2.upstream.alias);
  check('both thinking blocks went upstream as sent',
    JSON.stringify(thinkingBlocksIn(x2.upstream.body)) === JSON.stringify(THINKING_TURN.slice(0, 2)), JSON.stringify(thinkingBlocksIn(x2.upstream.body)));
  check('nothing to report: same organization', moveLines().length === 0 && dropLines().length === 0, [...moveLines(), ...dropLines()].join(' | '));
}

header('thinking stripped: the ordinary fill order, and no thinking upstream');
{
  const y2 = await send(plainBody('conversation Y', true));
  check('served', y2.status === 200, `${y2.status} ${y2.text.slice(0, 200)}`);
  check('by b-other, the next seat in fill order', y2.upstream.alias === 'b-other', y2.upstream.alias);
  check('neither kind of thinking block went upstream', thinkingBlocksIn(y2.upstream.body).length === 0, JSON.stringify(thinkingBlocksIn(y2.upstream.body)));
  check('a move that loses nothing is not reported', moveLines().length === 0 && dropLines().length === 0, [...moveLines(), ...dropLines()].join(' | '));
}

header('no usable seat left in the organization: the conversation crosses, and the proxy says so');
{
  // c-peer reported 0.99 when it served conversation X, so it is drained now.
  const w2 = await send(claudeCodeBody('conversation W', true));
  check('served', w2.status === 200, `${w2.status} ${w2.text.slice(0, 200)}`);
  check('by b-other', w2.upstream.alias === 'b-other', w2.upstream.alias);
  check('one line names the move', moveLines().length === 1 && moveLines()[0].includes('from seat a-home to seat b-other'), moveLines().join(' | '));
  check('the list of what was left out reaches the client', (() => {
    try { return JSON.parse(w2.text).input_transformations.length === 2; } catch { return false; }
  })(), w2.text.slice(0, 300));
  check('one line says what the upstream left out', dropLines().length === 1
    && dropLines()[0].includes('upstream left 2 thinking blocks out of this request on seat b-other (organization_binding_mismatch 2)'), dropLines().join(' | '));
}

header('the same conversation, streamed: counted again in the log, said once on the console');
{
  const w3 = await send(claudeCodeBody('conversation W', true, { stream: true }));
  check('streamed 200 from b-other', w3.status === 200 && w3.upstream.alias === 'b-other', `${w3.status} ${w3.upstream.alias}`);
  check('the stream reached the client with the list in message_start', w3.text.includes('"input_transformations"') && w3.text.includes('PONG'), w3.text.slice(0, 300));
  check('still one line about the move', moveLines().length === 1, moveLines().join(' | '));
  check('still one line about what was left out', dropLines().length === 1, dropLines().join(' | '));
}

header('the request log');
{
  await sleep(200);
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.path === '/v1/messages');
  check('one line per request', lines.length === 8, String(lines.length));
  const withDrops = lines.filter((l) => l.thinking_dropped !== undefined);
  check('the two requests that crossed carry the count', withDrops.length === 2 && withDrops.every((l) => l.thinking_dropped === 2 && l.account === 'b-other'),
    JSON.stringify(withDrops.map((l) => [l.account, l.thinking_dropped, l.stream])));
  check('one buffered, one streamed', withDrops.some((l) => l.stream === false) && withDrops.some((l) => l.stream === true));
  check('with the reason the upstream gave', withDrops.every((l) => JSON.stringify(l.thinking_dropped_reasons) === JSON.stringify({ organization_binding_mismatch: 2 })),
    JSON.stringify(withDrops.map((l) => l.thinking_dropped_reasons)));
  check('a request with nothing left out carries neither field',
    lines.filter((l) => l.thinking_dropped === undefined).every((l) => l.thinking_dropped_reasons === undefined) && lines.length - withDrops.length === 6);
}

header('passthrough: no sticky key, and each conversation is still reported on its own');
{
  // A second proxy on the same seats, forwarding bodies as sent. Its pool
  // starts unmeasured, so with every seat reporting low utilization the first
  // seat in fill order serves every request here; the stub leaves thinking
  // out on every seat.
  for (const alias of Object.keys(util5h)) util5h[alias] = 0.10;
  dropOn = new Set(Object.keys(SEATS));
  const PASS_PORT = await freePort();
  const PASS_BASE = `http://127.0.0.1:${PASS_PORT}`;
  await startProxy({
    host: '127.0.0.1', port: PASS_PORT, passthrough: true, verbose: false, noLiveCapture: true,
    poolStrategy: 'fill-first', overageGuardEnabled: false, pacingMinMs: 0, pacingJitterMs: 0,
    fetchImpl,
  });
  for (let i = 0; i < 50; i++) { try { await fetch(`${PASS_BASE}/health`); break; } catch { await sleep(100); } }

  const before = dropLines().length;
  const p1 = await send(plainBody('conversation P', true), PASS_BASE);
  check('served, with the thinking forwarded as sent', p1.status === 200
    && JSON.stringify(thinkingBlocksIn(p1.upstream.body)) === JSON.stringify(THINKING_TURN.slice(0, 2)), `${p1.status} ${JSON.stringify(thinkingBlocksIn(p1.upstream.body))}`);
  check('the first conversation is reported', dropLines().length === before + 1, dropLines().slice(before).join(' | '));
  const q1 = await send(plainBody('conversation Q', true), PASS_BASE);
  check('a second conversation on the same seat is reported too', q1.upstream.alias === p1.upstream.alias && dropLines().length === before + 2,
    `${p1.upstream.alias} ${q1.upstream.alias} ${dropLines().slice(before).join(' | ')}`);
  const p2 = await send(plainBody('conversation P', true), PASS_BASE);
  const q2 = await send(plainBody('conversation Q', true), PASS_BASE);
  check('a later turn of either says nothing new', p2.status === 200 && q2.status === 200 && dropLines().length === before + 2, dropLines().slice(before).join(' | '));
  const r1 = await send(plainBody('conversation R'), PASS_BASE);
  check('a conversation with no thinking is not reported', r1.status === 200 && dropLines().length === before + 2, dropLines().slice(before).join(' | '));
  check('no move line: nothing was rebound', moveLines().length === 1, moveLines().join(' | '));
}

out(`\nthinking-binding-proxy: ${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-30).join('\n'));
process.exit(fail === 0 ? 0 : 1);

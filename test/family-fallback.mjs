#!/usr/bin/env node
// Family fallback: a request for a family every seat is parked on is served
// as the configured model of a family the pool can still serve.
//
// The case it is for: Fable is metered on a seat's included credit (the
// `7d_oi` bucket), not its 5h and 7d windows. Once that credit is spent, a
// Fable request gets 429 with `7d_oi` rejected while the seat still serves
// Opus (see pool-bucket-scoped-parking.mjs). With
// `--family-fallback=fable=claude-opus-5-5`, the next Fable request goes
// upstream as Opus on that seat, marked `x-dario-family-fallback`, instead of
// a local 429 until the credit resets. The request whose 429 parks the family
// (the credit ran out on it, or dario restarted and had not seen it spent) is
// sent again through dario's front door and served the same way.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { parseFamilyFallback, familyFallbackModel, describeFamilyFallback } = await import('../dist/family-fallback.js');
const { AccountPool, parseRateLimits, EMPTY_SNAPSHOT } = await import('../dist/pool.js');

const NOW = Date.now();
const SECS = Math.floor(NOW / 1000);
const RESET_7D = SECS + 3 * 24 * 3600;

// A Fable 429 with the included credit spent and the seat's own windows open.
const fable429Headers = {
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
  'anthropic-ratelimit-unified-7d_oi-utilization': '1.02',
  'anthropic-ratelimit-unified-7d_oi-reset': String(RESET_7D),
  'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  'anthropic-ratelimit-unified-reset': String(RESET_7D),
  'anthropic-ratelimit-unified-status': 'rejected',
};
// A five-hour exhaustion: the seat is parked for every family.
const fiveHour429Headers = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1.02',
  'anthropic-ratelimit-unified-7d-utilization': '0.2',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': String(SECS + 85 * 60),
};

header('parseFamilyFallback');
{
  const a = parseFamilyFallback('fable=claude-opus-5-5');
  check('one pair', a.map.size === 1 && a.map.get('fable') === 'claude-opus-5-5' && a.errors.length === 0, [...a.map]);
  const b = parseFamilyFallback(' Fable = claude-opus-5-5 , sonnet=claude-haiku-5 ');
  check('case and spaces, two pairs', b.map.get('fable') === 'claude-opus-5-5' && b.map.get('sonnet') === 'claude-haiku-5' && b.errors.length === 0, [...b.map]);
  const c = parseFamilyFallback({ fable: 'claude-opus-5-5' });
  check('a config object', c.map.get('fable') === 'claude-opus-5-5' && c.errors.length === 0);
  check('empty string is off', parseFamilyFallback('').map.size === 0 && parseFamilyFallback('').errors.length === 0);
  check('null and undefined are off', parseFamilyFallback(null).map.size === 0 && parseFamilyFallback(undefined).map.size === 0);
  const bad = parseFamilyFallback('gpt=claude-opus-5-5,fable=claude-fable-5,haiku=gpt-5.6-terra,sonnet,opus=,fable=claude-opus-5-5');
  check('only the valid pair is kept', bad.map.size === 1 && bad.map.get('fable') === 'claude-opus-5-5', [...bad.map]);
  check('every other entry is reported', bad.errors.length === 5, bad.errors);
  check('same family is refused by name', bad.errors.some((e) => e.includes('same family')), bad.errors);
  check('a non-claude target is refused', bad.errors.some((e) => e.includes('gpt-5.6-terra')), bad.errors);
  const last = parseFamilyFallback('fable=claude-sonnet-5,fable=claude-opus-5-5');
  check('a later entry for the same family wins', last.map.get('fable') === 'claude-opus-5-5');
  check('describe', describeFamilyFallback(b.map) === 'fable → claude-opus-5-5, sonnet → claude-haiku-5', describeFamilyFallback(b.map));
}

header('familyFallbackModel');
{
  const map = parseFamilyFallback('fable=claude-opus-5-5').map;
  const pool = (parkedFamilies, servableFamilies) => ({
    parked: (f) => parkedFamilies.includes(f),
    servable: (f) => servableFamilies.includes(f),
  });
  check('fable parked, opus servable: switch', familyFallbackModel(map, 'claude-fable-5-1', pool(['fable'], ['opus'])) === 'claude-opus-5-5');
  check('fable not parked: no switch', familyFallbackModel(map, 'claude-fable-5-1', pool([], ['fable', 'opus'])) === null);
  check('opus parked too: no switch', familyFallbackModel(map, 'claude-fable-5-1', pool(['fable', 'opus'], [])) === null);
  check('fable parked, opus not servable (token expired, say): no switch', familyFallbackModel(map, 'claude-fable-5-1', pool(['fable'], [])) === null);
  check('a family with no entry: no switch', familyFallbackModel(map, 'claude-sonnet-5', pool(['sonnet'], ['opus'])) === null);
  check('no family: no switch', familyFallbackModel(map, 'gpt-5.6-terra', pool(['fable'], ['opus'])) === null);
  check('an empty map: no switch', familyFallbackModel(new Map(), 'claude-fable-5-1', pool(['fable'], ['opus'])) === null);
  check('a model name with a line break: no switch (it would be echoed in a header)', familyFallbackModel(map, 'claude-fable-5-1\r\nx-injected: 1', pool(['fable'], ['opus'])) === null);
  check('a model name with a space or a control character: no switch', familyFallbackModel(map, 'claude fable', pool(['fable'], ['opus'])) === null && familyFallbackModel(map, 'claude-fable\u0000', pool(['fable'], ['opus'])) === null);
  check('a model name over 256 characters: no switch', familyFallbackModel(map, `claude-fable-${'x'.repeat(250)}`, pool(['fable'], ['opus'])) === null);
  check('a [1m] request keeps its context window', familyFallbackModel(map, 'claude-fable-5[1m]', pool(['fable'], ['opus'])) === 'claude-opus-5-5[1m]');
  const tagged = parseFamilyFallback('fable=claude-opus-5-5[1m]').map;
  check('a target that already has [1m] is not tagged twice', familyFallbackModel(tagged, 'claude-fable-5[1m]', pool(['fable'], ['opus'])) === 'claude-opus-5-5[1m]');
}

header('AccountPool: what the proxy asks it');
{
  const seat = (p, alias) => p.add(alias, { accessToken: `t-${alias}`, refreshToken: `r-${alias}`, expiresAt: NOW + 30 * 24 * 3_600_000, deviceId: `d-${alias}`, accountUuid: `u-${alias}` });
  const p = new AccountPool();
  seat(p, 'one');
  p.updateRateLimits('one', { ...EMPTY_SNAPSHOT, status: 'allowed', util5h: 0.03, util7d: 0.4, updatedAt: NOW });
  check('a fresh seat can serve fable and opus', p.canServe('fable', NOW) && p.canServe('opus', NOW));
  p.markRejected('one', parseRateLimits(new Headers(fable429Headers), 'fable'));
  check('after the Fable credit 429: parked for fable', p.parkedUntil(NOW, 'fable') !== null);
  check('and still able to serve opus', p.canServe('opus', NOW) && !p.canServe('fable', NOW));
  const q = new AccountPool();
  seat(q, 'one');
  q.markRejected('one', parseRateLimits(new Headers(fiveHour429Headers), 'fable'));
  check('after a five-hour 429: parked for fable and unable to serve opus', q.parkedUntil(NOW, 'fable') !== null && !q.canServe('opus', NOW));
  check('an empty pool can serve nothing', !new AccountPool().canServe('opus', NOW));
  check('familyRateLimited: fable yes, opus no, after the credit 429', p.familyRateLimited('fable', NOW) && !p.familyRateLimited('opus', NOW));
  p.updateRateLimits('one', parseRateLimits(new Headers({ 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.04', 'anthropic-ratelimit-unified-7d-utilization': '0.4', 'anthropic-ratelimit-unified-reset': String(RESET_7D) }), 'opus'));
  check('an Opus 200 since: still parked for fable (the bucket is carried forward)', p.parkedUntil(NOW, 'fable') !== null && p.familyRateLimited('fable', NOW) && p.canServe('opus', NOW), p.parkedUntil(NOW, 'fable'));
  const r = new AccountPool();
  r.add('stale', { accessToken: 't', refreshToken: 'r', expiresAt: NOW - 1, deviceId: 'd', accountUuid: 'u' });
  check('an expired token is not a rate limit', !r.familyRateLimited('fable', NOW));
  check('an empty pool is not rate-limited', !new AccountPool().familyRateLimited('fable', NOW));
}

// ── the real proxy, one seat whose Fable credit is spent ───────────────
const PORT = await freePort();
const ADMIN_TOKEN = 'family-fallback-admin-token';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-family-fallback-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_POOL_FALLBACK;
delete process.env.DARIO_FAMILY_FALLBACK;
await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(join(tmpHome, '.dario', 'accounts', 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const sent = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5'].map((id) => ({ id, type: 'model' })) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : Buffer.from(init?.body ?? '').toString());
  sent.push(body.model);
  if (/fable/i.test(body.model)) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
      status: 429, headers: { 'content-type': 'application/json', ...fable429Headers },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  }), {
    status: 200, headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.04',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-reset': String(RESET_7D),
    },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

const { startProxy } = await import('../dist/proxy.js');
await startProxy({ host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl, familyFallback: 'fable=claude-opus-5-5,opus=claude-opus-5-5',
  // One slot: the re-sent request needs the slot the first one holds, so a
  // fallback that kept it would wait on itself until the queue timeout.
  maxConcurrent: 1, queueTimeoutMs: 5000 });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (model, extraHeaders = {}) => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: `hi ${Math.random()}` }] }),
});

header('startup');
{
  check('the banner names the pair', log.some((l) => l.includes('Family fallback: fable → claude-opus-5-5')), log.filter((l) => l.includes('amily')));
  check('a same-family entry is dropped with a warning', log.some((l) => l.includes('family fallback: dropped') && l.includes('same family')), log.filter((l) => l.includes('dropped')));
}

header('request 1: Fable goes upstream, the 429 parks fable, and the same request is served as Opus');
{
  // A fresh proxy has not seen the credit spent: this is the first request
  // after a restart. Before the mid-flight fallback it got the 429 (or the
  // codex fallback, where one is armed).
  const r = await messages('claude-fable-5-1');
  const body = await r.json();
  check('the client gets 200', r.status === 200, [r.status, body]);
  check('sent as Fable, then once as Opus, and no more', sent.join() === 'claude-fable-5-1,claude-opus-5-5', sent);
  check('marked x-dario-family-fallback with the requested model', r.headers.get('x-dario-family-fallback') === 'claude-fable-5-1', r.headers.get('x-dario-family-fallback'));
  check('the answer names the model that served it', body.model === 'claude-opus-5-5', body.model);
  check('the re-send is logged', log.some((l) => l.includes('the 429 parked every seat for claude-fable-5-1 -> sent again as claude-opus-5-5')), log.slice(-6));
}

header('request 2: Fable is served as Opus on the same seat');
{
  const before = sent.length;
  const r = await messages('claude-fable-5-1');
  const body = await r.json();
  check('the client gets 200', r.status === 200, r.status);
  check('the request went upstream as claude-opus-5-5', sent.length === before + 1 && sent[before] === 'claude-opus-5-5', sent.slice(before));
  check('marked x-dario-family-fallback with the requested model', r.headers.get('x-dario-family-fallback') === 'claude-fable-5-1', r.headers.get('x-dario-family-fallback'));
  check('the answer names the model that served it', body.model === 'claude-opus-5-5', body.model);
  check('the switch is logged', log.some((l) => l.includes('every seat is parked for claude-fable-5-1 -> served as claude-opus-5-5')), log.slice(-5));
}

header('request 3: an Opus request is untouched');
{
  const before = sent.length;
  const r = await messages('claude-opus-5-5');
  await r.text();
  check('200, sent as Opus, no marker', r.status === 200 && sent[before] === 'claude-opus-5-5' && r.headers.get('x-dario-family-fallback') === null, [r.status, sent.slice(before), r.headers.get('x-dario-family-fallback')]);
}

header('request 4: after that Opus 200, Fable is still served as Opus');
{
  // The Opus 200 replaced the seat's reading; the carried-forward 7d_oi
  // bucket is what still keeps Fable off.
  const before = sent.length;
  const r = await messages('claude-fable-5-1');
  await r.text();
  check('200, sent upstream as Opus only, marked', r.status === 200 && sent.slice(before).join() === 'claude-opus-5-5' && r.headers.get('x-dario-family-fallback') === 'claude-fable-5-1', [r.status, sent.slice(before), r.headers.get('x-dario-family-fallback')]);
}

header('request 5: a seat-pinned Fable request is not re-pointed');
{
  const before = sent.length;
  const r = await messages('claude-fable-5-1', { 'x-dario-account': 'one', 'x-dario-admin-token': ADMIN_TOKEN });
  await r.text();
  check('the pin was honoured (not refused)', r.status !== 403 && r.status !== 404, r.status);
  check('no Opus request was sent for it', !sent.slice(before).includes('claude-opus-5-5'), [r.status, sent.slice(before)]);
  check('no marker', r.headers.get('x-dario-family-fallback') === null);
}

header('request 6: a Fable model name with a line break is not switched, and the proxy keeps answering');
{
  const before = sent.length;
  const r = await messages('claude-fable-5-1\r\nx-injected: 1');
  await r.text();
  check('not served as Opus', !sent.slice(before).includes('claude-opus-5-5'), [r.status, sent.slice(before)]);
  check('no marker and no injected header', r.headers.get('x-dario-family-fallback') === null && r.headers.get('x-injected') === null);
  check('not a proxy error', r.status !== 500, r.status);
  check('no forged log line', !log.some((l) => l.startsWith('x-injected')));
  const h = await fetch(`${BASE}/health`);
  check('the proxy still answers', h.status === 200, h.status);
}

out(`\nfamily-fallback: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * test/cache-trace.mjs
 *
 * The cache trace (src/cache-trace.ts): what a Codex request shares with the
 * previous request on its prompt_cache_key. Pure module with an injected
 * clock, so every case runs without sleeping; plus the log-field mapping the
 * proxy writes (cacheLogFields), the stdout line, and the order concurrent
 * forwards are remembered in.
 */
import { CacheTrace, itemHash, prefixHash, traceKey, formatCacheTraceLine, CACHE_TRACE_TTL_MS, CACHE_TRACE_MAX_ITEMS } from '../dist/cache-trace.js';
import { cacheLogFields } from '../dist/proxy.js';
import { forwardToCodex, _resetCacheTraceForTest } from '../dist/codex-backend.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); fail++; }
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}

header('itemHash / prefixHash');
{
  check('the same item hashes the same', itemHash({ role: 'user', content: 'hi' }) === itemHash({ role: 'user', content: 'hi' }));
  check('a different item hashes differently', itemHash({ role: 'user', content: 'hi' }) !== itemHash({ role: 'user', content: 'hi!' }));
  check('12 hex characters', /^[0-9a-f]{12}$/.test(itemHash({ a: 1 })));
  const body = { model: 'm', instructions: 'sys', tools: [{ type: 'function', name: 'read' }, { type: 'web_search' }] };
  check('prefix hash is stable', prefixHash(body) === prefixHash({ ...body }));
  check('a changed system prompt changes the prefix', prefixHash(body) !== prefixHash({ ...body, instructions: 'sys2' }));
  check('a renamed tool changes the prefix', prefixHash(body) !== prefixHash({ ...body, tools: [{ type: 'function', name: 'write' }, { type: 'web_search' }] }));
  check('a changed tool description does not (the key hashes names only)', prefixHash(body) === prefixHash({ ...body, tools: [{ type: 'function', name: 'read', description: 'x' }, { type: 'web_search' }] }));
}

header('traceKey');
{
  const derived = 'dario-' + '0123456789abcdef'.repeat(2);
  check('a derived key is kept as it went out', traceKey(derived, true) === derived);
  const own = traceKey('alice@example.com', false);
  check('a caller key is a digest, none of it in the clear', /^key-[0-9a-f]{16}$/.test(own) && !own.includes('alice'), own);
  check('a caller key digests the same every time', traceKey('alice@example.com', false) === own);
  check('two caller keys digest apart', traceKey('bob@example.com', false) !== own);
  check('a caller key shaped exactly like a derived one is still digested', /^key-[0-9a-f]{16}$/.test(traceKey(derived, false)), traceKey(derived, false));
}

header('CacheTrace.note: first, extends, diverged, shortened');
{
  let now = 1_000_000;
  const t = new CacheTrace({ now: () => now });
  const base = { key: 'k1', alias: 'a', prefix: 'p1' };
  const first = t.note({ ...base, items: ['i1'], at: now });
  check('first request on a key: nulls, item count kept', first.items === 1 && first.sinceMs === null && first.prevItems === null && first.extends === null && first.divergedAt === null && first.seatChanged === null && first.prefixChanged === null, first);
  now += 3_100;
  const second = t.note({ ...base, items: ['i1', 'i2', 'i3'], at: now });
  check('a strict extension: extends=true, since=3100, prev=1', second.extends === true && second.sinceMs === 3100 && second.prevItems === 1 && second.items === 3 && second.divergedAt === null, second);
  check('same seat and prefix read as unchanged', second.seatChanged === false && second.prefixChanged === false, second);
  now += 20_000;
  const same = t.note({ ...base, items: ['i1', 'i2', 'i3'], at: now });
  check('the same input again is not an extension (nothing new to cache) and did not diverge', same.extends === false && same.divergedAt === null && same.sinceMs === 20_000, same);
  now += 1_000;
  const diverged = t.note({ ...base, items: ['i1', 'X', 'i3', 'i4'], at: now });
  check('a changed middle item: extends=false, divergedAt=1', diverged.extends === false && diverged.divergedAt === 1 && diverged.prevItems === 3 && diverged.items === 4, diverged);
  now += 1_000;
  const shorter = t.note({ ...base, items: ['i1', 'X'], at: now });
  check('a shortened history agrees as far as it goes: extends=false, no divergence', shorter.extends === false && shorter.divergedAt === null && shorter.prevItems === 4, shorter);
}

header('CacheTrace.peek / remember: compare without remembering');
{
  let now = 3_000_000;
  const t = new CacheTrace({ now: () => now });
  const req = { key: 'kp', alias: 'a', prefix: 'p', items: ['i1'], at: now };
  const peeked = t.peek(req);
  check('peek on a new key reads as first and remembers nothing', peeked.sinceMs === null && t.size() === 0, peeked);
  const again = t.peek({ ...req, alias: 'b' });
  check('a second peek of the same request is still first', again.sinceMs === null && again.seatChanged === null, again);
  t.remember({ ...req, alias: 'b' });
  now += 1_000;
  const next = t.note({ key: 'kp', alias: 'b', prefix: 'p', items: ['i1', 'i2'], at: now });
  check('the next request compares with the remembered one', next.prevItems === 1 && next.extends === true && next.seatChanged === false && next.sinceMs === 1_000, next);
}

header('CacheTrace.remember: accepted out of order, the later request stays');
{
  let now = 4_000_000;
  const t = new CacheTrace({ now: () => now });
  const a = { key: 'ko', alias: 'seat-a', prefix: 'p', items: ['i1'], at: now + 100 };
  const b = { key: 'ko', alias: 'seat-b', prefix: 'p', items: ['i1', 'i2', 'i3'], at: now + 200 };
  t.peek(a); t.peek(b);
  t.remember(b);
  t.remember(a);
  const c = t.note({ key: 'ko', alias: 'seat-b', prefix: 'p', items: ['i1', 'i2', 'i3', 'i4', 'i5'], at: now + 300 });
  check('an older request accepted last does not replace a newer one', c.prevItems === 3 && c.sinceMs === 100 && c.extends === true && c.seatChanged === false, c);

  const sameMs = { key: 'ks', alias: 'seat-a', prefix: 'p', items: ['i1'], at: now };
  const sameMsLater = { key: 'ks', alias: 'seat-b', prefix: 'p', items: ['i1', 'i2'], at: now };
  t.peek(sameMs); t.peek(sameMsLater);
  t.remember(sameMsLater);
  t.remember(sameMs);
  const d = t.note({ key: 'ks', alias: 'seat-b', prefix: 'p', items: ['i1', 'i2', 'i3'], at: now + 1 });
  check('in the same ms, dispatch order decides', d.prevItems === 2 && d.seatChanged === false, d);

  const capped = new CacheTrace({ now: () => now, maxKeys: 2 });
  capped.remember({ key: 'new1', alias: 'a', prefix: 'p', items: ['i1'], at: now + 50 });
  capped.remember({ key: 'new2', alias: 'a', prefix: 'p', items: ['i1'], at: now + 60 });
  capped.remember({ key: 'late-old', alias: 'a', prefix: 'p', items: ['i1'], at: now + 10 });
  const kept1 = capped.peek({ key: 'new1', alias: 'a', prefix: 'p', items: ['i1', 'i2'], at: now + 70 });
  const evicted = capped.peek({ key: 'late-old', alias: 'a', prefix: 'p', items: ['i1', 'i2'], at: now + 70 });
  check('over the cap, the entry that went out earliest goes, even if inserted last', capped.size() === 2 && kept1.sinceMs === 20 && evicted.sinceMs === null, { kept1, evicted });
}

header('forwardToCodex: upstream headers out of order, the next turn compares with the later request');
{
  // A goes out, then B on the same key; B's headers arrive first, then A's.
  // C must compare with B, the later request, not with A.
  const STREAM = [
    { type: 'response.created', response: { id: 'resp_x', model: 'gpt-5.6-sol' } },
    { type: 'response.completed', response: { id: 'resp_x', model: 'gpt-5.6-sol', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const ok = () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(STREAM.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))); c.close(); } }),
  });
  const deferred = () => {
    let release, called;
    const sent = new Promise((r) => { called = r; });
    const answer = new Promise((r) => { release = r; });
    return { sent, release: () => release(ok()), fetch: async () => { called(); return answer; } };
  };
  const res = () => ({
    headersSent: false, writeHead() { this.headersSent = true; }, write() { return true; }, end() {},
    on() { return this; }, removeListener() { return this; },
  });
  const body = (n) => Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', prompt_cache_key: 'concurrent-conv',
    messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
  }));
  const SEAT_A = { alias: 'seat-a', accessToken: 'tok', idToken: undefined };
  const SEAT_B = { alias: 'seat-b', accessToken: 'tok', idToken: undefined };

  _resetCacheTraceForTest();
  const outcomes = {};
  const a = deferred();
  const b = deferred();
  const doneA = forwardToCodex({}, res(), body(1), SEAT_A, '*', {}, 5000, false, 'openai', a.fetch, false, (o) => { outcomes.a = o; });
  await a.sent;
  await new Promise((r) => setTimeout(r, 5));
  const doneB = forwardToCodex({}, res(), body(3), SEAT_B, '*', {}, 5000, false, 'openai', b.fetch, false, (o) => { outcomes.b = o; });
  await b.sent;
  b.release();
  await doneB;
  a.release();
  await doneA;
  await forwardToCodex({}, res(), body(5), SEAT_B, '*', {}, 5000, false, 'openai', async () => ok(), false, (o) => { outcomes.c = o; });
  const c = outcomes.c?.cache;
  check('both concurrent requests were served', outcomes.a?.status === 200 && outcomes.b?.status === 200, { a: outcomes.a?.status, b: outcomes.b?.status });
  check('C compares with B: 5 items over 3, extends, same seat', c?.items === 5 && c.prevItems === 3 && c.extends === true && c.seatChanged === false, c);
}

header('CacheTrace.note: seat and prefix changes, keys apart');
{
  let now = 5_000_000;
  const t = new CacheTrace({ now: () => now });
  t.note({ key: 'k', alias: 'a', prefix: 'p', items: ['i1'], at: now });
  now += 500;
  const moved = t.note({ key: 'k', alias: 'b', prefix: 'p', items: ['i1', 'i2'], at: now });
  check('a different seat is flagged, the shape still extends', moved.seatChanged === true && moved.prefixChanged === false && moved.extends === true, moved);
  now += 500;
  const reprompted = t.note({ key: 'k', alias: 'b', prefix: 'p2', items: ['i1', 'i2', 'i3'], at: now });
  check('a changed prefix is flagged', reprompted.prefixChanged === true && reprompted.seatChanged === false, reprompted);
  const other = t.note({ key: 'other', alias: 'b', prefix: 'p2', items: ['i1', 'i2', 'i3'], at: now });
  check('another key starts on its own', other.sinceMs === null && other.extends === null, other);
  check('two keys remembered', t.size() === 2);
}

header('CacheTrace.note: a history past the item cap');
{
  let now = 7_000_000;
  const t = new CacheTrace({ now: () => now });
  const hist = (n) => Array.from({ length: n }, (_, i) => `i${i}`);
  t.note({ key: 'long', alias: 'a', prefix: 'p', items: hist(CACHE_TRACE_MAX_ITEMS + 1), at: now });
  now += 1_000;
  const longer = t.note({ key: 'long', alias: 'a', prefix: 'p', items: hist(CACHE_TRACE_MAX_ITEMS + 2), at: now });
  check('prevItems is the full previous length, not the kept part', longer.prevItems === CACHE_TRACE_MAX_ITEMS + 1 && longer.items === CACHE_TRACE_MAX_ITEMS + 2, longer);
  check('a longer input past the kept part cannot be called either way: extends=null, no divergence', longer.extends === null && longer.divergedAt === null, longer);
  now += 1_000;
  const same = t.note({ key: 'long', alias: 'a', prefix: 'p', items: hist(CACHE_TRACE_MAX_ITEMS + 2), at: now });
  check('the same long input again is not an extension', same.extends === false && same.divergedAt === null, same);
  now += 1_000;
  const changed = hist(CACHE_TRACE_MAX_ITEMS + 3); changed[5] = 'X';
  const early = t.note({ key: 'long', alias: 'a', prefix: 'p', items: changed, at: now });
  check('a change inside the kept part still diverges', early.extends === false && early.divergedAt === 5, early);
  const t2 = new CacheTrace({ now: () => now });
  t2.note({ key: 'edge', alias: 'a', prefix: 'p', items: hist(CACHE_TRACE_MAX_ITEMS), at: now });
  const past = t2.note({ key: 'edge', alias: 'a', prefix: 'p', items: hist(CACHE_TRACE_MAX_ITEMS + 1), at: now });
  check('a previous input kept whole still extends, even when this one runs past the cap', past.extends === true && past.prevItems === CACHE_TRACE_MAX_ITEMS, past);
}

header('CacheTrace: TTL and the key cap');
{
  let now = 9_000_000;
  const t = new CacheTrace({ now: () => now, ttlMs: 10_000, maxKeys: 3 });
  t.note({ key: 'old', alias: 'a', prefix: 'p', items: ['i1'], at: now });
  now += 10_001;
  const stale = t.note({ key: 'old', alias: 'a', prefix: 'p', items: ['i1', 'i2'], at: now });
  check('past the TTL the key reads as first again', stale.sinceMs === null && stale.extends === null, stale);
  for (const k of ['k1', 'k2', 'k3']) t.note({ key: k, alias: 'a', prefix: 'p', items: ['i1'], at: now });
  check('the cap holds: the oldest key went', t.size() === 3);
  const evicted = t.note({ key: 'old', alias: 'a', prefix: 'p', items: ['i1', 'i2', 'i3'], at: now });
  check('an evicted key reads as first', evicted.sinceMs === null, evicted);
  check('the default TTL is an hour', CACHE_TRACE_TTL_MS === 3_600_000);
  now += 10_001;
  t.note({ key: 'fresh', alias: 'a', prefix: 'p', items: ['i1'], at: now });
  check('a note sweeps every expired key', t.size() === 1);
}

header('cacheLogFields and the stdout line');
{
  const trace = { key: 'dario-abcdef0123456789abcdef', items: 23, sinceMs: 3_140, prevItems: 21, extends: true, divergedAt: null, seatChanged: false, prefixChanged: false };
  const fields = cacheLogFields(trace);
  check('log fields carry every trace field under cache_*',
    fields.cache_key === trace.key && fields.cache_items === 23 && fields.cache_since_ms === 3_140 && fields.cache_prev_items === 21
    && fields.cache_extends === true && fields.cache_diverged_at === null && fields.cache_seat_changed === false && fields.cache_prefix_changed === false, fields);
  check('no trace, no fields', Object.keys(cacheLogFields(undefined)).length === 0);
  const line = formatCacheTraceLine(412, trace.key, trace, { inputTokens: 44_120, cacheReadTokens: 0 }, 'work');
  check('the line names the key, seat, gap, items, extension and the share',
    line === '[dario] #412 cache: key=dario-abcdef0123 seat=work since=3.1s items=23/21 extends=yes read=0/44120 (0%)', line);
  const first = formatCacheTraceLine(1, 'k', { ...trace, sinceMs: null, prevItems: null, extends: null, seatChanged: null, prefixChanged: null }, { inputTokens: 100, cacheReadTokens: 0 });
  check('a first request says so', first.includes('since=first') && first.includes('items=23 ') && first.includes('extends=-') && !first.includes('seat='), first);
  const moved = formatCacheTraceLine(2, 'k', { ...trace, extends: false, divergedAt: 4, seatChanged: true, prefixChanged: true }, { inputTokens: 1_000, cacheReadTokens: 3_000 });
  check('a diverged, moved, reprompted request shows all three and the share', moved.includes('extends=no diverged_at=4 seat_changed prefix_changed read=3000/4000 (75%)'), moved);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);

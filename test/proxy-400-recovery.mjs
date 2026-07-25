#!/usr/bin/env node
// 400-recovery chain: multi-pass, bounded, and non-remediable 400s pass straight
// through. Hermetic — the upstream is a scripted fake via ProxyOptions.fetchImpl,
// and `upstreamApiKey` puts dario in per-token API-key mode so no OAuth pool,
// credentials, or real network are involved.
//
// The bug this locks down (dario#851 finding 2, fixed in #855): every remediation
// retried INLINE, exactly once, then fell out of the if/else chain. A model that
// trips two pinned defaults got one fixed and the other forwarded. Live repro on
// claude-opus-4-1 (no `effort` support AND a 32000 max_tokens cap):
//
//   #0 effort parameter unsupported ... retrying
//   #1 400            <- client saw "max_tokens: 64000 > 32000"
//
// Request 2 then succeeded because effort was cached by then, which is exactly
// what made it look like a warm-up quirk instead of a bug.

import { startProxy } from '../dist/proxy.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

// Uncommon port: the suite runs at --test-concurrency=8 and other files bind
// sockets, so stay well clear of dario's 3456-3460 range.
const PORT = 38761;
const BASE = `http://127.0.0.1:${PORT}`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const errBody = (message) => ({ type: 'error', error: { type: 'invalid_request_error', message } });

const OK_BODY = {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-1-20250805',
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

// The scripted upstream. Each element is consumed by one upstream call; the last
// one repeats if the proxy keeps going (so a runaway loop shows up as a call
// count, not a hang).
let script = [];
let calls = [];
const fakeFetch = async (url, init) => {
  const body = init?.body ? Buffer.from(init.body).toString('utf8') : '';
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* non-JSON — fine */ }
  // orderHeadersForOutbound returns an ARRAY of [k, v] tuples (that is how it
  // pins CC's header order); passthrough mode passes a plain object. Handle both,
  // and match case-insensitively -- reading it as an object silently yielded
  // undefined and made every beta assertion below pass vacuously.
  const rawHdrs = init?.headers ?? {};
  const entries = Array.isArray(rawHdrs) ? rawHdrs : Object.entries(rawHdrs);
  const betaHdr = entries.find(([k]) => String(k).toLowerCase() === 'anthropic-beta')?.[1];
  calls.push({ url: String(url), max_tokens: parsed.max_tokens, effort: parsed.output_config?.effort, beta: betaHdr });
  const next = script.length > 1 ? script.shift() : script[0];
  return next();
};

// NB: effortSupportByModel / maxTokensCapByModel are MODULE-level and persist
// across requests by design (pay the round-trip once). Each block below therefore
// uses its OWN model id -- sharing one would let block 1's cached cap pre-clamp
// block 2 up front, and block 2 would then see a single upstream call instead of
// the bound it means to exercise.
const send = (model) => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dario' },
  body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
});

await startProxy({
  port: PORT,
  host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key', // API-key mode: x-api-key upstream
  noClaudeAuth: true, // don't read or refresh the real OAuth pool for a unit test
  fetchImpl: fakeFetch,
});
// give the listener a moment to bind
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// ─────────────────────────────────────────────────────────────
header('two distinct rejections are both fixed within ONE client request');
{
  calls = [];
  script = [
    () => json(errBody('This model does not support the effort parameter.'), 400),
    () => json(errBody('max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1-20250805'), 400),
    () => json(OK_BODY),
  ];
  const res = await send('claude-opus-4-1-20250805');
  const body = await res.json().catch(() => ({}));

  check('client gets 200 on its FIRST request', res.status === 200, `got ${res.status}`);
  check('client gets the real content, not an error', body?.content?.[0]?.text === 'OK');
  check('upstream was called 3 times (initial + 2 remediations)', calls.length === 3, `got ${calls.length}`);
  check('pass 1 carried an effort value', typeof calls[0]?.effort === 'string');
  check('pass 2 dropped effort entirely', calls[1]?.effort === undefined);
  check('pass 2 still had the un-clamped max_tokens', calls[1]?.max_tokens === 64000, `got ${calls[1]?.max_tokens}`);
  check('pass 3 clamped max_tokens to the reported cap', calls[2]?.max_tokens === 32000, `got ${calls[2]?.max_tokens}`);
  check('pass 3 still has effort stripped', calls[2]?.effort === undefined);
}

// ─────────────────────────────────────────────────────────────
header('the pass bound holds — a rejection we cannot satisfy does not spin');
{
  calls = [];
  // Each response reports a LOWER cap, so every pass is genuinely remediable and
  // the chain would recurse forever without MAX_RECOVERY_PASSES.
  const caps = [32000, 16000, 8000, 4000, 2000, 1000, 500];
  let i = 0;
  script = [() => {
    const cap = caps[Math.min(i++, caps.length - 1)];
    return json(errBody(`max_tokens: 64000 > ${cap}, which is the maximum allowed number of output tokens for claude-opus-4-1-20250805`), 400);
  }];
  const res = await send('claude-test-boundmodel-9-9');

  check('client eventually gets the 400 rather than hanging', res.status === 400, `got ${res.status}`);
  // MAX_RECOVERY_PASSES = 4 -> initial call + 4 remediations = 5, then the bound
  // stops matching and the 5th response is forwarded.
  check('upstream called exactly 5 times (1 + MAX_RECOVERY_PASSES)', calls.length === 5, `got ${calls.length}`);
  check('each pass clamped further down', calls[4]?.max_tokens === 4000, `got ${calls[4]?.max_tokens}`);
}

// ─────────────────────────────────────────────────────────────
header('a non-remediable 400 is forwarded on the first pass');
{
  calls = [];
  script = [() => json(errBody('messages: at least one message is required'), 400)];
  const res = await send('claude-test-passthru-9-9');
  const body = await res.text();

  check('client gets the 400', res.status === 400, `got ${res.status}`);
  check('upstream called exactly once — no speculative retry', calls.length === 1, `got ${calls.length}`);
  check('the upstream error text is preserved', body.includes('at least one message is required'));
}


// ─────────────────────────────────────────────────────────────
header('two HEADER-mutating rejections do not undo each other (reviewer catch, #855)');
{
  calls = [];
  // The rejected flag must be one dario ACTUALLY sends (advisor-tool is in the
  // baked base set and is not a long-context beta) -- rejecting a flag that was
  // never in the outbound header makes this test pass vacuously.
  // Both of these branches rewrite headers['anthropic-beta']. Each used to derive
  // its replacement from the request-scoped `beta` string, which is fixed before
  // dispatchLoop and never reassigned -- so under multi-pass the second branch
  // recomputed from the ORIGINAL beta and reintroduced the flag the first had
  // already stripped, burning a round trip (and, with a third rejection stacked
  // on, exhausting the bound and forwarding a spurious 400).
  let n = 0;
  script = [() => {
    n++;
    if (n === 1) return json(errBody('Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header'), 400);
    if (n === 2) return json(errBody('long context beta is not yet available for this subscription'), 400);
    return json(OK_BODY);
  }];
  const res = await send('claude-test-hdrmodel-9-9');

  const betas = calls.map((c) => (c.beta ?? '').split(',').filter(Boolean));
  check('client gets 200', res.status === 200, `got ${res.status}`);
  check('resolved in 3 upstream calls, no wasted re-fix pass', calls.length === 3, `got ${calls.length}`);
  check('pass 2 dropped the rejected flag',
    !betas[1]?.includes('advisor-tool-2026-03-01'));
  check('pass 3 did NOT reintroduce the rejected flag',
    !betas[2]?.includes('advisor-tool-2026-03-01'),
    `pass 3 beta = ${calls[2]?.beta}`);
  check('pass 3 also dropped context-1m',
    !betas[2]?.includes('context-1m-2025-08-07'),
    `pass 3 beta = ${calls[2]?.beta}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

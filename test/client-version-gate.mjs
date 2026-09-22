#!/usr/bin/env node
// Client-version gate parsing + the sentence dario answers with, and the proxy
// response the caller actually receives on both protocol paths.
//
// 2026-09-22, the day claude-opus-5-5 shipped: every request for it came back
//   400 {"type":"invalid_request_error","message":"Claude Code 2.1.278 does not
//        support this model; version 2.1.280 or newer is required. Run 'claude
//        update', or update the Claude Code SDK."}
// Anthropic gates a new model on the client version it reads off the request,
// which for dario is the bundled template's `user-agent: claude-cli/<_version>`.
// Nothing about the pool, the seat or the model was wrong, and the message names
// Claude Code — which the caller (Cursor, Cline, the Agent SDK) usually is not.
// The daily sdk-drift watch compares the bundle against npm and can be a day
// behind the publish, so this 400 is the first symptom and it has to say what it
// means on its own.

import { parseClientVersionGate, describeClientVersionGate, startProxy } from '../dist/proxy.js';
import { freePort } from './helpers/free-port.mjs';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}

// --- the live-observed wire shape ---
const LIVE_MESSAGE = "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. "
  + "Run 'claude update', or update the Claude Code SDK.";
const live = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: LIVE_MESSAGE },
  request_id: 'req_011CfJoivTcfNRfKJNjmZapZ',
});
const g = parseClientVersionGate(live);
check('live shape parses', g !== null);
check('claimed version extracted', g.claimed === '2.1.278');
check('required version extracted', g.required === '2.1.280');

check('case-insensitive match', parseClientVersionGate('CLAUDE CODE 2.1.1 DOES NOT SUPPORT THIS MODEL; VERSION 2.2.0 OR NEWER IS REQUIRED') !== null);
check('two-part versions parse', parseClientVersionGate('Claude Code 3.0 does not support this model; version 3.1 or newer is required').required === '3.1');

// --- the neighbouring 400s must not be swallowed by this branch ---
check('effort rejection is not a version gate',
  parseClientVersionGate('{"error":{"message":"This model does not support effort level \'max\'. Supported levels: high, low, medium."}}') === null);
check('max_tokens rejection is not a version gate',
  parseClientVersionGate('{"error":{"message":"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1-20250805."}}') === null);
check('model_not_found is not a version gate',
  parseClientVersionGate('{"error":{"message":"model: claude-opus-5.5 was not found. Did you mean claude-opus-5-5?"}}') === null);
check('unrelated 400 → null', parseClientVersionGate('{"error":{"message":"long context beta is not yet available"}}') === null);

// --- the sentence the caller reads ---
const sentence = describeClientVersionGate({ claimed: '2.1.278', required: '2.1.280' }, 'claude-opus-5-5');
check('names the model', sentence.includes('claude-opus-5-5'));
check('names both versions', sentence.includes('2.1.280') && sentence.includes('2.1.278'));
check('says it is the template label, not the caller', /template/i.test(sentence) && /not your client/i.test(sentence));
check('carries the remedy', sentence.includes('claude-code@latest') && /cc-drift-template-watch/.test(sentence));
check('no em dash', !sentence.includes('—'));

// ─────────────────────────────────────────────────────────────
// The handler branch itself. The parser and the sentence above are only the
// ingredients; what the user sees is the response this branch writes, and its
// shape differs per endpoint. A wiring error there -- wrong envelope, missing
// `code`, a retry the gate can never satisfy -- would leave every check above
// green while clients got the wrong thing, which is the gap the review caught.
//
// Hermetic in the same way as test/proxy-400-recovery.mjs: the upstream is a
// scripted fake via ProxyOptions.fetchImpl and `upstreamApiKey` puts dario in
// per-token API-key mode, so no OAuth pool, credentials or network are involved.
const header = (n) => console.log(`\n=== ${n} ===`);

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

// The gate 400 exactly as Anthropic sends it, request-id header included: the
// branch is supposed to carry that id through so a gated request stays traceable.
const UPSTREAM_REQUEST_ID = 'req_011CfJoivTcfNRfKJNjmZapZ';
let upstreamCalls = 0;
const fakeFetch = async () => {
  upstreamCalls++;
  return new Response(live, {
    status: 400,
    headers: { 'content-type': 'application/json', 'request-id': UPSTREAM_REQUEST_ID },
  });
};

// The branch logs once per (model, required) at error level. Capture stderr so
// the repeat-suppression is asserted rather than assumed.
const gateLogs = [];
const realError = console.error;
console.error = (...args) => { gateLogs.push(args.join(' ')); };

await startProxy({
  port: PORT,
  host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key',
  noClaudeAuth: true,
  fetchImpl: fakeFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const ANTHROPIC_MODEL = 'claude-opus-5-5';
const OPENAI_MODEL = 'claude-opus-5-6';

const sendMessages = (model) => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dario' },
  body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
});
const sendChat = (model) => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer dario' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
});

// ─────────────────────────────────────────────────────────────
header('/v1/messages — the gate 400 comes back in Anthropic shape, named');
{
  upstreamCalls = 0;
  gateLogs.length = 0;
  const res = await sendMessages(ANTHROPIC_MODEL);
  const body = await res.json().catch(() => ({}));
  const expected = describeClientVersionGate({ claimed: '2.1.278', required: '2.1.280' }, ANTHROPIC_MODEL);

  check('status is 400', res.status === 400, `got ${res.status}`);
  check('content-type is json', (res.headers.get('content-type') ?? '').includes('application/json'));
  check('Anthropic error envelope', body?.type === 'error' && body?.error?.type === 'invalid_request_error',
    JSON.stringify(body));
  check('message is dario\'s sentence, not the upstream one', body?.error?.message === expected,
    JSON.stringify(body?.error?.message));
  check('the upstream Claude Code text is gone', !JSON.stringify(body).includes('does not support this model'));
  check('upstream request id preserved', res.headers.get('request-id') === UPSTREAM_REQUEST_ID,
    String(res.headers.get('request-id')));
  check('no retry — a version gate is not remediable', upstreamCalls === 1, `got ${upstreamCalls}`);
  check('logged once at error level', gateLogs.filter((l) => l.includes('requires Claude Code')).length === 1,
    JSON.stringify(gateLogs));

  // Same (model, required) again: the diagnosis is already on the operator's
  // console, and a gated model is requested on every turn of a stuck client.
  const res2 = await sendMessages(ANTHROPIC_MODEL);
  await res2.text();
  check('second gated request still answered', res2.status === 400, `got ${res2.status}`);
  check('but not logged a second time', gateLogs.filter((l) => l.includes('requires Claude Code')).length === 1,
    JSON.stringify(gateLogs));
}

// ─────────────────────────────────────────────────────────────
header('/v1/chat/completions — same gate, OpenAI error shape and code');
{
  upstreamCalls = 0;
  gateLogs.length = 0;
  const res = await sendChat(OPENAI_MODEL);
  const body = await res.json().catch(() => ({}));
  const expected = describeClientVersionGate({ claimed: '2.1.278', required: '2.1.280' }, OPENAI_MODEL);

  check('status is 400', res.status === 400, `got ${res.status}`);
  check('OpenAI error envelope — no top-level type', body?.type === undefined && typeof body?.error === 'object',
    JSON.stringify(body));
  check('error.type is invalid_request_error', body?.error?.type === 'invalid_request_error', JSON.stringify(body));
  check('blames the model param', body?.error?.param === 'model', JSON.stringify(body?.error?.param));
  check('carries the client_version_too_old code', body?.error?.code === 'client_version_too_old',
    JSON.stringify(body?.error?.code));
  check('message is dario\'s sentence, naming the requested model', body?.error?.message === expected,
    JSON.stringify(body?.error?.message));
  check('no retry on the OpenAI path either', upstreamCalls === 1, `got ${upstreamCalls}`);
}

console.error = realError;
console.log(`\nclient-version-gate: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

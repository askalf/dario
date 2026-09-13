#!/usr/bin/env node
// The compare path end to end: a forwarder writing into the capture sink.
//
// This is the test that was missing. `test/compare.mjs` says runCompare() is
// "deliberately not exercised" because it reads credentials and would make a
// network call — true, and it left the seam between the sink and the forwarder
// untested. The sink implemented `on` but not `removeListener`; forwardToCodex
// removes its client-close listener in a `finally`, so every comparison threw
// on the way out AFTER the upstream request had been sent and paid for, and
// was written to disk as `compare failed: res.removeListener is not a
// function`. 919 of 919 records on the production box over a week, every one
// empty, the reason sitting in a file nobody reads.
//
// Nothing here touches a real credential or the real backend: the Codex base
// URL points at a stub, which is why this file owns its import order — that
// URL is read once, when codex-backend.js loads.

import { createServer } from 'node:http';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const SLUG = 'gpt-5.5';
const port = await freePort();

// A stub Codex backend: the model list, then one complete Responses stream.
const seen = { requests: 0 };
const stub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ slug: SLUG, visibility: 'list' }] }));
    return;
  }
  seen.requests++;
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, obj, seq) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...obj })}\n\n`);
    const text = '{"entities":[],"relationships":[]}';
    const msg = { id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    const full = { id: 'r1', object: 'response', created_at: 1, status: 'completed', model: SLUG, output: [msg], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    ev('response.created', { response: { ...full, status: 'in_progress', output: [] } }, 0);
    ev('response.output_item.added', { output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }, 1);
    ev('response.output_text.delta', { item_id: 'm1', output_index: 0, content_index: 0, delta: text }, 2);
    ev('response.output_text.done', { item_id: 'm1', output_index: 0, content_index: 0, text }, 3);
    ev('response.output_item.done', { output_index: 0, item: msg }, 4);
    ev('response.completed', { response: full }, 5);
    res.end();
  });
});
await new Promise((r) => stub.listen(port, '127.0.0.1', r));

// Set BEFORE the import: codex-backend reads it once, at module load.
process.env.DARIO_CODEX_BASE_URL = `http://127.0.0.1:${port}`;
const { captureSink } = await import('../dist/compare.js');
const { forwardToCodex } = await import('../dist/codex-backend.js');

const creds = { alias: 'test', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, accountId: 'acct' };
const anthropicBody = () => Buffer.from(JSON.stringify({
  model: SLUG, max_tokens: 64,
  messages: [{ role: 'user', content: 'Extract entities. Return ONLY JSON.' }],
}));

header('a comparison completes and captures the answer');
{
  const { sink, side } = captureSink();
  let threw = null;
  try {
    await forwardToCodex({}, sink, anthropicBody(), creds, '*', {}, 10_000, false, 'anthropic');
  } catch (err) { threw = err.message; }
  const captured = side();
  check('no throw on the way out — the finally can remove its listener', threw === null, threw);
  check('the sink captured a 200', captured.status === 200, JSON.stringify(captured).slice(0, 200));
  check('and the model\'s answer, not an error envelope', captured.body.includes('entities') && !captured.body.includes('removeListener') && !captured.body.includes('"type":"error"'), captured.body.slice(0, 160));
  check('timing is recorded', typeof captured.ms === 'number' && captured.ms >= 0);
  check('the backend was actually asked once', seen.requests === 1, seen.requests);
}

header('the OpenAI shape too — both are compare targets');
{
  const { sink, side } = captureSink();
  const body = Buffer.from(JSON.stringify({ model: SLUG, messages: [{ role: 'user', content: 'x' }] }));
  let threw = null;
  try {
    await forwardToCodex({}, sink, body, creds, '*', {}, 10_000, false, 'openai');
  } catch (err) { threw = err.message; }
  const captured = side();
  check('no throw', threw === null, threw);
  check('captured a 200 with a body', captured.status === 200 && captured.body.length > 0, JSON.stringify(captured).slice(0, 200));
}

header('a sink missing removeListener is what the bug looked like');
{
  // The old stub, reconstructed: everything the body needs, no listener
  // removal. Proves the assertion above is load-bearing rather than passing
  // for some unrelated reason.
  const old = {
    statusCode: 0, headersSent: false,
    writeHead() { return this; }, setHeader() { return this; },
    write() { return true; }, end() { return this; },
    on() { return this; }, once() { return this; }, emit() { return false; },
  };
  let threw = null;
  try {
    await forwardToCodex({}, old, anthropicBody(), creds, '*', {}, 10_000, false, 'anthropic');
  } catch (err) { threw = err.message; }
  check('it throws exactly the error the box recorded 919 times', threw !== null && /removeListener is not a function/.test(threw), threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
stub.close();
process.exit(fail === 0 ? 0 : 1);

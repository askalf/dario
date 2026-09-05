#!/usr/bin/env node
/**
 * test/codex-thrown-report.mjs
 *
 * The forwardToCodex OUTCOME on the thrown path (dario#1149/#1152 review).
 *
 * There are two ways a codex request fails: the upstream answers a non-2xx,
 * or the fetch itself rejects — a reset socket, a refused connection, our own
 * abort timeout. The first exit always reported the client's stream flag and
 * model; the second reported `(502, null, false, '')`, so every transport
 * failure was recorded as a NON-streaming request against a nameless model.
 * The dashboards under-counted streams and filed the failure under ''.
 *
 * test/codex-admin-surface.mjs drives the same path through a real proxy, but
 * the model half is masked there: the proxy's analytics hook falls back to the
 * request's own model (`o.model || rawModel`, src/proxy.ts), so only the
 * stream flag is observable end to end. The outcome object is only visible
 * undiluted here.
 *
 * No network: an injected `fetch` that throws, and a fake ServerResponse.
 */

import { forwardToCodex } from '../dist/codex-backend.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}

/** Minimal ServerResponse stand-in: records status, headers and written body. */
function fakeRes() {
  return {
    statusCode: null, headers: null, chunks: [], ended: false, headersSent: false,
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs; this.headersSent = true; },
    write(s) { this.chunks.push(s); return true; },
    end(s) { if (s !== undefined) this.chunks.push(s); this.ended = true; },
    on() { return this; },
    removeListener() { return this; },
    get body() { return this.chunks.join(''); },
  };
}
const CREDS = { alias: 'test', accessToken: 'tok', idToken: undefined };
const throwingUpstream = (err) => async () => { throw err; };
const reqBody = (over = {}) => Buffer.from(JSON.stringify({
  model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], ...over,
}));

/** Run one thrown-upstream request and return the reported outcome (or null). */
async function reportOf(bodyOver, { shape = 'openai', defer = false, err = new TypeError('fetch failed') } = {}) {
  let outcome = null;
  const res = fakeRes();
  const served = await forwardToCodex(
    {}, res, reqBody(bodyOver), CREDS, '*', {}, 5000, false, shape,
    throwingUpstream(err), defer, (o) => { outcome = o; },
  );
  return { outcome, res, served };
}

header('a thrown upstream reports the CLIENT\'s stream flag, not a hardcoded false');
{
  const streaming = await reportOf({ stream: true });
  check('the client is still answered 502', streaming.served === true && streaming.res.statusCode === 502,
    String(streaming.res.statusCode));
  check('the outcome is reported at all', streaming.outcome !== null);
  check('THE BUG: a streaming request is recorded as a stream',
    streaming.outcome?.stream === true, JSON.stringify(streaming.outcome));
  check('THE BUG: and against the model it asked for, not \'\'',
    streaming.outcome?.model === 'gpt-5.6-sol', JSON.stringify(streaming.outcome));
  check('status is the 502 the client saw', streaming.outcome?.status === 502, JSON.stringify(streaming.outcome));
  check('no tokens were exchanged, so both counts are zero',
    streaming.outcome?.inputTokens === 0 && streaming.outcome?.outputTokens === 0);
  check('the account is named so per-account analytics can attribute it',
    streaming.outcome?.alias === 'test');

  const plain = await reportOf({});
  check('a NON-streaming request is still recorded as non-streaming (no over-correction)',
    plain.outcome?.stream === false, JSON.stringify(plain.outcome));
  check('...and still carries the model', plain.outcome?.model === 'gpt-5.6-sol');
}

header('the same holds on the Anthropic shape and for our own abort timeout');
{
  const ant = await reportOf({ stream: true }, { shape: 'anthropic' });
  check('anthropic streaming: recorded as a stream', ant.outcome?.stream === true, JSON.stringify(ant.outcome));
  check('anthropic streaming: recorded with the model', ant.outcome?.model === 'gpt-5.6-sol');

  const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const timedOut = await reportOf({ stream: true }, { err: abortErr });
  check('an upstream timeout lands in the same catch and keeps the metadata',
    timedOut.outcome?.stream === true && timedOut.outcome?.model === 'gpt-5.6-sol' && timedOut.outcome?.status === 502,
    JSON.stringify(timedOut.outcome));
}

header('a DECLINE still reports nothing — the next provider records what it serves');
{
  const declined = await reportOf({ stream: true }, { defer: true });
  check('the request is handed on, not answered', declined.served === false);
  check('and nothing is reported, so the row is not double-counted',
    declined.outcome === null, JSON.stringify(declined.outcome));
  check('...having written no bytes either',
    declined.res.headersSent === false && declined.res.ended === false && declined.res.chunks.length === 0);
}

header('an unparseable body reports the 400 it served, with no model to name');
{
  let outcome = null;
  const res = fakeRes();
  await forwardToCodex(
    {}, res, Buffer.from('not json'), CREDS, '*', {}, 5000, false, 'openai',
    throwingUpstream(new TypeError('fetch failed')), false, (o) => { outcome = o; },
  );
  check('the client gets a 400, not a 502', res.statusCode === 400, String(res.statusCode));
  check('reported as a 400 with no stream flag and no model — there was no request to read one from',
    outcome?.status === 400 && outcome?.stream === false && outcome?.model === '', JSON.stringify(outcome));
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);

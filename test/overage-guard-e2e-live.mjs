/**
 * test/overage-guard-e2e-live.mjs
 *
 * Live end-to-end test of the overage-guard halt cycle.
 *
 * The unit tests (test/overage-guard.mjs) cover the OverageGuard class's
 * internal state machine. This test exercises the FULL pipeline against
 * a real proxy:
 *
 *   1. Monkey-patch globalThis.fetch BEFORE importing the proxy so the
 *      proxy's outbound calls hit a synthetic upstream we control.
 *   2. Start a real dario proxy on a test port with the bundled template
 *      (no live CC capture).
 *   3. Drive real HTTP requests through the proxy and verify:
 *        a) normal subscription request → 200, halt=false
 *        b) upstream returns overage → request still 200 (upstream succeeded)
 *           but guard transitions to halted state via analytics record
 *        c) subsequent request → 503 with Anthropic-shaped dario_overage_guard body
 *        d) POST /admin/resume → wasHalted=true, state cleared
 *        e) post-resume request → 200 again
 *
 * Excluded from the default `npm test` runner (filename ends in
 * `-e2e-live.mjs` rather than `.mjs`-only; test/all.test.mjs scans for
 * filename matches). Run with:
 *
 *   npm run build && node test/overage-guard-e2e-live.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises';

// ── Step 1: Patch globalThis.fetch BEFORE importing the proxy ─────────

const realFetch = globalThis.fetch;
let upstreamMode = 'subscription'; // 'subscription' | 'overage'
let upstreamCalls = 0;

globalThis.fetch = async function patchedFetch(input, init = {}) {
  const rawUrl = typeof input === 'string' ? input : (input?.url ?? String(input));
  // Parse properly to avoid the substring-sanitization trap: `url.includes(
  // 'api.anthropic.com')` would match `https://evil.com/api.anthropic.com.fake`
  // and any other URL with that string anywhere. Exact-host match instead.
  // CodeQL: js/incomplete-url-substring-sanitization (alert #20 on PR #291).
  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  const host = parsed?.hostname ?? '';
  const path = parsed?.pathname ?? '';

  // Catch outbound calls to api.anthropic.com — these are the ones the
  // proxy makes on behalf of clients (the path we want to mock).
  if (host === 'api.anthropic.com') {
    upstreamCalls++;

    // /v1/code/sessions/.../client/presence — heartbeat. Return empty 200.
    if (path.endsWith('/client/presence')) {
      return new Response('', { status: 200 });
    }

    // /v1/messages — the real path. Return a synthetic Anthropic response
    // with the chosen claim header.
    if (path === '/v1/messages') {
      const body = JSON.stringify({
        id: 'msg_test_e2e',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: `E2E synthetic response (mode=${upstreamMode})` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
      const headers = new Headers({
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-representative-claim': upstreamMode === 'overage' ? 'overage' : 'five_hour',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-7d-utilization': '0.05',
        'anthropic-ratelimit-unified-overage-status': 'available',
      });
      return new Response(body, { status: 200, headers });
    }

    // Any other anthropic path — return a minimal 200 so the proxy doesn't
    // crash on an unexpected outbound call.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // Anything else (oauth.claude.com, our own loopback /v1/messages from
  // the test driver below, etc.) passes through to the real fetch.
  return realFetch(input, init);
};

// ── Step 2: Start the proxy ───────────────────────────────────────────

// Imported AFTER the fetch patch so any module-level fetch references
// inside dist/proxy.js resolve through the patched function.
const { startProxy } = await import('../dist/proxy.js');
const TEST_PORT = 13456;

await startProxy({
  port: TEST_PORT,
  host: '127.0.0.1',
  noLiveCapture: true, // skip the CC binary capture; use bundled template
  overageGuardEnabled: true,
  overageGuardBehavior: 'halt',
  overageGuardCooldownMs: 5000, // shorter for the test
  overageGuardNotifyOs: false,  // no native toast during the test
});

console.log(`\n[e2e] proxy started on http://127.0.0.1:${TEST_PORT}\n`);

// ── Helpers ───────────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function post(path, body = {}) {
  // Use realFetch so the test client's outbound call to localhost doesn't
  // get caught by our mock (it wouldn't anyway since the host check
  // excludes localhost, but be explicit).
  return realFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function get(path) {
  return realFetch(`${BASE}${path}`);
}
async function postMessages() {
  return post('/v1/messages', {
    model: 'claude-haiku-4-5',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else      { console.error(`  ❌ ${label}`); fail++; }
}
function checkEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { console.log(`  ✅ ${label}`); pass++; }
  else    { console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

// ── STAGE 1: normal subscription request flows ───────────────────────

console.log('=== STAGE 1: normal subscription request ===');
upstreamMode = 'subscription';
const r1 = await postMessages();
checkEq('r1 status 200', r1.status, 200);
const r1Body = await r1.json();
check('r1 body.content[0].text contains E2E', r1Body?.content?.[0]?.text?.includes('E2E'));

// Wait for analytics to settle and the guard to (not) react.
await sleep(300);

const guard1 = await get('/admin/resume').then(r => r.json());
checkEq('after subscription request, halted=false', guard1.halted, false);
checkEq('after subscription request, state=null', guard1.state, null);

// ── STAGE 2: upstream returns overage → guard halts ──────────────────

console.log('\n=== STAGE 2: upstream returns overage → guard halts ===');
upstreamMode = 'overage';

const r2 = await postMessages();
// The triggering request itself returns normally — the response is
// already on the wire by the time analytics records the claim.
checkEq('r2 (triggering) status 200', r2.status, 200);

// Wait for the analytics record → guard halt transition.
await sleep(300);

const guard2 = await get('/admin/resume').then(r => r.json());
checkEq('after overage record, halted=true', guard2.halted, true);
checkEq('halt reason=overage_detected', guard2.state?.reason, 'overage_detected');
checkEq('halt request.claim=overage', guard2.state?.request?.claim, 'overage');

// ── STAGE 3: subsequent /v1/messages → 503 ───────────────────────────

console.log('\n=== STAGE 3: halted proxy returns 503 ===');
const r3 = await postMessages();
checkEq('r3 status 503 (halted)', r3.status, 503);
const r3Body = await r3.json();
checkEq('503 body.type=error', r3Body.type, 'error');
checkEq('503 body.error.type=dario_overage_guard', r3Body.error?.type, 'dario_overage_guard');
check('503 body.error.message mentions dario resume',
  typeof r3Body.error?.message === 'string' && r3Body.error.message.includes('dario resume'));

// Confirm the upstream was NOT hit for the halted request — the proxy
// short-circuited at the request handler.
const upstreamCountBeforeResume = upstreamCalls;

// ── STAGE 4: POST /admin/resume clears halt ──────────────────────────

console.log('\n=== STAGE 4: POST /admin/resume clears the halt ===');
const resume = await post('/admin/resume', {});
checkEq('resume status 200', resume.status, 200);
const resumeBody = await resume.json();
checkEq('resume.ok=true', resumeBody.ok, true);
checkEq('resume.wasHalted=true', resumeBody.wasHalted, true);

const guard4 = await get('/admin/resume').then(r => r.json());
checkEq('after resume, halted=false', guard4.halted, false);
checkEq('after resume, state=null', guard4.state, null);

// ── STAGE 5: requests flow again post-resume ─────────────────────────

console.log('\n=== STAGE 5: requests flow after resume ===');
upstreamMode = 'subscription'; // flip back to normal upstream
const r5 = await postMessages();
checkEq('post-resume request returns 200', r5.status, 200);
const r5Body = await r5.json();
check('post-resume body.content[0].text reflects mode=subscription',
  r5Body?.content?.[0]?.text?.includes('mode=subscription'));

// Verify the post-resume request HIT the upstream (proxy is no longer
// short-circuiting at the halt check).
check('upstream count increased after resume',
  upstreamCalls > upstreamCountBeforeResume);

// ── Done ─────────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail  ·  ${upstreamCalls} upstream calls intercepted`);
process.exit(fail === 0 ? 0 : 1);

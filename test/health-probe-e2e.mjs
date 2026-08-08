#!/usr/bin/env node
// dario#905 — end-to-end wiring for the opt-in serving probe on /health.
//
// serving-probe.mjs covers the verdict policy and health-response.mjs covers
// the rendering. What NEITHER covers is the part that lives in proxy.ts and is
// the easiest to get wrong, because both of its failure directions are silent:
//
//   - opt-in leaking: a plain /health quietly starts spending tokens on every
//     docker healthcheck. Nothing breaks; the bill just grows.
//   - the trust gate leaking: a /health left world-readable through a
//     Cloudflare tunnel becomes a button the internet can press to spend the
//     operator's tokens. That is #642's fail-open, re-introduced on a surface
//     that costs money.
//
// So this drives a REAL startProxy() and counts actual upstream probe calls.
//
// Hermetic: API-key mode (no OAuth pool, no credentials.json) and a scripted
// upstream through ProxyOptions.fetchImpl — the same shape queue-slot-leak.mjs
// uses. No network, no tokens, no live account.

import { startProxy } from '../dist/proxy.js';
import { _resetServingProbeForTest } from '../dist/serving-probe.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 38781;
const BASE = `http://127.0.0.1:${PORT}`;

// Every probe the proxy sends, in order. A probe is the only POST to
// /v1/messages this test ever provokes — it never sends a client request.
const probeCalls = [];
let probeStatus = 200;

const fakeFetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/v1/messages') && init?.method === 'POST') {
    probeCalls.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'msg_probe', content: [] }), {
      status: probeStatus,
      headers: { 'content-type': 'application/json' },
    });
  }
  // Model-catalog prewarm and anything else — irrelevant here.
  return new Response(JSON.stringify({ data: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

await startProxy({
  port: PORT,
  host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key',
  noClaudeAuth: true,
  fetchImpl: fakeFetch,
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const getHealth = async (path, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: await res.json() };
};
const probeCount = () => probeCalls.length;

// ---------------------------------------------------------------------------
header('a plain /health never spends a token');
{
  _resetServingProbeForTest();
  const before = probeCount();
  const { body } = await getHealth('/health');
  check('no probe field', !('probe' in body), JSON.stringify(body));
  check('NO upstream request sent', probeCount() === before);
  check('queue snapshot still there (#910)', typeof body.queue === 'object' && body.queue !== null);
  check('stall field present on the snapshot', 'stalledSince' in body.queue, JSON.stringify(body.queue));
  check('idle queue is not stalled', body.queue.stalledSince === null);
}

// ---------------------------------------------------------------------------
header('?probe=1 from loopback runs exactly one real round-trip');
{
  _resetServingProbeForTest();
  const before = probeCount();
  const { body } = await getHealth('/health?probe=1');
  check('exactly one upstream request', probeCount() === before + 1, `sent ${probeCount() - before}`);
  check('probe verdict attached', body.probe && body.probe.ok === true, JSON.stringify(body.probe));
  check('reason served', body.probe?.reason === 'served');
  check('ageMs rendered', typeof body.probe?.ageMs === 'number');

  const sent = probeCalls[probeCalls.length - 1];
  check('went to api.anthropic.com', sent.url === 'https://api.anthropic.com/v1/messages');
  check('max_tokens 1 — stays cheap', sent.body.max_tokens === 1);
  check('api-key mode auth mirrored', sent.headers['x-api-key'] === 'sk-ant-test-not-a-real-key');
  check('no CC system prompt injected', sent.body.system === undefined);
}

// ---------------------------------------------------------------------------
header('the verdict is cached — a per-second monitor bills once per TTL');
{
  const before = probeCount();
  await getHealth('/health?probe=1');
  await getHealth('/health?probe=1');
  await getHealth('/health?probe=1');
  check('three polls, zero extra upstream requests', probeCount() === before, `sent ${probeCount() - before}`);
}

// ---------------------------------------------------------------------------
header('THE exposure that must not exist — a public caller cannot spend tokens');
{
  _resetServingProbeForTest();
  const before = probeCount();
  // cf-ray marks the request as having arrived through the Cloudflare tunnel,
  // i.e. from the public internet — the same signal that gates OAuth internals.
  const { body } = await getHealth('/health?probe=1', { 'cf-ray': '8f0000000000-IAD' });
  check('NO upstream request sent for a tunnel caller', probeCount() === before, `sent ${probeCount() - before}`);
  check('no probe field disclosed', !('probe' in body));
  // This proxy runs with NO DARIO_API_KEY, so authenticateRequest() returns
  // true for every caller. Before the keyConfigured fix, that short-circuited
  // the #642 gate before it ever looked at cf-ray, and a tunnel caller got the
  // full internal view. Both surfaces are now closed for it.
  check('no OAuth internals disclosed to a tunnel caller', !('oauth' in body), JSON.stringify(body));
  check('no expiresIn', !('expiresIn' in body));
  check('no request volume', !('requests' in body));
  check('no queue snapshot', !('queue' in body));
  check('liveness verdict only', Object.keys(body).length === 1 && body.status !== undefined, JSON.stringify(body));
}

header('an unkeyed proxy still serves its own healthcheck in full');
{
  // The reason the fix routes through the transport rules instead of just
  // demanding a key: docker HEALTHCHECK and `dario doctor` hit loopback with
  // no key and no cf-ray, and must keep seeing everything.
  const { body } = await getHealth('/health');
  check('bare loopback still gets OAuth internals', 'oauth' in body, JSON.stringify(body));
  check('bare loopback still gets the queue snapshot', typeof body.queue === 'object');
  check('bare loopback still gets version', typeof body.version === 'string');
}

// ---------------------------------------------------------------------------
header('a failing probe surfaces on the trusted surface');
{
  _resetServingProbeForTest();
  probeStatus = 401;
  const { body } = await getHealth('/health?probe=1');
  check('probe reports failure', body.probe?.ok === false, JSON.stringify(body.probe));
  check('reason auth-rejected', body.probe?.reason === 'auth-rejected');
  check('status carried', body.probe?.status === 401);
  check('body reads degraded', body.status === 'degraded');
  probeStatus = 200;
}

// ---------------------------------------------------------------------------
header('a throttled upstream does not read as an outage');
{
  _resetServingProbeForTest();
  probeStatus = 429;
  const { body } = await getHealth('/health?probe=1');
  check('429 keeps the probe ok', body.probe?.ok === true, JSON.stringify(body.probe));
  check('reason still visible', body.probe?.reason === 'rate-limited');
  probeStatus = 200;
}

// ---------------------------------------------------------------------------
header('falsey spellings do not trigger a billed request');
{
  _resetServingProbeForTest();
  const before = probeCount();
  for (const q of ['?probe=0', '?probe=false', '?probe=yes', '?verbose=1']) {
    const { body } = await getHealth(`/health${q}`);
    check(`${q} → no probe`, !('probe' in body));
  }
  check('no upstream requests for any of them', probeCount() === before, `sent ${probeCount() - before}`);
}

console.log(`\nhealth-probe-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

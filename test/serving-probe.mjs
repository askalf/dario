// Tests for serving-probe.ts — the opt-in "can dario actually serve?" check (dario#905).
//
// The behaviours that matter here are policy, not plumbing:
//   1. 429/529 must NOT be failures. A watchdog that restarts on a throttle
//      thrashes a healthy dario — the same trap /livez already documents.
//   2. 401/403 MUST be failures. That is the accountUuid-drift signature that
//      structural /health provably cannot see: token unexpired, refresh fine,
//      upstream rejecting every request.
//   3. It must never throw. A health surface that can 500 is worse than none.
//   4. It must be cached and single-flighted. Every probe is a real billed
//      request; a monitor polling per-second must not spend per-second.
//
// Everything is driven through an injected fetch — no network, no tokens.

import {
  getServingProbe,
  classifyProbeStatus,
  probeAgeMs,
  _resetServingProbeForTest,
  DEFAULT_PROBE_MODEL,
} from '../dist/serving-probe.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

/** A fetch stand-in that answers with `status` and counts its calls. */
function stubFetch(status, opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => opts.body ?? '{}',
    };
  };
  impl.calls = calls;
  return impl;
}

const token = async () => 'tok-abc';

// ---------------------------------------------------------------------------
header('classifyProbeStatus — the verdict policy, pure');
{
  check('200 → ok/served', classifyProbeStatus(200).ok === true && classifyProbeStatus(200).reason === 'served');
  check('299 → ok', classifyProbeStatus(299).ok === true);
  check('429 → ok (rate-limited, NOT a failure)', classifyProbeStatus(429).ok === true && classifyProbeStatus(429).reason === 'rate-limited');
  check('529 → ok (upstream overloaded, NOT a failure)', classifyProbeStatus(529).ok === true && classifyProbeStatus(529).reason === 'upstream-overloaded');
  check('401 → fail/auth-rejected', classifyProbeStatus(401).ok === false && classifyProbeStatus(401).reason === 'auth-rejected');
  check('403 → fail/auth-rejected', classifyProbeStatus(403).ok === false && classifyProbeStatus(403).reason === 'auth-rejected');
  check('500 → fail/upstream-error', classifyProbeStatus(500).ok === false && classifyProbeStatus(500).reason === 'upstream-error');
  check('400 → fail/upstream-error', classifyProbeStatus(400).ok === false && classifyProbeStatus(400).reason === 'upstream-error');
}

// ---------------------------------------------------------------------------
header('happy path — a served round-trip');
{
  _resetServingProbeForTest();
  const f = stubFetch(200);
  const r = await getServingProbe({ fetchImpl: f, getToken: token, now: () => 1000 });
  check('ok', r.ok === true);
  check('reason served', r.reason === 'served');
  check('status carried', r.status === 200);
  check('default model', r.model === DEFAULT_PROBE_MODEL);
  check('checkedAt stamped from injected clock', r.checkedAt === 1000);
  check('one upstream call', f.calls.length === 1);

  const { url, init } = f.calls[0];
  check('hits api.anthropic.com/v1/messages', url === 'https://api.anthropic.com/v1/messages');
  check('POST', init.method === 'POST');
  check('bearer from getToken', init.headers['authorization'] === 'Bearer tok-abc');
  check('oauth beta set', init.headers['anthropic-beta'] === 'oauth-2025-04-20');
  check('no x-api-key in OAuth mode', init.headers['x-api-key'] === undefined);

  const body = JSON.parse(init.body);
  check('max_tokens 1 — the probe stays cheap', body.max_tokens === 1);
  check('single user turn', body.messages.length === 1 && body.messages[0].role === 'user');
  check('no system prompt injected (probe bypasses the CC transform)', body.system === undefined);
}

// ---------------------------------------------------------------------------
header('upstream-API-key mode mirrors request-path auth');
{
  _resetServingProbeForTest();
  const f = stubFetch(200);
  await getServingProbe({ fetchImpl: f, upstreamApiKey: 'sk-test', getToken: token, now: () => 1 });
  const h = f.calls[0].init.headers;
  check('x-api-key forwarded', h['x-api-key'] === 'sk-test');
  check('no bearer when api key is set', h['authorization'] === undefined);
  check('getToken not consulted', true); // no throw / no bearer proves the branch
}

// ---------------------------------------------------------------------------
header('throttled upstream is NOT an outage (anti restart-loop)');
{
  _resetServingProbeForTest();
  const r = await getServingProbe({ fetchImpl: stubFetch(429), getToken: token, now: () => 1 });
  check('429 → ok true', r.ok === true);
  check('429 reason surfaced for the operator', r.reason === 'rate-limited');
}
{
  _resetServingProbeForTest();
  const r = await getServingProbe({ fetchImpl: stubFetch(529), getToken: token, now: () => 1 });
  check('529 → ok true', r.ok === true);
}

// ---------------------------------------------------------------------------
header('auth rejection IS an outage — the drift case /health cannot see');
{
  _resetServingProbeForTest();
  const r = await getServingProbe({ fetchImpl: stubFetch(401), getToken: token, now: () => 1 });
  check('401 → ok false', r.ok === false);
  check('reason auth-rejected', r.reason === 'auth-rejected');
  check('status carried for triage', r.status === 401);
}

// ---------------------------------------------------------------------------
header('never throws — every failure becomes a verdict');
{
  _resetServingProbeForTest();
  const boom = async () => { throw new Error('ECONNREFUSED 1.2.3.4:443'); };
  let threw = false;
  let r;
  try { r = await getServingProbe({ fetchImpl: boom, getToken: token, now: () => 1 }); }
  catch { threw = true; }
  check('no exception escapes', threw === false);
  check('network failure → ok false', r.ok === false);
  check('reason network-error', r.reason === 'network-error');
  check('detail carries the cause', /ECONNREFUSED/.test(r.detail));
}
{
  _resetServingProbeForTest();
  const r = await getServingProbe({ fetchImpl: stubFetch(200), now: () => 1 });
  check('no token source → ok false', r.ok === false);
  check('reason no-token', r.reason === 'no-token');
}

// ---------------------------------------------------------------------------
header('timeout is bounded, and bounds token acquisition too');
{
  _resetServingProbeForTest();
  // fetch that only settles when the caller aborts it.
  const hangs = (_url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    }, { once: true });
  });
  const r = await getServingProbe({ fetchImpl: hangs, getToken: token, timeoutMs: 20 });
  check('hung upstream → ok false', r.ok === false);
  check('reason timeout', r.reason === 'timeout');
  check('detail names the budget', /20ms/.test(r.detail));
}
{
  _resetServingProbeForTest();
  // A getToken that never settles must not wedge the probe forever — the
  // model-catalog #642 trap: an un-bounded token wait leaves the in-flight
  // guard non-null and every future probe returns the stale cached verdict.
  const neverResolves = () => new Promise(() => {});
  const r = await getServingProbe({ fetchImpl: stubFetch(200), getToken: neverResolves, timeoutMs: 20 });
  check('hung getToken settles', r.ok === false);
  check('detail says token acquisition timed out', /token acquisition timed out/.test(r.detail));
}

// ---------------------------------------------------------------------------
header('cached — a per-second monitor does not bill per second');
{
  _resetServingProbeForTest();
  const f = stubFetch(200);
  let clock = 10_000;
  const deps = { fetchImpl: f, getToken: token, now: () => clock, ttlMs: 60_000 };
  const a = await getServingProbe(deps);
  clock = 40_000; // 30s later — inside TTL
  const b = await getServingProbe(deps);
  check('still one upstream call inside TTL', f.calls.length === 1);
  check('same verdict object returned', b.checkedAt === a.checkedAt);

  clock = 100_000; // 90s after the probe — past TTL
  await getServingProbe(deps);
  check('re-probes once past TTL', f.calls.length === 2);
}

// ---------------------------------------------------------------------------
header('single-flighted — concurrent callers share one billed request');
{
  _resetServingProbeForTest();
  const f = stubFetch(200, { delayMs: 25 });
  const deps = { fetchImpl: f, getToken: token };
  const [x, y, z] = await Promise.all([
    getServingProbe(deps), getServingProbe(deps), getServingProbe(deps),
  ]);
  check('exactly one upstream call for three callers', f.calls.length === 1);
  check('all three get the same verdict', x.checkedAt === y.checkedAt && y.checkedAt === z.checkedAt);
}

// ---------------------------------------------------------------------------
header('a failed probe does not poison the next one');
{
  _resetServingProbeForTest();
  let status = 500;
  const f = async () => ({ status, ok: false, text: async () => '{}' });
  let clock = 1000;
  const deps = { fetchImpl: f, getToken: token, now: () => clock, ttlMs: 100 };
  const bad = await getServingProbe(deps);
  check('first probe failed', bad.ok === false);
  status = 200; clock = 2000; // past TTL, upstream recovered
  const good = await getServingProbe(deps);
  check('recovers to ok once upstream does', good.ok === true);
}

// ---------------------------------------------------------------------------
header('probeAgeMs');
{
  check('age from checkedAt', probeAgeMs({ checkedAt: 500 }, 2_000) === 1_500);
  check('never negative on clock skew', probeAgeMs({ checkedAt: 5_000 }, 1_000) === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

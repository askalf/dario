#!/usr/bin/env node
/**
 * test/provider-cooldown.mjs
 *
 * DEV-f66b131c — when EVERY entry in the failover chain is rate-limited, the
 * chain used to cycle between them: one request touched codex, then claude,
 * then codex again before dropping. 185 such lines in 38 minutes on
 * 2026-09-02, each doomed request spending quota on BOTH accounts.
 *
 * The assertions that matter here are COUNTS, not outcomes — the outcome was
 * always "the request fails". What was wrong is how many upstream attempts it
 * cost to get there, and how many the NEXT request costs.
 *
 * Two halves:
 *   1. the cool-down primitives (src/provider-cooldown.ts), pure, clock injected
 *   2. forwardToCodex's decline report, against an injected fetch — the signal
 *      the request path cools on (status + the upstream's own retry-after)
 *
 * No network, no live proxy, no sleeping.
 */

import {
  ProviderCooldowns,
  canAttempt,
  allProvidersCooled,
  cooldownRetryAfterMs,
  parseRetryAfterMs,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  ALL_PROVIDERS_RATE_LIMITED,
} from '../dist/provider-cooldown.js';
import { forwardToCodex } from '../dist/codex-backend.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function eq(label, actual, expected) {
  check(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, actual === expected);
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}

/** A clock we advance by hand, so a 60s cool-down costs no wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const CREDS = { alias: 'fleet', accessToken: 'tok', idToken: undefined };

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers) { this.headersSent = true; this.statusCode = status; Object.assign(this.headers, headers ?? {}); },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; },
  };
}

/** An upstream that answers `status` with the given headers, never a stream. */
function upstreamReturning(status, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null, entries: () => Object.entries(headers)[Symbol.iterator]() },
    text: async () => 'rate limit reached',
    body: null,
  });
}

// ─── 1. parseRetryAfterMs ───────────────────────────────────────────────────

header('1. parseRetryAfterMs — delta-seconds, HTTP-date, and the junk cases');
{
  const now = Date.parse('2026-09-02T20:13:40Z');
  eq('delta-seconds', parseRetryAfterMs('30', now), 30_000);
  eq('zero is honoured as retry-now', parseRetryAfterMs('0', now), 0);
  eq('absent → null (caller uses its default)', parseRetryAfterMs(null, now), null);
  eq('empty → null', parseRetryAfterMs('   ', now), null);
  eq('unparseable → null, never NaN', parseRetryAfterMs('soon', now), null);
  eq('HTTP-date 120s out', parseRetryAfterMs('Wed, 02 Sep 2026 20:15:40 GMT', now), 120_000);
  eq('a date in the past clamps to 0, never negative', parseRetryAfterMs('Wed, 02 Sep 2026 20:00:00 GMT', now), 0);
  eq('an absurd delta clamps to the ceiling', parseRetryAfterMs('86400', now), MAX_COOLDOWN_MS);
}

// ─── 2. ProviderCooldowns ───────────────────────────────────────────────────

header('2. ProviderCooldowns — a 429 cools, time expires it, a success clears it');
{
  const clock = fakeClock();
  const cd = new ProviderCooldowns(clock.now);

  check('nothing is cooled to start with', !cd.isCooled('codex'));
  eq('a 429 with no retry-after uses the default', cd.note('codex'), DEFAULT_COOLDOWN_MS);
  check('codex is now cooled', cd.isCooled('codex'));
  check('claude is untouched', !cd.isCooled('claude'));

  clock.advance(DEFAULT_COOLDOWN_MS - 1);
  check('still cooled 1ms before expiry', cd.isCooled('codex'));
  clock.advance(2);
  check('no longer cooled after expiry', !cd.isCooled('codex'));

  cd.note('claude', 5_000);
  eq('retry-after drives the remaining time', cd.remainingMs('claude'), 5_000);
  cd.clear('claude');
  eq('a success clears it outright', cd.remainingMs('claude'), 0);

  cd.note('codex', 999 * 60_000);
  check('an absurd retry-after is capped', cd.remainingMs('codex') <= MAX_COOLDOWN_MS);
}

// ─── 3. The chain rules ─────────────────────────────────────────────────────

header('3. canAttempt / allProvidersCooled — within a request and across them');
{
  const clock = fakeClock();
  const cd = new ProviderCooldowns(clock.now);
  const attempted = new Set();

  check('codex attemptable at the start', canAttempt('codex', attempted, cd));
  attempted.add('codex');
  // The codex -> claude -> codex revisit inside one request id, refused.
  eq('NOT attemptable a second time in the same request', canAttempt('codex', attempted, cd), false);

  check('an empty chain is not "all cooled"', !allProvidersCooled([], cd));
  cd.note('codex'); cd.note('claude');
  check('both cooled → the terminal condition', allProvidersCooled(['codex', 'claude'], cd));
  clock.advance(DEFAULT_COOLDOWN_MS + 1);
  check('and it lapses on its own', !allProvidersCooled(['codex', 'claude'], cd));

  cd.note('codex', 10_000); cd.note('claude', 45_000);
  eq('retry-after is the LONGEST remaining', cooldownRetryAfterMs(['codex', 'claude'], cd), 45_000);
  eq('the verdict string is stable', ALL_PROVIDERS_RATE_LIMITED, 'all-providers-rate-limited');
}

// ─── 4. The chain walk — attempt COUNTS, which is the actual defect ─────────
//
// A faithful stand-in for the request path: try codex if the rules allow, then
// claude if the rules allow, and count the upstream attempts each request
// costs. `codexUp` / `claudeUp` say whether each account can serve.

function runChain({ cooldowns, codex429, claude429 }) {
  const attempted = new Set();
  const attempts = [];
  let verdict = 'served';

  if (canAttempt('codex', attempted, cooldowns)) {
    attempts.push('codex');
    attempted.add('codex');
    if (codex429) cooldowns.note('codex');
    else { cooldowns.clear('codex'); return { attempts, verdict: 'served-by-codex' }; }
  }
  if (canAttempt('claude', attempted, cooldowns)) {
    attempts.push('claude');
    attempted.add('claude');
    if (claude429) cooldowns.note('claude');
    else { cooldowns.clear('claude'); return { attempts, verdict: 'served-by-claude' }; }
  }
  if (allProvidersCooled(['codex', 'claude'], cooldowns)) verdict = ALL_PROVIDERS_RATE_LIMITED;
  else verdict = 'upstream-error';
  return { attempts, verdict };
}

header('4. (a) codex 429 + claude healthy — one failover, still served');
{
  const cd = new ProviderCooldowns(fakeClock().now);
  const r = runChain({ cooldowns: cd, codex429: true, claude429: false });
  eq('attempt order', r.attempts.join('→'), 'codex→claude');
  eq('two attempts, not three', r.attempts.length, 2);
  eq('served by claude', r.verdict, 'served-by-claude');
  check('single-provider failover is NOT weakened', !cd.isCooled('claude'));
}

header('4. (b) claude 429 + codex healthy — served on codex');
{
  const clock = fakeClock();
  const cd = new ProviderCooldowns(clock.now);
  cd.note('claude', 30_000); // the pool 429'd first, as it does mid-flight
  const r = runChain({ cooldowns: cd, codex429: false, claude429: true });
  eq('codex only', r.attempts.join('→'), 'codex');
  eq('served by codex', r.verdict, 'served-by-codex');
}

header('4. (c) BOTH 429 — one attempt per entry, no revisit, then no attempts at all');
{
  const clock = fakeClock();
  const cd = new ProviderCooldowns(clock.now);

  const first = runChain({ cooldowns: cd, codex429: true, claude429: true });
  eq('request 1 attempts each entry exactly once', first.attempts.join('→'), 'codex→claude');
  eq('request 1 costs TWO attempts, not three (no codex revisit)', first.attempts.length, 2);
  eq('request 1 ends on the terminal verdict', first.verdict, ALL_PROVIDERS_RATE_LIMITED);

  // This is the whole ticket: the NEXT request must cost nothing.
  const second = runChain({ cooldowns: cd, codex429: true, claude429: true });
  eq('request 2 makes ZERO upstream attempts', second.attempts.length, 0);
  eq('request 2 fails fast with the same verdict', second.verdict, ALL_PROVIDERS_RATE_LIMITED);

  let total = 0;
  for (let i = 0; i < 20; i++) total += runChain({ cooldowns: cd, codex429: true, claude429: true }).attempts.length;
  eq('20 further requests inside the window cost 0 attempts', total, 0);

  // …and the window is bounded: it re-probes once it lapses.
  clock.advance(DEFAULT_COOLDOWN_MS + 1);
  const afterExpiry = runChain({ cooldowns: cd, codex429: true, claude429: true });
  eq('after the cool-down lapses it re-probes both', afterExpiry.attempts.join('→'), 'codex→claude');
}

header('4. (d) a retry-after header is honoured for its stated duration');
{
  const clock = fakeClock();
  const cd = new ProviderCooldowns(clock.now);
  cd.note('codex', parseRetryAfterMs('120', clock.now()));
  cd.note('claude', parseRetryAfterMs('120', clock.now()));
  eq('cooled for the header value, not the default', cooldownRetryAfterMs(['codex', 'claude'], cd), 120_000);
  clock.advance(DEFAULT_COOLDOWN_MS + 1); // past the DEFAULT, inside the header
  eq('still no attempts past the default window', runChain({ cooldowns: cd, codex429: true, claude429: true }).attempts.length, 0);
  clock.advance(120_000);
  eq('re-probes once the stated window passes', runChain({ cooldowns: cd, codex429: true, claude429: true }).attempts.length, 2);
}

// ─── 5. forwardToCodex reports WHY it declined ──────────────────────────────

header('5. forwardToCodex — the decline hook carries status + retry-after');
{
  const declines = [];
  const declined = await forwardToCodex(
    {}, fakeRes(), Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'openai',
    upstreamReturning(429, { 'retry-after': '90' }), true, undefined,
    (d) => declines.push(d),
  );
  eq('a 429 still declines (failover intact)', declined, false);
  eq('exactly one decline reported', declines.length, 1);
  eq('status is carried', declines[0]?.status, 429);
  eq('retry-after is parsed to ms', declines[0]?.retryAfterMs, 90_000);
}

{
  const declines = [];
  await forwardToCodex(
    {}, fakeRes(), Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'openai',
    upstreamReturning(503), true, undefined,
    (d) => declines.push(d),
  );
  eq('a 5xx declines too', declines.length, 1);
  eq('…reported as 503, so the caller can decline to cool it', declines[0]?.status, 503);
  eq('no retry-after → null, not 0', declines[0]?.retryAfterMs, null);
}

{
  const declines = [];
  const transport = async () => { throw new Error('ECONNREFUSED'); };
  await forwardToCodex(
    {}, fakeRes(), Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'openai',
    transport, true, undefined,
    (d) => declines.push(d),
  );
  eq('a transport failure reports status 0 (never got one)', declines[0]?.status, 0);
}

{
  // A 400 is OUR fault and must still be surfaced, hook or no hook.
  const declines = [];
  const res = fakeRes();
  const served = await forwardToCodex(
    {}, res, Buffer.from(JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })),
    CREDS, '*', {}, 5000, false, 'openai',
    upstreamReturning(400), true, undefined,
    (d) => declines.push(d),
  );
  eq('a 400 answers the client rather than deferring', served, true);
  eq('and reports no decline', declines.length, 0);
  eq('client saw the 400', res.statusCode, 400);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

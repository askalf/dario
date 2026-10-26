#!/usr/bin/env node
// The credits rung of the failover chain (src/credits-rung.ts).
//
// A `--pool-fallback` entry written `credits:<model>` names the API credits a
// Max plan includes as a rung: when every seat is drained or cooling and no
// subscription rung can serve, the request goes to api.anthropic.com as a
// plain API request on DARIO_CREDITS_API_KEY. Two halves are proved here.
//
// The pure half: how a chain is read (which entries are credits entries, what
// the subscription and openai-compat rungs see once they are taken out, which
// metered rung is asked first), what goes out on the wire (x-api-key, no
// OAuth beta), and how the rung is described to the operator.
//
// The live half: a real proxy with one Claude seat and the rung armed. The
// seat is healthy at selection time and 429s once dispatched, so the first
// request moves to the key MID-FLIGHT; that parks the seat, so the second is
// re-pointed at selection time. The Anthropic upstream is ProxyOptions.fetchImpl,
// which answers a bearer with a 429 and the key with a 200, and records every
// call so the thin body and the headers can be inspected. A second proxy has
// the entry but no key: the entry must be inert and the honest 429 must stand.
//
// Hermetic: HOME is a mkdtemp'd dir with one Claude account and nothing else.
// No network.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The pure half.
// ---------------------------------------------------------------------------
const {
  CREDITS_PREFIX, ACCOUNT_KEY_CREDITS, creditsFallbackMarker, isCreditsEntry, creditsEntryModel,
  creditsEntries, withoutCreditsEntries, creditsBeforePlain, pickCreditsTarget, creditsHeaders,
  describeCreditsRung,
} = await import('../dist/credits-rung.js');
const { billingBucketFromClaim, isNonSubscriptionBilling, CREDITS_CLAIM } = await import('../dist/analytics.js');
const { ledgerBucketFor } = await import('../dist/ledger.js');

header('reading the chain');
{
  check('the prefix is credits:', CREDITS_PREFIX === 'credits:');
  check('the marker is the prefix plus the model', creditsFallbackMarker('claude-sonnet-5') === 'credits:claude-sonnet-5');
  check('a credits entry is recognised, case and whitespace aside',
    isCreditsEntry('credits:claude-sonnet-5') && isCreditsEntry('  Credits:claude-opus-5 ') && !isCreditsEntry('claude:opus') && !isCreditsEntry('gpt-5.6-sol'));
  check('the model half comes back as written', creditsEntryModel('credits:claude-opus-5:high') === 'claude-opus-5:high');
  check('an empty model half is no entry', creditsEntryModel('credits:') === null && creditsEntryModel('credits: ') === null);
  const chain = ['gpt-5.6-sol', 'credits:claude-sonnet-5', 'claude-sonnet-5', 'credits:claude-opus-5'];
  check('creditsEntries lists the models in chain order', JSON.stringify(creditsEntries(chain)) === JSON.stringify(['claude-sonnet-5', 'claude-opus-5']));
  check('withoutCreditsEntries is what the other rungs read', JSON.stringify(withoutCreditsEntries(chain)) === JSON.stringify(['gpt-5.6-sol', 'claude-sonnet-5']));
  check('a chain without credits entries is returned whole', JSON.stringify(withoutCreditsEntries(['a', 'b'])) === JSON.stringify(['a', 'b']));
}

header('which metered rung is asked first: the chain decides');
{
  check('credits written before the plain entry: credits first', creditsBeforePlain(['credits:claude-sonnet-5', 'gpt-5.6-sol']) === true);
  check('credits written after the plain entry: the backend first', creditsBeforePlain(['gpt-5.6-sol', 'credits:claude-sonnet-5']) === false);
  check('nothing but credits: credits first', creditsBeforePlain(['credits:claude-sonnet-5']) === true);
  check('no credits entry at all: false, there is nothing to ask', creditsBeforePlain(['gpt-5.6-sol', 'claude-sonnet-5']) === false && creditsBeforePlain([]) === false);
}

header('pickCreditsTarget resolves against the catalog like any Claude entry');
{
  const bases = ['claude-sonnet-5', 'claude-opus-5'];
  const t = pickCreditsTarget(['gpt-5.6-sol', 'credits:claude-sonnet-5'], bases);
  check('the first credits entry the catalog lists is the target', t !== null && t.model === 'claude-sonnet-5', JSON.stringify(t));
  const eff = pickCreditsTarget(['credits:claude:opus:high'], bases);
  check('an effort suffix is carried on the target (credits:claude:opus:high)', eff !== null && eff.model === 'claude-opus-5' && eff.effort === 'high', JSON.stringify(eff));
  const effHyphen = pickCreditsTarget(['credits:claude-opus-5-high'], bases);
  check('...in the hyphen spelling too', effHyphen !== null && effHyphen.model === 'claude-opus-5' && effHyphen.effort === 'high', JSON.stringify(effHyphen));
  const alias = pickCreditsTarget(['credits:sonnet'], bases);
  check('an alias resolves against the catalog', alias !== null && alias.model === 'claude-sonnet-5', JSON.stringify(alias));
  check('a name the catalog does not list is skipped, not sent (a typo must not become a 404 billed to the key)',
    pickCreditsTarget(['credits:claude-nope-9'], bases) === null);
  const second = pickCreditsTarget(['credits:claude-nope-9', 'credits:claude-opus-5'], bases);
  check('...and the next credits entry is tried', second !== null && second.model === 'claude-opus-5', JSON.stringify(second));
  check('no credits entry: null', pickCreditsTarget(['gpt-5.6-sol', 'claude-sonnet-5'], bases) === null);
}

header('creditsHeaders: a plain API client, nothing of Claude Code');
{
  const h = creditsHeaders('sk-ant-test', 'oauth-2025-04-20,interleaved-thinking-2025-05-14', '2023-06-01');
  check('x-api-key carries the key', h['x-api-key'] === 'sk-ant-test');
  check('no Authorization header', !('Authorization' in h) && !('authorization' in h));
  check('the version header is set', h['anthropic-version'] === '2023-06-01');
  check('the OAuth beta is removed, the client\'s other betas stay', h['anthropic-beta'] === 'interleaved-thinking-2025-05-14');
  const none = creditsHeaders('sk-ant-test', 'oauth-2025-04-20');
  check('a beta list that was only the OAuth flag yields no beta header at all', !('anthropic-beta' in none));
  check('no client beta: no beta header', !('anthropic-beta' in creditsHeaders('sk-ant-test', undefined)));
  check('nothing of Claude Code\'s identity is in the set',
    Object.keys(h).every((k) => !/^x-(app|claude|stainless)/i.test(k) && k.toLowerCase() !== 'user-agent'), Object.keys(h).join(','));
}

header('describeCreditsRung: the startup line and doctor share one phrase');
{
  check('no credits entry: null', describeCreditsRung(['gpt-5.6-sol'], true) === null);
  const armed = describeCreditsRung(['gpt-5.6-sol', 'credits:claude-sonnet-5'], true);
  check('armed: names the model, the header and the bucket',
    armed.includes('API credits as claude-sonnet-5') && armed.includes('x-api-key') && armed.includes('billing bucket credits, metered in the ledger'), armed);
  const inert = describeCreditsRung(['credits:claude-sonnet-5'], false);
  check('without the key: says inert and names the variable',
    inert.includes('inert') && inert.includes('DARIO_CREDITS_API_KEY'), inert);
}

header('the claim, the bucket, the ledger, the guard');
{
  check('the claim constant', CREDITS_CLAIM === 'anthropic_credits');
  check('the analytics account key', ACCOUNT_KEY_CREDITS === '__credits__');
  check('claim → bucket credits', billingBucketFromClaim(CREDITS_CLAIM) === 'credits');
  check('the ledger files it as metered', ledgerBucketFor({ status: 200, claim: CREDITS_CLAIM }) === 'metered');
  check('a failed credits request is not counted', ledgerBucketFor({ status: 429, claim: CREDITS_CLAIM }) === null);
  check('the overage guard does not halt on it', isNonSubscriptionBilling(CREDITS_CLAIM) === false);
}

// ---------------------------------------------------------------------------
// The live half. HOME is set BEFORE importing proxy.js: the accounts modules
// resolve their directories at module-evaluation time.
// ---------------------------------------------------------------------------
const PROXY_ARMED_PORT = await freePort();
const PROXY_NOKEY_PORT = await freePort();
const PROXY_FORBIDDEN_PORT = await freePort();
const KEY = 'sk-ant-test-credits-rung';

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-credits-rung-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.DARIO_CREDITS_API_KEY;

await mkdir(join(tmpHome, '.dario', 'accounts'), { recursive: true });
await writeFile(
  join(tmpHome, '.dario', 'accounts', 'main.json'),
  JSON.stringify({
    alias: 'main',
    accessToken: 'claude-access-token',
    refreshToken: 'claude-refresh-token',
    expiresAt: Date.now() + 6 * 3_600_000,
    scopes: ['user:inference'],
    deviceId: 'dev-1',
    accountUuid: 'uuid-1',
  }),
);

const { startProxy } = await import('../dist/proxy.js');

const bodyText = (b) => b == null ? '' : (typeof b === 'string' ? b : Buffer.from(b).toString());
// What the key answers: 'ok' serves; 'forbidden' is a non-billing 403, the
// shape Anthropic sends for a key without permission for the resource.
const makeFetch = (calls, keyAnswer = 'ok') => async (url, init = {}) => {
  const target = String(url);
  if (target.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }, { id: 'claude-opus-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const headers = new Headers(init.headers ?? {});
  let body = null;
  try { body = JSON.parse(bodyText(init.body)); } catch { body = null; }
  const call = {
    url: target,
    auth: headers.get('authorization'),
    apiKey: headers.get('x-api-key'),
    beta: headers.get('anthropic-beta'),
    version: headers.get('anthropic-version'),
    userAgent: headers.get('user-agent'),
    body,
  };
  calls.push(call);
  if (call.apiKey && keyAnswer === 'forbidden') {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' },
    }), { status: 403, headers: { 'content-type': 'application/json', 'request-id': 'req_credits_403' } });
  }
  if (call.apiKey) {
    // The key serves. A plain API response: no unified rate-limit claim.
    return new Response(JSON.stringify({
      id: 'msg_credits_1', type: 'message', role: 'assistant', model: body?.model ?? 'claude-sonnet-5',
      content: [{ type: 'text', text: 'hi from the credits rung' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_credits_1' } });
  }
  // The seat is over its five-hour window: utilization at the threshold is
  // what parks it until the stated reset (pool.ts isWindowRejection), so the
  // request after this one meets a parked seat at selection time.
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 300),
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 300),
    },
  });
};

const armedCalls = [];
const nokeyCalls = [];
const forbiddenCalls = [];
const common = { host: '127.0.0.1', passthrough: false, verbose: false, noLiveCapture: true };
await startProxy({ ...common, port: PROXY_ARMED_PORT, poolFallbackModel: 'credits:claude-sonnet-5', creditsApiKey: KEY, fetchImpl: makeFetch(armedCalls) });
await startProxy({ ...common, port: PROXY_NOKEY_PORT, poolFallbackModel: 'credits:claude-sonnet-5', creditsApiKey: '', fetchImpl: makeFetch(nokeyCalls) });
await startProxy({ ...common, port: PROXY_FORBIDDEN_PORT, poolFallbackModel: 'credits:claude-sonnet-5', creditsApiKey: KEY, fetchImpl: makeFetch(forbiddenCalls, 'forbidden') });

const BASE_ARMED = `http://127.0.0.1:${PROXY_ARMED_PORT}`;
const BASE_NOKEY = `http://127.0.0.1:${PROXY_NOKEY_PORT}`;
const BASE_FORBIDDEN = `http://127.0.0.1:${PROXY_FORBIDDEN_PORT}`;
for (const base of [BASE_ARMED, BASE_NOKEY, BASE_FORBIDDEN]) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/health`); break; } catch { await sleep(100); }
  }
}

const messages = (base) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});
const chat = (base) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'ping' }] }),
});

header('armed: the seat 429s mid-flight, the key serves the same request');
{
  const res = await messages(BASE_ARMED);
  const text = await res.text();
  check('status is 200', res.status === 200, `${res.status} ${text.slice(0, 200)}`);
  check('the answer came from the key', text.includes('hi from the credits rung'), text.slice(0, 200));
  check('the response is marked credits:<model>', res.headers.get('x-dario-pool-fallback') === 'credits:claude-sonnet-5',
    String(res.headers.get('x-dario-pool-fallback')));
  check('the seat was asked first (this IS mid-flight)', armedCalls.length === 2 && armedCalls[0].auth !== null && armedCalls[0].apiKey === null,
    JSON.stringify(armedCalls.map((c) => ({ auth: !!c.auth, apiKey: !!c.apiKey }))));
  const key = armedCalls[1];
  check('the key request carries x-api-key and no bearer', key && key.apiKey === KEY && key.auth === null, JSON.stringify({ keyMatches: key?.apiKey === KEY, auth: key?.auth === null ? null : 'present' }));
  check('the key request went to the Messages path', key && /\/v1\/messages(\?|$)/.test(key.url), key?.url);
  check('the OAuth beta is gone, the client\'s other beta stays', key && key.beta === 'interleaved-thinking-2025-05-14', String(key?.beta));
  check('nothing of Claude Code\'s user agent', key && (key.userAgent === null || !/claude-cli/i.test(key.userAgent)), String(key?.userAgent));
  check('the model is swapped for the rung\'s', key?.body?.model === 'claude-sonnet-5', JSON.stringify(key?.body?.model));
  check('the client\'s own messages go out', key?.body?.messages?.[0]?.content === 'ping', JSON.stringify(key?.body?.messages));
  check('no Claude Code template system prompt', key?.body?.system === undefined, String(JSON.stringify(key?.body?.system)).slice(0, 120));
  check('no Claude Code identity in the body', key?.body?.metadata === undefined, String(JSON.stringify(key?.body?.metadata)));
  const seat = armedCalls[0];
  check('the seat request before it DID carry the template (so the thinning is the rung\'s doing)',
    seat?.body?.system !== undefined || seat?.body?.metadata !== undefined, JSON.stringify(Object.keys(seat?.body ?? {})));
}

header('armed: the seat is now parked, the key is chosen at selection time');
{
  const before = armedCalls.length;
  const res = await messages(BASE_ARMED);
  const text = await res.text();
  check('status is 200', res.status === 200, `${res.status} ${text.slice(0, 200)}`);
  check('the response is marked', res.headers.get('x-dario-pool-fallback') === 'credits:claude-sonnet-5', String(res.headers.get('x-dario-pool-fallback')));
  check('the parked seat was not asked: one call, on the key', armedCalls.length === before + 1 && armedCalls[before].apiKey === KEY && armedCalls[before].auth === null,
    JSON.stringify(armedCalls.slice(before).map((c) => ({ auth: !!c.auth, apiKey: !!c.apiKey }))));
}

header('armed: the OpenAI wire shape rides the same rung');
{
  const before = armedCalls.length;
  const res = await chat(BASE_ARMED);
  const json = await res.json().catch(() => null);
  check('status is 200', res.status === 200, `${res.status} ${String(JSON.stringify(json)).slice(0, 200)}`);
  check('the answer is translated back to the OpenAI shape', json?.choices?.[0]?.message?.content === 'hi from the credits rung', String(JSON.stringify(json)).slice(0, 200));
  check('the response is marked', res.headers.get('x-dario-pool-fallback') === 'credits:claude-sonnet-5', String(res.headers.get('x-dario-pool-fallback')));
  const key = armedCalls[before];
  check('the key request is Anthropic-shaped with the rung\'s model', key && key.apiKey === KEY && key.body?.model === 'claude-sonnet-5' && Array.isArray(key.body?.messages),
    String(JSON.stringify(key?.body)).slice(0, 200));
}

header('armed: the receipt files the three requests under credits, and the guard did not halt');
{
  const res = await fetch(`${BASE_ARMED}/analytics`);
  const a = await res.json().catch(() => null);
  check('/analytics answers', res.status === 200 && a !== null, String(res.status));
  const b = a?.window?.billingBucketBreakdown ?? {};
  check('billingBucketBreakdown.credits counts the three', b.credits === 3, JSON.stringify(b));
  check('nothing was filed as api or extra usage', (b.api ?? 0) === 0 && (b.extra_usage ?? 0) === 0, JSON.stringify(b));
  check('the claim breakdown names anthropic_credits', (a?.window?.claimBreakdown ?? {})[CREDITS_CLAIM] === 3, JSON.stringify(a?.window?.claimBreakdown));
  check('the overage guard did not halt', a?.overage?.halted !== true, JSON.stringify(a?.overage));
  const acct = a?.perAccount ?? {};
  check('the requests are booked to the credits account key, not to the seat', ACCOUNT_KEY_CREDITS in acct && !(('main' in acct) && acct.main.requests > 0),
    JSON.stringify(Object.keys(acct)));
}

header('no key: the entry is inert and the honest 429 stands');
{
  const res = await messages(BASE_NOKEY);
  const text = await res.text();
  check('status is 429', res.status === 429, `${res.status} ${text.slice(0, 200)}`);
  check('the client was not handed a fallback header it cannot trust', res.headers.get('x-dario-pool-fallback') === null, String(res.headers.get('x-dario-pool-fallback')));
  check('nothing went out on a key', nokeyCalls.every((c) => c.apiKey === null), JSON.stringify(nokeyCalls.map((c) => !!c.apiKey)));
  const again = await messages(BASE_NOKEY);
  const text2 = await again.text();
  check('with the seat parked, the next request is the pool\'s own 429 with a retry-after', again.status === 429 && again.headers.get('retry-after') !== null,
    `${again.status} ${text2.slice(0, 200)}`);
  check('...sent nowhere upstream', nokeyCalls.length === 1, String(nokeyCalls.length));
}

header('the key refuses with a non-billing 403: the client gets the original status and body');
{
  // Review on #1740: the rejection classifier reads a 403's body, and with no
  // seat to fail over from nothing forwarded the saved bytes, so the client
  // got the status with an empty body. The forwarder now reuses the body.
  const res = await messages(BASE_FORBIDDEN);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  check('status is 403', res.status === 403, `${res.status} ${text.slice(0, 200)}`);
  check('the original error body reaches the client', json?.error?.type === 'permission_error' && /permission/.test(json?.error?.message ?? ''), text.slice(0, 200));
  check('the rejection is classified and marked', res.headers.get('x-dario-upstream-rejection') === 'upstream_rejected', String(res.headers.get('x-dario-upstream-rejection')));
  check('the response says which rung answered', res.headers.get('x-dario-pool-fallback') === 'credits:claude-sonnet-5', String(res.headers.get('x-dario-pool-fallback')));
  check('the key was asked once, after the seat: no retry on the key', forbiddenCalls.length === 2 && forbiddenCalls[0].apiKey === null && forbiddenCalls[1].apiKey === KEY,
    JSON.stringify(forbiddenCalls.map((c) => ({ auth: !!c.auth, key: c.apiKey === KEY }))));
  check('request-id rides along', res.headers.get('request-id') === 'req_credits_403', String(res.headers.get('request-id')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

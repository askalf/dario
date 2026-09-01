// Synthetic-only serving health contract. No network or real credentials.
import {
  getServingProbe,
  classifyProbeResponse,
  probeAgeMs,
  _resetServingProbeForTest,
  DEFAULT_PROBE_MODEL,
} from '../dist/serving-probe.js';
import { strict as assert } from 'node:assert';

function stubFetch(status, body = '{}') {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}
const token = async () => 'synthetic-token';

assert.deepEqual(classifyProbeResponse(200), { ok: true, reason: 'served' });
const billing = classifyProbeResponse(403, '{"error":{"type":"permission_error"}}');
assert.equal(billing.ok, false);
assert.equal(billing.reason, 'billing-required');
assert.match(billing.detail, /subscription|payment/i);
assert.match(billing.detail, /will not help/i);
assert.doesNotMatch(billing.detail, /accounts remove|run `dario login`/i);
const limited = classifyProbeResponse(429, '{"error":{"type":"rate_limit_error"}}');
assert.equal(limited.ok, false);
assert.equal(limited.reason, 'rate-limited');
assert.match(limited.detail, /self-clears|reset window/i);
const credential = classifyProbeResponse(401, '{"error":{"type":"authentication_error"}}');
assert.equal(credential.ok, false);
assert.equal(credential.reason, 'auth-rejected');
assert.match(credential.detail, /re-authentication/i);

_resetServingProbeForTest();
const servedFetch = stubFetch(200);
const served = await getServingProbe({ fetchImpl: servedFetch, getToken: token, now: () => 1000 });
assert.equal(served.ok, true);
assert.equal(served.reason, 'served');
assert.equal(served.model, DEFAULT_PROBE_MODEL);
assert.equal(servedFetch.calls.length, 1);
assert.equal(servedFetch.calls[0].init.headers.authorization, 'Bearer synthetic-token');
assert.equal(JSON.parse(servedFetch.calls[0].init.body).max_tokens, 1);

_resetServingProbeForTest();
const billingResult = await getServingProbe({
  fetchImpl: stubFetch(403, '{"error":{"type":"permission_error"}}'),
  getToken: token,
  now: () => 2000,
});
assert.equal(billingResult.ok, false);
assert.equal(billingResult.reason, 'billing-required');
assert.match(billingResult.detail, /will not help/i);

_resetServingProbeForTest();
let calls = 0;
const cachedFetch = async () => {
  calls++;
  return { status: 200, text: async () => '{}' };
};
const deps = { fetchImpl: cachedFetch, getToken: token, now: () => 3000, ttlMs: 60_000 };
await Promise.all([getServingProbe(deps), getServingProbe(deps), getServingProbe(deps)]);
assert.equal(calls, 1);
assert.equal(probeAgeMs({ ...served, checkedAt: 1000 }, 1250), 250);

console.log('serving probe synthetic outcomes: ok');

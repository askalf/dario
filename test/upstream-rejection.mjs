import { strict as assert } from 'node:assert';
import { classifyUpstreamRejection, diagnosticSnippet } from '../dist/upstream-rejection.js';

const billingCases = [
  [402, '{"error":{"type":"payment_required"}}'],
  [403, '{"error":{"details":{"error_code":"oauth_not_allowed_for_organization"}}}'],
  [400, '{"error":{"message":"Credit balance too low; visit Plans & Billing"}}'],
];
for (const [status, body] of billingCases) {
  assert.deepEqual(classifyUpstreamRejection(status, body), {
    class: 'billing', marker: 'billing_required',
  });
}
assert.deepEqual(classifyUpstreamRejection(429, '{"error":{"type":"rate_limit_error"}}'), {
  class: 'rate_limit', marker: 'rate_limited',
});
assert.deepEqual(classifyUpstreamRejection(403, '{"error":{"type":"permission_error"}}'), {
  class: 'other', marker: 'upstream_rejected',
});
assert.equal(diagnosticSnippet('  one\n  two  ', 7), 'one two');
console.log('upstream rejection classification: ok');

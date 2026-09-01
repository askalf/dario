import { strict as assert } from 'node:assert';
import {
  classifyUpstreamRejection,
  diagnosticSnippet,
  rejectionRemediation,
} from '../dist/upstream-rejection.js';

const billingCases = [
  [402, '{"error":{"type":"payment_required"}}'],
  [403, '{"error":{"details":{"error_code":"oauth_not_allowed_for_organization"}}}'],
  [403, '{"error":{"type":"permission_error"}}'],
  [400, '{"error":{"message":"Credit balance too low; visit Plans & Billing"}}'],
];
for (const [status, body] of billingCases) {
  const result = classifyUpstreamRejection(status, body);
  assert.deepEqual(result, { class: 'billing', marker: 'billing_required' });
  const remedy = rejectionRemediation(result);
  assert.match(remedy, /subscription|payment/i);
  assert.match(remedy, /will not help/i);
  assert.doesNotMatch(remedy, /run `dario login`|accounts remove/i);
}
const rateLimit = classifyUpstreamRejection(429, '{"error":{"type":"rate_limit_error"}}');
assert.deepEqual(rateLimit, { class: 'rate_limit', marker: 'rate_limited' });
assert.match(rejectionRemediation(rateLimit), /self-clears|reset window/i);
const credential = classifyUpstreamRejection(401, '{"error":{"type":"authentication_error"}}');
assert.deepEqual(credential, { class: 'credential', marker: 'credential_rejected' });
assert.match(rejectionRemediation(credential), /re-authentication/i);
assert.deepEqual(classifyUpstreamRejection(500, '{}'), {
  class: 'other', marker: 'upstream_rejected',
});
assert.equal(diagnosticSnippet('  one\n  two  ', 7), 'one two');
console.log('upstream rejection classification and remediation: ok');

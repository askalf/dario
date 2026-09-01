import { strict as assert } from 'node:assert';
import { applyServingVerdict } from '../dist/doctor-serving.js';

const structural = [
  { status: 'ok', label: 'OAuth', detail: 'healthy (expires in 5h)' },
  { status: 'ok', label: 'Pool', detail: 'pool of 1' },
  { status: 'info', label: 'Pool routing', detail: 'next: login (1/1 healthy)' },
  { status: 'ok', label: 'Identity', detail: '1/1 pool account match' },
];
const billing = applyServingVerdict(structural, {
  ok: false,
  reason: 'billing-required',
  detail: 'The subscription needs operator attention. Restarting or logging in again will not help.',
  checkedAt: 1,
  latencyMs: 1,
  model: 'synthetic',
  status: 403,
});
assert.equal(billing[0].status, 'fail');
assert.match(billing[0].detail, /billing-required/);
for (const label of ['OAuth', 'Pool', 'Pool routing', 'Identity']) {
  const row = billing.find((check) => check.label === label);
  assert.equal(row.status, 'fail');
  assert.match(row.detail, /NOT SERVING/);
}
const healthy = applyServingVerdict(structural, {
  ok: true, reason: 'served', checkedAt: 1, latencyMs: 1, model: 'synthetic', status: 200,
});
assert.equal(healthy[0].status, 'ok');
assert.match(healthy[0].detail, /served/);
console.log('doctor serving conclusion: ok');

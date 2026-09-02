import { strict as assert } from 'node:assert';
import { applyServingVerdict } from '../dist/doctor-serving.js';
import { runDoctorChecks } from '../dist/doctor.js';

const structural = [
  { status: 'ok', label: 'OAuth', detail: 'healthy (expires in 5h)' },
  { status: 'ok', label: 'Pool', detail: 'pool of 1' },
  { status: 'info', label: 'Pool routing', detail: 'next: login (1/1 healthy)' },
  { status: 'ok', label: 'Identity', detail: '1/1 pool account match' },
];
const billingProbe = {
  ok: false,
  reason: 'billing-required',
  detail: 'The subscription needs operator attention. Restarting or logging in again will not help.',
  checkedAt: 1,
  latencyMs: 1,
  model: 'synthetic',
  status: 403,
};
const billing = applyServingVerdict(structural, billingProbe);
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

let probeCalls = 0;
const commandRows = await runDoctorChecks(
  { probe: true },
  {
    collect: async () => structural,
    probe: async () => {
      probeCalls += 1;
      return billingProbe;
    },
  },
);
assert.equal(probeCalls, 1, 'doctor --probe obtains the live serving verdict');
assert.equal(commandRows[0].label, 'Serving');
assert.equal(commandRows[0].status, 'fail');
assert.equal(commandRows.find((check) => check.label === 'OAuth').status, 'fail');

let skippedProbeCalls = 0;
const structuralOnlyRows = await runDoctorChecks(
  {},
  {
    collect: async () => structural,
    probe: async () => {
      skippedProbeCalls += 1;
      return billingProbe;
    },
  },
);
assert.equal(skippedProbeCalls, 0, 'doctor without --probe remains structural-only');
assert.deepEqual(structuralOnlyRows, structural);
console.log('doctor serving conclusion: ok');

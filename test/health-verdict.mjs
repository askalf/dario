#!/usr/bin/env node
// Tests for scripts/health-verdict.sh — the parsing + verdict behind the
// self-hosted serving-health watcher (cc-oauth-health.yml).
//
// This is the one piece of dario's own monitoring whose failure mode is
// SILENCE. If the extraction stops matching — a field renamed, a body shape
// changed, an object gaining a nested brace — the watcher does not error. It
// reports "all axes healthy" indefinitely, and the first anyone hears of it is
// the next outage nobody got paged for. That is the same class of bug as
// dario#905 itself (a green /health over a dead proxy), so it should not be
// living untested inside a YAML `run:` block.
//
// Bodies here are real shapes: what dario 5.5.x actually returns to a loopback
// caller, and what a pre-5.5.0 container returns (no probe, no stall field).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'health-verdict.sh');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

/** Run the verdict script over a body, return the five named fields. */
function verdict(body, env = {}) {
  const r = spawnSync('sh', [SCRIPT], {
    input: body,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.error) {
    console.log(`  SKIP — no POSIX sh available: ${r.error.message}`);
    process.exit(0);
  }
  const [oauth, probeOk, probeReason, stalled, axis] = (r.stdout ?? '').split('\n');
  return { oauth, probeOk, probeReason, stalled, axis, status: r.status, stderr: r.stderr };
}

const healthyQueue = '"queue":{"active":0,"queued":0,"maxConcurrent":10,"maxQueued":128,"stalledSince":null}';
const okProbe = '"probe":{"ok":true,"reason":"served","checkedAt":1754790000000,"latencyMs":812,"model":"claude-haiku-4-5","status":200,"ageMs":1200}';

// ---------------------------------------------------------------------------
header('all axes green');
{
  const v = verdict(`{"status":"ok","version":"5.5.2","oauth":"healthy","expiresIn":"4h 57m","requests":167,${okProbe},${healthyQueue}}`);
  check('oauth healthy', v.oauth === 'healthy', v.oauth);
  check('probe ok true', v.probeOk === 'true', v.probeOk);
  check('reason served', v.probeReason === 'served');
  check('stalled 0', v.stalled === '0');
  check('NO axis — nothing fires', v.axis === '', `axis=${v.axis}`);
  check('exit 0', v.status === 0);
}

// ---------------------------------------------------------------------------
header('axis 1 — the credential is dead');
{
  const v = verdict(`{"status":"degraded","oauth":"broken","expiresIn":"0s",${healthyQueue}}`);
  check('axis names OAuth', v.axis === 'OAuth broken', v.axis);
}
{
  const v = verdict('');
  check('empty body (container down) → unreachable', v.oauth === 'unreachable');
  check('and that alerts', v.axis === 'OAuth unreachable', v.axis);
}
{
  // The published-port path strips the body to bare liveness. If the watcher
  // ever loses its loopback vantage point it must alert, not read "healthy".
  const v = verdict('{"status":"ok"}');
  check('stripped public body → unreachable, not silently green', v.axis === 'OAuth unreachable', v.axis);
}

// ---------------------------------------------------------------------------
header('axis 2 — THE #905 shape: structurally healthy, not serving');
{
  const failProbe = '"probe":{"ok":false,"reason":"auth-rejected","checkedAt":1754790000000,"latencyMs":233,"model":"claude-haiku-4-5","status":401,"ageMs":900}';
  const v = verdict(`{"status":"degraded","oauth":"healthy","expiresIn":"4h 57m",${failProbe},${healthyQueue}}`);
  check('oauth still reads healthy', v.oauth === 'healthy');
  check('but the axis fires on the probe', v.axis === 'not serving (auth-rejected)', v.axis);
  check('reason carried for the runbook', v.probeReason === 'auth-rejected');
}
{
  const t = '"probe":{"ok":false,"reason":"timeout","checkedAt":1,"latencyMs":15000,"model":"claude-haiku-4-5"}';
  const v = verdict(`{"status":"ok","oauth":"healthy",${t},${healthyQueue}}`);
  check('timeout also alerts', v.axis === 'not serving (timeout)', v.axis);
}

header('axis 2 — a throttle is NOT an outage');
{
  // dario reports 429/529 as ok:true precisely so a watchdog does not restart
  // on them. If this ever alerts, the fleet gets restart-looped during a
  // rate-limit window — the exact failure /livez was created to avoid.
  for (const reason of ['rate-limited', 'upstream-overloaded']) {
    const p = `"probe":{"ok":true,"reason":"${reason}","checkedAt":1,"latencyMs":90,"model":"claude-haiku-4-5","status":429}`;
    const v = verdict(`{"status":"ok","oauth":"healthy",${p},${healthyQueue}}`);
    check(`${reason} does NOT alert`, v.axis === '', `axis=${v.axis}`);
  }
}

// ---------------------------------------------------------------------------
header('axis 3 — wedged vs merely busy');
{
  const busy = '"queue":{"active":10,"queued":40,"maxConcurrent":10,"maxQueued":128,"stalledSince":1754790000000,"stalledForMs":1200}';
  const v = verdict(`{"status":"ok","oauth":"healthy",${okProbe},${busy}}`);
  check('flat out at capacity but turning over → no alert', v.axis === '', `axis=${v.axis}`);
  check('stall value still reported', v.stalled === '1200');
}
{
  const wedged = '"queue":{"active":10,"queued":40,"maxConcurrent":10,"maxQueued":128,"stalledSince":1754790000000,"stalledForMs":28800000}';
  const v = verdict(`{"status":"ok","oauth":"healthy",${okProbe},${wedged}}`);
  check('8h with zero turnover → alert', v.axis === 'queue wedged (480m)', v.axis);
}
{
  const edge = `"queue":{"active":10,"queued":1,"maxConcurrent":10,"maxQueued":128,"stalledForMs":300000}`;
  const v = verdict(`{"status":"ok","oauth":"healthy",${okProbe},${edge}}`);
  check('exactly at threshold does not fire (strictly greater)', v.axis === '', `axis=${v.axis}`);
  const over = `"queue":{"active":10,"queued":1,"maxConcurrent":10,"maxQueued":128,"stalledForMs":300001}`;
  check('one ms over does', verdict(`{"status":"ok","oauth":"healthy",${okProbe},${over}}`).axis !== '');
}
{
  const wedged = '"queue":{"active":10,"queued":40,"maxConcurrent":10,"maxQueued":128,"stalledForMs":120000}';
  const v = verdict(`{"status":"ok","oauth":"healthy",${okProbe},${wedged}}`, { STALL_ALERT_MS: '60000' });
  check('threshold is configurable', v.axis === 'queue wedged (2m)', v.axis);
}

// ---------------------------------------------------------------------------
header('precedence — report the root axis, not the symptom it causes');
{
  // Dead credential ALSO fails the probe. Paging about the probe would send
  // the operator to the wrong runbook.
  const failProbe = '"probe":{"ok":false,"reason":"auth-rejected","checkedAt":1,"latencyMs":10,"model":"claude-haiku-4-5","status":401}';
  const wedged = '"queue":{"active":10,"queued":9,"maxConcurrent":10,"maxQueued":128,"stalledForMs":99999999}';
  const v = verdict(`{"status":"degraded","oauth":"broken",${failProbe},${wedged}}`);
  check('oauth wins over probe and queue', v.axis === 'OAuth broken', v.axis);
}
{
  const failProbe = '"probe":{"ok":false,"reason":"upstream-error","checkedAt":1,"latencyMs":10,"model":"claude-haiku-4-5","status":500}';
  const wedged = '"queue":{"active":10,"queued":9,"maxConcurrent":10,"maxQueued":128,"stalledForMs":99999999}';
  const v = verdict(`{"status":"ok","oauth":"healthy",${failProbe},${wedged}}`);
  check('probe wins over queue', v.axis === 'not serving (upstream-error)', v.axis);
}

// ---------------------------------------------------------------------------
header('version tolerance — a missing field is NOT a failure');
{
  // A pre-5.5.0 container: no probe, no stalledForMs. The watcher must keep
  // doing its original job and must never page because a field it hoped for
  // was absent.
  const old = '{"status":"ok","version":"5.4.31","oauth":"healthy","expiresIn":"3h 2m","requests":42,"queue":{"active":0,"queued":0,"maxConcurrent":10,"maxQueued":128}}';
  const v = verdict(old);
  check('oauth still parsed', v.oauth === 'healthy');
  check('probe reported as not measured (empty)', v.probeOk === '', `got ${v.probeOk}`);
  check('stall defaults to 0', v.stalled === '0');
  check('NO alert fires', v.axis === '', `axis=${v.axis}`);
}
{
  const older = '{"status":"ok","oauth":"healthy","expiresIn":"3h"}';
  const v = verdict(older);
  check('no queue object at all → still no alert', v.axis === '');
}

// ---------------------------------------------------------------------------
header('the probe object is matched by scope, not by loose key');
{
  // `"ok"` and `"reason"` could plausibly appear elsewhere in a future body.
  // Anchoring to the probe object is what keeps this honest.
  const body = `{"status":"ok","oauth":"healthy","ok":false,"reason":"decoy",${okProbe},${healthyQueue}}`;
  const v = verdict(body);
  check('decoy keys outside the probe object are ignored', v.probeOk === 'true', v.probeOk);
  check('decoy reason ignored', v.probeReason === 'served', v.probeReason);
  check('no false alert', v.axis === '');
}

console.log(`\nhealth-verdict: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

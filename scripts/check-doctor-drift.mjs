#!/usr/bin/env node
// BUILDOUT-06 — dario doctor drift check.
//
// Runs `docker exec askalf-dario dario doctor --obedience`, parses its status
// rows, and reports the runtime drifts NO other watcher catches:
//   - OAuth not [OK]        -> the deployed bearer/refresh is dead or expiring;
//                              dario 401s every non-Haiku call until re-authed
//                              (the recurring identity-drift time-sink).
//   - Template "live capture" -> the stale ~/.dario/cc-template.live.json is
//                              shadowing the bundled template (no CC binary in
//                              the container to refresh it).
//   - Identity [WARN]       -> OAuth-bearer/userID mismatch. doctor only detects
//                              this in POOL mode; single-account reads identity
//                              live per-request so it shows as [INFO] (not drift).
//   - Obedience [FAIL]      -> a model family answered a probe but ignored the
//                              client system prompt (dario#509 — the 2026-06-12
//                              sonnet regression class). Behavioral and
//                              upstream-influenced: a failure means "investigate
//                              the system-prompt presentation/merge", not
//                              necessarily "dario bug". Obedience [WARN] rows
//                              (probe couldn't complete) are infra flakes, NOT
//                              drift — they don't file issues.
//
// Complements cc-drift-watch (CC binary), cc-drift-template-watch (template
// bake) and sdk-drift-watch (npm pins) — none look at the live OAuth / runtime
// cache state, and none assert the models actually FOLLOW client system
// instructions. Detection only; no auto-fix.
//
// A deployed dario predating --obedience ignores the flag (unknown doctor args
// are no-ops) and emits no Obedience rows — that parses as clean for the
// obedience axis, so this script can ship ahead of the container image.
//
// stdout: a JSON report. Exit 1 = drift, 0 = clean, 3 = doctor could not run or
// its output was unparseable (infra/format error — the workflow surfaces red,
// NOT a false drift issue). Mirrors scripts/check-sdk-drift.mjs's contract.

import { execFileSync } from 'node:child_process';
import { classifyDoctorOutput } from './doctor-drift-classify.mjs';

/**
 * Synchronous sleep between retries — this script runs as a top-level sync
 * flow with no event loop to await. Mirrors scripts/check-sdk-drift.mjs.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run `docker exec askalf-dario dario doctor --obedience`, retrying ONLY the
// transient "container momentarily unreachable" case. The askalf-dario
// container is bounced during a deploy (image pull + recreate); a doctor run
// that lands in that window fails INSTANTLY with empty stdout — docker exits
// non-zero before dario prints a row. Un-retried, that surfaces as a false red
// CI run (exit 3) even though nothing drifted, and the container is back
// seconds later. Same transient-blip guard scripts/check-sdk-drift.mjs already
// wraps around its npm calls.
//
// What is deliberately NOT retried:
//   - a run that produced output, even on a non-zero exit: `dario doctor`
//     prints its rows and THEN exits 1 on a [FAIL], so non-empty stdout is a
//     real run carrying drift — parse it, never retry it away.
//   - a timeout-kill (err.killed): doctor genuinely hung, not a fast container
//     miss. Retrying 3×180s would blow the job's 8-min budget — surface it now.
const ATTEMPTS = 3;
let raw = '';
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    // 180s: the obedience probe is up to 3 serial attempts × 30s per family
    // (families run in parallel) on top of doctor's local checks.
    raw = execFileSync('docker', ['exec', 'askalf-dario', 'dario', 'doctor', '--obedience'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    break;
  } catch (err) {
    // `dario doctor` may exit non-zero while still printing its rows — keep that
    // output and parse it. Only a truly empty result is an infra error.
    raw = (err.stdout || '').toString();
    if (raw.trim()) break;
    // Empty output. Retry a fast container miss (mid-deploy bounce); surface a
    // timeout-kill or the exhausted final attempt as exit 3 (infra error — the
    // workflow shows red but files NO false drift issue).
    if (!err.killed && attempt < ATTEMPTS) {
      process.stderr.write(
        `check-doctor-drift: docker exec produced no output (attempt ${attempt}/${ATTEMPTS}: ${err.message}) — retrying, askalf-dario may be mid-deploy\n`,
      );
      // Seconds-scale backoff (5s, then 10s), not check-sdk-drift's ms-scale:
      // an image pull + container recreate takes seconds, and a ~1s retry
      // window would still land inside the same bounce. Worst case adds 15s
      // of sleep — far inside the job's 8-min budget even with one 180s
      // timeout attempt on top.
      sleepSync(5_000 * attempt);
      continue;
    }
    process.stderr.write(
      `check-doctor-drift: \`docker exec askalf-dario dario doctor\` produced no output after ${attempt} attempt(s): ${err.message}\n`,
    );
    process.exit(3);
  }
}

const { oauth, template, identity, obedience, drift, parsedAnchors } = classifyDoctorOutput(raw);

// If neither anchor row parsed, doctor's format changed — treat as infra/format
// error rather than silently reporting "clean".
if (!parsedAnchors) {
  process.stderr.write(
    'check-doctor-drift: could not parse OAuth or Template rows — dario doctor output format may have changed\n',
  );
  process.exit(3);
}

const report = { checkedAt: new Date().toISOString(), oauth, template, identity, obedience, drift };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(drift.length > 0 ? 1 : 0);

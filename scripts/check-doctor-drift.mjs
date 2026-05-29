#!/usr/bin/env node
// BUILDOUT-06 — dario doctor drift check.
//
// Runs `docker exec askalf-dario dario doctor`, parses its status rows, and
// reports the runtime drifts NO other watcher catches:
//   - OAuth not [OK]        -> the deployed bearer/refresh is dead or expiring;
//                              dario 401s every non-Haiku call until re-authed
//                              (the recurring identity-drift time-sink).
//   - Template "live capture" -> the stale ~/.dario/cc-template.live.json is
//                              shadowing the bundled template (no CC binary in
//                              the container to refresh it).
//   - Identity [WARN]       -> OAuth-bearer/userID mismatch. doctor only detects
//                              this in POOL mode; single-account reads identity
//                              live per-request so it shows as [INFO] (not drift).
//
// Complements cc-drift-watch (CC binary), cc-drift-template-watch (template
// bake) and sdk-drift-watch (npm pins) — none look at the live OAuth / runtime
// cache state. Detection only; no auto-fix.
//
// stdout: a JSON report. Exit 1 = drift, 0 = clean, 3 = doctor could not run or
// its output was unparseable (infra/format error — the workflow surfaces red,
// NOT a false drift issue). Mirrors scripts/check-sdk-drift.mjs's contract.

import { execFileSync } from 'node:child_process';

let raw = '';
try {
  raw = execFileSync('docker', ['exec', 'askalf-dario', 'dario', 'doctor'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
} catch (err) {
  // `dario doctor` may exit non-zero while still printing its rows — keep that
  // output and parse it. Only a truly empty result is an infra error.
  raw = (err.stdout || '').toString();
  if (!raw.trim()) {
    process.stderr.write(
      `check-doctor-drift: \`docker exec askalf-dario dario doctor\` produced no output: ${err.message}\n`,
    );
    process.exit(3);
  }
}

// Rows render as:  [ OK ]  OAuth   healthy (...)   /   [INFO]  Template   bundled capture, ...
function findRow(labelRe) {
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*\[\s*(OK|INFO|WARN|FAIL|ERROR)\s*\]\s+(.*\S)\s*$/i);
    if (!m) continue;
    const status = m[1].toUpperCase();
    const rest = m[2];
    if (labelRe.test(rest)) return { status, detail: rest };
  }
  return null;
}

const oauth = findRow(/^OAuth\b/i);
const template = findRow(/^Template\b(?!\s+drift)/i); // the capture row, NOT "Template drift"
const identity = findRow(/^Identity\b/i);

// If neither anchor row parsed, doctor's format changed — treat as infra/format
// error rather than silently reporting "clean".
if (!oauth && !template) {
  process.stderr.write(
    'check-doctor-drift: could not parse OAuth or Template rows — dario doctor output format may have changed\n',
  );
  process.exit(3);
}

const drift = [];
if (oauth && oauth.status !== 'OK') {
  drift.push({ check: 'OAuth', status: oauth.status, detail: oauth.detail });
}
if (template && /\blive capture\b/i.test(template.detail)) {
  drift.push({ check: 'Template', status: template.status, detail: template.detail });
}
if (identity && identity.status === 'WARN') {
  drift.push({ check: 'Identity', status: identity.status, detail: identity.detail });
}

const report = { checkedAt: new Date().toISOString(), oauth, template, identity, drift };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(drift.length > 0 ? 1 : 0);

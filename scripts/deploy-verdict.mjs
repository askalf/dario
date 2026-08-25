#!/usr/bin/env node
/**
 * Is what's RUNNING what we last RELEASED?
 *
 * THE GAP THIS FILLS. The release pipeline's idempotency gate already proves
 * the artifacts exist: the git tag, the npm version, the ghcr image. What
 * nothing checked is the last leg — that the box actually pulled the image and
 * is running it. Publishing is not deploying.
 *
 * That leg has failed before and stayed failed silently: dario's refresh-lock
 * `lockId` code sat released-but-not-live on the Cloudflare Worker. Every
 * status surface read green the whole time, because each was reporting on a
 * different link in the chain and no one link is the deployment.
 *
 * And the existing health watcher cannot see it BY DESIGN. It probes the
 * running container and asks "are you serving?" — a container running a stale
 * version answers yes, truthfully. Healthy and current are different
 * questions, and only one of them was being asked.
 *
 * WHY A GRACE PERIOD. A release legitimately takes time to reach the box:
 * multi-arch build, ghcr push, then the pull. Alerting the instant a tag
 * appears would page on every single release. The grace window is what makes
 * this a deploy-stuck detector rather than a deploy-in-progress detector.
 *
 * Pure and dependency-free so it is unit-testable (test/deploy-verdict.mjs).
 * A watcher whose parsing silently stops matching reports "aligned" forever —
 * that has to be provable without cutting a real release to find out.
 */

/** Parse "v5.5.66" / "5.5.66" -> [5,5,66]; null when not X.Y.Z. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * @param {object} o
 * @param {string|null} o.deployed        version the container reports, null/'' if unreadable
 * @param {string|null} o.released        latest release tag
 * @param {number}      o.releaseAgeMs    how long ago that release was cut
 * @param {number}      o.graceMs         how long a deploy is allowed to take
 * @returns {{state:string, alert:boolean, summary:string}}
 *
 * States:
 *   aligned      deployed === released
 *   deploying    behind, but the release is still inside the grace window
 *   stuck        behind, and the grace window has passed        -> ALERT
 *   ahead        deployed > released                            -> ALERT
 *   unreadable   could not read the container's version         -> no alert
 */
export function deployVerdict({ deployed, released, releaseAgeMs, graceMs }) {
  const dep = (deployed ?? '').trim();
  const rel = (released ?? '').trim();

  // Deliberately NOT an alert. The health watcher owns "container down" and
  // already alerts on it with the right diagnostics; a second workflow filing
  // its own issue for the same event just doubles the noise on the worst day.
  // Silence here is not a blind spot — it is the other watcher's job.
  if (!dep || !parseVersion(dep)) {
    return { state: 'unreadable', alert: false, summary: `could not read the deployed version (got ${JSON.stringify(deployed ?? null)}) — the health watcher owns container-down alerting` };
  }
  if (!rel || !parseVersion(rel)) {
    return { state: 'unreadable', alert: false, summary: `could not read the latest release (got ${JSON.stringify(released ?? null)})` };
  }

  const cmp = compareVersions(dep, rel);
  if (cmp === 0) return { state: 'aligned', alert: false, summary: `deployed ${dep} === released ${rel}` };

  if (cmp > 0) {
    // The box is running something never released. Usually a hand-built image
    // or an aborted rollback — either way the running code is not the code in
    // the tag, which is the invariant this watcher exists to hold.
    return { state: 'ahead', alert: true, summary: `deployed ${dep} is NEWER than the latest release ${rel} — the box is running code that was never released` };
  }

  const mins = Math.round(releaseAgeMs / 60000);
  if (releaseAgeMs < graceMs) {
    return { state: 'deploying', alert: false, summary: `deployed ${dep} behind released ${rel}, but that release is only ${mins}m old — inside the ${Math.round(graceMs / 60000)}m deploy window` };
  }
  return { state: 'stuck', alert: true, summary: `deployed ${dep} is BEHIND released ${rel}, and that release is ${mins}m old — past the ${Math.round(graceMs / 60000)}m deploy window` };
}

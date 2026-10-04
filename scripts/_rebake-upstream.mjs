// Pure helpers for rebake-upstream-check.mjs: the verdict on each probe and the
// text that goes into the rebake PR. Kept apart from the runner so the tests can
// import them without starting a proxy.

/** Billing buckets that mean the request was billed to the subscription. */
const SUBSCRIPTION_BUCKETS = new Set(['subscription', 'subscription_fallback']);

/**
 * One probe passes when upstream accepted the rebuilt request (HTTP 200) and
 * billed it to the subscription. The served model is reported, not judged:
 * a load-time downgrade is the billing canary's finding, not the bundle's.
 *
 * A probe marked `blocked` did not complete because the borrowed access token
 * needed renewing. That says nothing about the bundle, so it is neither a pass
 * nor a failure: `incomplete`.
 */
export function probeVerdict({ status, bucket, blocked }) {
  if (blocked) return { ok: false, incomplete: true, why: 'not completed' };
  if (status !== 200) return { ok: false, incomplete: false, why: status ? `HTTP ${status}` : 'no response' };
  if (!SUBSCRIPTION_BUCKETS.has(bucket)) return { ok: false, incomplete: false, why: `billed to ${bucket}` };
  return { ok: true, incomplete: false, why: '' };
}

/**
 * The run: `fail` when any completed probe failed, whatever happened to the
 * others; `incomplete` when none failed but at least one could not complete;
 * `pass` only when there is at least one probe and every one passed.
 */
export function summarizeProbes(results) {
  const verdicts = results.map(probeVerdict);
  if (verdicts.length === 0 || verdicts.some((v) => !v.ok && !v.incomplete)) return 'fail';
  return verdicts.some((v) => v.incomplete) ? 'incomplete' : 'pass';
}

/**
 * The Validation paragraph of a rebake PR.
 *
 * outcome: 'pass' | 'fail' | 'incomplete' (the borrowed credential needed
 * renewing part-way; the probes that completed are kept) | 'blocked' (it
 * needed renewing before any probe, so nothing was sent) | 'error' (the proxy
 * never came up, so nothing was sent).
 */
export function formatUpstreamCheck({ outcome, results = [], version, captured, detail = '' }) {
  const bundle = `the bundle alone (Claude Code ${version}, captured ${captured})`;
  if (outcome === 'blocked') {
    return [
      `The upstream check could not run: the subscription access token it borrows needed renewing, and this check never renews it. No request built from ${bundle} has been sent upstream. Dispatch the watcher again once the platform proxy has refreshed.`,
    ];
  }
  if (outcome === 'error') {
    return [
      `The upstream check could not run: ${detail || 'the proxy did not become healthy'}. No request built from ${bundle} has been sent upstream.`,
    ];
  }
  const how = 'The proxy ran without `--passthrough`, with `--no-live-capture` and no live template cache, over the subscription credential borrowed read-only.';
  const done = results.filter((r) => !probeVerdict(r).incomplete).length;
  const head = outcome === 'pass'
    ? `Requests rebuilt from ${bundle} were sent upstream by this run and accepted. ${how}`
    : outcome === 'incomplete'
      ? `The upstream check did not finish: ${done === 0 ? 'none' : done} of the ${results.length} requests rebuilt from ${bundle} completed before the subscription access token it borrows needed renewing, which this check never does. ${done === 0 ? 'That says' : 'The ones that completed were accepted; the rest say'} nothing about the bundle. Dispatch the watcher again once the platform proxy has refreshed. ${how}`
      : `Requests rebuilt from ${bundle} were sent upstream by this run and at least one was not accepted as subscription traffic. Do not merge until that is understood; a failure does not by itself show that the captured change is the cause. ${how}`;
  return [
    head,
    '',
    '| Model | Result | Billed to | Served by |',
    '|---|---|---|---|',
    ...results.map((r) => {
      const v = probeVerdict(r);
      if (v.incomplete) return `| \`${r.model}\` | not completed: the access token needed renewing | | |`;
      const answer = r.status ? `HTTP ${r.status}` : 'no response';
      const result = v.ok || v.why === answer ? answer : `${answer}, ${v.why}`;
      return `| \`${r.model}\` | ${result} | ${r.claim ? `\`${r.claim}\` (${r.bucket})` : r.bucket} | ${r.served ? `\`${r.served}\`` : 'not readable'} |`;
    }),
  ];
}

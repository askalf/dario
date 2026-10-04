// Pure helpers for rebake-upstream-check.mjs: the verdict on each probe and the
// text that goes into the rebake PR. Kept apart from the runner so the tests can
// import them without starting a proxy.

/** Billing buckets that mean the request was billed to the subscription. */
const SUBSCRIPTION_BUCKETS = new Set(['subscription', 'subscription_fallback']);

/**
 * One probe passes when upstream accepted the rebuilt request (HTTP 200) and
 * billed it to the subscription. The served model is reported, not judged:
 * a load-time downgrade is the billing canary's finding, not the bundle's.
 */
export function probeVerdict({ status, bucket }) {
  if (status !== 200) return { ok: false, why: status ? `HTTP ${status}` : 'no response' };
  if (!SUBSCRIPTION_BUCKETS.has(bucket)) return { ok: false, why: `billed to ${bucket}` };
  return { ok: true, why: '' };
}

/** `pass` only when there is at least one probe and every one passed. */
export function summarizeProbes(results) {
  return results.length > 0 && results.every((r) => probeVerdict(r).ok) ? 'pass' : 'fail';
}

/**
 * The Validation paragraph of a rebake PR.
 *
 * outcome: 'pass' | 'fail' | 'blocked' (the borrowed credential needed
 * renewing, which this check must not do) | 'error' (the proxy never came up).
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
  const head = outcome === 'pass'
    ? `Requests rebuilt from ${bundle} were sent upstream by this run and accepted. The proxy ran without \`--passthrough\`, with \`--no-live-capture\` and no live template cache, over the subscription credential borrowed read-only.`
    : `Requests rebuilt from ${bundle} were sent upstream by this run and at least one was not accepted as subscription traffic. Do not merge until that is understood; a failure does not by itself show that the captured change is the cause.`;
  return [
    head,
    '',
    '| Model | Result | Billed to | Served by |',
    '|---|---|---|---|',
    ...results.map((r) => {
      const v = probeVerdict(r);
      const answer = r.status ? `HTTP ${r.status}` : 'no response';
      const result = v.ok || v.why === answer ? answer : `${answer}, ${v.why}`;
      return `| \`${r.model}\` | ${result} | ${r.claim ? `\`${r.claim}\` (${r.bucket})` : r.bucket} | ${r.served ? `\`${r.served}\`` : 'not readable'} |`;
    }),
  ];
}

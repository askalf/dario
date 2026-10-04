// Pure helpers for rebake-upstream-check.mjs: what a probe declares, the verdict
// on each probe, and the text that goes into the rebake PR. Kept apart from the
// runner so the tests can import them without starting a proxy.

/** Billing buckets that mean the request was billed to the subscription. */
const SUBSCRIPTION_BUCKETS = new Set(['subscription', 'subscription_fallback']);

/** Statuses the proxy answers with when it has no usable token. */
const AUTH_STATUSES = new Set([401, 403, 503]);

/** What the proxy logs when it needs a new token and may not fetch one. */
export const RENEWAL_MARKER = 'DARIO_NO_TOKEN_REFRESH';

/**
 * The tools a probe declares: every tool in the bundle, by name, with an empty
 * schema. A client that declares Claude Code's tool names gets the bundle's
 * definitions of them in the rebuilt request, so each probe carries every
 * bundled tool definition upstream. A request that declares no tools carries
 * none at all for most models.
 */
export function probeTools(bundle) {
  return (bundle.tools ?? [])
    .filter((t) => typeof t.name === 'string' && !t.name.startsWith('mcp__'))
    .map((t) => ({ name: t.name, description: t.name, input_schema: { type: 'object', properties: {} } }));
}

/** The request body of one probe. `tool_choice: none` keeps the model from calling what it was shown. */
export function probeBody(model, tools) {
  return { model, max_tokens: 16, messages: [{ role: 'user', content: 'OK' }], tools, tool_choice: { type: 'none' } };
}

/**
 * The names of the bundle's tools that a rebuilt request carries exactly as
 * the bundle holds them (name, description and input schema). The request
 * builder does not take every tool from the bundle, so the runner asks it
 * which ones it does and declares only those.
 */
export function carriedBundleTools(outboundTools, bundle) {
  const sent = new Map((outboundTools ?? []).map((t) => [t.name, t]));
  return (bundle.tools ?? []).filter((t) => {
    const o = sent.get(t.name);
    return o && o.description === t.description && JSON.stringify(o.input_schema) === JSON.stringify(t.input_schema);
  }).map((t) => t.name);
}

/**
 * True when a probe did not complete because the borrowed access token needed
 * renewing. Both signs are required and both belong to this probe: an auth
 * status, and the renewal marker in what the proxy logged WHILE it ran. The
 * marker alone proves nothing: the proxy logs it at startup and before a
 * request for any seat that is merely close to expiry, and goes on serving.
 * Without the status test an upstream rejection of the bundle would be filed
 * as a token problem.
 */
export function probeBlocked({ status, logDuringProbe }) {
  return AUTH_STATUSES.has(status) && String(logDuringProbe ?? '').includes(RENEWAL_MARKER);
}

/**
 * One probe passes when upstream accepted the rebuilt request (HTTP 200) and
 * billed it to the subscription. The served model is reported, not judged:
 * a load-time downgrade is the billing canary's finding, not the bundle's.
 *
 * A probe marked `blocked` (see probeBlocked) says nothing about the bundle,
 * so it is neither a pass nor a failure: `incomplete`.
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
 * The text of the check.
 *
 * outcome: 'pass' | 'fail' (these two go into a rebake PR) | 'incomplete' (the
 * borrowed credential needed renewing part-way; the probes that completed are
 * kept) | 'blocked' (the proxy could not serve for want of a token, so nothing
 * was sent) | 'error' (the check itself did not work, so nothing was sent).
 * The watcher opens no PR on the last three, so their text is for its log.
 */
export function formatUpstreamCheck({ outcome, results = [], version, captured, tools = { carried: 0, total: 0, left: [] }, detail = '' }) {
  const bundle = `the bundle (Claude Code ${version}, captured ${captured})`;
  if (outcome === 'blocked') {
    return [
      `The upstream check could not run: the proxy had no usable access token, because the one it borrows needed renewing and this check never renews it. No request built from ${bundle} was sent upstream. The next watcher run tries again.`,
    ];
  }
  if (outcome === 'error') {
    return [
      `The upstream check could not run: ${detail || 'the proxy did not become healthy'}. No request built from ${bundle} was sent upstream.`,
    ];
  }
  const left = tools.left.length ? ` (not ${tools.left.map((n) => `\`${n}\``).join(', ')}, which the request builder does not take from the bundle)` : '';
  const how = `Each request declared the bundle's tools by name, and carried the bundled definitions of ${tools.carried} of its ${tools.total} tools${left} and the bundled system prompt for its model. The proxy ran without \`--passthrough\`, with \`--no-live-capture\` and no live template cache, over the subscription credential borrowed read-only.`;
  const done = results.filter((r) => !probeVerdict(r).incomplete).length;
  const head = outcome === 'pass'
    ? `Requests rebuilt from ${bundle} were sent upstream by this run and accepted. ${how}`
    : outcome === 'incomplete'
      ? `The upstream check did not finish: ${done === 0 ? 'none' : done} of the ${results.length} requests rebuilt from ${bundle} completed before the access token it borrows needed renewing, which this check never does. ${done === 0 ? 'That says' : 'The ones that completed were accepted; the rest say'} nothing about the bundle. The next watcher run tries again. ${how}`
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

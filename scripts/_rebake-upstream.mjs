// Pure helpers for rebake-upstream-check.mjs: what a probe declares, what a sent
// request lacks of the bundle, the verdict on each probe, and the text that goes
// into the rebake PR. Kept apart from the runner so the tests can import them
// without starting a proxy.

/** Billing buckets that mean the request was billed to the subscription. */
const SUBSCRIPTION_BUCKETS = new Set(['subscription', 'subscription_fallback']);

/**
 * An upstream answer that rejects the request itself. 401 is about the token,
 * 408 and 429 about timing and rate: none of the three says anything about
 * what the request carried.
 */
const isRejection = (status) => status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

/**
 * An upstream answer after which the proxy rests the seat it used: a refused
 * token (401, 403) or a rate limit (429). With no seat left to use, the proxy
 * answers the next request itself and sends nothing upstream.
 */
const restsSeat = (status) => status === 401 || status === 403 || status === 429;

const answersOf = (probe) => (Array.isArray(probe?.upstream) ? probe.upstream : []);

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
 * What a request lacks of the bundle. `request` is the { system, tools } of a
 * request body, as built or as recorded on its way upstream; `prompt` is the
 * bundle's prompt for the request's model and `declared` the names of the
 * tools the probe declared. Returns what is missing, in words: nothing when a
 * system block holds the prompt and every declared tool is carried exactly as
 * the bundle holds it.
 */
export function missingFromSent(request, { prompt, declared, bundle }) {
  const missing = [];
  const system = typeof request?.system === 'string' ? [{ text: request.system }] : Array.isArray(request?.system) ? request.system : [];
  const hasPrompt = typeof prompt === 'string' && prompt.length > 0
    && system.some((block) => typeof block?.text === 'string' && block.text.includes(prompt));
  if (!hasPrompt) missing.push('the bundled system prompt for its model');
  const carried = new Set(carriedBundleTools(Array.isArray(request?.tools) ? request.tools : [], bundle));
  const lacking = declared.filter((name) => !carried.has(name));
  if (lacking.length > 0) missing.push(`the bundled definition of ${lacking.length} of the ${declared.length} declared tools`);
  return missing;
}

/**
 * The verdict on one probe: { kind, why }.
 *
 * `status` is what the proxy answered the probe (0 when it did not answer).
 * `upstream` is the statuses upstream gave the requests the proxy sent for it,
 * in order (0 for one upstream did not answer). The proxy can send a request
 * again, on another seat or without a beta flag upstream refused, so the LAST
 * answer is the one judged. `afterSeatRested` says an earlier probe of the run
 * drew an answer that rests a seat (see probeVerdicts).
 *
 * Only an answer from upstream says anything about the bundle:
 *   pass        the proxy answered 200, from upstream, billed to the subscription
 *   fail        upstream's last answer rejected the request, or accepted it
 *               and billed it elsewhere
 *   incomplete  upstream did not judge the request: it refused the token,
 *               rate-limited, failed or was silent, or the proxy had no seat
 *               left to send it with
 *   error       the check did not work: the proxy did not answer, or answered
 *               on its own account with nothing from upstream to show for it
 *
 * The served model is reported, not judged: a load-time downgrade is the
 * billing canary's finding, not the bundle's.
 */
export function probeVerdict({ status, bucket, upstream, afterSeatRested = false }) {
  const answers = answersOf({ upstream });
  const last = answers[answers.length - 1];
  if (status === 200) {
    if (answers.length === 0) return { kind: 'error', why: 'the proxy answered HTTP 200 with no request recorded upstream' };
    // A 200 that upstream's last answer does not account for came from somewhere else.
    if (!(last >= 200 && last < 300)) return { kind: 'error', why: `the proxy answered HTTP 200 after upstream ${last ? `answered HTTP ${last}` : 'did not answer'}` };
    return SUBSCRIPTION_BUCKETS.has(bucket) ? { kind: 'pass', why: '' } : { kind: 'fail', why: `billed to ${bucket}` };
  }
  if (answers.length === 0) {
    if (!status) return { kind: 'error', why: 'the proxy did not answer' };
    if (afterSeatRested) return { kind: 'incomplete', why: `not sent: the proxy answered HTTP ${status} itself, after an earlier answer from upstream rested a seat` };
    return { kind: 'error', why: `the proxy answered HTTP ${status} without sending anything upstream` };
  }
  if (isRejection(last)) return { kind: 'fail', why: `HTTP ${last}` };
  if (last === 401) return { kind: 'incomplete', why: 'upstream refused the borrowed token (HTTP 401)' };
  if (!last) return { kind: 'incomplete', why: 'upstream did not answer' };
  if (last >= 200 && last < 300) return { kind: 'error', why: `the proxy ${status ? `answered HTTP ${status}` : 'did not answer'} after upstream answered HTTP ${last}` };
  return { kind: 'incomplete', why: `upstream answered HTTP ${last}` };
}

/**
 * The verdict on each probe of a run, in order.
 *
 * The probes share one proxy. Once upstream has refused a token or rate-limited
 * a seat, the proxy rests that seat, and with none left it answers the later
 * probes itself. Such an answer is the same unjudged request as the one that
 * rested the seat, not a fault of the check, so it is `incomplete`. The same
 * answer with no such history is an `error`.
 */
export function probeVerdicts(results) {
  let seatRested = false;
  return results.map((probe) => {
    const verdict = probeVerdict({ ...probe, afterSeatRested: seatRested });
    if (answersOf(probe).some(restsSeat)) seatRested = true;
    return verdict;
  });
}

/**
 * The run. A rejection is a fact about the bundle whatever happened to the
 * other probes, so `fail` comes first. Then `error` when a probe could not be
 * run or there were none, `incomplete` when upstream left one unjudged, and
 * `pass` only when every probe passed.
 */
export function summarizeProbes(results) {
  const kinds = probeVerdicts(results).map((v) => v.kind);
  if (kinds.includes('fail')) return 'fail';
  if (kinds.length === 0 || kinds.includes('error')) return 'error';
  return kinds.includes('incomplete') ? 'incomplete' : 'pass';
}

/** Why a run is an `error`, from the probes that could not be run. */
export function errorDetail(results) {
  const verdicts = probeVerdicts(results);
  const errors = results.map((r, i) => ({ model: r.model, ...verdicts[i] })).filter((v) => v.kind === 'error');
  return errors.length === 0 ? 'no probe was run' : errors.map((v) => `${v.why} (${v.model})`).join('; ');
}

const said = (status) => (status ? `HTTP ${status}` : 'no answer');
/** The answers upstream gave before its last one, for a request the proxy sent more than once. */
const earlier = (answers) => (answers.length > 1 ? ` after ${answers.slice(0, -1).map(said).join(', ')}` : '');

/**
 * The text of the check.
 *
 * outcome: 'pass' | 'fail' (these two go into a rebake PR) | 'incomplete'
 * (upstream left at least one request unjudged; the ones it did judge are
 * kept) | 'error' (the check itself did not work, or the proxy sent something
 * other than the bundle: no verdict either way).
 * The watcher opens no PR on the last two, so their text is for its log.
 */
export function formatUpstreamCheck({ outcome, results = [], version, captured, tools = { carried: 0, total: 0, left: [] }, detail = '' }) {
  const bundle = `the bundle (Claude Code ${version}, captured ${captured})`;
  if (outcome === 'error') {
    return [
      `The upstream check did not work: ${detail || 'the proxy did not become healthy'}. It gives no verdict on ${bundle}.`,
    ];
  }
  const verdicts = probeVerdicts(results);
  const declared = tools.carried === tools.total ? `all ${tools.total} tools in the bundle` : `${tools.carried} of the ${tools.total} tools in the bundle`;
  const left = tools.left.length ? ` (not ${tools.left.map((n) => `\`${n}\``).join(', ')}, which the request builder does not take from the bundle)` : '';
  const resent = results.some((r) => answersOf(r).length > 1) ? ' Where the proxy sent a request more than once, the row gives every answer and the last one is judged.' : '';
  const how = `Each probe declared ${declared} by name${left}. Every \`/v1/messages\` request the proxy sent upstream was recorded on its way, and each carried the bundled definitions of those tools and the bundled system prompt for its model.${resent} The proxy was started in code with its own defaults for building a request, no live capture and no live template cache; the caller's \`DARIO_*\` and \`ANTHROPIC_*\` variables and \`~/.dario/config.json\` took no part. The subscription credential was borrowed read-only.`;
  const done = verdicts.filter((v) => v.kind === 'pass').length;
  const head = outcome === 'pass'
    ? `Requests rebuilt from ${bundle} were sent upstream by this run and accepted. ${how}`
    : outcome === 'incomplete'
      ? `The upstream check did not finish: ${done === 0 ? 'none' : done} of the ${results.length} requests rebuilt from ${bundle} completed. ${done === 0 ? 'That says' : 'The ones that completed were accepted; the rest say'} nothing about the bundle, and the table gives the reason for each. The next watcher run tries again. ${how}`
      : `Requests rebuilt from ${bundle} were sent upstream by this run and at least one was not accepted as subscription traffic. Do not merge until that is understood; a failure does not by itself show that the captured change is the cause. ${how}`;
  return [
    head,
    '',
    '| Model | Result | Billed to | Served by |',
    '|---|---|---|---|',
    ...results.map((r, i) => {
      const v = verdicts[i];
      if (v.kind === 'incomplete') return `| \`${r.model}\` | not completed: ${v.why} | | |`;
      if (v.kind === 'error') return `| \`${r.model}\` | not run: ${v.why} | | |`;
      const before = earlier(answersOf(r));
      const result = v.kind === 'pass' ? `HTTP 200${before}` : v.why.startsWith('HTTP ') ? `${v.why}${before}` : `HTTP ${r.status}${before}, ${v.why}`;
      return `| \`${r.model}\` | ${result} | ${r.claim ? `\`${r.claim}\` (${r.bucket})` : r.bucket} | ${r.served ? `\`${r.served}\`` : 'not readable'} |`;
    }),
  ];
}

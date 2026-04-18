/**
 * Response-shape classifier for the authorize-URL probe.
 *
 * Lives in its own module so the probe and its unit test can share the
 * same logic without stubbing fetch. The probe hits a live URL; the test
 * feeds synthetic response shapes.
 */

/**
 * The specific string Anthropic's authorize endpoint returns for a scope
 * set its policy engine rejects. From the dario #42 investigation —
 * see src/cc-oauth-detect.ts FALLBACK.scopes comment block.
 */
export const REJECT_MARKER = 'Invalid request format';

/**
 * Cloudflare fronts claude.ai and challenges unrecognized clients — GitHub
 * Actions runners get the "Just a moment..." interstitial. We detect this
 * specifically so the nightly report says "CF-blocked" instead of a vague
 * "unexpected response", and operators know the probe needs to run from
 * a trusted IP (or be complemented by the scope-literal scan in
 * check-cc-drift.mjs) to actually be useful.
 */
function isCloudflareChallenge({ status, body }) {
  const bodyText = typeof body === 'string' ? body : '';
  // CF's challenge interstitial is stable across their variants:
  //   - "Just a moment..." in the <title>
  //   - /cdn-cgi/challenge-platform/ scripts referenced in the HTML
  //   - "cf-mitigated" response header (not always surfaced by fetch, so
  //     body heuristics are the fallback)
  if (bodyText.includes('Just a moment...') || bodyText.includes('/cdn-cgi/challenge-platform/')) {
    return true;
  }
  // 403 with a short-ish body pointing at cdn-cgi is also CF blocking.
  if (status === 403 && bodyText.includes('cdn-cgi')) {
    return true;
  }
  return false;
}

/**
 * Classify a response from the authorize endpoint as accepted / rejected /
 * inconclusive. The probe only cares about these three states:
 *
 *   accepted     — params passed validation (redirected to login/consent,
 *                  or a 2xx consent page rendered)
 *   rejected     — scope (or other request-format) validation failed with
 *                  the specific marker Anthropic returns
 *   inconclusive — anything else (5xx, unexpected 4xx body, HTML that
 *                  doesn't match either pattern). Treated as "try again
 *                  next nightly run" rather than drift.
 *
 * Input is the minimal shape we can collect from fetch() — the probe
 * reads `status`, the Location header (redirect target), and the body
 * text. `error` is set when the fetch itself blew up (DNS, timeout).
 */
export function classifyAuthorizeResponse({ status, location, body, error }) {
  if (error) {
    return { verdict: 'inconclusive', reason: `fetch error: ${error}` };
  }

  if (isCloudflareChallenge({ status, body })) {
    return {
      verdict: 'inconclusive',
      reason:
        `blocked by Cloudflare bot challenge (status=${status}). ` +
        `The live probe is unreliable from CI IPs — rely on the scope-literal ` +
        `scan in check-cc-drift.mjs, or run this probe from a trusted network.`,
    };
  }

  const bodyText = typeof body === 'string' ? body : '';
  if (bodyText.includes(REJECT_MARKER)) {
    return { verdict: 'rejected', reason: `body contains "${REJECT_MARKER}"` };
  }

  // 3xx with a Location that points at a login or consent page → the
  // request was accepted and the endpoint is handing us off to the user
  // consent step. This is the happy path for a valid scope set.
  if (status >= 300 && status < 400 && typeof location === 'string' && location.length > 0) {
    return { verdict: 'accepted', reason: `${status} redirect to ${location}` };
  }

  // 2xx without the reject marker → consent / login page rendered inline.
  if (status >= 200 && status < 300) {
    return { verdict: 'accepted', reason: `${status} body rendered, no reject marker` };
  }

  return {
    verdict: 'inconclusive',
    reason: `unexpected response: status=${status}, location=${location ?? 'none'}, body_len=${bodyText.length}`,
  };
}

/**
 * Combine the verdicts for probe A (pinned scopes) and probe B (pinned
 * scopes + a known-rejected scope) into a single watcher result.
 *
 *   A must be 'accepted' AND B must be 'rejected' for a clean run.
 *   A 'rejected' → our scopes stopped being accepted (breakage).
 *   B 'accepted' → the rejected scope is now accepted (policy relaxed).
 *   Either 'inconclusive' → the whole probe is inconclusive; no drift
 *     claim either way. Report it as info, don't page.
 */
export function combineVerdicts(a, b) {
  if (a.verdict === 'inconclusive' || b.verdict === 'inconclusive') {
    return {
      outcome: 'inconclusive',
      drift: false,
      items: [
        a.verdict === 'inconclusive'
          ? { probe: 'A', severity: 'info', message: `probe A inconclusive: ${a.reason}` }
          : null,
        b.verdict === 'inconclusive'
          ? { probe: 'B', severity: 'info', message: `probe B inconclusive: ${b.reason}` }
          : null,
      ].filter(Boolean),
    };
  }

  const items = [];

  if (a.verdict !== 'accepted') {
    items.push({
      probe: 'A',
      severity: 'high',
      message:
        `Pinned FALLBACK.scopes no longer accepted by authorize endpoint (${a.reason}). ` +
        `This is the dario #42 failure mode: users will hit "Invalid request format" on fresh login. ` +
        `Investigate which scope the server now rejects and update FALLBACK.scopes in src/cc-oauth-detect.ts; ` +
        `bump the cache suffix (CACHE_PATH) so existing users regenerate.`,
    });
  }

  if (b.verdict !== 'rejected') {
    items.push({
      probe: 'B',
      severity: 'medium',
      message:
        `The known-rejected scope (org:create_api_key) is no longer rejected (${b.reason}). ` +
        `Anthropic may have relaxed policy for this client_id. Not a user-facing breakage, but ` +
        `worth investigating: if the longer set is now accepted, revisit whether dropping ` +
        `org:create_api_key in FALLBACK.scopes is still the right call.`,
    });
  }

  return {
    outcome: items.length > 0 ? 'drift' : 'clean',
    drift: items.length > 0,
    items,
  };
}

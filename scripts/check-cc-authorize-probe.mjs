#!/usr/bin/env node
/**
 * CC authorize-URL probe.
 *
 * Follow-up to check-cc-drift.mjs — catches server-side scope policy flips
 * against Anthropic's authorize endpoint. The binary-scan drift watcher
 * can't see these: scopes are stored as a variable-reference list that no
 * regex resolves, so scanBinaryForOAuthConfig just returns FALLBACK.scopes
 * verbatim. This probe fills that gap.
 *
 * dario #42 is the motivating case: between CC v2.1.104 and v2.1.107,
 * Anthropic's authorize endpoint flipped its policy on `org:create_api_key`
 * for the CC client_id. The 6-scope form (with org:create_api_key) now
 * returns "Invalid request format"; the 5-scope form is the only one
 * accepted. The binary-scan drift watcher stayed green through that flip
 * because neither the client_id nor the URLs changed.
 *
 * The probe sends two GET requests to the authorize endpoint:
 *   A — pinned FALLBACK.scopes → expected: accepted (no reject marker,
 *       typically a 302 redirect to login)
 *   B — pinned FALLBACK.scopes + ' org:create_api_key' → expected:
 *       rejected (body contains "Invalid request format")
 *
 * Either expectation flipping is drift:
 *   A flipped → our scopes stopped being accepted (breakage incoming)
 *   B flipped → the rejected scope is now accepted (worth investigating)
 *
 * Network errors and unexpected response shapes do NOT exit non-zero —
 * the JSON report records them as inconclusive and the next nightly run
 * retries. This avoids false-positive issues from transient network flake.
 */

import { createHash, randomBytes } from 'node:crypto';

import { FALLBACK_FOR_DRIFT_CHECK as FALLBACK } from '../dist/cc-oauth-detect.js';
import { classifyAuthorizeResponse, combineVerdicts } from './_authorize-probe-classifier.mjs';

// Stays in sync with cc-oauth-detect.ts FALLBACK even if scanning gets
// extended later — we pull from the built module rather than hardcode.
const PINNED = {
  clientId: FALLBACK.clientId,
  authorizeUrl: FALLBACK.authorizeUrl,
  scopes: FALLBACK.scopes,
};

// The scope the server started rejecting in the dario #42 window. If this
// ever stops being rejected, that's information we want to surface.
const KNOWN_REJECTED_SCOPE = 'org:create_api_key';

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_REDIRECT_URI = 'http://localhost:12345/callback';

function log(msg) {
  console.error(`[cc-authz-probe] ${msg}`);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE S256 challenge. The authorize endpoint validates the
 * challenge format before (or alongside) the scope check, so we hand it
 * a real one rather than a placeholder — otherwise the "format" error we
 * trigger might be about PKCE, not scopes, and we'd misclassify.
 */
function pkceChallenge() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return challenge;
}

function buildAuthorizeUrl(scopes) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: PINNED.clientId,
    response_type: 'code',
    redirect_uri: PROBE_REDIRECT_URI,
    scope: scopes,
    code_challenge: pkceChallenge(),
    code_challenge_method: 'S256',
    state: base64url(randomBytes(16)),
  });
  return `${PINNED.authorizeUrl}?${params.toString()}`;
}

const PROBE_HEADERS = {
  // Identify honestly — don't pretend to be a real browser, but do provide
  // an Accept header a real authorize request would send so we don't get
  // routed to a JSON-only error path.
  'User-Agent': 'dario-cc-drift-probe/1 (+https://github.com/askalf/dario)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

/**
 * GET once with manual redirect handling, return the shape the classifier
 * wants. Separated from the probe() wrapper so we can follow one hop.
 */
async function fetchOnce(url) {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: PROBE_HEADERS,
    });
  } catch (err) {
    return { status: 0, location: null, body: '', error: err instanceof Error ? err.message : String(err) };
  }

  const location = res.headers.get('location');
  let body = '';
  try {
    body = await res.text();
  } catch (err) {
    return { status: res.status, location, body: '', error: `read body failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { status: res.status, location, body, error: null };
}

/**
 * `claude.com/cai/oauth/authorize` is an edge that 307-redirects to
 * `claude.ai/oauth/authorize` (same query string). The edge does NOT run
 * scope validation — it forwards the request and the destination returns
 * the "Invalid request format" body. If we stopped at the edge we'd see
 * every scope set as "accepted" and miss the dario #42 class of drift
 * entirely. So follow exactly one hop when the Location points at
 * claude.ai/anthropic.com/claude.com.
 */
async function probe(label, scopes) {
  const url = buildAuthorizeUrl(scopes);
  log(`${label}: GET ${PINNED.authorizeUrl} (scope count=${scopes.split(/\s+/).length})`);

  const first = await fetchOnce(url);
  if (first.error) {
    return classifyAuthorizeResponse(first);
  }

  const isTrustedRedirect =
    first.status >= 300 && first.status < 400 &&
    typeof first.location === 'string' &&
    /^https:\/\/(claude\.ai|claude\.com|[\w-]+\.anthropic\.com)\//.test(first.location);

  if (!isTrustedRedirect) {
    // Either a direct response (edge validated on its own) or a redirect
    // to somewhere we don't want to blindly follow. Classify as-is.
    return classifyAuthorizeResponse(first);
  }

  log(`${label}: following edge redirect → ${first.location}`);
  const second = await fetchOnce(first.location);
  return classifyAuthorizeResponse(second);
}

const checkedAt = new Date().toISOString();

const a = await probe('A (pinned scopes)', PINNED.scopes);
const b = await probe('B (pinned + known-rejected)', `${PINNED.scopes} ${KNOWN_REJECTED_SCOPE}`);

log(`A verdict: ${a.verdict} (${a.reason})`);
log(`B verdict: ${b.verdict} (${b.reason})`);

const combined = combineVerdicts(a, b);

const report = {
  drift: combined.drift,
  outcome: combined.outcome,
  checkedAt,
  pinned: {
    clientId: PINNED.clientId,
    authorizeUrl: PINNED.authorizeUrl,
    scopes: PINNED.scopes,
  },
  knownRejectedScope: KNOWN_REJECTED_SCOPE,
  probes: {
    A: { scopes: PINNED.scopes, verdict: a.verdict, reason: a.reason },
    B: { scopes: `${PINNED.scopes} ${KNOWN_REJECTED_SCOPE}`, verdict: b.verdict, reason: b.reason },
  },
  items: combined.items,
};

console.log(JSON.stringify(report, null, 2));

// Exit 1 only on confirmed drift. Inconclusive runs exit 0 — a flaky
// network or a weird one-off 500 shouldn't page oncall.
process.exit(combined.drift ? 1 : 0);

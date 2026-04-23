// Tests for runAuthorizeProbe + buildProbeAuthorizeUrl.
//
// The classifier logic (classifyAuthorizeResponse, combineVerdicts) is
// already covered by test/cc-authorize-probe-classifier.mjs — that file
// exercises the re-export from scripts/_authorize-probe-classifier.mjs
// so both the module-internal path and the script-facing path are
// validated. This file covers the new orchestration added in v3.32.0
// for `dario doctor --probe`: URL shape + one-hop redirect following +
// verdict plumbing with a mock fetchImpl.

import {
  buildProbeAuthorizeUrl,
  runAuthorizeProbe,
} from '../dist/cc-authorize-probe.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('buildProbeAuthorizeUrl — URL shape');
{
  const url = buildProbeAuthorizeUrl({
    clientId: 'test-client-id',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    scopes: 'user:a user:b',
  });
  const u = new URL(url);
  check('host + path match authorizeUrl', u.origin + u.pathname === 'https://claude.ai/oauth/authorize');
  check('client_id param is set', u.searchParams.get('client_id') === 'test-client-id');
  check('scope param is the passed scopes', u.searchParams.get('scope') === 'user:a user:b');
  check('code=true', u.searchParams.get('code') === 'true');
  check('response_type=code', u.searchParams.get('response_type') === 'code');
  check('code_challenge_method=S256', u.searchParams.get('code_challenge_method') === 'S256');
  check('code_challenge present', (u.searchParams.get('code_challenge') ?? '').length > 0);
  check('state present', (u.searchParams.get('state') ?? '').length > 0);
  check('redirect_uri is a dummy localhost URL (probe, not real flow)',
    /^http:\/\/localhost:\d+\//.test(u.searchParams.get('redirect_uri') ?? ''));
}

header('buildProbeAuthorizeUrl — PKCE code_challenge differs across invocations');
{
  const a = new URL(buildProbeAuthorizeUrl({ clientId: 'x', authorizeUrl: 'https://example.com/authz', scopes: 's' }));
  const b = new URL(buildProbeAuthorizeUrl({ clientId: 'x', authorizeUrl: 'https://example.com/authz', scopes: 's' }));
  check('code_challenge is fresh per call (random)',
    a.searchParams.get('code_challenge') !== b.searchParams.get('code_challenge'));
  check('state is fresh per call', a.searchParams.get('state') !== b.searchParams.get('state'));
}

// ─────────────────────────────────────────────────────────────

/** Mock fetch — pops responses from a queue in order. */
function mockFetch(responses) {
  return async () => {
    const next = responses.shift();
    if (!next) throw new Error('mockFetch: queue exhausted');
    return {
      status: next.status,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'location') return next.location ?? null;
          return null;
        },
      },
      text: async () => next.body ?? '',
    };
  };
}

header('runAuthorizeProbe — 302 to login + login page rendered = accepted');
{
  // Realistic flow: 302 from /oauth/authorize → /login on claude.ai
  // (same-host trusted redirect, probe follows), login page HTML
  // renders inline with no reject marker.
  const result = await runAuthorizeProbe(
    { clientId: 'c', authorizeUrl: 'https://claude.ai/oauth/authorize', scopes: 'a b c' },
    {
      fetchImpl: mockFetch([
        { status: 302, location: 'https://claude.ai/login?redirect=...', body: '' },
        { status: 200, location: null, body: '<html><body>Log in to Claude</body></html>' },
      ]),
    },
  );
  check('verdict=accepted', result.verdict === 'accepted');
  check('scopeCount=3', result.scopeCount === 3);
  check('probedUrl starts with authorizeUrl', result.probedUrl.startsWith('https://claude.ai/oauth/authorize?'));
  check('reason names the 200 body', result.reason.includes('200 body rendered'));
}

header('runAuthorizeProbe — 302 to non-Anthropic host = accepted (no follow)');
{
  // If the redirect points at a host we don't trust, the probe stops
  // there and classifies the 302 itself as "accepted" (the params
  // passed validation; we just don't fetch the untrusted location).
  const result = await runAuthorizeProbe(
    { clientId: 'c', authorizeUrl: 'https://claude.ai/oauth/authorize', scopes: 'a b c' },
    {
      fetchImpl: mockFetch([
        { status: 302, location: 'https://some-other-provider.example/oauth', body: '' },
      ]),
    },
  );
  check('verdict=accepted', result.verdict === 'accepted');
  check('reason names the 302', result.reason.includes('302 redirect'));
}

header('runAuthorizeProbe — body contains reject marker = rejected');
{
  const result = await runAuthorizeProbe(
    { clientId: 'c', authorizeUrl: 'https://claude.ai/oauth/authorize', scopes: 'bad' },
    { fetchImpl: mockFetch([{ status: 200, location: null, body: '<html><body>Authorization failed<br>Invalid request format</body></html>' }]) },
  );
  check('verdict=rejected', result.verdict === 'rejected');
  check('reason names the marker', result.reason.includes('Invalid request format'));
}

header('runAuthorizeProbe — Cloudflare challenge = inconclusive');
{
  const result = await runAuthorizeProbe(
    { clientId: 'c', authorizeUrl: 'https://claude.ai/oauth/authorize', scopes: 'a b c' },
    { fetchImpl: mockFetch([{ status: 200, location: null, body: '<html><title>Just a moment...</title></html>' }]) },
  );
  check('verdict=inconclusive', result.verdict === 'inconclusive');
  check('reason names Cloudflare', /cloudflare/i.test(result.reason));
}

header('runAuthorizeProbe — fetch throws = inconclusive');
{
  const result = await runAuthorizeProbe(
    { clientId: 'c', authorizeUrl: 'https://claude.ai/oauth/authorize', scopes: 'a b c' },
    { fetchImpl: async () => { throw new Error('ENETUNREACH'); } },
  );
  check('verdict=inconclusive', result.verdict === 'inconclusive');
  check('reason names fetch error', result.reason.includes('ENETUNREACH'));
}

header('runAuthorizeProbe — follows one hop when redirect lands on trusted Anthropic host');
{
  // First response: 307 to claude.ai/oauth/authorize (the legacy
  // claude.com/cai/... edge redirect that motivated dario#71). Second
  // response: the actual "Invalid request format" from claude.ai.
  const result = await runAuthorizeProbe(
    { clientId: 'c', authorizeUrl: 'https://claude.com/cai/oauth/authorize', scopes: 'a' },
    {
      fetchImpl: mockFetch([
        { status: 307, location: 'https://claude.ai/oauth/authorize?...', body: '' },
        { status: 200, location: null, body: 'Invalid request format' },
      ]),
    },
  );
  check('one-hop follow found the marker', result.verdict === 'rejected');
}

header('runAuthorizeProbe — does NOT follow redirect to untrusted host (queue-exhaustion guard)');
{
  // If the first-hop redirect pointed at a non-trusted host and we
  // DID follow, the mock queue would be exhausted on the second call
  // and throw. This test uses a one-response queue — if the probe
  // tries to follow, it throws; if it correctly stops, the first
  // response is classified and returned cleanly.
  let threw = false;
  try {
    const result = await runAuthorizeProbe(
      { clientId: 'c', authorizeUrl: 'https://claude.ai/oauth/authorize', scopes: 'a' },
      {
        fetchImpl: mockFetch([
          { status: 307, location: 'https://attacker.example.com/phish', body: '' },
        ]),
      },
    );
    check('probe returned without attempting second fetch', result.reason.includes('307 redirect'));
  } catch (err) {
    threw = true;
  }
  check('did NOT exhaust the mock queue (would have thrown)', threw === false);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

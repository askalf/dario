#!/usr/bin/env node
/**
 * CC authorize-URL probe, headless-browser variant.
 *
 * The fetch-based probe in check-cc-authorize-probe.mjs gets blocked by
 * Cloudflare's bot challenge from GitHub Actions IPs — CF inspects TLS
 * fingerprints and challenges anything that isn't a real browser, and
 * our fetch() presents Node/undici TLS. The fetch script's own doc
 * comment admits "the probe is most useful when a maintainer runs it
 * locally after the binary-scan watcher flags scope drift" — that
 * isn't preventative; by then a user has already hit it.
 *
 * This variant launches headless Chromium via Playwright, which speaks
 * TLS the same way a regular browser does and passes Cloudflare's
 * JavaScript challenges out of the box. CI runs through this; the
 * fetch-based probe stays as a zero-dependency fallback for operators
 * running probes locally without installing Playwright.
 *
 * CI dependency: the calling workflow must `npx playwright install
 * chromium` before invoking this script. This file does not modify
 * dario's runtime dependencies — Playwright is installed as a one-off
 * CI artifact, not declared in package.json, preserving the
 * zero-runtime-dep policy.
 *
 * JSON report shape is identical to check-cc-authorize-probe.mjs so
 * the workflow's issue-opening logic and the operator-facing format
 * stay unchanged.
 */

import { createHash, randomBytes } from 'node:crypto';

import { FALLBACK_FOR_DRIFT_CHECK as FALLBACK } from '../dist/cc-oauth-detect.js';
import { classifyAuthorizeResponse, combineVerdicts } from '../dist/cc-authorize-probe.js';

const PINNED = {
  clientId: FALLBACK.clientId,
  authorizeUrl: FALLBACK.authorizeUrl,
  scopes: FALLBACK.scopes,
};

const SCOPE_UNDER_TEST = 'org:create_api_key';

const PROBE_TIMEOUT_MS = 45_000; // headless browser takes longer to settle than fetch
const PROBE_REDIRECT_URI = 'http://localhost:12345/callback';

function log(msg) {
  console.error(`[cc-authz-probe-headless] ${msg}`);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkceChallenge() {
  const verifier = base64url(randomBytes(32));
  return base64url(createHash('sha256').update(verifier).digest());
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

// Import Playwright dynamically so this script can be invoked with a
// clear error if Playwright isn't installed, instead of a top-level
// import failure that looks like a syntax error in the CI log.
let playwright;
try {
  playwright = await import('playwright');
} catch (err) {
  log(`Playwright not installed — run \`npx playwright install chromium\` first.`);
  log(`Install error: ${err?.message ?? String(err)}`);
  process.exit(2);
}

// Launch once, reuse for both probes. Cloudflare IP scoring is
// session-based, so hitting CF twice from the same browser context
// means the second request doesn't re-challenge (saves ~5s).
const browser = await playwright.chromium.launch({
  headless: true,
  // Flags that reduce the automation-detection signal without trying to
  // look like a human. We're not evading detection — we're just
  // presenting a real browser stack so CF's JS challenge can run.
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
});

const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 720 },
  locale: 'en-US',
});

async function probe(label, scopes) {
  const url = buildAuthorizeUrl(scopes);
  log(`${label}: navigating (scope count=${scopes.split(/\s+/).length})`);

  const page = await context.newPage();
  try {
    let finalStatus = 0;
    let finalLocation = null;

    // Record the last response that landed on the authorize endpoint.
    // Playwright's goto() follows redirects, so by the time we read
    // page.url() we're past any 3xx hops. status() on the FINAL response
    // is what we want; redirect chain isn't needed for classification.
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PROBE_TIMEOUT_MS,
    }).catch((err) => {
      log(`${label}: goto failed — ${err?.message ?? String(err)}`);
      return null;
    });

    if (response) {
      finalStatus = response.status();
      // Follow any same-host redirect trail to the final URL.
      finalLocation = page.url();
    }

    // Give Cloudflare's JS challenge (if any) a chance to clear. If the
    // page is already past the challenge (normal case), this is a no-op.
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);

    const body = await page.content();
    const verdict = classifyAuthorizeResponse({
      status: finalStatus,
      location: finalLocation,
      body,
      error: null,
    });
    return verdict;
  } finally {
    await page.close().catch(() => undefined);
  }
}

const checkedAt = new Date().toISOString();

const scopesWithoutTest = PINNED.scopes
  .split(/\s+/)
  .filter((s) => s !== SCOPE_UNDER_TEST)
  .join(' ');

const a = await probe('A (pinned — 6-scope with org:create_api_key)', PINNED.scopes);
const b = await probe('B (5-scope — org:create_api_key removed)', scopesWithoutTest);

await context.close();
await browser.close();

log(`A verdict: ${a.verdict} (${a.reason})`);
log(`B verdict: ${b.verdict} (${b.reason})`);

const combined = combineVerdicts(a, b);

const report = {
  drift: combined.drift,
  outcome: combined.outcome,
  checkedAt,
  transport: 'headless-chromium',
  pinned: {
    clientId: PINNED.clientId,
    authorizeUrl: PINNED.authorizeUrl,
    scopes: PINNED.scopes,
  },
  scopeUnderTest: SCOPE_UNDER_TEST,
  probes: {
    A: { scopes: PINNED.scopes, verdict: a.verdict, reason: a.reason },
    B: { scopes: scopesWithoutTest, verdict: b.verdict, reason: b.reason },
  },
  items: combined.items,
};

console.log(JSON.stringify(report, null, 2));

process.exit(combined.drift ? 1 : 0);

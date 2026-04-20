// dario shim runtime — loaded into a CC child process via NODE_OPTIONS=--require
//
// CommonJS by necessity: --require only accepts CJS. Hand-written, no build step.
//
// Responsibilities, in order of importance:
//   1. Patch globalThis.fetch so outbound POSTs to *.anthropic.com/v1/messages
//      are rewritten with the dario template (system blocks, tools, fingerprint headers).
//   2. Peek the response headers and relay billing markers
//      (anthropic-ratelimit-unified-representative-claim and friends) to the
//      dario host over a unix/named-pipe socket if DARIO_SHIM_SOCK is set.
//   3. Be invisible when DARIO_SHIM is unset — so dario can install the require
//      globally without breaking unrelated Node processes.
//   4. Failsafe: any internal error falls through to the original fetch. The shim
//      must never break the host process. CC's retry/auth/streaming logic stays intact.

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const TEMPLATE_PATH = process.env.DARIO_SHIM_TEMPLATE
  || path.join(os.homedir(), '.dario', 'cc-template.live.json');
const RELAY_SOCK = process.env.DARIO_SHIM_SOCK || null;
const VERBOSE = process.env.DARIO_SHIM_VERBOSE === '1';

function log(msg) {
  if (VERBOSE) {
    try { process.stderr.write(`[dario-shim] ${msg}\n`); } catch (_) { /* noop */ }
  }
}

/**
 * Detect the JS runtime we've been loaded into. Shim was designed for
 * Node — Bun ships its own fetch + undici with slightly different
 * internals, and Deno's fetch is a completely different implementation.
 * Patching globalThis.fetch works in all three, but body/header semantics
 * may drift. We log a warning for non-Node runtimes so surprising
 * behavior is traceable to the root cause.
 *
 * When Anthropic eventually ships a Bun-compiled / single-binary CC,
 * this detector is the canary — a user running `dario shim -- claude ...`
 * against a Bun CC will see the warning and know to expect quirks.
 */
function detectRuntime() {
  if (typeof globalThis.Bun !== 'undefined') return 'bun';
  if (typeof globalThis.Deno !== 'undefined') return 'deno';
  if (typeof process !== 'undefined' && process.versions && process.versions.node) return 'node';
  return 'unknown';
}

const RUNTIME = detectRuntime();
if (RUNTIME !== 'node') {
  log(`running under ${RUNTIME} — shim was validated against Node. Body/header semantics may differ.`);
}

let template = null;
let templateMtime = 0;

/**
 * Load the template, re-reading from disk if the file's mtime has changed.
 * Auto-refresh matters for long-running shim sessions: dario's live
 * fingerprint capture may update the template file mid-session (daily
 * refresh), and we'd like the shim to pick up the new version without
 * requiring a child restart.
 *
 * Cached in memory between calls so we don't stat on every intercept.
 */
function loadTemplate() {
  try {
    const stat = fs.statSync(TEMPLATE_PATH);
    if (template && stat.mtimeMs === templateMtime) return template;
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.agent_identity && parsed.system_prompt && Array.isArray(parsed.tools)) {
      const prevVersion = template && template.cc_version;
      template = parsed;
      templateMtime = stat.mtimeMs;
      if (prevVersion && prevVersion !== parsed.cc_version) {
        log(`template reloaded: cc_version ${prevVersion} → ${parsed.cc_version}`);
      } else {
        log(`template loaded from ${TEMPLATE_PATH} (cc_version=${parsed.cc_version || 'unknown'}${
          Array.isArray(parsed.header_order) ? `, header_order=${parsed.header_order.length}` : ''
        })`);
      }
      return template;
    }
    log(`template at ${TEMPLATE_PATH} missing required fields — passthrough`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`template load failed: ${e.message} — passthrough`);
  }
  return null;
}

let relaySock = null;
function relay(event) {
  if (!RELAY_SOCK) return;
  try {
    if (!relaySock) {
      relaySock = net.createConnection(RELAY_SOCK);
      relaySock.on('error', () => { relaySock = null; });
    }
    relaySock.write(JSON.stringify(event) + '\n');
  } catch (_) { /* relay is best-effort */ }
}

function isAnthropicMessages(url) {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    return /(^|\.)anthropic\.com$/.test(u.hostname) && u.pathname === '/v1/messages';
  } catch (_) {
    return false;
  }
}

function rewriteBody(bodyText, tmpl) {
  let body;
  try { body = JSON.parse(bodyText); } catch (_) { return null; }
  if (!body || typeof body !== 'object') return null;

  // Defensive shape check. Real CC sends:
  //   system: [billing_tag, agent_identity, system_prompt]  (length 3, all text blocks)
  // If we see anything else — a one-element system, a four-element system,
  // an image block in system[0], CC shipping a restructured system array
  // in a future release — passthrough instead of rewriting. Blindly
  // replacing blocks we don't understand can corrupt the request in ways
  // that break the child silently (think: 400 with "unexpected block type").
  //
  // The old logic accepted `length >= 1`, creating [1] and [2] out of thin
  // air when they didn't exist. That's a recipe for template drift incidents
  // when CC's shape changes. Strict check, log, passthrough on mismatch.
  if (!Array.isArray(body.system) || body.system.length !== 3) {
    log(`body rewrite skipped: system has ${Array.isArray(body.system) ? body.system.length : 'no'} blocks, expected 3`);
    return null;
  }
  const allText = body.system.every((b) =>
    b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string',
  );
  if (!allText) {
    log('body rewrite skipped: system contains non-text blocks');
    return null;
  }

  const billingTag = body.system[0];
  body.system = [
    billingTag,
    { type: 'text', text: tmpl.agent_identity, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: tmpl.system_prompt,  cache_control: { type: 'ephemeral' } },
  ];
  body.tools = tmpl.tools;
  return JSON.stringify(body);
}

function rewriteHeaders(headers, tmpl) {
  // Headers in fetch() init can be Headers, plain object, or array of pairs.
  // We normalize into a Map (lowercased keys, insertion-order iteration),
  // then return an array of [name, value] pairs — a valid HeadersInit —
  // which fetch() will serialize on the wire in our exact order.
  //
  // A plain Headers object won't do: per the fetch spec, Headers iteration
  // is sorted alphabetically, so building a Headers with sets in order
  // would succeed internally but iteration (and any downstream code that
  // reads via for...of) would see sorted order. Using an array bypasses
  // that entirely — the HTTP layer writes pairs in array order.
  //
  // This is the v3.13 "hide in the population" hook: when the live capture
  // has recorded CC's header sequence, we replay it on every outbound
  // request so Anthropic sees the same shape we observed.
  const src = new Headers(headers || {});
  const snapshot = new Map();
  for (const [name, value] of src) {
    snapshot.set(name.toLowerCase(), value);
  }
  if (tmpl.cc_version) {
    snapshot.set('user-agent', `claude-cli/${tmpl.cc_version} (external, cli)`);
    snapshot.set('x-anthropic-billing-header', `cc_version=${tmpl.cc_version}`);
  }
  snapshot.set('anthropic-beta', tmpl.anthropic_beta || 'claude-code-20250219');

  if (!Array.isArray(tmpl.header_order) || tmpl.header_order.length === 0) {
    return [...snapshot.entries()];
  }

  // Rebuild in the captured order. Any header the caller supplied that
  // wasn't in the captured order gets appended at the end so we don't
  // silently drop host-added headers (content-type, content-length).
  const ordered = [];
  const seen = new Set();
  for (const name of tmpl.header_order) {
    const key = name.toLowerCase();
    if (snapshot.has(key)) {
      ordered.push([key, snapshot.get(key)]);
      seen.add(key);
    }
  }
  for (const [key, value] of snapshot) {
    if (!seen.has(key)) {
      ordered.push([key, value]);
    }
  }
  return ordered;
}

/**
 * Warn when the child's user-agent cc_version differs from the template's.
 * Useful signal during a CC upgrade: the user installed a new CC but the
 * live template cache is stale, so we're about to fingerprint as an older
 * version than the actual CC binary. The shim still works — we overwrite
 * the user-agent regardless — but logging the drift makes debugging
 * easier when a user reports "Anthropic started seeing me as 2.1.200 even
 * though I'm running 2.1.250".
 */
function checkVersionDrift(headers, tmpl) {
  if (!tmpl || !tmpl.cc_version) return;
  try {
    const h = new Headers(headers || {});
    const ua = h.get('user-agent') || '';
    const match = ua.match(/claude-cli\/(\d+\.\d+\.\d+)/);
    if (match && match[1] && match[1] !== tmpl.cc_version) {
      log(`version drift: child cc_version=${match[1]}, template cc_version=${tmpl.cc_version} — shim will impersonate template version`);
    }
  } catch (_) { /* noop */ }
}

function shouldIntercept(input, init) {
  const method = (init && init.method) || (input && input.method) || 'GET';
  if (String(method).toUpperCase() !== 'POST') return false;
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  return isAnthropicMessages(url);
}

const originalFetch = globalThis.fetch;

function installFetchPatch() {
  if (typeof originalFetch !== 'function') {
    log('globalThis.fetch is not a function — shim disabled');
    return;
  }
  globalThis.fetch = darioShimFetch;
}

async function darioShimFetch(input, init) {
  try {
    if (!shouldIntercept(input, init)) {
      return originalFetch.call(this, input, init);
    }

    const tmpl = loadTemplate();
    if (!tmpl) return originalFetch.call(this, input, init);

    let bodyText;
    if (init && typeof init.body === 'string') {
      bodyText = init.body;
    } else if (input && typeof input.text === 'function') {
      bodyText = await input.clone().text();
    } else {
      log('unsupported body shape — passthrough');
      return originalFetch.call(this, input, init);
    }

    const rewritten = rewriteBody(bodyText, tmpl);
    if (!rewritten) {
      log('body rewrite failed — passthrough');
      return originalFetch.call(this, input, init);
    }

    const srcHeaders = (init && init.headers) || (input && input.headers);
    checkVersionDrift(srcHeaders, tmpl);
    const newInit = Object.assign({}, init || {}, {
      method: 'POST',
      body: rewritten,
      headers: rewriteHeaders(srcHeaders, tmpl),
    });
    const url = typeof input === 'string' ? input : input.url;

    relay({ kind: 'request', timestamp: Date.now(), bytes: rewritten.length });
    const response = await originalFetch.call(this, url, newInit);

    const claim = response.headers.get('anthropic-ratelimit-unified-representative-claim');
    const overage = response.headers.get('anthropic-ratelimit-unified-overage-utilization');
    relay({
      kind: 'response',
      timestamp: Date.now(),
      status: response.status,
      claim: claim || null,
      overageUtil: overage ? parseFloat(overage) : null,
    });
    return response;
  } catch (e) {
    log(`shim fetch error: ${e.message} — passthrough`);
    return originalFetch.call(this, input, init);
  }
};

if (process.env.DARIO_SHIM === '1') {
  installFetchPatch();
}

// Internal hooks for unit tests. Always exported so tests can require this
// file without setting DARIO_SHIM (which would patch the test process's fetch).
module.exports = {
  _rewriteBody: rewriteBody,
  _rewriteHeaders: rewriteHeaders,
  _checkVersionDrift: checkVersionDrift,
  _detectRuntime: detectRuntime,
  _loadTemplate: loadTemplate,
  _shouldIntercept: shouldIntercept,
  _isAnthropicMessages: isAnthropicMessages,
  _darioShimFetch: darioShimFetch,
  _installFetchPatch: installFetchPatch,
};

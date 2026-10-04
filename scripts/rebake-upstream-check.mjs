#!/usr/bin/env node
/**
 * Upstream check for a freshly baked bundle.
 *
 * cc-drift-template-watch.yml runs this between the bake and the rebake PR.
 * It answers the one question no other check does: does upstream accept a
 * request REBUILT FROM THE BUNDLE, and bill it to the subscription? compat-test
 * and the live-test probe run the proxy in passthrough mode, and the billing
 * canary's proxy prefers the runner's live capture to the bundle.
 *
 * It starts this checkout's proxy through scripts/_rebake-probe-proxy.mjs: in
 * code, with the bundle as its only template, so that the CLI's flag defaults,
 * the caller's DARIO_* and ANTHROPIC_* variables and ~/.dario/config.json take
 * no part in how a request is built. It sends one small request for the base
 * model and for each prompt-variant family's capture model. Each request
 * declares the bundle's tools by name, so the rebuilt request carries the
 * bundled tool definitions; a request with no tools carries none for most
 * models.
 *
 * What went upstream is read, not assumed. The proxy records the model, system
 * blocks and tools of every request it sends, and a run in which one of them
 * lacks the bundled prompt for its model or the bundled definition of a
 * declared tool is an error, not a verdict.
 *
 * The subscription credential is BORROWED READ-ONLY (DARIO_NO_TOKEN_REFRESH=1,
 * set here, not left to the caller). A second process that refreshes the shared
 * token rotates it out from under production; see cc-billing-classifier-canary.yml.
 *
 * Outcomes, written to upstream-check.json as { outcome, results, tools }:
 *   pass        upstream answered every probe 200, billed to the subscription
 *   fail        upstream rejected a probe, or billed one elsewhere
 *   incomplete  none failed, but upstream left one unjudged: the token needed
 *               renewing, or upstream rate-limited, failed or was silent
 *   blocked     the proxy could not serve for want of a token; nothing sent
 *   error       the check did not work (a probe got no answer, or an answer
 *               with nothing from upstream behind it), or the proxy sent
 *               something other than the bundle; no verdict
 * stdout is the text of the check (markdown). The exit code is 0 for pass and
 * 1 for anything else; the workflow reads the outcome from the JSON, so a
 * crash of this script cannot be read as a verdict on the bundle.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { carriedBundleTools, errorDetail, formatUpstreamCheck, missingFromSent, probeBlocked, probeBody, probeTools, summarizeProbes, RENEWAL_MARKER } from './_rebake-upstream.mjs';
import { startTracked } from './_tracked-process.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REBAKE_CHECK_PORT || 3459);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'rebake-upstream-'));
// The proxy's local key for this run, set on the proxy and sent on every probe.
const PROBE_KEY = randomBytes(24).toString('hex');

// A signal that ends this check runs no `finish`, so the scratch directory,
// which holds the proxy's log and its record of what it sent, is removed here.
// While the proxy runs, the process helper handles the same signal after this,
// stops the proxy and ends the process. Otherwise the signal is raised again
// from here.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    rmSync(tmp, { recursive: true, force: true });
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  });
}

// A DARIO_* or ANTHROPIC_* variable can change how a request is built, where it
// is sent and which credential pays for it. None of the caller's reaches the
// request builder loaded below or the proxy, which inherits this environment.
// The ones this check depends on are set here.
for (const name of Object.keys(process.env)) {
  if (/^(DARIO|ANTHROPIC)_/.test(name)) delete process.env[name];
}
process.env.DARIO_NO_TOKEN_REFRESH = '1';
// The builder must answer from the bundle, as the proxy will, and it reads this
// variable when it is loaded: hence the assignment before the dynamic imports.
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(tmp, 'no-live-cache.json');
const { TEMPLATE_BASE_MODEL, VARIANT_FAMILIES } = await import('../dist/live-fingerprint.js');
const { buildCCRequest } = await import('../dist/cc-template.js');
const { billingBucketFromClaim } = await import('../dist/analytics.js');

const srcBundle = readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8');
const bundle = JSON.parse(srcBundle);
// One probe per model, each with the prompt the bundle holds for it.
const PROBES = [
  { model: TEMPLATE_BASE_MODEL, prompt: bundle.system_prompt },
  ...VARIANT_FAMILIES.map((f) => ({ model: f.captureModel, prompt: bundle.system_prompt_variants?.[f.key] ?? bundle.system_prompt })),
];
let tools = { carried: 0, total: (bundle.tools ?? []).length, left: [] };
const finish = (outcome, results = [], detail = '') => {
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(formatUpstreamCheck({ outcome, results, version: bundle._version, captured: bundle._captured, tools, detail }).join('\n') + '\n');
  writeFileSync(join(repoRoot, 'upstream-check.json'), JSON.stringify({ outcome, results, tools }, null, 2) + '\n');
  process.exit(outcome === 'pass' ? 0 : 1);
};

// The proxy loads dist/cc-template-data.json, which `npm run build` copied
// before the bake rewrote src/. Checking a stale copy would validate the bundle
// being replaced.
let distBundle = null;
try { distBundle = readFileSync(join(repoRoot, 'dist/cc-template-data.json'), 'utf-8'); } catch { /* not built */ }
if (distBundle !== srcBundle) finish('error', [], 'dist/cc-template-data.json is not the bundle in src/ (copy it or rebuild first)');

// What a probe should carry, from the request builder the proxy uses. The
// builder does not take every tool from the bundle, so the probes declare the
// ones it does, and a request for each model must then carry all of those and
// the bundle's prompt for that model.
const built = (model, declaredTools) => buildCCRequest(probeBody(model, declaredTools), 'rebake-upstream-check', { type: 'ephemeral' }, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }).body;
const fromBundle = new Set(carriedBundleTools(built(TEMPLATE_BASE_MODEL, probeTools(bundle)).tools, bundle));
const declared = probeTools(bundle).filter((t) => fromBundle.has(t.name));
const declaredNames = declared.map((t) => t.name);
tools = { carried: declared.length, total: tools.total, left: (bundle.tools ?? []).map((t) => t.name).filter((n) => !fromBundle.has(n)) };
if (declared.length === 0) finish('error', [], 'the request builder carries none of the bundled tool definitions for a client that declares them');
for (const { model, prompt } of PROBES) {
  const missing = missingFromSent(built(model, declared), { prompt, declared: declaredNames, bundle });
  if (missing.length > 0) finish('error', [], `the request builder's request for ${model} lacks ${missing.join(' and ')}`);
}

const health = async () => {
  try {
    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return 0;
  }
};

// A proxy started on a port that already answers would leave the other process
// serving, and the probes would test someone else's proxy.
if (await health() !== 0) finish('error', [], `port ${PORT} is already in use`);

const logPath = join(tmp, 'proxy.log');
const recordPath = join(tmp, 'sent.jsonl');
const logFd = openSync(logPath, 'a');
// The CLI runs the proxy on Bun when Bun is installed, and the same choice is
// made here. startTracked puts the proxy in its own process group, so that
// stopping it stops whatever it started.
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
})();
const proxyArgs = ['scripts/_rebake-probe-proxy.mjs', String(PORT), recordPath];
const proxy = startTracked(hasBun ? 'bun' : process.execPath, hasBun ? ['run', ...proxyArgs] : proxyArgs, {
  cwd: repoRoot,
  env: { ...process.env, DARIO_API_KEY: PROBE_KEY },
  stdio: ['ignore', logFd, logFd],
});
const stop = async () => {
  const stopped = await proxy.stop(async () => (await health()) !== 0);
  closeSync(logFd);
  // A proxy left listening makes the next run find the port taken.
  if (!stopped) console.error(`::warning::rebake upstream check: the proxy on port ${PORT} is still answering after SIGTERM and SIGKILL`);
};
const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };
const textFrom = (path, offset) => { try { return readFileSync(path).subarray(offset).toString('utf-8'); } catch { return ''; } };
// The /v1/messages requests the proxy has recorded since `offset`.
const sentFrom = (offset) => textFrom(recordPath, offset).split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return {}; } })
  .filter((entry) => entry.request);

let up = false;
for (let i = 0; i < 30 && !proxy.hasExited(); i += 1) {
  if (await health() === 200) { up = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!up) {
  // The proxy's own words go to the job log. They can name accounts and paths,
  // and the text of this check is published.
  const log = textFrom(logPath, 0);
  console.error('rebake upstream check: the proxy did not become healthy. Its log ends:');
  console.error(log.trim().split('\n').slice(-15).join('\n'));
  await stop();
  finish(log.includes(RENEWAL_MARKER) ? 'blocked' : 'error', [], 'the proxy did not become healthy within 30 seconds (its log is in the run)');
}

const results = [];
const notTheBundle = [];
for (const { model, prompt } of PROBES) {
  const logBefore = sizeOf(logPath);
  const sentBefore = sizeOf(recordPath);
  let status = 0;
  let claim = '';
  let served = '';
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': PROBE_KEY },
      body: JSON.stringify(probeBody(model, declared)),
      signal: AbortSignal.timeout(60000),
    });
    status = res.status;
    claim = res.headers.get('anthropic-ratelimit-unified-representative-claim') ?? res.headers.get('representative-claim') ?? '';
    const body = await res.json().catch(() => null);
    served = typeof body?.model === 'string' ? body.model : '';
  } catch {
    status = 0;
  }
  // The proxy appends to its record before it answers, so what this probe sent
  // upstream, and what upstream answered, is on disk by now.
  const sent = sentFrom(sentBefore);
  for (const entry of sent) {
    const missing = missingFromSent(entry.request, { prompt, declared: declaredNames, bundle });
    if (missing.length > 0) notTheBundle.push(`a request the proxy sent upstream for ${model} lacked ${missing.join(' and ')}`);
  }
  const blocked = probeBlocked({ status, logDuringProbe: textFrom(logPath, logBefore) });
  results.push({ model, status, claim, bucket: billingBucketFromClaim(claim || null), served, blocked, upstream: sent.map((entry) => entry.status) });
}

await stop();
// Upstream's answer to a request that did not carry the bundle is no verdict on
// the bundle, whatever the answer was.
if (notTheBundle.length > 0) finish('error', results, [...new Set(notTheBundle)].join('; '));
const outcome = summarizeProbes(results);
finish(outcome, results, outcome === 'error' ? errorDetail(results) : '');

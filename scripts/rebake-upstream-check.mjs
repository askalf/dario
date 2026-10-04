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
 * It starts this checkout's proxy in canonical-rebuild mode with the bundle as
 * its only template:
 *   --no-live-capture                 Claude Code is never spawned
 *   DARIO_LIVE_TEMPLATE_CACHE=<none>  a live capture on this host is not read
 * and sends one small request for the base model and for each prompt-variant
 * family's capture model. Each request declares the bundle's tools by name, so
 * the rebuilt request carries the bundled tool definitions; a request with no
 * tools carries none for most models. Before anything is sent, the same
 * request builder the proxy uses is asked what it would send, and the check
 * stops if a probe would not carry the bundled prompt and tools.
 *
 * The subscription credential is BORROWED READ-ONLY (DARIO_NO_TOKEN_REFRESH=1,
 * set here, not left to the caller). A second process that refreshes the shared
 * token rotates it out from under production; see cc-billing-classifier-canary.yml.
 *
 * Outcomes, written to upstream-check.json as { outcome, results, tools }:
 *   pass        every probe got 200 and was billed to the subscription
 *   fail        a probe that completed was rejected or billed elsewhere
 *   incomplete  no probe failed, but the token needed renewing part-way
 *   blocked     the proxy could not serve for want of a token; nothing sent
 *   error       the check itself did not work; nothing sent
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

import { carriedBundleTools, formatUpstreamCheck, probeBlocked, probeBody, probeTools, summarizeProbes, RENEWAL_MARKER } from './_rebake-upstream.mjs';
import { startTracked } from './_tracked-process.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REBAKE_CHECK_PORT || 3459);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'rebake-upstream-'));
// The proxy's local key, set on the proxy and sent on every probe. A
// DARIO_API_KEY in the caller's environment would otherwise reach the proxy and
// reject the probes with 401 before any of them went upstream.
const PROBE_KEY = randomBytes(24).toString('hex');

// The builder is asked below what a probe would send. It must answer from the
// bundle, as the proxy started further down will, and it reads this variable
// when it is loaded: hence the assignment before the dynamic imports.
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(tmp, 'no-live-cache.json');
const { TEMPLATE_BASE_MODEL, VARIANT_FAMILIES } = await import('../dist/live-fingerprint.js');
const { buildCCRequest, systemPromptForModel } = await import('../dist/cc-template.js');
const { billingBucketFromClaim } = await import('../dist/analytics.js');
const MODELS = [TEMPLATE_BASE_MODEL, ...VARIANT_FAMILIES.map((f) => f.captureModel)];

const srcBundle = readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8');
const bundle = JSON.parse(srcBundle);
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

// What a probe will carry, from the request builder the proxy uses. The builder
// does not take every tool from the bundle, so the probes declare the ones it
// does, and every probe must then carry all of those and the bundled prompt
// for its model.
const built = (model, declared) => buildCCRequest(probeBody(model, declared), 'rebake-upstream-check', { type: 'ephemeral' }, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }).body;
const fromBundle = new Set(carriedBundleTools(built(TEMPLATE_BASE_MODEL, probeTools(bundle)).tools, bundle));
const declared = probeTools(bundle).filter((t) => fromBundle.has(t.name));
tools = { carried: declared.length, total: tools.total, left: (bundle.tools ?? []).map((t) => t.name).filter((n) => !fromBundle.has(n)) };
if (declared.length === 0) finish('error', [], 'the request builder carries none of the bundled tool definitions for a client that declares them');
for (const model of MODELS) {
  const body = built(model, declared);
  const carried = carriedBundleTools(body.tools, bundle).length;
  const prompt = (body.system ?? []).some((block) => typeof block?.text === 'string' && block.text.includes(systemPromptForModel(model)));
  if (carried !== declared.length || !prompt) {
    finish('error', [], `a probe for ${model} would not carry the bundle (${carried} of ${declared.length} declared tool definitions, bundled prompt: ${prompt ? 'yes' : 'no'})`);
  }
}

const health = async () => {
  try {
    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return 0;
  }
};

// `dario proxy` on a port that already answers exits 0 and leaves the other
// process serving, so the probes would test someone else's proxy.
if (await health() !== 0) finish('error', [], `port ${PORT} is already in use`);

const logPath = join(tmp, 'proxy.log');
const logFd = openSync(logPath, 'a');
// dist/cli.js relaunches itself under Bun when Bun is installed, and the Node
// wrapper it leaves behind does not forward signals. The runtime is chosen
// here and DARIO_NO_BUN is set, so the process started below is the proxy
// itself; it runs on Bun where the CLI would have. startTracked also puts it
// in its own process group, so that stopping it stops whatever it started.
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
})();
const cliArgs = ['dist/cli.js', 'proxy', `--port=${PORT}`, '--no-live-capture'];
const proxy = startTracked(hasBun ? 'bun' : process.execPath, hasBun ? ['run', ...cliArgs] : cliArgs, {
  cwd: repoRoot,
  env: { ...process.env, DARIO_API_KEY: PROBE_KEY, DARIO_NO_BUN: '1', DARIO_NO_TOKEN_REFRESH: '1' },
  stdio: ['ignore', logFd, logFd],
});
const stop = async () => {
  const stopped = await proxy.stop(async () => (await health()) !== 0);
  closeSync(logFd);
  // A proxy left listening makes the next run find the port taken.
  if (!stopped) console.error(`::warning::rebake upstream check: the proxy on port ${PORT} is still answering after SIGTERM and SIGKILL`);
};
const logSize = () => { try { return statSync(logPath).size; } catch { return 0; } };
const logFrom = (offset) => { try { return readFileSync(logPath).subarray(offset).toString('utf-8'); } catch { return ''; } };

let up = false;
for (let i = 0; i < 30 && !proxy.hasExited(); i += 1) {
  if (await health() === 200) { up = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!up) {
  // The proxy's own words go to the job log. They can name accounts and paths,
  // and the text of this check is published.
  const log = logFrom(0);
  console.error('rebake upstream check: the proxy did not become healthy. Its log ends:');
  console.error(log.trim().split('\n').slice(-15).join('\n'));
  await stop();
  finish(log.includes(RENEWAL_MARKER) ? 'blocked' : 'error', [], 'the proxy did not become healthy within 30 seconds (its log is in the run)');
}

const results = [];
for (const model of MODELS) {
  const logBefore = logSize();
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
  const blocked = probeBlocked({ status, logDuringProbe: logFrom(logBefore) });
  results.push({ model, status, claim, bucket: billingBucketFromClaim(claim || null), served, blocked });
}

await stop();
finish(summarizeProbes(results), results);

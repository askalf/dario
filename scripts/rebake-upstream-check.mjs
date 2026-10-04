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
 * the only template in play:
 *   --no-live-capture                 Claude Code is never spawned
 *   DARIO_LIVE_TEMPLATE_CACHE=<none>  a live capture on this host is not read
 * and sends one small request for the base model and for each prompt-variant
 * family's capture model.
 *
 * The subscription credential is BORROWED READ-ONLY (DARIO_NO_TOKEN_REFRESH=1,
 * set here, not left to the caller). A second process that refreshes the shared
 * token rotates it out from under production; see cc-billing-classifier-canary.yml.
 * When the access token needs renewing the check reports `blocked` and sends
 * nothing.
 *
 * stdout: the Validation text for the PR (markdown).
 * upstream-check.json: { outcome, results } for the workflow.
 * Exits: 0 pass, 1 a probe failed, 3 could not run (blocked or the proxy did
 * not come up).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEMPLATE_BASE_MODEL, VARIANT_FAMILIES } from '../dist/live-fingerprint.js';
import { billingBucketFromClaim } from '../dist/analytics.js';
import { formatUpstreamCheck, summarizeProbes } from './_rebake-upstream.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REBAKE_CHECK_PORT || 3459);
const BASE = `http://127.0.0.1:${PORT}`;
const MODELS = [TEMPLATE_BASE_MODEL, ...VARIANT_FAMILIES.map((f) => f.captureModel)];

const srcBundle = readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8');
const bundle = JSON.parse(srcBundle);
const finish = (outcome, results = [], detail = '') => {
  process.stdout.write(formatUpstreamCheck({ outcome, results, version: bundle._version, captured: bundle._captured, detail }).join('\n') + '\n');
  writeFileSync(join(repoRoot, 'upstream-check.json'), JSON.stringify({ outcome, results }, null, 2) + '\n');
  process.exit(outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : 3);
};

// The proxy loads dist/cc-template-data.json, which `npm run build` copied
// before the bake rewrote src/. Checking a stale copy would validate the bundle
// being replaced.
let distBundle = null;
try { distBundle = readFileSync(join(repoRoot, 'dist/cc-template-data.json'), 'utf-8'); } catch { /* not built */ }
if (distBundle !== srcBundle) finish('error', [], 'dist/cc-template-data.json is not the bundle in src/ (copy it or rebuild first)');

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

const tmp = mkdtempSync(join(tmpdir(), 'rebake-upstream-'));
const logPath = join(tmp, 'proxy.log');
const logFd = openSync(logPath, 'a');
const proxy = spawn(process.execPath, ['dist/cli.js', 'proxy', `--port=${PORT}`, '--no-live-capture'], {
  cwd: repoRoot,
  env: { ...process.env, DARIO_NO_TOKEN_REFRESH: '1', DARIO_LIVE_TEMPLATE_CACHE: join(tmp, 'no-live-cache.json') },
  stdio: ['ignore', logFd, logFd],
});
let exited = false;
proxy.on('exit', () => { exited = true; });
const stop = async () => {
  if (!exited) {
    proxy.kill('SIGTERM');
    await new Promise((resolve) => { proxy.once('exit', resolve); setTimeout(resolve, 5000); });
  }
  closeSync(logFd);
};
const proxyLog = () => { try { return readFileSync(logPath, 'utf-8'); } catch { return ''; } };
const needsRenewal = () => proxyLog().includes('DARIO_NO_TOKEN_REFRESH');
const cleanup = () => rmSync(tmp, { recursive: true, force: true });

let up = false;
for (let i = 0; i < 30 && !exited; i += 1) {
  if (await health() === 200) { up = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!up) {
  const blocked = needsRenewal();
  const tail = proxyLog().trim().split('\n').slice(-3).join(' / ').slice(0, 300);
  await stop();
  cleanup();
  finish(blocked ? 'blocked' : 'error', [], `the proxy did not become healthy within 30s${tail ? ` (${tail})` : ''}`);
}

const results = [];
for (const model of MODELS) {
  let status = 0;
  let claim = '';
  let served = '';
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dario' },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] }),
      signal: AbortSignal.timeout(60000),
    });
    status = res.status;
    claim = res.headers.get('anthropic-ratelimit-unified-representative-claim') ?? res.headers.get('representative-claim') ?? '';
    const body = await res.json().catch(() => null);
    served = typeof body?.model === 'string' ? body.model : '';
  } catch {
    status = 0;
  }
  results.push({ model, status, claim, bucket: billingBucketFromClaim(claim || null), served });
}

const blockedMidRun = results.some((r) => r.status !== 200) && needsRenewal();
await stop();
cleanup();
finish(blockedMidRun ? 'blocked' : summarizeProbes(results), results);

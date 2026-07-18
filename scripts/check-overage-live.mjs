#!/usr/bin/env node
/**
 * Live subscription-routing check — sends a sustained, multi-model load THROUGH
 * a dario proxy against real api.anthropic.com and confirms every response
 * bills to the subscription plan (five_hour / seven_day [_fallback]), never
 * overage or api. dario sends Claude Code-compatible requests, so a
 * subscription works in other tools; this confirms the billing bucket end to
 * end. It is the billing-bucket counterpart to scripts/check-wire-drift.mjs.
 *
 * ⚠ MAKES REAL subscription calls — needs a valid Pro/Max OAuth credential and
 * egress to api.anthropic.com. Run it yourself (operator / self-hosted), never
 * in GH-hosted CI. Where an agent firewall (warden) is present it
 * blocks agent-driven OAuth-read + egress, so this is an operator-run harness
 * by design: launch it from your own shell (or `! node scripts/…`).
 *
 * It starts its OWN short-lived dario from the local build (dist/cli.js) on a
 * SPARE port with the overage-guard ENABLED, so a single non-subscription hit
 * halts the run immediately. It reads the per-response
 * `anthropic-ratelimit-unified-representative-claim` + `-status` headers and
 * classifies each with dario's own billingBucketFromClaim. Small max_tokens +
 * short prompts keep the token burn minimal.
 *
 *   npm run build && node scripts/check-overage-live.mjs
 *   COUNT=10 CONCURRENCY=3 node scripts/check-overage-live.mjs      # heavier soak
 *   MODELS=claude-opus-4-8,claude-haiku-4-5 node scripts/check-overage-live.mjs
 *
 * OAuth note: this spins up a SECOND dario using your default credentials. If a
 * box dario is already running and the access token is near expiry, both may
 * refresh and race the refresh-token family. Run it when the token is fresh; it
 * is short-lived (~a minute) to keep that window small. Override the port with
 * PORT= if 3466 is taken.
 *
 * Exit 0 = every request billed to the subscription plan (five_hour /
 * seven_day [_fallback]). Exit 1 = an overage/api hit, or the overage-guard
 * halted on a non-subscription hit.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { billingBucketFromClaim, SUBSCRIPTION_CLAIMS } from '../dist/analytics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const PORT = Number(process.env.PORT || 3466);
const COUNT = Number(process.env.COUNT || 5);          // requests per model
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 32);
const PROMPT = process.env.PROMPT || 'reply with the single word: ok';
const MODELS = (process.env.MODELS
  || 'claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5,claude-fable-5,claude-opus-4-8[1m],claude-sonnet-5[1m],claude-fable-5[1m]'
).split(',').map((s) => s.trim()).filter(Boolean);

const BASE = `http://127.0.0.1:${PORT}`;
const logFile = join(mkdtempSync(join(tmpdir(), 'overage-live-')), 'dario.log');
const cliPath = join(repoRoot, 'dist', 'cli.js');
const log = (m) => console.error(`[overage-live] ${m}`);

if (!existsSync(cliPath)) {
  log(`dist/cli.js missing — run \`npm run build\` first.`);
  process.exit(2);
}

// ── start a short-lived dario from the local build ──
log(`starting dario (build under test) on :${PORT} with overage-guard on, log-file=${logFile}`);
const proxy = spawn(process.execPath, [cliPath, 'proxy', `--port=${PORT}`, `--log-file=${logFile}`], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
let proxyOut = '';
proxy.stdout.on('data', (d) => { proxyOut += d.toString(); });
proxy.stderr.on('data', (d) => { proxyOut += d.toString(); });

function shutdown() { try { proxy.kill('SIGTERM'); } catch {} }
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function oneRequest(model) {
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: PROMPT }] }),
      signal: AbortSignal.timeout(120000),
    });
    const claim = res.headers.get('anthropic-ratelimit-unified-representative-claim');
    const rlStatus = res.headers.get('anthropic-ratelimit-unified-status');
    let bodyErrType = null;
    if (!res.ok) { try { bodyErrType = (JSON.parse(await res.text()).error || {}).type || null; } catch {} }
    return { httpStatus: res.status, claim, rlStatus, bodyErrType };
  } catch (e) {
    return { httpStatus: 0, claim: null, rlStatus: null, error: String(e && e.message || e) };
  }
}

function classify(r) {
  // Guard halted (dario returned its own 503) — a breach was already seen.
  if (r.bodyErrType === 'dario_overage_guard') return 'HALTED';
  // A 429 the server marked 'rejected' (rate-limit status).
  if (r.httpStatus === 429 && (r.rlStatus === 'rejected' || r.bodyErrType === 'dario_overage_guard')) return 'REJECTED';
  const bucket = billingBucketFromClaim(r.claim);
  if (bucket === 'extra_usage' || bucket === 'api') return 'BREACH';
  if (SUBSCRIPTION_CLAIMS.has(r.claim || '')) return r.httpStatus === 429 ? 'WINDOW' : 'OK';
  if (r.httpStatus === 429) return r.rlStatus === 'rejected' ? 'REJECTED' : 'WINDOW';
  if (r.httpStatus >= 200 && r.httpStatus < 300) return 'OK?'; // 2xx but no claim header (unknown) — inconclusive
  return 'ERROR';
}

async function runModel(model) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < COUNT) {
      const n = i++;
      // stop early if the guard already halted the proxy
      if (results.some((r) => classify(r) === 'HALTED' || classify(r) === 'BREACH')) return;
      const r = await oneRequest(model);
      r.n = n;
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, COUNT) }, worker));
  return results;
}

(async () => {
  if (!(await waitHealth())) {
    log('dario never reached /health within 30s. Proxy output:');
    console.error(proxyOut.slice(-2000));
    process.exit(2);
  }
  log(`health OK. Sending ${COUNT}×${MODELS.length} requests (concurrency ${CONCURRENCY}, max_tokens ${MAX_TOKENS})…`);

  const perModel = {};
  let breached = false;
  for (const model of MODELS) {
    const rs = await runModel(model);
    const tally = {};
    for (const r of rs) { const c = classify(r); tally[c] = (tally[c] || 0) + 1; }
    perModel[model] = { count: rs.length, tally, sampleClaim: rs.map((r) => r.claim).find(Boolean) || null };
    if (tally.BREACH || tally.HALTED || tally.REJECTED) breached = true;
    // If the guard halted, every later model would just 503 — stop the soak.
    if (tally.HALTED) { log('overage-guard HALTED — stopping the soak.'); break; }
  }

  console.log('\n=== subscription-routing report ===');
  console.log(`dario build: local dist  | port ${PORT} | ${COUNT}/model × ${MODELS.length} models`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('model', 26), pad('n', 3), pad('claim', 14), 'outcome');
  for (const [m, v] of Object.entries(perModel)) {
    const outcome = Object.entries(v.tally).map(([k, n]) => `${k}:${n}`).join(' ');
    console.log(pad(m, 26), pad(v.count, 3), pad(v.sampleClaim || '-', 14), outcome);
  }
  // Cross-check against dario's own per-request log (claim/bucket), if present.
  try {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const nonSub = lines.filter((e) => e.bucket && !['subscription', 'subscription_fallback', 'unknown'].includes(e.bucket));
    console.log(`\ndario log: ${lines.length} request records; non-subscription buckets: ${nonSub.length}`);
    if (nonSub.length) console.log('  ' + nonSub.slice(0, 5).map((e) => `${e.model}:${e.bucket}`).join(', '));
  } catch { /* no log or unreadable */ }

  console.log(`\nOutcome legend: OK=subscription 2xx  WINDOW=subscription 429 (rate cap, not a breach)`);
  console.log(`  BREACH=overage/api  REJECTED=server marked the request rejected (429)  HALTED=overage-guard tripped`);
  const verdict = breached ? '❌ BREACH — non-subscription billing or a rejected request detected' : '✅ CLEAN — all models billed to the subscription plan';
  console.log(`\n${verdict}`);
  shutdown();
  process.exit(breached ? 1 : 0);
})();

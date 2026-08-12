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
 * Exit 0 = every model was MEASURED and billed to the subscription plan
 * (five_hour / seven_day [_fallback]). Exit 1 = an overage/api hit, or the
 * overage-guard halted on a non-subscription hit. Exit 2 = dario never came
 * up. Exit 3 = INCONCLUSIVE: at least one model returned no billing claim at
 * all, so the run measured nothing for it — deliberately NOT 0, because a
 * model that is never served must never read as "clean".
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
    // Null (header absent) is kept distinct from 0 so the report can say
    // "no overage meter" rather than asserting $0 — see classify().
    const overageRaw = res.headers.get('anthropic-ratelimit-unified-overage-utilization');
    const overageUtil = overageRaw === null ? null : parseFloat(overageRaw);
    let bodyErrType = null;
    if (!res.ok) { try { bodyErrType = (JSON.parse(await res.text()).error || {}).type || null; } catch {} }
    return { httpStatus: res.status, claim, rlStatus, overageUtil, bodyErrType };
  } catch (e) {
    return { httpStatus: 0, claim: null, rlStatus: null, overageUtil: null, error: String(e && e.message || e) };
  }
}

function classify(r) {
  // Guard halted (dario returned its own 503) — a breach was already seen.
  if (r.bodyErrType === 'dario_overage_guard') return 'HALTED';
  // A 429 the server marked 'rejected' (rate-limit status).
  if (r.httpStatus === 429 && (r.rlStatus === 'rejected' || r.bodyErrType === 'dario_overage_guard')) return 'REJECTED';
  const bucket = billingBucketFromClaim(r.claim);
  if (bucket === 'extra_usage' || bucket === 'api') return 'BREACH';
  // SUSPECT, not proof. The 2026-07-05 probe that classified
  // `*_overage_included` as subscription ran on a MAX account, where the
  // included weekly credit made it $0 (overage-utilization 0). A plan
  // without that credit may return the SAME claim string while real money
  // moves, and the claim name alone cannot tell the two apart.
  //
  // ⚠ What `overage-utilization` MEANS is unresolved in our own code:
  // doctor.ts renders it as "% of configured monthly spend" (a CUMULATIVE
  // meter), while proxy.ts says it is omitted "when the subscription claim
  // covers the request" (per-request). If it is cumulative, a nonzero value
  // says only that overage was spent sometime this month — NOT that this
  // request was billed — so the overage-guard must NOT halt on it. Doing so
  // would re-create the #672 halt-loop outage for anyone carrying any
  // monthly overage spend. This flag exists to make the combination VISIBLE
  // for diagnosis; resolving the semantics needs a live capture across the
  // moment a plan crosses into extra usage. See #288.
  if (/_overage_included$/.test(r.claim || '') && (r.overageUtil ?? 0) > 0) return 'SUSPECT';
  if (SUBSCRIPTION_CLAIMS.has(r.claim || '')) return r.httpStatus === 429 ? 'WINDOW' : 'OK';
  // A 429 carrying NO claim header is not evidence of subscription billing:
  // the request was never served and never billed, so there is nothing to
  // classify. Folding it into WINDOW (whose legend asserts "subscription 429")
  // is what made the 2026-08-11 Pro-account run print "✅ CLEAN — all models
  // billed to the subscription plan" while claude-fable-5 was never served at
  // all — bare 429, no claim, no rate-limit headers, and no dario request
  // record. UNSERVED keeps "we measured nothing" distinct from "we measured
  // subscription billing", which is the entire question this script answers.
  if (r.httpStatus === 429) {
    if (r.rlStatus === 'rejected') return 'REJECTED';
    return r.claim ? 'WINDOW' : 'UNSERVED';
  }
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
    const overages = rs.map((r) => r.overageUtil).filter((v) => v !== null && v !== undefined);
    perModel[model] = {
      count: rs.length,
      tally,
      sampleClaim: rs.map((r) => r.claim).find(Boolean) || null,
      peakOverage: overages.length ? Math.max(...overages) : null,
      // A model is MEASURED only if at least one request came back with a
      // billing claim. Billing classification is what this script exists to
      // report, so "no claim ever returned" means no data — never a pass.
      measured: rs.some((r) => Boolean(r.claim)),
    };
    if (tally.BREACH || tally.HALTED || tally.REJECTED || tally.SUSPECT) breached = true;
    // If the guard halted, every later model would just 503 — stop the soak.
    if (tally.HALTED) { log('overage-guard HALTED — stopping the soak.'); break; }
  }

  console.log('\n=== subscription-routing report ===');
  console.log(`dario build: local dist  | port ${PORT} | ${COUNT}/model × ${MODELS.length} models`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('model', 26), pad('n', 3), pad('claim', 30), pad('overage', 8), 'outcome');
  for (const [m, v] of Object.entries(perModel)) {
    const outcome = Object.entries(v.tally).map(([k, n]) => `${k}:${n}`).join(' ');
    const ov = v.peakOverage === null ? '-' : `${Math.round(v.peakOverage * 100)}%`;
    console.log(pad(m, 26), pad(v.count, 3), pad(v.sampleClaim || '-', 30), pad(ov, 8), outcome);
  }
  // Cross-check against dario's own per-request log (claim/bucket), if present.
  try {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const nonSub = lines.filter((e) => e.bucket && !['subscription', 'subscription_fallback', 'unknown'].includes(e.bucket));
    console.log(`\ndario log: ${lines.length} request records; non-subscription buckets: ${nonSub.length}`);
    if (nonSub.length) console.log('  ' + nonSub.slice(0, 5).map((e) => `${e.model}:${e.bucket}`).join(', '));
  } catch { /* no log or unreadable */ }

  const unmeasured = Object.entries(perModel).filter(([, v]) => !v.measured).map(([m]) => m);

  console.log(`\nOutcome legend: OK=subscription 2xx  WINDOW=subscription 429 (rate cap, not a breach)`);
  console.log(`  BREACH=overage/api  REJECTED=server marked the request rejected (429)  HALTED=overage-guard tripped`);
  console.log(`  UNSERVED=429 with NO claim header — never served, never billed, NOTHING measured (not a pass)`);
  console.log(`  SUSPECT=*_overage_included claim WITH a nonzero overage meter — the guard reports this as`);
  console.log(`          subscription and does not halt. Needs interpretation: see classify() on whether`);
  console.log(`          overage-utilization is a per-request flag or a cumulative monthly-spend meter.`);

  // Order matters: a breach outranks missing data, but missing data must never
  // read as CLEAN. A model that returned no claim was not measured, so the
  // script cannot assert anything about how it bills.
  let verdict, code;
  if (breached) {
    verdict = '❌ BREACH — non-subscription billing or a rejected request detected';
    code = 1;
  } else if (unmeasured.length) {
    verdict = `⚠️  INCONCLUSIVE — NOT MEASURED: ${unmeasured.join(', ')}\n`
      + `   No billing claim was returned for the model(s) above, so this run says NOTHING about how\n`
      + `   they bill. The remaining models billed to the subscription plan. Re-run once those models\n`
      + `   are actually served (e.g. on Pro, claude-fable-5 requires extra usage to be enabled).`;
    code = 3;
  } else {
    verdict = '✅ CLEAN — all models billed to the subscription plan';
    code = 0;
  }
  console.log(`\n${verdict}`);
  shutdown();
  process.exit(code);
})();

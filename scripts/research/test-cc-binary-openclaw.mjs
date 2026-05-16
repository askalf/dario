#!/usr/bin/env node
// Test 3 in the @theo OpenClaw triage: spawn CC's actual binary
// from two test directories — one clean, one with "OpenClaw" in
// the commit history — and observe BOTH:
//
//   (a) what CC actually puts on the wire (does CC pre-filter,
//       transform, redact, or otherwise behave differently when
//       OpenClaw appears in its environment context?)
//
//   (b) what api.anthropic.com responds with given CC's exact
//       unmodified body, including billing-claim header and any
//       refusal indicators.
//
// Methodology:
//   - Spin up a transparent forwarding proxy on a random localhost
//     port. Proxy logs CC's request, swaps x-api-key → OAuth
//     bearer, prepends oauth-2025-04-20 to anthropic-beta, then
//     forwards to api.anthropic.com unchanged. Logs the response.
//   - Create two ephemeral git directories. `clean/` has a single
//     "initial commit". `openclaw/` has the same plus an additional
//     commit "feat: OpenClaw integration baseline" + a JSON file
//     with "OpenClaw" content (matching Theo's setup).
//   - From each directory, spawn `claude --print -p "<prompt>"`
//     pointed at our proxy. Capture the full transaction.
//   - Diff the two transactions. Report.
//
// The script is read-only against api.anthropic.com — it just
// proxies CC's request. Cost is two real upstream requests (~$0
// on a Max plan).

import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
// Hardcoded — env-var fallback was getting shadowed by Windows shell PROMPT.
const PROMPT = 'say hello in 5 words';

// ──────────────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────────────

const home = process.env.USERPROFILE || process.env.HOME;
const oa = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8')).claudeAiOauth;
const bearer = oa.accessToken;
if (!bearer) { console.error('FATAL: no CC accessToken'); process.exit(1); }
console.error(`[auth] resolved CC token (${Math.round((oa.expiresAt - Date.now()) / 60000)} min remaining)`);

// ──────────────────────────────────────────────────────────────────────
// Forwarding proxy: log CC's request, swap auth, forward, log response
// ──────────────────────────────────────────────────────────────────────

function startProxy() {
  return new Promise((resolve) => {
    const server = http.createServer(async (clientReq, clientRes) => {
      let bodyChunks = [];
      clientReq.on('data', (c) => bodyChunks.push(c));
      clientReq.on('end', async () => {
        const reqBody = Buffer.concat(bodyChunks).toString();
        const txn = {
          ts: Date.now(),
          req: {
            method: clientReq.method,
            url: clientReq.url,
            headers: { ...clientReq.headers },
            body: reqBody,
          },
        };

        // Build outbound to api.anthropic.com: swap auth, prepend beta
        const outHeaders = { ...clientReq.headers };
        delete outHeaders['x-api-key'];
        delete outHeaders['host'];
        delete outHeaders['content-length'];
        outHeaders['authorization'] = `Bearer ${bearer}`;
        let beta = outHeaders['anthropic-beta'] || '';
        if (!beta.split(',').includes('oauth-2025-04-20')) {
          beta = beta ? `oauth-2025-04-20,${beta}` : 'oauth-2025-04-20';
          outHeaders['anthropic-beta'] = beta;
        }
        outHeaders['anthropic-dangerous-direct-browser-access'] = 'true';

        const upstream = https.request({
          hostname: 'api.anthropic.com',
          path: clientReq.url,
          method: clientReq.method,
          headers: outHeaders,
        }, (upRes) => {
          const respChunks = [];
          upRes.on('data', (c) => respChunks.push(c));
          upRes.on('end', () => {
            const respBody = Buffer.concat(respChunks);
            txn.resp = {
              status: upRes.statusCode,
              headers: { ...upRes.headers },
              billingClaim: upRes.headers['anthropic-ratelimit-unified-representative-claim'] || '(unset)',
              body: respBody.toString(),
            };
            // Forward to CC client
            clientRes.writeHead(upRes.statusCode, upRes.headers);
            clientRes.end(respBody);
            transactions.push(txn);
          });
        });
        upstream.on('error', (err) => {
          txn.resp = { error: err.message };
          clientRes.writeHead(502);
          clientRes.end('proxy error');
          transactions.push(txn);
        });
        upstream.write(reqBody);
        upstream.end();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.error(`[proxy] listening on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
  });
}

const transactions = [];

// ──────────────────────────────────────────────────────────────────────
// Test fixture: ephemeral git directories
// ──────────────────────────────────────────────────────────────────────

function gitInit(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: 'ignore', shell: false };
  spawnSync('git', ['init', '-q'], opts);
  spawnSync('git', ['config', 'user.email', 'test@local'], opts);
  spawnSync('git', ['config', 'user.name', 'test'], opts);
  // Default branch name varies (master vs main); force 'main' for reproducibility.
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], opts);

  fs.writeFileSync(path.join(dir, 'README.md'), `# ${label} test repo\n`);
  spawnSync('git', ['add', '.'], opts);
  spawnSync('git', ['commit', '-m', 'initial commit', '-q'], opts);
  return dir;
}

function addOpenClawCommit(dir) {
  const opts = { cwd: dir, stdio: 'ignore', shell: false };
  // JSON file matching Theo's "OpenClaw in a json blob" claim.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    integrations: ['OpenClaw'],
    description: 'OpenClaw integration config',
  }, null, 2));
  spawnSync('git', ['add', '.'], opts);
  spawnSync('git', ['commit', '-m', 'feat: OpenClaw integration baseline', '-q'], opts);
}

// ──────────────────────────────────────────────────────────────────────
// CC spawn helper
// ──────────────────────────────────────────────────────────────────────

function runCC(cwd, port) {
  return new Promise((resolve) => {
    const cc = spawn(CC_BIN, ['--print', '-p', PROMPT], {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'sk-cc-binary-test-stub',
        CLAUDE_NONINTERACTIVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    cc.stdout.on('data', (c) => { stdout += c; });
    cc.stderr.on('data', (c) => { stderr += c; });
    cc.on('exit', (code) => resolve({ code, stdout, stderr }));
    cc.on('error', (err) => resolve({ code: -1, stdout, stderr, error: err.message }));
    setTimeout(() => { cc.kill(); resolve({ code: -2, stdout, stderr, timeout: true }); }, 60_000);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

const { server, port } = await startProxy();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-binary-test-'));
const cleanDir = gitInit(path.join(tmpRoot, 'clean'), 'clean');
const openclawDir = gitInit(path.join(tmpRoot, 'openclaw'), 'openclaw');
addOpenClawCommit(openclawDir);

console.error(`[fixture] clean dir:    ${cleanDir}`);
console.error(`[fixture] openclaw dir: ${openclawDir}`);
console.error('');

// Run twice from each, so we have N=2 trials per condition. Pace
// between to avoid concentrated burst.
const runs = [];
for (const trial of [1, 2]) {
  for (const variant of [
    { name: `clean_t${trial}`, dir: cleanDir },
    { name: `openclaw_t${trial}`, dir: openclawDir },
  ]) {
    process.stderr.write(`  running ${variant.name.padEnd(15)} ... `);
    const txnIndexBefore = transactions.length;
    const cc = await runCC(variant.dir, port);
    const myTxns = transactions.slice(txnIndexBefore);
    const lastTxn = myTxns[myTxns.length - 1];
    const claim = lastTxn?.resp?.billingClaim ?? '(no txn)';
    const status = lastTxn?.resp?.status ?? '-';
    process.stderr.write(`exit=${cc.code} requests=${myTxns.length} status=${status} claim=${claim}\n`);
    runs.push({
      ...variant,
      trial,
      ccExit: cc.code,
      ccStdout: cc.stdout.slice(0, 1000),
      ccStderr: cc.stderr.slice(0, 1000),
      requestCount: myTxns.length,
      transactions: myTxns,
    });
    await sleep(2000);
  }
}

server.close();

// ──────────────────────────────────────────────────────────────────────
// Analysis
// ──────────────────────────────────────────────────────────────────────

console.error('');
console.error('=== SUMMARY ===');
console.error('variant              exit  reqs  status  claim');
console.error('─'.repeat(75));
for (const r of runs) {
  const last = r.transactions[r.transactions.length - 1];
  console.error(
    `${r.name.padEnd(20)} ${String(r.ccExit).padEnd(5)} ${String(r.requestCount).padEnd(5)} ${String(last?.resp?.status ?? '-').padEnd(7)} ${last?.resp?.billingClaim ?? '(no resp)'}`,
  );
}

console.error('');
console.error('=== CC stdout per variant (what the user would see) ===');
for (const r of runs) {
  console.error(`--- ${r.name} ---`);
  console.error(`  ${r.ccStdout.replace(/\n/g, ' | ').slice(0, 200)}`);
}

// JSON dump FIRST so we always have the data even if analysis below crashes.
console.log(JSON.stringify({ runs, totalTransactions: transactions.length }, null, 2));

// Find the /v1/messages POST in a run (the first transaction is sometimes a
// HEAD probe or an OAuth-detection request that isn't the /v1/messages call).
function findMessagesTxn(run) {
  return run.transactions.find((t) => t.req.method === 'POST' && t.req.url.startsWith('/v1/messages'));
}

console.error('');
console.error('=== CC outbound body diff: clean_t1 vs openclaw_t1 ===');
try {
  const clean1 = runs.find((r) => r.name === 'clean_t1');
  const oc1 = runs.find((r) => r.name === 'openclaw_t1');
  const cTxn = clean1 ? findMessagesTxn(clean1) : null;
  const oTxn = oc1 ? findMessagesTxn(oc1) : null;

  if (!cTxn) console.error('  WARNING: no POST /v1/messages found in clean_t1');
  if (!oTxn) console.error('  WARNING: no POST /v1/messages found in openclaw_t1');

  if (cTxn && oTxn) {
    let cBody, oBody;
    try { cBody = JSON.parse(cTxn.req.body); } catch (e) { console.error('  clean body parse:', e.message); }
    try { oBody = JSON.parse(oTxn.req.body); } catch (e) { console.error('  openclaw body parse:', e.message); }

    console.error(`  clean    body bytes: ${cTxn.req.body.length}, system[2] chars: ${cBody?.system?.[2]?.text?.length ?? 0}`);
    console.error(`  openclaw body bytes: ${oTxn.req.body.length}, system[2] chars: ${oBody?.system?.[2]?.text?.length ?? 0}`);

    const cleanHasOC = cTxn.req.body.toLowerCase().includes('openclaw');
    const openclawHasOC = oTxn.req.body.toLowerCase().includes('openclaw');
    console.error(`  clean    has "openclaw" in outbound body: ${cleanHasOC}`);
    console.error(`  openclaw has "openclaw" in outbound body: ${openclawHasOC}`);

    if (openclawHasOC) {
      const text = oTxn.req.body;
      let idx = 0;
      const occurrences = [];
      while ((idx = text.toLowerCase().indexOf('openclaw', idx)) !== -1) {
        occurrences.push({
          offset: idx,
          context: text.slice(Math.max(0, idx - 60), idx + 60).replace(/\n/g, '\\n'),
        });
        idx++;
      }
      console.error(`  openclaw occurrences in CC's outbound body: ${occurrences.length}`);
      occurrences.slice(0, 5).forEach((o) => console.error(`    [${o.offset}] ...${o.context}...`));
    }
  }
} catch (err) {
  console.error('  analysis error:', err.message);
}

// Cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

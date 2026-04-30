#!/usr/bin/env node
// Refined test of @theo's claim — using his EXACT commit message
// format. His test used `{"schema": "openclaw.inbound_meta.v1"}`
// as the commit message — a JSON blob that looks like an internal
// openclaw schema reference. Earlier tests used a friendly
// "feat: OpenClaw integration" message and didn't reproduce; the
// hypothesis is that the classifier pattern-matches on the
// schema-shape, not the bare "openclaw" string.
//
// Variants (one ephemeral git directory per variant; CC spawned
// from each via the same forwarding-proxy infra as
// test-cc-binary-openclaw.mjs):
//
//   01_control_clean              initial commit only, nothing openclaw
//   02_theo_exact                 {"schema": "openclaw.inbound_meta.v1"}  (Theo's exact)
//   03_friendly_openclaw          feat: OpenClaw integration baseline       (the earlier-test format that didn't reproduce)
//   04_plain_openclaw             openclaw                                  (just the word)
//   05_schema_name_only           openclaw.inbound_meta.v1                  (schema name, no JSON shape)
//   06_claude_schema_blob         {"schema": "claude.inbound_meta.v1"}      (same JSON shape, claude name — control)
//   07_competitor_schema_blob     {"schema": "competitor.foo.v1"}           (same JSON shape, generic — control)
//
// Account-state nuance: Theo got HTTP 400 ("You're out of extra
// usage") because the classifier flipped his request to
// extra-usage billing AND he was out of credit. On an account WITH
// extra-usage capacity, the same flip would surface as
// `claim: extra_usage` (or similar) in the response header,
// request would succeed silently. So we read the BILLING CLAIM
// HEADER for ground truth, not the status code.

import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
const PROMPT = 'say hello in 5 words';

const home = process.env.USERPROFILE || process.env.HOME;
const oa = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8')).claudeAiOauth;
const bearer = oa.accessToken;
if (!bearer) { console.error('FATAL: no CC accessToken'); process.exit(1); }
console.error(`[auth] resolved CC token (${Math.round((oa.expiresAt - Date.now()) / 60000)} min remaining)`);

const transactions = [];

function startProxy() {
  return new Promise((resolve) => {
    const server = http.createServer(async (clientReq, clientRes) => {
      let bodyChunks = [];
      clientReq.on('data', (c) => bodyChunks.push(c));
      clientReq.on('end', async () => {
        const reqBody = Buffer.concat(bodyChunks).toString();
        const txn = {
          ts: Date.now(),
          req: { method: clientReq.method, url: clientReq.url, headers: { ...clientReq.headers }, body: reqBody },
        };
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

function gitInit(dir, commitMsg) {
  fs.mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: 'ignore', shell: false };
  spawnSync('git', ['init', '-q'], opts);
  spawnSync('git', ['config', 'user.email', 'test@local'], opts);
  spawnSync('git', ['config', 'user.name', 'test'], opts);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], opts);

  fs.writeFileSync(path.join(dir, 'test.md'), '# test\n');
  spawnSync('git', ['add', '.'], opts);
  spawnSync('git', ['commit', '-m', commitMsg, '-q'], opts);
  return dir;
}

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

const VARIANTS = [
  { name: '01_control_clean',          commitMsg: 'initial commit' },
  { name: '02_theo_exact',             commitMsg: '{"schema": "openclaw.inbound_meta.v1"}' },
  { name: '03_friendly_openclaw',      commitMsg: 'feat: OpenClaw integration baseline' },
  { name: '04_plain_openclaw',         commitMsg: 'openclaw' },
  { name: '05_schema_name_only',       commitMsg: 'openclaw.inbound_meta.v1' },
  { name: '06_claude_schema_blob',     commitMsg: '{"schema": "claude.inbound_meta.v1"}' },
  { name: '07_competitor_schema_blob', commitMsg: '{"schema": "competitor.foo.v1"}' },
];

const { server, port } = await startProxy();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-schema-test-'));

const runs = [];
for (const v of VARIANTS) {
  const dir = path.join(tmpRoot, v.name);
  gitInit(dir, v.commitMsg);
  const txnIndexBefore = transactions.length;
  process.stderr.write(`  ${v.name.padEnd(32)} ... `);
  const cc = await runCC(dir, port);
  const myTxns = transactions.slice(txnIndexBefore);

  // Pick the conversation transaction (largest /v1/messages POST)
  const conv = myTxns
    .filter((t) => t.req.method === 'POST' && t.req.url.startsWith('/v1/messages'))
    .sort((a, b) => b.req.body.length - a.req.body.length)[0];

  const claim = conv?.resp?.billingClaim ?? '(no resp)';
  const status = conv?.resp?.status ?? '-';
  process.stderr.write(`status=${status} claim=${claim.padEnd(15)} exit=${cc.code}\n`);

  runs.push({
    ...v,
    dir,
    ccExit: cc.code,
    ccStdout: cc.stdout.slice(0, 500),
    transactions: myTxns,
    convTxnExists: !!conv,
    convStatus: status,
    convClaim: claim,
    convBodyBytes: conv?.req.body.length ?? 0,
    convRespBody: conv?.resp?.body?.slice(0, 500) ?? null,
  });
  await sleep(2000);
}

server.close();

console.error('');
console.error('=== SUMMARY ===');
console.error('variant                          status  claim          body bytes');
console.error('─'.repeat(80));
for (const r of runs) {
  console.error(
    `${r.name.padEnd(32)} ${String(r.convStatus).padEnd(7)} ${r.convClaim.padEnd(14)} ${r.convBodyBytes}`,
  );
}
console.error('');

console.error('=== CC stdout per variant ===');
for (const r of runs) {
  console.error(`--- ${r.name} ---`);
  console.error(`  ${r.ccStdout.replace(/\n/g, ' | ').slice(0, 200)}`);
}

// JSON dump
console.log(JSON.stringify({ runs, totalTransactions: transactions.length }, null, 2));

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

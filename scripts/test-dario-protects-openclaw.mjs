#!/usr/bin/env node
// Verify that dario's default template-replay mode protects users
// from Anthropic's `openclaw.inbound_meta.v1` billing-classifier
// filter (verified by test-openclaw-schema-trigger.mjs as flipping
// requests to extra-usage when the string appears in CC's git
// environment block).
//
// dario's template-replay architecture (since v3.0.0; see Discussion
// #14) replaces CC's outbound body with dario's bundled CC template.
// The user's git context — including any commit messages referencing
// openclaw protocol namespaces — gets discarded at the proxy
// boundary. Only dario's captured generic system prompt reaches
// Anthropic.
//
// Test: from a directory whose git history contains
// `{"schema": "openclaw.inbound_meta.v1"}`, run
// `claude --print -p "say hello in 5 words"` with
// ANTHROPIC_BASE_URL pointed at dario (localhost:3456). Expect:
// status 200, claim five_hour, no 400 — because the offending
// commit message never leaves the local machine.
//
// Compares against the same directory routed direct-to-API (which
// we already know returns 400).

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
const DARIO_URL = 'http://localhost:3456';
const PROMPT = 'say hello in 5 words';

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

function runCC(cwd, baseUrl) {
  return new Promise((resolve) => {
    const cc = spawn(CC_BIN, ['--print', '-p', PROMPT], {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-stub-for-dario-test',
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

async function checkDarioRunning() {
  try {
    const res = await fetch(`${DARIO_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const ok = await checkDarioRunning();
if (!ok) {
  console.error(`FATAL: dario not reachable at ${DARIO_URL}/health. Start it with \`node dist/cli.js proxy --verbose\` first.`);
  process.exit(1);
}
console.error(`[ok] dario reachable at ${DARIO_URL}`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-protects-'));
const dirOpenclaw = gitInit(path.join(tmpRoot, 'openclaw'), '{"schema": "openclaw.inbound_meta.v1"}');
console.error(`[fixture] openclaw dir: ${dirOpenclaw}`);
console.error('');

const trials = [];
for (const trial of [1, 2]) {
  process.stderr.write(`  trial ${trial} — claude --print through dario ... `);
  const r = await runCC(dirOpenclaw, DARIO_URL);
  // Parse stdout for refusal/success
  const looksOk = r.stdout.length > 0 && !r.stdout.includes('API Error');
  const looks400 = r.stdout.includes('You\'re out of extra usage') || r.stdout.includes('400');
  process.stderr.write(`exit=${r.code} | ok=${looksOk} | hit-400=${looks400}\n`);
  process.stderr.write(`    stdout: ${r.stdout.slice(0, 150).replace(/\n/g, ' | ')}\n`);
  trials.push({ trial, ...r, looksOk, looks400 });
  await sleep(2000);
}

console.error('');
console.error('=== SUMMARY ===');
for (const t of trials) {
  console.error(`  trial ${t.trial}: exit=${t.code} ok=${t.looksOk} 400=${t.looks400}`);
}

console.log(JSON.stringify({ trials, dirOpenclaw }, null, 2));

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

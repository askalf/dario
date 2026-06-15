#!/usr/bin/env node
/**
 * cch seed calibration (dario#528) — keep src/cch.ts:CCH_SEEDS current WITHOUT
 * depending on anyone else to hand us the rotating seed.
 *
 * The seed Claude Code uses for the `cch` integrity hash rotates between
 * releases and lives inside the compiled binary, so we can't algebraically
 * derive it. But we can run the genuine binary and read the cch it stamps,
 * then check it against what we know:
 *
 *   1. src/cch.ts already covers this version AND reproduces the cch  -> OK.
 *   2. some seed we ALREADY know reproduces it (version bumped, seed
 *      unchanged — the common case) -> print the one-line CCH_SEEDS entry to
 *      add; nothing to reverse-engineer.
 *   3. no known seed reproduces it -> the seed ROTATED. Save the captured
 *      material + observed cch so WE extract the new seed (binary string-scan
 *      or a debugger watchpoint on the cch region) on our own schedule, then
 *      add it to CCH_SEEDS. Exit non-zero.
 *
 * Capture path is the safe one the drift/probe scripts use: point the real
 * binary at a loopback collector with a STUB api key — the cch is built into
 * the request body before it's sent, so a stub key + fake endpoint still
 * yields a real cch, and no OAuth/credentials are touched.
 *
 *   node scripts/cch-calibrate.mjs
 *   DARIO_CLAUDE_BIN=/path/to/claude node scripts/cch-calibrate.mjs
 *
 * Wiring: run on the dario self-hosted runner when cc-drift flags a new CC
 * version (that host has `claude` installed; GH-hosted runners don't). Until a
 * seed is added, dario just ships a random cch for the new version — safe, no
 * breakage, see src/cch.ts.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cchForBody, cchWithSeed, CCH_SEEDS } from '../dist/cch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'claude';
const TIMEOUT_MS = 35_000;
const useShell = process.platform === 'win32' && !/[\\/]/.test(CC_BIN);

function log(m) { console.error(`[cch-calibrate] ${m}`); }

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (req.url.startsWith('/v1/messages') && req.method === 'POST' && !server._cap) {
      server._cap = { headers: req.headers, buf };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: error\ndata: {"type":"error","error":{"type":"capture_only"}}\n\n');
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-capture-stub',
    CLAUDE_NONINTERACTIVE: '1',
  };
  log(`MITM :${port} -> spawning "${CC_BIN}" --print (stub key + loopback, no OAuth)`);
  const cc = spawn(CC_BIN, ['--print', '-p', 'calibrate'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: useShell,
  });
  cc.stderr.on('data', () => {});
  cc.stdout.on('data', () => {});
  cc.on('exit', () => setTimeout(finish, 250));
  cc.on('error', (e) => { log(`spawn error: ${e.message} (set DARIO_CLAUDE_BIN to the claude path)`); process.exit(3); });
  setTimeout(() => { try { cc.kill(); } catch {} finish(); }, TIMEOUT_MS);
});

let done = false;
function finish() {
  if (done) return; done = true;
  const cap = server._cap;
  if (!cap) { log('no /v1/messages captured — is claude installed and runnable?'); process.exit(2); }

  let buf = cap.buf;
  if ((cap.headers['content-encoding'] || '').includes('gzip')) { try { buf = gunzipSync(buf); } catch {} }
  const text = buf.toString('utf8');
  const cchM = /cch=([0-9a-fA-F]{5})/.exec(text);
  const verM = /cc_version=([0-9]+\.[0-9]+\.[0-9]+)/.exec(text);
  if (!cchM || !verM) { log('captured body carries no cch / cc_version billing tag'); process.exit(2); }

  const observed = cchM[1].toLowerCase();
  const version = verM[1];
  log(`captured cc_version=${version} cch=${observed} (body ${buf.length}B)`);

  // 1) already covered and still correct?
  const known = cchForBody(text, version);
  if (known === observed) {
    console.log(`OK: ${version} is in CCH_SEEDS and reproduces the live cch (${observed}). No action needed.`);
    process.exit(0);
  }
  if (known !== null && known !== observed) {
    log(`WARNING: ${version} is in CCH_SEEDS but its seed no longer reproduces the live cch (${known} != ${observed}).`);
  }

  // 2) does a seed we already know reproduce it? (version bumped, seed unchanged)
  for (const [v, seed] of Object.entries(CCH_SEEDS)) {
    if (cchWithSeed(text, seed) === observed) {
      console.log(`COVERED BY EXISTING SEED — add this line to CCH_SEEDS in src/cch.ts:`);
      console.log(`  '${version}': 0x${seed.toString(16)}n,   // same seed as ${v}, confirmed live`);
      process.exit(0);
    }
  }

  // 3) genuine rotation — hand ourselves the data to extract the new seed.
  const out = join(__dirname, '..', `cch-rotated-${version}.json`);
  writeFileSync(out, JSON.stringify({ version, observed, body: text }, null, 2));
  console.log(`SEED ROTATED for ${version}: no known seed reproduces cch=${observed}.`);
  console.log(`Saved capture -> ${out}`);
  console.log(`Extract the new seed (scan the CC binary's embedded JS for the xxh64 call / debugger watchpoint on the cch region), add it to CCH_SEEDS, and re-run to confirm.`);
  process.exit(1);
}

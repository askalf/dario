#!/usr/bin/env node
/**
 * Runtime wire-drift watcher — the request-time counterpart to
 * scripts/check-cc-drift.mjs (which statically scans the installed Claude Code
 * package and so can't see anything CC only decides at REQUEST time).
 *
 * Two wire signals drifted silently between CC 2.1.170 and 2.1.199 because
 * nothing ran the installed `claude` and compared the request it sends to what dario
 * emits (dario#528 follow-up):
 *
 *   1. Per-model `anthropic-beta` set. betaForModel encodes CC's per-family
 *      add/drop/reorder rules; those moved (sonnet-5 keeps mid-conversation-
 *      system, haiku drops afk-mode + reorders, fable/[1m] positions). This
 *      check spawns the installed `claude` for opus/sonnet/haiku/fable, reads each
 *      anthropic-beta header, and asserts betaForModel reproduces it from the
 *      opus base — EXACTLY, order included.
 *
 *   2. `cch` billing-integrity token. CC dropped it entirely (sdk-cli); dario
 *      now omits it unless a calibrated seed exists (hasCchSeed). This check
 *      reads whether CC's billing block still carries `cch=` and asserts
 *      dario's gate agrees: CC-emits-cch XOR we-have-a-seed is a drift.
 *
 * Mechanism: spawn the installed `claude` pointed at a loopback endpoint with a
 * stub api key and read the request it sends. No OAuth, no real Anthropic call
 * — the beta header and billing block are built into the request before it
 * leaves the process.
 *
 * Run on the self-hosted `dario-drift` runner (it has `claude`); GH-hosted
 * runners don't. Exits non-zero on any HARD drift (empty findings => clean).
 *
 *   node scripts/check-wire-drift.mjs
 *   DARIO_CLAUDE_BIN=/path/to/claude node scripts/check-wire-drift.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { betaForModel } from '../dist/proxy.js';
import { hasCchSeed } from '../dist/cch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'claude';
const useShell = process.platform === 'win32' && !/[\\/]/.test(CC_BIN);
const cleanHome = mkdtempSync(join(tmpdir(), 'wire-drift-'));

// The families dario transforms betaForModel for. Opus is the base.
const MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'];

function log(m) { console.error(`[wire-drift] ${m}`); }

function capture(model) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url.includes('/v1/messages') && req.method === 'POST' && !server._cap) {
          server._cap = { headers: req.headers, buf: Buffer.concat(chunks) };
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const env = {
        ...process.env,
        HOME: cleanHome, USERPROFILE: cleanHome,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'sk-capture-stub',
        CLAUDE_NONINTERACTIVE: '1',
      };
      const cc = spawn(CC_BIN, ['--print', '--model', model, '-p', 'hi'], {
        env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: useShell,
      });
      const done = () => {
        try { server.close(); } catch {}
        const cap = server._cap;
        if (!cap) return resolve(null);
        let buf = cap.buf;
        if ((cap.headers['content-encoding'] || '').includes('gzip')) { try { buf = gunzipSync(buf); } catch {} }
        const text = buf.toString('utf8');
        const beta = typeof cap.headers['anthropic-beta'] === 'string' ? cap.headers['anthropic-beta'] : null;
        const billing = (/x-anthropic-billing-header:[^"]*/.exec(text) || [])[0] || null;
        const version = (/cc_version=([0-9]+\.[0-9]+\.[0-9]+)/.exec(text) || [])[1] || null;
        const cchEmitted = /cch=[0-9a-fA-F]{5}/.test(text);
        resolve({ model, beta, billing, version, cchEmitted });
      };
      cc.on('exit', () => setTimeout(done, 200));
      cc.on('error', (e) => { log(`spawn error for ${model}: ${e.message}`); resolve(null); });
      setTimeout(() => { try { cc.kill(); } catch {}; done(); }, 40000);
    });
  });
}

const findings = [];
const caps = {};
for (const m of MODELS) {
  const c = await capture(m);
  if (!c || !c.beta) {
    findings.push({ severity: 'high', category: 'capture', message: `Failed to capture a /v1/messages request for ${m} (is claude installed and runnable?).` });
    continue;
  }
  caps[m] = c;
}

const opus = caps['claude-opus-4-8'];
if (opus && opus.beta) {
  // ── (1) per-model beta transform vs the installed CC ──
  // Opus IS the base; assert betaForModel reproduces every other family from it.
  for (const m of MODELS) {
    const c = caps[m];
    if (!c || !c.beta) continue;
    const derived = betaForModel(opus.beta, m);
    if (derived !== c.beta) {
      findings.push({
        severity: 'high',
        category: 'beta.transform',
        model: m,
        message: `betaForModel drift for ${m}: dario would emit a beta set that does not match the installed CC ${c.version || ''}.`,
        expected: c.beta,
        got: derived,
      });
    }
  }

  // Informational: is the BAKED base still current (modulo the OAuth flag dario
  // appends only in production and afk-mode's remote-config volatility)?
  try {
    const tmpl = JSON.parse(readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8'));
    const norm = (s) => s.split(',').filter((f) => f && f !== 'oauth-2025-04-20' && f !== 'afk-mode-2026-01-31').join(',');
    if (tmpl.anthropic_beta && norm(tmpl.anthropic_beta) !== norm(opus.beta)) {
      findings.push({
        severity: 'low',
        category: 'beta.base',
        message: 'Baked template anthropic_beta differs from the installed opus base (ignoring oauth-2025-04-20 + volatile afk-mode). Re-run capture-and-bake; the periodic template refresh heals this automatically.',
        expected: opus.beta,
        got: tmpl.anthropic_beta,
      });
    }
  } catch { /* template unreadable — the static drift check covers that */ }
}

// ── (2) cch gate vs CC's billing block ──
for (const m of MODELS) {
  const c = caps[m];
  if (!c || !c.version) continue;
  const weWouldEmit = hasCchSeed(c.version);
  if (c.cchEmitted && !weWouldEmit) {
    findings.push({
      severity: 'high', category: 'cch.gate', model: m,
      message: `CC ${c.version} emits a cch token but dario has no seed for it (hasCchSeed=false) — dario would OMIT cch while CC sends one. Run scripts/cch-calibrate.mjs to add the seed.`,
    });
  } else if (!c.cchEmitted && weWouldEmit) {
    findings.push({
      severity: 'high', category: 'cch.gate', model: m,
      message: `CC ${c.version} emits NO cch token but dario holds a seed (hasCchSeed=true) — dario would emit a cch CC no longer sends. Drop ${c.version} from CCH_SEEDS.`,
    });
  }
}

const report = {
  drift: findings.some((f) => f.severity === 'high'),
  checkedAt: new Date().toISOString(),
  ccVersion: opus?.version ?? null,
  captured: Object.fromEntries(Object.entries(caps).map(([m, c]) => [m, { beta: c.beta, cchEmitted: c.cchEmitted, billing: c.billing }])),
  findings,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.drift ? 1 : 0);

#!/usr/bin/env node
// A/B test of the @theo claim (2026-04-29):
//
//   "if you have a recent commit that mentions OpenClaw in a json
//    blob, Claude Code will either refuse your request or bill you
//    extra money."
//
// We disambiguate two distinct mechanisms his claim could be from:
//
//   - REFUSAL (content filter, RLHF or server-side classifier on
//     content): manifests as the model refusing to comply with a
//     benign prompt. Status code may stay 200 with a refusal body,
//     or it may become a 4xx.
//
//   - OVERAGE (billing classifier): manifests as the
//     `anthropic-ratelimit-unified-representative-claim` response
//     header flipping from `five_hour` (subscription) to a
//     pay-per-token classification.
//
// Methodology mirrors test-system-prompt-mods.mjs: capture CC's
// outbound body, deep-clone for each variant, mutate ONLY the
// commit-messages substring inside system[2].text, hold everything
// else identical (model, tools, effort, max_tokens, body field
// order, OAuth bearer, anthropic-beta with `oauth-2025-04-20`
// prepended). Send to api.anthropic.com directly. Read both the
// billing-claim header AND the response body for refusal text.
//
// Variants:
//   01  control_clean             — openclaw stripped from the captured baseline
//   02  openclaw_lower            — "openclaw" injected into a commit line
//   03  openclaw_caps             — "OpenClaw" (Theo's exact casing)
//   04  openclaw_upper            — "OPENCLAW"
//   05  hermes                    — another #13-listed tool name (control)
//   06  cline                     — another text-tool client (control)
//   07  neutral_rebar3            — random non-Anthropic-related token (noise control)
//   08  openclaw_in_user_message  — same content but in user prompt, not system

import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
const CAPTURE_TIMEOUT_MS = 25_000;
const PACE_MS = 2_000;

// ──────────────────────────────────────────────────────────────────────
// Capture (mirrors test-system-prompt-mods.mjs)
// ──────────────────────────────────────────────────────────────────────

async function captureFromCC() {
  return new Promise((resolve, reject) => {
    let captured = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/v1/messages') && req.method === 'POST' && !captured) {
          try { captured = { url: req.url, headers: req.headers, body: JSON.parse(body) }; }
          catch (e) { captured = { url: req.url, headers: req.headers, err: e.message }; }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: error\ndata: {"type":"error","error":{"type":"capture_only"}}\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.error(`[capture] MITM on http://127.0.0.1:${port}`);
      const cc = spawn(CC_BIN, ['--print', '-p', 'hi'], {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: 'sk-capture-stub',
          CLAUDE_NONINTERACTIVE: '1',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      const finish = () => {
        server.close();
        if (captured?.body) resolve(captured);
        else reject(new Error('no /v1/messages body captured'));
      };
      cc.on('exit', () => setTimeout(finish, 200));
      cc.on('error', (err) => reject(err));
      setTimeout(() => { cc.kill(); finish(); }, CAPTURE_TIMEOUT_MS);
    });
  });
}

async function sendUpstream(body, bearer, captureHeaders, urlPath) {
  let beta = captureHeaders['anthropic-beta'] || '';
  if (!beta.split(',').includes('oauth-2025-04-20')) {
    beta = beta ? `oauth-2025-04-20,${beta}` : 'oauth-2025-04-20';
  }
  const headers = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'anthropic-beta': beta,
    'anthropic-version': captureHeaders['anthropic-version'] || '2023-06-01',
    'authorization': `Bearer ${bearer}`,
    'user-agent': captureHeaders['user-agent'],
    'x-app': captureHeaders['x-app'] || 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  body.stream = false;

  const res = await fetch('https://api.anthropic.com' + urlPath, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const claim = res.headers.get('anthropic-ratelimit-unified-representative-claim') || '(unset)';
  const respText = await res.text();
  let respJson = null;
  try { respJson = JSON.parse(respText); } catch {}
  const text = respJson?.content?.find((b) => b.type === 'text')?.text || '';

  // Look for refusal indicators in the response body. RLHF refusals
  // typically use a small set of phrases; we flag any of them.
  const refusalIndicators = [
    /^I (can'?t|cannot|won'?t)/i,
    /^I'?m not (able|going|comfortable)/i,
    /\bagainst (my|our) (policies|guidelines)/i,
    /\bI (apologize|cannot help)/i,
    /\bunable to (assist|help|comply)/i,
  ];
  const refusalDetected = refusalIndicators.some((re) => re.test(text.slice(0, 500)));

  return {
    status: res.status,
    claim,
    requestId: res.headers.get('request-id'),
    text,
    output_chars: text.length,
    output_tokens: respJson?.usage?.output_tokens,
    input_tokens: respJson?.usage?.input_tokens,
    errorType: respJson?.error?.type,
    errorMessage: respJson?.error?.message?.slice(0, 200),
    refusalDetected,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Variant construction
// ──────────────────────────────────────────────────────────────────────

/**
 * Strip openclaw mentions from a captured baseline so the control
 * variant is genuinely "clean." The dario repo's git history /
 * status may surface openclaw via commit messages or branch names,
 * so we redact them to NOTACLAW.
 */
function stripOpenClawMentions(s) {
  return s.replace(/openclaw/gi, 'NOTACLAW');
}

/**
 * Inject a synthetic commit line near the top of the "Recent
 * commits:" section, so the token sits where Theo claims it
 * triggers (a recent commit message that CC reports to the model
 * via its environment block).
 */
function injectCommitLine(s, token) {
  const synthetic = `f00dface chore: ${token} integration test for billing classifier verification\n`;
  return s.replace(/Recent commits:\n/, `Recent commits:\n${synthetic}`);
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

const captured = await captureFromCC();
console.error(`[capture] body keys: ${Object.keys(captured.body).join(', ')}`);
console.error(`[capture] system[2].text length: ${captured.body.system[2].text.length}`);

const cleanBase = stripOpenClawMentions(captured.body.system[2].text);
console.error(`[strip] after openclaw redaction: ${cleanBase.length} chars (was ${captured.body.system[2].text.length})`);
console.error(`[strip] redactions: ${(captured.body.system[2].text.match(/openclaw/gi) || []).length}`);

const VARIANTS = [
  { name: '01_control_clean', sys: cleanBase, userPrompt: 'hi' },
  { name: '02_openclaw_lower', sys: injectCommitLine(cleanBase, 'openclaw'), userPrompt: 'hi' },
  { name: '03_openclaw_caps', sys: injectCommitLine(cleanBase, 'OpenClaw'), userPrompt: 'hi' },
  { name: '04_openclaw_upper', sys: injectCommitLine(cleanBase, 'OPENCLAW'), userPrompt: 'hi' },
  { name: '05_hermes', sys: injectCommitLine(cleanBase, 'hermes'), userPrompt: 'hi' },
  { name: '06_cline', sys: injectCommitLine(cleanBase, 'cline'), userPrompt: 'hi' },
  { name: '07_neutral_rebar3', sys: injectCommitLine(cleanBase, 'rebar3'), userPrompt: 'hi' },
  { name: '08_openclaw_in_user', sys: cleanBase, userPrompt: 'I am working with openclaw integration code, please say hello in 5 words' },
];

const home = process.env.USERPROFILE || process.env.HOME;
const oa = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8')).claudeAiOauth;
const bearer = oa.accessToken;
if (!bearer) { console.error('FATAL: no CC accessToken'); process.exit(1); }
const minsLeft = Math.round((oa.expiresAt - Date.now()) / 60000);
console.error(`[auth] resolved CC token (${minsLeft} min remaining)`);
console.error('');

const results = [];
for (const v of VARIANTS) {
  const body = structuredClone(captured.body);
  body.system[2].text = v.sys;
  body.messages = [{ role: 'user', content: v.userPrompt }];

  process.stderr.write(`  ${v.name.padEnd(28)} ... `);
  try {
    const r = await sendUpstream(body, bearer, captured.headers, captured.url);
    const refusalMark = r.refusalDetected ? 'REFUSAL' : '       ';
    process.stderr.write(`status=${r.status} claim=${r.claim.padEnd(12)} ${refusalMark} chars=${r.output_chars} tok=${r.output_tokens}\n`);
    results.push({
      ...v,
      sys: undefined,  // don't store 27kB of system per variant in JSON output
      sys_chars: v.sys.length,
      status: r.status,
      claim: r.claim,
      requestId: r.requestId,
      output_chars: r.output_chars,
      output_tokens: r.output_tokens,
      input_tokens: r.input_tokens,
      errorType: r.errorType,
      errorMessage: r.errorMessage,
      refusalDetected: r.refusalDetected,
      response_preview: r.text.slice(0, 300),
      response_full: r.text,
    });
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    results.push({ ...v, sys: undefined, error: e.message });
  }
  await sleep(PACE_MS);
}

console.error('');
console.error('=== SUMMARY ===');
console.error('variant                       status claim         refusal? chars  tokens');
console.error('─'.repeat(85));
for (const r of results) {
  const claim = (r.claim || '?').padEnd(13);
  const refusal = r.refusalDetected ? 'REFUSAL ' : '        ';
  console.error(`${r.name.padEnd(28)} ${r.status || '?'}    ${claim} ${refusal} ${r.output_chars || 0}     ${r.output_tokens || 0}`);
}
console.error('');
console.error('=== response previews ===');
for (const r of results) {
  console.error(`--- ${r.name} ---`);
  console.error(`  ${(r.response_preview || r.error || '').replace(/\n/g, ' | ').slice(0, 150)}`);
}

console.log(JSON.stringify(results, null, 2));

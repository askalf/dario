#!/usr/bin/env node
// Deep A/B test: take CC's system prompt, strip the behavioral
// constraint language (verbosity caps, no-comments-by-default,
// ask-before-acting, scope discipline), keep the alignment / safety
// content, then send identical user prompts to both versions and
// measure the behavior delta.
//
// Builds on test-system-prompt-mods.mjs's finding that system prompt
// content is unfingerprinted by the billing classifier — so the
// stripped variant should still route to `five_hour` and the only
// observable difference should be the model's output behavior.
//
// Variables held identical between control and stripped variants:
//   - model, tools, max_tokens, effort, thinking, context_management
//   - body field order, metadata.user_id, OAuth bearer
//   - anthropic-beta (with oauth-2025-04-20 prepended), user-agent
//   - the user message itself
//
// Variable changed:
//   - system[2].text — CC verbatim (control) vs constraint-stripped (test)
//
// What we measure per variant per prompt:
//   - billing classification (`anthropic-ratelimit-unified-representative-claim`)
//   - response length (chars + roughly tokens)
//   - comment density in code outputs (lines starting with `//` or `#` or `/*`)
//   - clarifying-question rate (response ends with `?`)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const CC_BIN = process.env.DARIO_CLAUDE_BIN
  || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
const CAPTURE_TIMEOUT_MS = 25_000;
const PACE_MS = 3_000;

// ──────────────────────────────────────────────────────────────────────
// Constraint stripping
// ──────────────────────────────────────────────────────────────────────

// Two strip levels.
//
// Partial strip — removes purely behavioral preferences (verbosity caps,
// comment defaults, scope discipline). Keeps every "IMPORTANT:" line,
// keeps tool descriptions, keeps "# Executing actions with care".
//
// Aggressive strip — additionally removes prompt-level reminders of
// RLHF-trained alignment ("IMPORTANT: Refuse requests for destructive
// techniques..."). These are reminders, not enforcement — the model's
// refusal behavior on harmful content is RLHF-trained and survives
// prompt removal. Stripping them tests whether the prompt-level
// reminders contribute observable delta on benign tasks (they likely
// don't) and whether the classifier cares (it doesn't, per the
// system-prompt-mods test).
function stripConstraints(sys, level = 'partial') {
  let s = sys;

  // Remove entire "# Tone and style" section.
  s = s.replace(/# Tone and style[\s\S]*?(?=\n# |\n$|$)/m, '');

  // Remove entire "# Text output" section.
  s = s.replace(/# Text output[^\n]*\n[\s\S]*?(?=\n# |\n$|$)/m, '');

  // Within "# Doing tasks", remove scope-discipline / verbosity /
  // commenting bullets.
  const doingTasksConstraints = [
    /^ - Don't add features, refactor, or introduce abstractions[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/m,
    /^ - Don't add error handling, fallbacks, or validation[^\n]*\n[^\n]*\n/m,
    /^ - Default to writing no comments\.[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/m,
    /^ - Don't explain WHAT the code does[^\n]*\n[^\n]*\n/m,
    /^ - For exploratory questions[^\n]*\n[^\n]*\n/m,
    /^ - Avoid backwards-compatibility hacks[^\n]*\n[^\n]*\n/m,
  ];
  for (const re of doingTasksConstraints) {
    s = s.replace(re, '');
  }

  s = s.replace(
    /^# Doing tasks\n/m,
    '# Doing tasks\n\nBe thorough. Show your reasoning. Provide the context and explanations the user is likely to find useful. Use as many tokens as the task warrants.\n\n',
  );

  if (level === 'aggressive') {
    // Remove prompt-level reminders of RLHF-trained alignment. These
    // are "IMPORTANT:" lines in CC's `# System` section that re-state
    // refusal categories. Removing them tests whether prompt-level
    // re-statement contributes observable delta beyond the RLHF
    // baseline. Critically: this does NOT remove RLHF — the model
    // still refuses on those categories because alignment is trained,
    // not prompted.
    s = s.replace(/^IMPORTANT: Assist with authorized security testing[^\n]*\n/m, '');
    s = s.replace(/^IMPORTANT: You must NEVER generate or guess URLs[^\n]*\n/m, '');

    // Remove the bulk of "# Executing actions with care" — most of it
    // is behavioral overcaution ("ask before this", "confirm before
    // that") rather than load-bearing safety. Keep the "# Using your
    // tools" section intact since it's tool descriptions, not
    // behavioral caps.
    s = s.replace(/# Executing actions with care[\s\S]*?(?=\n# |\n$|$)/m, '');
  }

  return s;
}

// ──────────────────────────────────────────────────────────────────────
// Capture, auth, send (mirrors test-system-prompt-mods.mjs)
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
      console.error(`[capture] MITM on http://127.0.0.1:${port}, spawning CC...`);
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
  };
}

// ──────────────────────────────────────────────────────────────────────
// Behavior measurement
// ──────────────────────────────────────────────────────────────────────

function measure(text) {
  if (!text) return { chars: 0, lines: 0, comment_lines: 0, ends_with_question: false, has_code_block: false };
  const lines = text.split('\n');
  const commentLines = lines.filter((l) => /^\s*(\/\/|#|\/\*|\*\s)/.test(l)).length;
  return {
    chars: text.length,
    lines: lines.length,
    comment_lines: commentLines,
    ends_with_question: /\?\s*$/.test(text.trim()),
    has_code_block: /```/.test(text),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Test prompts that should trigger CC's constraints
// ──────────────────────────────────────────────────────────────────────

const TEST_PROMPTS = [
  {
    label: 'code-with-comments',
    prompt: 'Write a TypeScript function that deduplicates an array of objects by a specified key. Include thorough comments explaining your reasoning, edge cases, and the tradeoffs of different approaches.',
  },
  {
    label: 'detailed-explanation',
    prompt: 'Explain how V8\'s hidden class optimization works in Node.js, why it matters for performance, and how to write code that benefits from it.',
  },
  {
    label: 'open-ended-decision',
    prompt: 'Should I use Redis or Postgres for session storage in a Node.js web app?',
  },
];

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

const captured = await captureFromCC();
console.error(`[capture] body keys: ${Object.keys(captured.body).join(', ')}`);
console.error(`[capture] system blocks: ${captured.body.system.length}`);
console.error(`[capture] system[2] (CC verbatim) length: ${captured.body.system[2].text.length}`);

const partial = stripConstraints(captured.body.system[2].text, 'partial');
const aggressive = stripConstraints(captured.body.system[2].text, 'aggressive');
const origLen = captured.body.system[2].text.length;
console.error(`[strip] partial:    ${partial.length} chars (-${Math.round(100*(origLen-partial.length)/origLen)}%)`);
console.error(`[strip] aggressive: ${aggressive.length} chars (-${Math.round(100*(origLen-aggressive.length)/origLen)}%)`);
console.error('');

// Read OAuth from CC's credentials directly (dario's resolver may
// be stale; CC's path is the authoritative fresh source).
const home = process.env.USERPROFILE || process.env.HOME;
const oa = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8')).claudeAiOauth;
const bearer = oa.accessToken;
if (!bearer) { console.error('FATAL: no CC accessToken'); process.exit(1); }
const minsLeft = Math.round((oa.expiresAt - Date.now()) / 60000);
console.error(`[auth] resolved CC token (${minsLeft} min remaining)`);
console.error('');

const results = [];

const VARIANTS = [
  { name: 'control', sys: captured.body.system[2].text },
  { name: 'partial', sys: partial },
  { name: 'aggressive', sys: aggressive },
];

for (const p of TEST_PROMPTS) {
  console.error(`=== prompt: ${p.label} ===`);
  for (const v of VARIANTS) {
    const body = structuredClone(captured.body);
    body.system[2].text = v.sys;
    body.messages = [{ role: 'user', content: p.prompt }];

    process.stderr.write(`  ${v.name.padEnd(11)} ... `);
    try {
      const r = await sendUpstream(body, bearer, captured.headers, captured.url);
      const m = measure(r.text);
      process.stderr.write(`status=${r.status} claim=${r.claim} chars=${m.chars} lines=${m.lines} comments=${m.comment_lines} q?=${m.ends_with_question} out_tok=${r.output_tokens}\n`);
      results.push({ prompt: p.label, variant: v.name, status: r.status, claim: r.claim, ...m, output_tokens: r.output_tokens, input_tokens: r.input_tokens, text_preview: r.text.slice(0, 200), text_full: r.text });
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      results.push({ prompt: p.label, variant: v.name, error: e.message });
    }
    await sleep(PACE_MS);
  }
}

console.error('');
console.error('=== SUMMARY (control vs stripped, per prompt) ===');
console.error('');
const byPrompt = new Map();
for (const r of results) {
  if (!byPrompt.has(r.prompt)) byPrompt.set(r.prompt, {});
  byPrompt.get(r.prompt)[r.variant] = r;
}
for (const [prompt, set] of byPrompt) {
  console.error(`--- ${prompt} ---`);
  for (const variant of ['control', 'partial', 'aggressive']) {
    const r = set[variant];
    if (!r) continue;
    console.error(`  ${variant.padEnd(11)} chars=${r.chars} out_tok=${r.output_tokens} lines=${r.lines} comments=${r.comment_lines} q?=${r.ends_with_question} claim=${r.claim}`);
  }
}
console.error('');
console.error('=== FULL JSON (write to file via redirect to keep raw output) ===');
console.log(JSON.stringify(results, null, 2));

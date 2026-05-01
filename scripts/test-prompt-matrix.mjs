#!/usr/bin/env node
// Extended A/B matrix probe — push the limits of behavioral variation
// surfaceable via system-prompt modification. Builds on the smaller
// test-constraint-removal.mjs by adding:
//
//   - Custom-prompt recipes from docs/system-prompt.md as variants
//     (terse-engineer / verbose-explainer / code-reviewer /
//     research-assistant) alongside the constraint-strip levels.
//   - Wider behavioral measurements: emoji presence, markdown headers,
//     tables, "decisive start" pattern matching, in addition to the
//     chars / tokens / comments / question measurements from the
//     earlier matrix.
//   - Configurable matrix dimensions — pass --variants and --prompts
//     to subset the run when you want a focused probe rather than
//     full N×M.
//
// Empirical premise (from test-system-prompt-mods.mjs): the billing
// classifier doesn't read system prompt content. Therefore every
// variant in this matrix should route `five_hour`. Behavior delta is
// the dependent variable.
//
// Real upstream cost on the maintainer's Max plan; negligible
// (single-digit cents per run for a 12-trial focused matrix).

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
// Constraint stripping — ported byte-for-byte from
// test-constraint-removal.mjs:stripConstraints. Same regex list.
// ──────────────────────────────────────────────────────────────────────

function stripConstraints(sys, level = 'partial') {
  let s = sys;
  s = s.replace(/# Tone and style[\s\S]*?(?=\n# |\n$|$)/m, '');
  s = s.replace(/# Text output[^\n]*\n[\s\S]*?(?=\n# |\n$|$)/m, '');
  const doingTasksConstraints = [
    /^ - Don't add features, refactor, or introduce abstractions[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/m,
    /^ - Don't add error handling, fallbacks, or validation[^\n]*\n[^\n]*\n/m,
    /^ - Default to writing no comments\.[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/m,
    /^ - Don't explain WHAT the code does[^\n]*\n[^\n]*\n/m,
    /^ - For exploratory questions[^\n]*\n[^\n]*\n/m,
    /^ - Avoid backwards-compatibility hacks[^\n]*\n[^\n]*\n/m,
  ];
  for (const re of doingTasksConstraints) s = s.replace(re, '');
  s = s.replace(
    /^# Doing tasks\n/m,
    '# Doing tasks\n\nBe thorough. Show your reasoning. Provide the context and explanations the user is likely to find useful. Use as many tokens as the task warrants.\n\n',
  );
  if (level === 'aggressive') {
    s = s.replace(/^IMPORTANT: Assist with authorized security testing[^\n]*\n/m, '');
    s = s.replace(/^IMPORTANT: You must NEVER generate or guess URLs[^\n]*\n/m, '');
    s = s.replace(/# Executing actions with care[\s\S]*?(?=\n# |\n$|$)/m, '');
  }
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// Recipe library — same text that ships in docs/system-prompt.md
// ──────────────────────────────────────────────────────────────────────

const RECIPES = {
  'terse-engineer':
    "You are a senior engineer. Answer questions directly and ship code. Prefer working code over prose. Skip pleasantries, hedging, and apologies. When asked for a recommendation, recommend — don't enumerate every option unless asked. Match output length to question complexity. If the question is ambiguous, pick the most likely interpretation and proceed; flag the assumption in one sentence.",

  'verbose-explainer':
    "You are an engineer-mentor. Your job is to teach by example. For every code answer, explain the reasoning, alternative approaches, and tradeoffs you considered. For every concept, give the intuition first, then the technical detail, then a concrete example. Include comments in code that explain WHY decisions were made, not just WHAT the code does. Aim for outputs that build the user's mental model, not just answer the question.",

  'code-reviewer':
    "You are reviewing code. Your job is to surface issues — bugs, security risks, performance traps, edge cases not handled, style and maintainability concerns, missing tests, ambiguous APIs. Order findings by severity. Suggest specific fixes with code snippets, but don't rewrite the entire file unless asked. If the code is correct, say \"no issues found\" and stop — don't invent problems. Honest is more valuable than thorough.",

  'research-assistant':
    "You are a research assistant. Answer questions with structured analysis: summary first (2-4 sentences), then claim-by-claim breakdown with supporting reasoning, then unresolved questions or limitations. Distinguish between observed facts, reasonable inferences, and speculation — never blur the boundaries. Use markdown tables for comparisons across more than two items. When citing online sources, prefer primary documentation, papers, or official spec text over secondary blog posts. Flag uncertainty explicitly.",
};

function resolveVariant(name, ccVerbatim) {
  if (name === 'control') return ccVerbatim;
  if (name === 'partial') return stripConstraints(ccVerbatim, 'partial');
  if (name === 'aggressive') return stripConstraints(ccVerbatim, 'aggressive');
  if (RECIPES[name]) return RECIPES[name];
  throw new Error(`Unknown variant: ${name}`);
}

// ──────────────────────────────────────────────────────────────────────
// Behavioral measurements
// ──────────────────────────────────────────────────────────────────────

function measure(text) {
  if (!text) return null;
  const lines = text.split('\n');
  return {
    chars: text.length,
    lines: lines.length,
    comment_lines: lines.filter((l) => /^\s*(\/\/|#|\/\*|\*\s)/.test(l)).length,
    has_code_block: /```/.test(text),
    has_markdown_headers: /^#{2,}\s/m.test(text),
    has_table: /^\|.*\|/m.test(text),
    // Emoji range covers common pictographic emoji.
    has_emoji: /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u.test(text),
    ends_with_question: /\?\s*$/.test(text.trim()),
    // Heuristic for "decisive start" — answers that lead with a
    // recommendation rather than reciting the question or hedging.
    starts_decisive: /^[A-Z][a-z]+(?:\.|,| is | wins | first | over )/m.test(text.trim()),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Test prompts — chosen to surface different behavioral axes
// ──────────────────────────────────────────────────────────────────────

const TEST_PROMPTS = [
  {
    label: 'redis-vs-postgres',
    prompt: 'Should I use Redis or Postgres for session storage in a Node.js web app?',
    note: 'Recommendation under ambiguity. Cross-reference to prior matrix.',
  },
  {
    label: 'http-fun-explanation',
    prompt: 'Explain HTTP methods (GET, POST, PUT, DELETE, PATCH) in a fun, conversational way for a junior developer.',
    note: '"Fun" tone request. Tests CC\'s no-emoji bias + tone constraint directly.',
  },
  {
    label: 'async-error-guide',
    prompt: 'Write a comprehensive technical guide on error handling in async JavaScript. Cover Promise rejection handling, try/catch with async/await, error propagation through async stacks, and observability patterns.',
    note: 'Long-form generation. Tests verbosity caps under explicit "comprehensive" instruction.',
  },
  {
    label: 'productivity-tips-listing',
    prompt: 'List 15 underrated developer productivity tips. Be specific and actionable.',
    note: 'Listing task with explicit count. Tests verbosity bias on enumeration.',
  },
];

// ──────────────────────────────────────────────────────────────────────
// Capture (mirrors test-constraint-removal.mjs)
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
    output_tokens: respJson?.usage?.output_tokens,
    input_tokens: respJson?.usage?.input_tokens,
    errorType: respJson?.error?.type,
    errorMessage: respJson?.error?.message?.slice(0, 200),
  };
}

// ──────────────────────────────────────────────────────────────────────
// CLI args — pick subsets of the matrix
// ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function getArg(flag) {
  const a = argv.find((x) => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1).split(',') : null;
}
const variantsToRun = getArg('--variants') || ['control', 'aggressive', 'terse-engineer'];
const promptLabelsToRun = getArg('--prompts') || TEST_PROMPTS.map((p) => p.label);
const promptsToRun = TEST_PROMPTS.filter((p) => promptLabelsToRun.includes(p.label));

console.error(`[matrix] variants: ${variantsToRun.join(', ')}`);
console.error(`[matrix] prompts:  ${promptsToRun.map((p) => p.label).join(', ')}`);
console.error(`[matrix] total trials: ${variantsToRun.length * promptsToRun.length}`);
console.error('');

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

const captured = await captureFromCC();
console.error(`[capture] system blocks: ${captured.body.system.length}`);
console.error(`[capture] system[2] (CC verbatim) length: ${captured.body.system[2].text.length}`);
console.error('');

const ccVerbatim = captured.body.system[2].text;
const variantTexts = Object.fromEntries(
  variantsToRun.map((name) => [name, resolveVariant(name, ccVerbatim)])
);
console.error('[variants] resolved sizes:');
for (const [name, sys] of Object.entries(variantTexts)) {
  console.error(`  ${name.padEnd(22)} ${sys.length.toLocaleString()} chars`);
}
console.error('');

const home = process.env.USERPROFILE || process.env.HOME;
const oa = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8')).claudeAiOauth;
const bearer = oa.accessToken;
if (!bearer) { console.error('FATAL: no CC accessToken'); process.exit(1); }
const minsLeft = Math.round((oa.expiresAt - Date.now()) / 60000);
console.error(`[auth] resolved CC token (${minsLeft} min remaining)`);
console.error('');

const results = [];

for (const p of promptsToRun) {
  console.error(`=== prompt: ${p.label} ===`);
  for (const variantName of variantsToRun) {
    const body = structuredClone(captured.body);
    body.system[2].text = variantTexts[variantName];
    body.messages = [{ role: 'user', content: p.prompt }];

    process.stderr.write(`  ${variantName.padEnd(22)} ... `);
    try {
      const r = await sendUpstream(body, bearer, captured.headers, captured.url);
      const m = measure(r.text);
      const compactSummary = m
        ? `chars=${m.chars} tok=${r.output_tokens} md=${m.has_markdown_headers ? '1' : '0'} tbl=${m.has_table ? '1' : '0'} emoji=${m.has_emoji ? '1' : '0'} q?=${m.ends_with_question ? '1' : '0'} dec=${m.starts_decisive ? '1' : '0'}`
        : `error: ${r.errorType || r.status}`;
      process.stderr.write(`status=${r.status} claim=${r.claim} ${compactSummary}\n`);
      results.push({
        prompt: p.label,
        variant: variantName,
        status: r.status,
        claim: r.claim,
        request_id: r.requestId,
        output_tokens: r.output_tokens,
        input_tokens: r.input_tokens,
        ...(m || {}),
        text_full: r.text,
      });
    } catch (e) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      results.push({ prompt: p.label, variant: variantName, error: e.message });
    }
    await sleep(PACE_MS);
  }
}

console.error('');
console.error('=== JSON ===');
console.log(JSON.stringify(results, null, 2));

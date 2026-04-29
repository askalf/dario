#!/usr/bin/env node
// Empirical A/B test: does Anthropic's billing classifier route to
// `five_hour` (subscription) when CC's system prompt content is
// modified, while everything else (effort, max_tokens, tools, headers,
// field order, billing tag, metadata user_id) is held identical?
//
// Approach:
//   1. Capture CC's exact outbound body via a loopback MITM (same
//      approach as scripts/capture-full-body.mjs).
//   2. For each variant in the ladder, deep-clone the captured body,
//      apply the variant's mutation to `system[2].text` only, and POST
//      the result directly to https://api.anthropic.com/v1/messages
//      with OAuth bearer auth.
//   3. Read the `anthropic-ratelimit-unified-representative-claim`
//      response header — that's the billing classification (`five_hour`
//      = subscription, `overage` = pay-per-token).
//   4. Print a result table.
//
// Cost: 1 real upstream request per variant. With ~7 variants on the
// default ladder, that's a trivial slice of any Max plan's budget. The
// dispatched messages are short ("hi") so output_tokens are minimal.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CC_BIN = process.env.DARIO_CLAUDE_BIN
  || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
const CAPTURE_TIMEOUT_MS = 25_000;
const PACE_MS = 2_000;

// ──────────────────────────────────────────────────────────────────────
// Step 1: Capture CC's outbound body (control)
// ──────────────────────────────────────────────────────────────────────

async function captureFromCC() {
  return new Promise((resolve, reject) => {
    let captured = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/v1/messages') && req.method === 'POST' && !captured) {
          try {
            captured = { url: req.url, headers: req.headers, body: JSON.parse(body) };
          } catch (e) {
            captured = { url: req.url, headers: req.headers, raw: body, err: e.message };
          }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: error\ndata: {"type":"error","error":{"type":"capture_only","message":"test-system-prompt-mods.mjs"}}\n\n');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      console.error(`[capture] MITM on ${baseUrl}, spawning CC...`);

      const cc = spawn(CC_BIN, ['--print', '-p', 'hi'], {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: 'sk-capture-stub',
          CLAUDE_NONINTERACTIVE: '1',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });

      const finish = () => {
        server.close();
        if (captured && captured.body) resolve(captured);
        else reject(new Error('no /v1/messages body captured'));
      };

      cc.on('exit', () => setTimeout(finish, 200));
      cc.on('error', (err) => reject(err));
      setTimeout(() => { cc.kill(); finish(); }, CAPTURE_TIMEOUT_MS);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Step 2: Variant ladder
// ──────────────────────────────────────────────────────────────────────

// Each variant mutates the captured body in-place. block 2 of the
// system array is CC's 13kB system prompt; block 1 is the agent
// identity; block 0 is the billing tag.
const VARIANTS = [
  {
    name: '01_control',
    desc: 'CC verbatim, no modifications',
    mutate: (_body) => {},
  },
  {
    name: '02_single_char_typo',
    desc: 'system[2]: prepend single char',
    mutate: (b) => { b.system[2].text = 'X' + b.system[2].text; },
  },
  {
    name: '03_word_substitution',
    desc: 'system[2]: "concise" → "brief"',
    mutate: (b) => { b.system[2].text = b.system[2].text.replaceAll('concise', 'brief'); },
  },
  {
    name: '04_sentence_removal',
    desc: 'system[2]: remove "Default to writing no comments." line',
    mutate: (b) => {
      b.system[2].text = b.system[2].text.replace(/Default to writing no comments\.[^\n]*\n/g, '');
    },
  },
  {
    name: '05_block2_replaced',
    desc: 'system[2].text replaced with custom 200-char prompt',
    mutate: (b) => {
      b.system[2].text = 'You are a helpful assistant. Be terse and direct. Prefer code over prose. Default to assuming the user knows what they want; ask only if their request is genuinely ambiguous.';
    },
  },
  {
    name: '06_extra_block_added',
    desc: 'system: add 4th block (3 → 4 blocks)',
    mutate: (b) => {
      b.system.push({ type: 'text', text: 'Additional operator instructions: prefer concise responses.' });
    },
  },
  {
    name: '07_length_padding',
    desc: 'system[2]: append 500 chars of "x"',
    mutate: (b) => { b.system[2].text = b.system[2].text + '\n\n' + 'x'.repeat(500); },
  },
];

// ──────────────────────────────────────────────────────────────────────
// Step 3: Send to api.anthropic.com with OAuth bearer
// ──────────────────────────────────────────────────────────────────────

async function sendUpstream(body, bearer, captureHeaders, urlPath) {
  // Reproduce CC's wire headers but swap auth: drop x-api-key, use Bearer.
  // anthropic-beta and anthropic-version come from the captured headers
  // so we don't drift from what CC sends.
  //
  // CC's MITM capture is done with a placeholder API key, so CC's
  // outbound anthropic-beta does NOT include `oauth-2025-04-20` (CC
  // only appends that beta when actually authenticated via OAuth).
  // When we replace the API-key auth with a real OAuth Bearer, we
  // need to prepend that beta or Anthropic returns
  // `authentication_error: invalid x-api-key` even with a valid token
  // — same workaround dario's proxy applies (see src/proxy.ts:821 and
  // dario#42).
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
  // Force non-streaming so we read the response body in one shot.
  // Note: this alters one wire-shape axis (`stream`) but is necessary
  // for clean header reads. If the classifier flips on stream alone
  // we'd see that in the control row.
  body.stream = false;

  const url = 'https://api.anthropic.com' + urlPath;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const claim = res.headers.get('anthropic-ratelimit-unified-representative-claim') || '(unset)';
  const respText = await res.text();
  let respJson = null;
  try { respJson = JSON.parse(respText); } catch {}
  return {
    status: res.status,
    claim,
    requestId: res.headers.get('request-id') || res.headers.get('x-request-id'),
    errorType: respJson?.error?.type,
    errorMessage: respJson?.error?.message?.slice(0, 120),
    output_chars: respJson?.content?.[0]?.text?.length ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

const captured = await captureFromCC();
console.error(`[capture] body keys: ${Object.keys(captured.body).join(', ')}`);
console.error(`[capture] system blocks: ${captured.body.system.length}`);
console.error(`[capture] system[2].text length: ${captured.body.system[2].text.length} chars`);
console.error(`[capture] tools: ${captured.body.tools?.length ?? 0}`);
console.error(`[capture] effort: ${captured.body.output_config?.effort}, max_tokens: ${captured.body.max_tokens}, model: ${captured.body.model}`);
console.error('');

// Skip dario's getAccessToken — it prefers ~/.dario/credentials.json which
// holds an expired token whose refresh_token has been invalidated by
// Anthropic, so it falls back to that stale token. Read CC's own fresh
// token at ~/.claude/.credentials.json directly. CC refreshes it as
// needed during normal CC use and the file's update time is the source
// of truth.
const fs = await import('node:fs');
const path = await import('node:path');
const home = process.env.USERPROFILE || process.env.HOME;
const ccCredsPath = path.join(home, '.claude', '.credentials.json');
const ccCreds = JSON.parse(fs.readFileSync(ccCredsPath, 'utf-8'));
const oa = ccCreds.claudeAiOauth || ccCreds;
const bearer = oa.accessToken;
if (!bearer) {
  console.error('FATAL: no accessToken in', ccCredsPath);
  process.exit(1);
}
const minsLeft = Math.round((oa.expiresAt - Date.now()) / 60000);
console.error(`[auth] using CC's accessToken (${minsLeft} min remaining)`);
console.error('');

const results = [];
for (const v of VARIANTS) {
  const body = structuredClone(captured.body);
  v.mutate(body);
  const sysLen = (body.system || []).reduce((s, b) => s + (b.text?.length || 0), 0);
  process.stderr.write(`[run] ${v.name.padEnd(28)} (sys total: ${sysLen} chars) ... `);
  try {
    const r = await sendUpstream(body, bearer, captured.headers, captured.url);
    process.stderr.write(`status=${r.status} claim=${r.claim}\n`);
    results.push({ ...v, sys_total_chars: sysLen, ...r });
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    results.push({ ...v, error: e.message });
  }
  await sleep(PACE_MS);
}

console.error('');
console.error('=== RESULT TABLE ===');
console.log(JSON.stringify(results, null, 2));

#!/usr/bin/env node
// Manual, live-account test — answers the ONE open question the "altman"
// engine (dario#1009) is blocked on: does OpenAI invalidate the previous
// refresh_token when it's used to refresh, the way Anthropic does for
// Claude? No public source documents this (see codex-oauth.ts's header) —
// every existing third-party OAuth client for this flow is single-instance
// and has never had a reason to find out.
//
// NOT auto-discovered by `npm test` (lives outside test/'s flat scan, which
// all.test.mjs readdirSync's non-recursively — see that file's EXCLUDED
// comment for the same pattern used by overage-guard-e2e-live.mjs).
// Requires a real ChatGPT Plus/Pro account and makes real calls to
// auth.openai.com. Deliberately ONE round of live requests, not a loop —
// the plugin this flow's constants come from explicitly warns against
// "high-volume automated requests" against this endpoint, and answering
// this question doesn't need more than a handful of real calls.
//
// Usage:
//   1. First run: node test/manual/codex-refresh-race.mjs login
//      Prints an authorize URL, prompts for the pasted code, stores
//      tokens locally at test/manual/.codex-race-creds.json (gitignored —
//      see the entry added alongside this file). Does not touch
//      ~/.dario/codex-accounts/ — fully separate from the real pool.
//   2. Then: node test/manual/codex-refresh-race.mjs race
//      Loads the stored refresh_token and fires TWO concurrent refresh
//      calls against it — the same shape as the real bug two dario
//      instances would hit. Reports plainly which of two outcomes
//      happened:
//        - ROTATING: one call succeeds, the other gets invalid_grant.
//          Codex needs the same pool/lock architecture Claude does.
//        - TOLERANT: both calls succeed (whether they return the same or
//          different new refresh_tokens). Codex may not need a
//          distributed lock at all — worth confirming with a second
//          run before concluding, since a flaky single result isn't proof.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateCodexPKCE,
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  refreshCodexAccessToken,
} from '../../dist/codex-oauth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = join(__dirname, '.codex-race-creds.json');

async function readLineFromStdin(prompt) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

// Same parse as src/codex-accounts.ts parseCodexManualPaste: nothing listens on
// the localhost callback port in a manual-paste flow, so the browser lands on a
// page that never loads and the address bar is where the code actually is.
function parseManualPaste(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return { code: '', state: null };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') };
    } catch {
      return { code: '', state: null };
    }
  }
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) return { code: trimmed, state: null };
  return { code: trimmed.slice(0, hashIdx).trim(), state: trimmed.slice(hashIdx + 1).trim() };
}

async function login() {
  const { codeVerifier, codeChallenge } = generateCodexPKCE();
  const state = Math.random().toString(36).slice(2);
  const url = buildCodexAuthorizeUrl(codeChallenge, state);
  console.log('\nOpen this URL and log in with the ChatGPT Plus/Pro account. The browser');
  console.log('lands on a localhost page that does not load — copy the whole address bar:\n');
  console.log(`  ${url}\n`);
  const pasted = await readLineFromStdin('Redirect URL (or code): ');
  const { code } = parseManualPaste(pasted);
  if (!code) { console.error('No code found in what you pasted.'); process.exit(1); }
  const tokens = await exchangeCodexAuthorizationCode(code, codeVerifier);
  await writeFile(CREDS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`\nStored tokens at ${CREDS_PATH}. Run with "race" next.`);
}

async function race() {
  let stored;
  try {
    stored = JSON.parse(await readFile(CREDS_PATH, 'utf-8'));
  } catch {
    console.error(`No stored credentials at ${CREDS_PATH}. Run with "login" first.`);
    process.exit(1);
  }

  console.log('\nFiring two concurrent refresh calls against the SAME refresh_token...\n');
  const results = await Promise.allSettled([
    refreshCodexAccessToken(stored.refreshToken),
    refreshCodexAccessToken(stored.refreshToken),
  ]);

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`  Call ${i + 1}: SUCCESS — new refresh_token=${r.value.refreshToken.slice(0, 12)}...`);
    } else {
      console.log(`  Call ${i + 1}: FAILED — ${r.reason?.message || r.reason}`);
    }
  });

  const successes = results.filter(r => r.status === 'fulfilled');
  console.log('');
  if (successes.length === 1) {
    console.log('RESULT: ROTATING — one call won, one got invalid_grant. Same failure mode as');
    console.log('dario#993 for Claude. Codex needs the same pool/lock architecture.');
    // Persist the winner's fresh token so a re-run of "race" still works.
    await writeFile(CREDS_PATH, JSON.stringify(successes[0].value, null, 2), { mode: 0o600 });
  } else if (successes.length === 2) {
    console.log('RESULT: TOLERANT — both calls succeeded. Codex may not need a distributed');
    console.log('lock at all. Re-run this once more before concluding (a single result isn\'t');
    console.log('proof either way) — and note whether the two calls returned the SAME or');
    console.log('DIFFERENT new refresh_tokens, since that changes what "tolerant" implies.');
    await writeFile(CREDS_PATH, JSON.stringify(successes[1].value, null, 2), { mode: 0o600 });
  } else {
    console.log('RESULT: INCONCLUSIVE — both calls failed. Check the errors above; this may');
    console.log('be an expired/dead token rather than a rotation-race result. Run "login" again.');
  }
}

const cmd = process.argv[2];
if (cmd === 'login') await login();
else if (cmd === 'race') await race();
else {
  console.error('Usage: node test/manual/codex-refresh-race.mjs [login|race]');
  process.exit(1);
}

#!/usr/bin/env node
/**
 * dario — Use your Claude subscription as an API.
 *
 * Usage:
 *   dario login     — Authenticate with your Claude account
 *   dario status    — Check token health
 *   dario proxy     — Start the API proxy (default: port 3456)
 *   dario refresh   — Force token refresh
 *   dario logout    — Remove saved credentials
 */

import { createInterface } from 'node:readline';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startOAuthFlow, exchangeCode, getStatus, refreshTokens } from './oauth.js';
import { startProxy } from './proxy.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'proxy';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function login() {
  console.log('');
  console.log('  dario — Claude OAuth Login');
  console.log('  ─────────────────────────');
  console.log('');

  const { authUrl, codeVerifier } = startOAuthFlow();

  console.log('  Step 1: Open this URL in your browser:');
  console.log('');
  console.log(`  ${authUrl}`);
  console.log('');
  console.log('  Step 2: Log in to your Claude account and authorize.');
  console.log('');
  console.log('  Step 3: After authorization, you\'ll be redirected to a page');
  console.log('  that shows a code. Copy the FULL URL from your browser\'s');
  console.log('  address bar (it contains the authorization code).');
  console.log('');

  const input = await ask('  Paste the redirect URL or authorization code: ');

  // Extract code from URL or use raw input
  let code = input;
  try {
    const url = new URL(input);
    // Only extract from trusted Anthropic redirect URLs
    if (url.hostname === 'platform.claude.com' || url.hostname === 'claude.ai') {
      code = url.searchParams.get('code') ?? input;
    }
  } catch {
    // Not a URL, use as-is (raw code)
  }

  if (!code || code.length < 10 || code.length > 2048) {
    console.error('  Invalid authorization code.');
    process.exit(1);
  }

  try {
    const tokens = await exchangeCode(code, codeVerifier);
    const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 60000);

    console.log('');
    console.log('  Login successful!');
    console.log(`  Token expires in ${expiresIn} minutes (auto-refreshes).`);
    console.log('');
    console.log('  Run `dario proxy` to start the API proxy.');
    console.log('');
  } catch (err) {
    console.error('');
    console.error(`  Login failed: ${err instanceof Error ? err.message : err}`);
    console.error('  Try again with `dario login`.');
    process.exit(1);
  }
}

async function status() {
  const s = await getStatus();

  console.log('');
  console.log('  dario — Status');
  console.log('  ─────────────');
  console.log('');

  if (!s.authenticated) {
    console.log(`  Status: ${s.status === 'expired' ? 'Expired (will auto-refresh)' : 'Not authenticated'}`);
    if (s.status === 'none') {
      console.log('  Run `dario login` to authenticate.');
    }
  } else {
    console.log(`  Status: ${s.status}`);
    console.log(`  Expires in: ${s.expiresIn}`);
  }
  console.log('');
}

async function refresh() {
  console.log('[dario] Refreshing token...');
  try {
    const tokens = await refreshTokens();
    const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 60000);
    console.log(`[dario] Token refreshed. Expires in ${expiresIn} minutes.`);
  } catch (err) {
    console.error(`[dario] Refresh failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function logout() {
  const path = join(homedir(), '.dario', 'credentials.json');
  try {
    await unlink(path);
    console.log('[dario] Credentials removed.');
  } catch {
    console.log('[dario] No credentials found.');
  }
}

async function proxy() {
  const portArg = args.find(a => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1]!) : 3456;
  const verbose = args.includes('--verbose') || args.includes('-v');

  await startProxy({ port, verbose });
}

async function help() {
  console.log(`
  dario — Use your Claude subscription as an API.

  Usage:
    dario login              Authenticate with your Claude account
    dario proxy [options]    Start the API proxy server
    dario status             Check authentication status
    dario refresh            Force token refresh
    dario logout             Remove saved credentials

  Proxy options:
    --port=PORT              Port to listen on (default: 3456)
    --verbose, -v            Log all requests

  How it works:
    1. Run \`dario login\` to authenticate with your Claude Max/Pro subscription
    2. Run \`dario proxy\` to start a local API server
    3. Point any Anthropic SDK at http://localhost:3456

    Example with OpenClaw, or any tool that uses the Anthropic API:
      ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario openclaw start

    Example with the Anthropic Python SDK:
      import anthropic
      client = anthropic.Anthropic(base_url="http://localhost:3456", api_key="dario")

    Example with curl:
      curl http://localhost:3456/v1/messages \\
        -H "Content-Type: application/json" \\
        -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

  Your subscription handles the billing. No API key needed.
  Tokens auto-refresh in the background — set it and forget it.
`);
}

// Main
const commands: Record<string, () => Promise<void>> = {
  login,
  status,
  proxy,
  refresh,
  logout,
  help,
  '--help': help,
  '-h': help,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  console.error('Run `dario help` for usage.');
  process.exit(1);
}

handler().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

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

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startAutoOAuthFlow, getStatus, refreshTokens } from './oauth.js';
import { startProxy } from './proxy.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'proxy';

async function login() {
  console.log('');
  console.log('  dario — Claude Login');
  console.log('  ───────────────────');
  console.log('');

  // Check if Claude Code credentials exist
  const ccPath = join(homedir(), '.claude', '.credentials.json');
  try {
    const raw = await readFile(ccPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) {
      const expiresAt = parsed.claudeAiOauth.expiresAt;
      if (expiresAt > Date.now()) {
        console.log('  Found Claude Code credentials. Starting proxy...');
        console.log('');
        await proxy();
        return;
      }
    }
  } catch { /* no Claude Code credentials, fall through to OAuth */ }

  console.log('  No Claude Code credentials found. Starting OAuth flow...');
  console.log('');

  try {
    const tokens = await startAutoOAuthFlow();
    const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 60000);

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
    if (s.status === 'expired' && s.canRefresh) {
      console.log('  Status: Expired (will auto-refresh when proxy starts)');
      console.log('  Run `dario refresh` to refresh now, or `dario proxy` to start.');
    } else if (s.status === 'none') {
      console.log('  Status: Not authenticated');
      console.log('  Run `dario login` to authenticate.');
    } else {
      console.log(`  Status: ${s.status}`);
      console.log('  Run `dario login` to re-authenticate.');
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
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('[dario] Invalid port. Must be 1-65535.');
    process.exit(1);
  }
  const verbose = args.includes('--verbose') || args.includes('-v');
  const modelArg = args.find(a => a.startsWith('--model='));
  const model = modelArg ? modelArg.split('=')[1] : undefined;

  await startProxy({ port, verbose, model });
}

async function help() {
  console.log(`
  dario — Use your Claude subscription as an API.

  Usage:
    dario login              Detect credentials + start proxy (or run OAuth)
    dario proxy [options]    Start the API proxy server
    dario status             Check authentication status
    dario refresh            Force token refresh
    dario logout             Remove saved credentials

  Proxy options:
    --model=MODEL            Force a model for all requests
                             Shortcuts: opus, sonnet, haiku
                             Full IDs: claude-opus-4-6, claude-sonnet-4-6
                             Default: passthrough (client decides)
    --port=PORT              Port to listen on (default: 3456)
    --verbose, -v            Log all requests

  Quick start:
    dario login              # auto-detects Claude Code credentials
    dario proxy              # or: dario proxy --model=opus

  Then point any Anthropic SDK at http://localhost:3456:
    export ANTHROPIC_BASE_URL=http://localhost:3456
    export ANTHROPIC_API_KEY=dario

  Examples:
    curl http://localhost:3456/v1/messages \\
      -H "Content-Type: application/json" \\
      -H "anthropic-version: 2023-06-01" \\
      -d '{"model":"claude-opus-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

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
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Fatal error:', msg.replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]'));
  process.exit(1);
});

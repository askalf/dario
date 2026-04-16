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

// ── Bun auto-relaunch ──
// Bun's TLS fingerprint matches Claude Code's runtime (both use Bun/BoringSSL).
// If Bun is installed and we're running on Node, relaunch under Bun for
// network-level fingerprint fidelity.
if (!('Bun' in globalThis) && !process.env.DARIO_NO_BUN) {
  try {
    const { execFileSync } = await import('node:child_process');
    // Check if bun exists
    execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: 3000 });
    // Relaunch under bun
    const { spawn } = await import('node:child_process');
    const child = spawn('bun', ['run', ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, DARIO_NO_BUN: '1' },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    // Prevent this process from continuing
    await new Promise(() => {});
  } catch {
    // Bun not available, continue with Node
  }
}

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startAutoOAuthFlow, getStatus, refreshTokens, loadCredentials } from './oauth.js';
import { startProxy, sanitizeError } from './proxy.js';
import { listAccountAliases, loadAllAccounts, addAccountViaOAuth, removeAccount } from './accounts.js';
import { listBackends, saveBackend, removeBackend, type BackendCredentials } from './openai-backend.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'proxy';

async function login() {
  console.log('');
  console.log('  dario — Claude Login');
  console.log('  ───────────────────');
  console.log('');

  // Check for existing credentials (Claude Code or dario's own)
  const creds = await loadCredentials();
  if (creds?.claudeAiOauth?.accessToken && creds.claudeAiOauth.expiresAt > Date.now()) {
    console.log('  Found credentials. Starting proxy...');
    console.log('');
    await proxy();
    return;
  }

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
    console.error(`  Login failed: ${sanitizeError(err)}`);
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
    console.error(`[dario] Refresh failed: ${sanitizeError(err)}`);
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
  // Bind address — accepts --host=<addr>; falls through to DARIO_HOST env
  // var or the default of 127.0.0.1 inside startProxy. The sanity check
  // here only rejects obviously bad shapes; real address validation
  // happens when the OS tries to bind.
  const hostArg = args.find(a => a.startsWith('--host='));
  const host = hostArg ? hostArg.split('=')[1] : undefined;
  if (host !== undefined && !/^[a-zA-Z0-9._:-]+$/.test(host)) {
    console.error('[dario] Invalid --host. Must be an IP address or hostname.');
    process.exit(1);
  }
  const verbose = args.includes('--verbose') || args.includes('-v');
  const passthrough = args.includes('--passthrough') || args.includes('--thin');
  const preserveTools = args.includes('--preserve-tools') || args.includes('--keep-tools');
  const hybridTools = args.includes('--hybrid-tools') || args.includes('--context-inject');
  if (preserveTools && hybridTools) {
    console.error('[dario] --preserve-tools and --hybrid-tools are mutually exclusive. Pick one.');
    process.exit(1);
  }
  const modelArg = args.find(a => a.startsWith('--model='));
  const model = modelArg ? modelArg.split('=')[1] : undefined;

  await startProxy({ port, host, verbose, model, passthrough, preserveTools, hybridTools });
}

async function accounts() {
  const sub = args[1];

  if (!sub || sub === 'list') {
    const aliases = await listAccountAliases();
    console.log('');
    console.log('  dario — Accounts');
    console.log('  ────────────────');
    console.log('');
    if (aliases.length === 0) {
      console.log('  No multi-account pool configured.');
      console.log('');
      console.log('  Pool mode activates automatically when ~/.dario/accounts/');
      console.log('  has 2+ entries. Add the first with:');
      console.log('    dario accounts add <alias>');
      console.log('');
      console.log('  Single-account dario (the default) keeps working as-is');
      console.log('  with ~/.dario/credentials.json — you do not need to');
      console.log('  migrate unless you want pool routing across accounts.');
      console.log('');
      return;
    }

    const loaded = await loadAllAccounts();
    const now = Date.now();
    console.log(`  ${aliases.length} account${aliases.length === 1 ? '' : 's'} configured`);
    if (aliases.length === 1) {
      console.log('  (Pool mode needs 2+ accounts — single-account mode until another is added.)');
    }
    console.log('');
    for (const a of loaded) {
      const msLeft = Math.max(0, a.expiresAt - now);
      const hours = Math.floor(msLeft / 3600000);
      const mins = Math.floor((msLeft % 3600000) / 60000);
      const expiry = msLeft > 0 ? `${hours}h ${mins}m` : 'expired';
      console.log(`    ${a.alias.padEnd(20)} token expires in ${expiry}`);
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    const alias = args[2];
    if (!alias) {
      console.error('');
      console.error('  Usage: dario accounts add <alias>');
      console.error('');
      console.error('  <alias> is any label you want for the account (e.g. "work", "personal").');
      console.error('');
      process.exit(1);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
      console.error('[dario] Invalid alias. Use letters, numbers, dot, underscore, dash only.');
      process.exit(1);
    }
    const existing = await listAccountAliases();
    if (existing.includes(alias)) {
      console.error(`[dario] Account "${alias}" already exists. Remove it first with \`dario accounts remove ${alias}\`.`);
      process.exit(1);
    }
    console.log('');
    console.log(`  Adding account "${alias}" to the pool...`);
    console.log('');
    try {
      const creds = await addAccountViaOAuth(alias);
      const minutes = Math.round((creds.expiresAt - Date.now()) / 60000);
      console.log('');
      console.log(`  Account "${alias}" added.`);
      console.log(`  Token expires in ${minutes} minutes (auto-refreshes in the background).`);
      const total = (await listAccountAliases()).length;
      if (total >= 2) {
        console.log('');
        console.log('  Pool mode is now active. Restart `dario proxy` to pick up the new account.');
      } else {
        console.log('');
        console.log('  Add at least one more account to activate pool routing:');
        console.log('    dario accounts add <another-alias>');
      }
      console.log('');
    } catch (err) {
      console.error('');
      console.error(`  Failed to add account: ${sanitizeError(err)}`);
      console.error('');
      process.exit(1);
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const alias = args[2];
    if (!alias) {
      console.error('');
      console.error('  Usage: dario accounts remove <alias>');
      console.error('');
      process.exit(1);
    }
    const ok = await removeAccount(alias);
    if (ok) {
      console.log(`[dario] Account "${alias}" removed.`);
    } else {
      console.error(`[dario] No account "${alias}" found.`);
      process.exit(1);
    }
    return;
  }

  console.error(`[dario] Unknown accounts subcommand: ${sub}`);
  console.error('Usage: dario accounts [list|add <alias>|remove <alias>]');
  process.exit(1);
}

async function backend() {
  const sub = args[1];

  if (!sub || sub === 'list') {
    const all = await listBackends();
    console.log('');
    console.log('  dario — Backends');
    console.log('  ────────────────');
    console.log('');
    if (all.length === 0) {
      console.log('  No secondary backends configured.');
      console.log('');
      console.log('  Dario\'s Claude subscription path runs unchanged. To add an');
      console.log('  OpenAI-compat backend (OpenAI, OpenRouter, Groq, local LiteLLM,');
      console.log('  etc.), run:');
      console.log('    dario backend add openai --key=sk-...');
      console.log('    dario backend add openai --key=sk-... --base-url=https://api.groq.com/openai/v1');
      console.log('');
      return;
    }
    console.log(`  ${all.length} backend${all.length === 1 ? '' : 's'} configured`);
    console.log('');
    for (const b of all) {
      // Never emit any substring of the key itself — even partial
      // prefixes/suffixes (like "sk-proj-...a1b2") are leakage as
      // far as CodeQL's js/clear-text-logging rule is concerned, and
      // it's right: partial disclosure is still disclosure. Name and
      // baseUrl together are enough to identify a backend.
      console.log(`    ${b.name.padEnd(16)} ${b.provider.padEnd(10)} ${b.baseUrl.padEnd(40)} ***`);
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    const name = args[2];
    if (!name || name.startsWith('--')) {
      console.error('');
      console.error('  Usage: dario backend add <name> --key=<api-key> [--base-url=<url>]');
      console.error('');
      console.error('  Examples:');
      console.error('    dario backend add openai --key=sk-proj-...');
      console.error('    dario backend add groq   --key=gsk_... --base-url=https://api.groq.com/openai/v1');
      console.error('    dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1');
      console.error('');
      process.exit(1);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      console.error('[dario] Invalid backend name. Use letters, numbers, dot, underscore, dash only.');
      process.exit(1);
    }

    const keyArg = args.find(a => a.startsWith('--key='));
    const baseUrlArg = args.find(a => a.startsWith('--base-url='));
    const apiKey = keyArg ? keyArg.split('=').slice(1).join('=') : '';
    const baseUrl = baseUrlArg ? baseUrlArg.split('=').slice(1).join('=') : 'https://api.openai.com/v1';

    if (!apiKey) {
      console.error('[dario] --key=<api-key> is required.');
      process.exit(1);
    }

    const creds: BackendCredentials = {
      provider: 'openai',  // v3.6.0: only openai-compat backends are supported
      name,
      apiKey,
      baseUrl,
    };

    await saveBackend(creds);
    console.log('');
    console.log(`  Backend "${name}" added (openai-compat, ${baseUrl}).`);
    console.log('  Restart \`dario proxy\` to pick up the new routing.');
    console.log('');
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const name = args[2];
    if (!name) {
      console.error('');
      console.error('  Usage: dario backend remove <name>');
      console.error('');
      process.exit(1);
    }
    const ok = await removeBackend(name);
    if (ok) {
      console.log(`[dario] Backend "${name}" removed.`);
    } else {
      console.error(`[dario] No backend "${name}" found.`);
      process.exit(1);
    }
    return;
  }

  console.error(`[dario] Unknown backend subcommand: ${sub}`);
  console.error('Usage: dario backend [list|add <name> --key=...|remove <name>]');
  process.exit(1);
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
    dario accounts list      List accounts in the multi-account pool
    dario accounts add NAME  Add a new account to the pool (runs OAuth flow)
    dario accounts remove N  Remove an account from the pool
    dario backend list       List configured OpenAI-compat backends
    dario backend add NAME --key=sk-... [--base-url=...]
                             Add an OpenAI-compat backend (OpenAI, OpenRouter, Groq, etc.)
    dario backend remove N   Remove an OpenAI-compat backend
    dario shim -- CMD ARGS   Run CMD inside the dario shim (experimental,
                             stealth fingerprint via in-process fetch patch)
    dario doctor             Print a health report: dario / Node / CC /
                             template / drift / OAuth / pool / backends

  Proxy options:
    --model=MODEL            Force a model for all requests
                             Shortcuts: opus, sonnet, haiku
                             Full IDs: claude-opus-4-6, claude-sonnet-4-6
                             Provider prefix: openai:gpt-4o, groq:llama-3.3-70b,
                             claude:opus, local:qwen-coder (forces backend)
                             Default: passthrough (client decides)
    --passthrough, --thin    Thin proxy — OAuth swap only, no injection
    --preserve-tools         Forward client tool schemas unchanged
                             Loses subscription routing; use for custom agents
    --hybrid-tools           Remap to CC tools, inject sessionId/requestId/etc.
                             Keeps subscription routing for custom agents
    --port=PORT              Port to listen on (default: 3456)
    --host=ADDRESS           Address to bind to (default: 127.0.0.1)
                             Use 0.0.0.0 for LAN; see README for DARIO_API_KEY
    --verbose, -v            Log all requests

  Quick start:
    dario login              # auto-detects Claude Code credentials
    dario proxy --model=opus # or: dario proxy --passthrough

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

async function shim() {
  // dario shim -- <command> [args...]
  // The `--` separator is conventional but optional; if the user omits it
  // we just pass everything after `shim` through to the child.
  const rest = args.slice(1);
  const sepIdx = rest.indexOf('--');
  let verbose = false;
  let head: string[];
  let childArgs: string[];
  if (sepIdx >= 0) {
    head = rest.slice(0, sepIdx);
    childArgs = rest.slice(sepIdx + 1);
  } else {
    head = [];
    childArgs = rest;
  }
  for (const flag of head) {
    if (flag === '-v' || flag === '--verbose') verbose = true;
    else {
      console.error(`Unknown shim flag: ${flag}`);
      process.exit(1);
    }
  }
  if (childArgs.length === 0) {
    console.error('Usage: dario shim [-v] -- <command> [args...]');
    console.error('Example: dario shim -- claude --print -p "hi"');
    process.exit(1);
  }

  const { runShim } = await import('./shim/host.js');
  try {
    const result = await runShim({
      command: childArgs[0]!,
      args: childArgs.slice(1),
      verbose,
    });
    if (verbose) {
      const summary = result.analytics.summary(60);
      console.error(`[dario shim] ${result.events.length} relay events, ` +
        `subscriptionPercent=${summary.window.subscriptionPercent}%`);
    }
    process.exit(result.exitCode);
  } catch (err) {
    console.error('shim failed:', sanitizeError(err));
    process.exit(1);
  }
}

async function doctor() {
  const { runChecks, formatChecks, exitCodeFor } = await import('./doctor.js');
  console.log('');
  console.log('  dario — Doctor');
  console.log('  ─────────────');
  console.log('');
  const checks = await runChecks();
  console.log(formatChecks(checks));
  console.log('');
  const code = exitCodeFor(checks);
  if (code !== 0) {
    console.log('  One or more checks failed. Address the [FAIL] rows and re-run `dario doctor`.');
    console.log('');
  }
  process.exit(code);
}

async function version() {
  try {
    const { fileURLToPath } = await import('node:url');
    const { readFile: rf } = await import('node:fs/promises');
    const dir = join(fileURLToPath(import.meta.url), '..', '..');
    const pkg = JSON.parse(await rf(join(dir, 'package.json'), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

// Main
const commands: Record<string, () => Promise<void>> = {
  login,
  status,
  proxy,
  refresh,
  logout,
  accounts,
  backend,
  shim,
  doctor,
  help,
  version,
  '--help': help,
  '-h': help,
  '--version': version,
  '-V': version,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  console.error('Run `dario help` for usage.');
  process.exit(1);
}

handler().catch(err => {
  console.error('Fatal error:', sanitizeError(err));
  process.exit(1);
});

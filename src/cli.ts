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
import { startAutoOAuthFlow, startManualOAuthFlow, detectHeadlessEnvironment, getStatus, refreshTokens, loadCredentials } from './oauth.js';
import { startProxy, sanitizeError } from './proxy.js';
import { VALID_EFFORT_VALUES, type EffortValue } from './cc-template.js';
import { listAccountAliases, loadAllAccounts, addAccountViaOAuth, removeAccount, ensureLoginCredentialsInPool, MIGRATED_LOGIN_ALIAS } from './accounts.js';
import { listBackends, saveBackend, removeBackend, type BackendCredentials } from './openai-backend.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'proxy';

async function login() {
  console.log('');
  console.log('  dario — Claude Login');
  console.log('  ───────────────────');
  console.log('');

  const manualFlag = args.includes('--manual') || args.includes('--headless');

  // Check for existing credentials (Claude Code or dario's own)
  const creds = await loadCredentials();
  if (creds?.claudeAiOauth?.accessToken && creds.claudeAiOauth.expiresAt > Date.now()) {
    console.log('  Found credentials. Starting proxy...');
    console.log('');
    await proxy();
    return;
  }

  // Credentials exist but are expired — try refresh before falling through
  // to a fresh OAuth flow. Without this, dario silently burned every
  // fresh-login attempt (surfaced by dario #42 when Anthropic's authorize
  // endpoint started rejecting the 6-scope list and `dario login` kept
  // reporting "No credentials found" even though refresh would have worked).
  if (creds?.claudeAiOauth?.refreshToken) {
    console.log('  Existing credentials expired — attempting token refresh...');
    try {
      const tokens = await refreshTokens();
      const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 60000);
      console.log(`  Refresh successful! Token expires in ${expiresIn} minutes.`);
      console.log('');
      console.log('  Run `dario proxy` to start the API proxy.');
      console.log('');
      return;
    } catch (err) {
      console.log(`  Refresh failed (${sanitizeError(err)}). Starting fresh OAuth flow...`);
      console.log('');
    }
  } else {
    console.log('  No Claude Code credentials found. Starting OAuth flow...');
    console.log('');
  }

  // If the user didn't explicitly pick `--manual`, surface a hint when
  // heuristics suggest the local-callback flow won't work (SSH session,
  // container). We don't auto-flip — false positives would be more
  // annoying than false negatives — but the hint keeps users from
  // waiting for a browser redirect that can't land.
  if (!manualFlag) {
    const reason = detectHeadlessEnvironment();
    if (reason) {
      console.log(`  Note: ${reason}. If the browser redirect doesn't land,`);
      console.log('  re-run with: dario login --manual');
      console.log('');
    }
  }

  try {
    const tokens = manualFlag ? await startManualOAuthFlow() : await startAutoOAuthFlow();
    const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 60000);

    console.log('  Login successful!');
    console.log(`  Token expires in ${expiresIn} minutes (auto-refreshes).`);
    console.log('');
    console.log('  Run `dario proxy` to start the API proxy.');
    console.log('');
  } catch (err) {
    const msg = sanitizeError(err);
    console.error('');
    console.error(`  Login failed: ${msg}`);
    if (!manualFlag && /callback server|EADDRINUSE|bind|timed out/i.test(msg)) {
      console.error('  Hint: try `dario login --manual` for headless / container setups.');
    } else {
      console.error('  Try again with `dario login`.');
    }
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
  // --verbose=2 / -vv / DARIO_LOG_BODIES=1 → emit redacted request bodies
  // on every POST. -v alone is unchanged (one-line per-request summary).
  // dario#40 (ringge asked for a body-dump mode when debugging client
  // compatibility without having to attach a MITM).
  const verboseBodies =
    args.includes('-vv')
    || args.includes('--verbose=2')
    || process.env.DARIO_LOG_BODIES === '1';
  const verbose = verboseBodies || args.includes('--verbose') || args.includes('-v');
  const passthrough = args.includes('--passthrough') || args.includes('--thin');
  const preserveTools = args.includes('--preserve-tools') || args.includes('--keep-tools');
  const hybridTools = args.includes('--hybrid-tools') || args.includes('--context-inject');
  if (preserveTools && hybridTools) {
    console.error('[dario] --preserve-tools and --hybrid-tools are mutually exclusive. Pick one.');
    process.exit(1);
  }
  // Opt-out for v3.19.3's text-tool-client auto-detection. Operators who
  // want the full CC fingerprint restored (tools array included) even
  // when Cline/Kilo/Roo is detected can pass --no-auto-detect; they keep
  // explicit control with --preserve-tools per session. dario#40 (ringge).
  const noAutoDetect = args.includes('--no-auto-detect') || args.includes('--no-auto-preserve');
  // --strict-tls refuses to start proxy mode when the process's TLS stack
  // doesn't match Claude Code's (i.e. we're on Node without Bun). Opt-in
  // hard guardrail for operators who want certainty that the JA3 the
  // proxy presents to Anthropic is Bun's BoringSSL ClientHello, not
  // Node's OpenSSL one. v3.23 (direction #3).
  const strictTls = args.includes('--strict-tls');
  const modelArg = args.find(a => a.startsWith('--model='));
  const model = modelArg ? modelArg.split('=')[1] : undefined;

  // --pace-min=MS / --pace-jitter=MS (v3.24, direction #6 — behavioral
  // smoothing). Inter-request gap floor + optional uniform-random jitter.
  // Defaults preserve v3.23 behavior (500ms floor, no jitter). The pure
  // calc lives in src/pacing.ts; the flags just feed it.
  const pacingMinMs = parsePositiveIntFlag('--pace-min=');
  const pacingJitterMs = parsePositiveIntFlag('--pace-jitter=');

  // --drain-on-close (v3.25, direction #5). When set, a client
  // disconnect no longer aborts the upstream SSE — dario keeps
  // draining the stream to EOF so Anthropic sees the CC-shaped
  // read-to-completion pattern. Costs tokens (the response is fully
  // generated even if nobody reads it), so it's opt-in.
  const drainOnClose = args.includes('--drain-on-close') || undefined;

  // --session-* knobs (v3.28, direction #1). Control the single-account
  // session-id lifecycle: idle threshold, jitter on that threshold, hard
  // max-age, and whether to give each upstream client its own session.
  // All defaults preserve v3.27 behaviour exactly. Logic lives in
  // src/session-rotation.ts; these flags just feed resolveSessionRotationConfig.
  const sessionIdleRotateMs = parsePositiveIntFlag('--session-idle-rotate=');
  const sessionRotateJitterMs = parsePositiveIntFlag('--session-rotate-jitter=');
  const sessionMaxAgeMs = parsePositiveIntFlag('--session-max-age=');
  const sessionPerClient = args.includes('--session-per-client') || undefined;

  // --preserve-orchestration-tags (bare OR =tag1,tag2,...) — opt-out for
  // workflows that legitimately need <system-reminder>, <thinking>, etc.
  // preserved on the wire. Default behaviour unchanged (strip all).
  // dario#78 (Gemini review push-back). Env mirror:
  //   DARIO_PRESERVE_ORCHESTRATION_TAGS=*           (preserve all)
  //   DARIO_PRESERVE_ORCHESTRATION_TAGS=thinking,env (preserve listed)
  const preserveOrchestrationTags = resolvePreserveOrchestrationTags(args, process.env['DARIO_PRESERVE_ORCHESTRATION_TAGS']);

  // --no-live-capture / --strict-template — template fail-closed knobs.
  // Convergent push-back from Grok + GPT in reviews/: drift resilience
  // should be opt-in-verifiable, not silently best-effort. dario#77.
  //   --no-live-capture   → skip the background CC capture entirely, use
  //                         the bundled snapshot; for air-gapped / CI.
  //   --strict-template   → refuse to start if the loaded template is
  //                         bundled (no live capture) or drifted from
  //                         the installed CC; same shape as --strict-tls.
  const noLiveCapture = args.includes('--no-live-capture')
    || parseBooleanEnv(process.env['DARIO_NO_LIVE_CAPTURE'])
    || undefined;
  const strictTemplate = args.includes('--strict-template')
    || parseBooleanEnv(process.env['DARIO_STRICT_TEMPLATE'])
    || undefined;

  // --max-concurrent=N / --max-queued=N / --queue-timeout=MS — bounded
  // request queue knobs (dario#80). Defaults preserve v3.30.x-and-earlier
  // behaviour for typical single-user workloads; tune up for high-fan-out
  // agent setups that otherwise hit dario-level 429s before upstream.
  const maxConcurrent = parsePositiveIntFlag('--max-concurrent=')
    ?? parsePositiveIntEnv(process.env['DARIO_MAX_CONCURRENT']);
  const maxQueued = parsePositiveIntFlag('--max-queued=')
    ?? parsePositiveIntEnv(process.env['DARIO_MAX_QUEUED']);
  const queueTimeoutMs = parsePositiveIntFlag('--queue-timeout=')
    ?? parsePositiveIntEnv(process.env['DARIO_QUEUE_TIMEOUT_MS']);

  // --effort=low|medium|high|xhigh|client — override the outbound
  // output_config.effort (dario#87). Default (unset) pins 'high' to match
  // CC 2.1.116's wire value. 'client' passes through whatever the client
  // sent, falling back to 'high' if the client didn't include one.
  //
  // Risk: setting effort to a non-CC-default value may cause Anthropic's
  // classifier to flip requests to 'overage' billing. Users opting in
  // should watch the `representative-claim` response header via -v logs
  // and revert to default if subscription billing breaks.
  const effort = resolveEffortFlag(args, process.env['DARIO_EFFORT']);

  // --max-tokens=<N|client> — override outbound max_tokens (dario#88,
  // Hermes compat). Default unset pins 32000 (CC 2.1.116's wire default).
  // 'client' passes through whatever the client sent (Hermes requests up
  // to 128k for Opus 4.7, 64k for Sonnet — default pin silently truncates
  // their output capacity). Anthropic enforces a per-model ceiling on
  // the server side, so passing through a too-high value returns a clean
  // 400 rather than silently accepting beyond-model-max.
  const maxTokens = resolveMaxTokensFlag(args, process.env['DARIO_MAX_TOKENS']);

  // Non-loopback bind without DARIO_API_KEY turns dario into an open
  // OAuth-subscription relay for anyone on the reachable network. Refuse
  // to start rather than rely on the operator to read the startup banner.
  // Escape hatch: --unsafe-no-auth for the rare "I know what I'm doing"
  // case (local-trusted LAN, temporary debug, etc.). dario#74.
  const resolvedHost = host ?? process.env['DARIO_HOST'] ?? '127.0.0.1';
  const isLoopback = resolvedHost === '127.0.0.1'
    || resolvedHost === 'localhost'
    || resolvedHost === '::1';
  const hasApiKey = typeof process.env['DARIO_API_KEY'] === 'string'
    && process.env['DARIO_API_KEY'].length > 0;
  const unsafeNoAuth = args.includes('--unsafe-no-auth');
  if (!isLoopback && !hasApiKey && !unsafeNoAuth) {
    console.error(`[dario] Refusing to start proxy: --host=${resolvedHost} is non-loopback but DARIO_API_KEY is not set.`);
    console.error(`[dario] Exposing dario on a non-loopback address without DARIO_API_KEY turns it into an open OAuth-subscription relay for any host that can reach the port.`);
    console.error(`[dario] Fix: set DARIO_API_KEY=<secret> in the environment, or bind to --host=127.0.0.1 (the default).`);
    console.error(`[dario] Override (not recommended): pass --unsafe-no-auth if you have out-of-band network controls and accept the risk.`);
    process.exit(1);
  }

  await startProxy({ port, host, verbose, verboseBodies, model, passthrough, preserveTools, hybridTools, noAutoDetect, strictTls, pacingMinMs, pacingJitterMs, drainOnClose, sessionIdleRotateMs, sessionRotateJitterMs, sessionMaxAgeMs, sessionPerClient, preserveOrchestrationTags, noLiveCapture, strictTemplate, maxConcurrent, maxQueued, queueTimeoutMs, effort, maxTokens });
}

/**
 * Parse `--max-tokens=<N|client>` + `DARIO_MAX_TOKENS` env (dario#88).
 * Numeric values pin; `client` (case-insensitive) = passthrough client's
 * max_tokens; unset = dario's default pin applies. Invalid values exit
 * non-zero with guidance. Exported for tests.
 */
export function resolveMaxTokensFlag(args: string[], env: string | undefined): number | 'client' | undefined {
  const withValue = args.find(a => a.startsWith('--max-tokens='));
  const raw = withValue ? withValue.slice('--max-tokens='.length) : env;
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.trim();
  if (normalized.toLowerCase() === 'client') return 'client';
  const n = Number.parseInt(normalized, 10);
  if (Number.isFinite(n) && n > 0) return n;
  console.error(`[dario] Invalid --max-tokens value: ${JSON.stringify(raw)}. Must be a positive integer or the literal "client".`);
  process.exit(1);
}

/**
 * Parse the `--effort` flag + `DARIO_EFFORT` env. Validates against the
 * allowed set; unrecognised values cause a non-zero exit with the list of
 * valid choices (same philosophy as other strict parsers in this CLI).
 * Flag value wins over env. Exported for tests. dario#87.
 */
export function resolveEffortFlag(args: string[], env: string | undefined): EffortValue | undefined {
  const withValue = args.find(a => a.startsWith('--effort='));
  const raw = withValue ? withValue.slice('--effort='.length) : env;
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  if ((VALID_EFFORT_VALUES as ReadonlyArray<string>).includes(normalized)) {
    return normalized as EffortValue;
  }
  console.error(`[dario] Invalid --effort value: ${JSON.stringify(raw)}. Must be one of: ${VALID_EFFORT_VALUES.join(', ')}.`);
  process.exit(1);
}

/**
 * Parse a positive-integer env var. Returns undefined on unset, empty,
 * non-numeric, or non-positive values so the caller's default applies.
 * Sibling of parsePositiveIntFlag; exported for tests + used by the
 * dario#80 queue env mirrors.
 */
export function parsePositiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Parse a boolean env var. Accepts "1", "true", "yes", "on" (case-insensitive)
 * as truthy; everything else (including unset) is undefined/false. Exported
 * for tests. Used by dario#77 DARIO_STRICT_TEMPLATE / DARIO_NO_LIVE_CAPTURE
 * and any future boolean env mirror.
 */
export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  return undefined;
}

/**
 * Parse --preserve-orchestration-tags (bare or =value) + env mirror.
 * Exported for tests.
 * dario#78.
 *
 *   undefined              — flag not passed + env unset → strip all (default)
 *   Set(['*'])             — flag bare OR value "*"      → preserve all
 *   Set(['thinking','env']) — value "thinking,env"        → preserve listed
 */
export function resolvePreserveOrchestrationTags(
  args: string[],
  env: string | undefined,
): Set<string> | undefined {
  // Explicit --preserve-orchestration-tags=value wins over everything.
  const withValue = args.find(a => a.startsWith('--preserve-orchestration-tags='));
  if (withValue) return parsePreserveTagsValue(withValue.split('=').slice(1).join('='));
  // Bare flag = preserve all.
  if (args.includes('--preserve-orchestration-tags')) return new Set(['*']);
  // Env mirror — explicit flag always wins, checked last.
  if (env !== undefined) return parsePreserveTagsValue(env);
  return undefined;
}

function parsePreserveTagsValue(value: string): Set<string> {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '*') return new Set(['*']);
  return new Set(trimmed.split(',').map(s => s.trim()).filter(Boolean));
}

function parsePositiveIntFlag(prefix: string): number | undefined {
  const found = args.find(a => a.startsWith(prefix));
  if (!found) return undefined;
  const raw = found.slice(prefix.length);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[dario] Invalid ${prefix.replace(/=$/, '')} value: ${JSON.stringify(raw)}. Must be a non-negative integer (ms).`);
    process.exit(1);
  }
  return n;
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

    // If the user has `dario login` credentials on disk or in the keychain
    // and the pool is empty, migrate those credentials into the pool first.
    // Otherwise the new account lives alone in accounts/, pool mode never
    // trips the 2+ threshold, and the login account is orphaned from the
    // pool until the user figures out they have to re-`accounts add` it.
    // Skip silently when the user explicitly picks the reserved alias —
    // their intent wins, they can run `accounts add` again for the login
    // migration under a different alias.
    if (existing.length === 0 && alias !== MIGRATED_LOGIN_ALIAS) {
      const migrated = await ensureLoginCredentialsInPool();
      if (migrated) {
        console.log('');
        console.log(`  Migrated your existing \`dario login\` account into the pool as "${migrated}".`);
        console.log(`  (Pool mode activates on 2+ accounts — this back-fill plus "${alias}" crosses that.)`);
      }
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
    dario login [--manual]   Detect credentials + start proxy (or run OAuth)
                             --manual (alias: --headless) for container / SSH
                             setups — prints an authorize URL and reads the
                             code you paste back instead of a local redirect
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
    dario subagent install   Register ~/.claude/agents/dario.md so Claude Code
                             can delegate dario diagnostics / template-refresh
                             operations to a named sub-agent (v3.26)
    dario subagent remove    Remove the registered sub-agent file
    dario subagent status    Show whether the sub-agent is installed
    dario mcp                Run dario as an MCP (Model Context Protocol)
                             server on stdio. Exposes read-only tools
                             (doctor, status, accounts_list, backends_list,
                             subagent_status, fingerprint_info) so MCP
                             clients (Claude Desktop, IDEs, etc.) can
                             inspect dario's state. No destructive ops
                             are exposed — mutations still require the
                             CLI. (v3.27)
    dario doctor             Print a health report: dario / Node / CC /
                             template / drift / OAuth / pool / backends
    dario doctor --probe     Also hit Anthropic's authorize endpoint with
                             dario's effective OAuth config and surface
                             the server's verdict — the single reliable
                             signal for scope-policy drift (dario#42/#71
                             class). One GET to claude.ai; no PII.
    dario doctor --json      Emit the check report as structured JSON
                             for machine consumption (claude-bridge
                             /status, CI scripts, etc.) instead of the
                             human-readable table.
    dario doctor --auth-check
                             One-shot listener on an ephemeral loopback
                             port. Send ONE request from your client
                             (OpenClaw, Hermes, curl, etc.) and dario
                             classifies the auth headers it sees against
                             DARIO_API_KEY — with redacted previews and
                             a targeted diagnosis (dario#97 class). Use
                             --timeout-ms=N to adjust the 30s default.
    dario config             Print the effective configuration (port,
                             host, DARIO_API_KEY state, OAuth status,
                             pool, backends, paths) with credentials
                             redacted. Safe to paste into bug reports.
                             --json for structured output.
    dario upgrade            npm install -g @askalf/dario@latest with a
                             pre-flight current-vs-latest check.

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
    --no-auto-detect         Disable Cline/Kilo/Roo auto-preserve-tools
                             (v3.19.3 behavior). Keeps CC fingerprint
                             intact even when a text-tool client is
                             detected; use --preserve-tools per session
                             when edits are needed. (dario#40)
    --strict-tls             Refuse to start proxy mode if this process
                             isn't running under Bun. Bun is what Claude
                             Code uses; matching its TLS stack keeps the
                             proxy's JA3/JA4 ClientHello indistinguishable
                             from a stock CC request. Install Bun
                             (https://bun.sh) so dario auto-relaunches
                             under it, or use shim mode. (v3.23)
    --pace-min=MS            Minimum ms between upstream requests
                             (default: 500). Prevents request floods
                             that are distinguishable from human-paced
                             CC traffic.
    --pace-jitter=MS         Max additional uniform-random jitter (ms)
                             added on top of --pace-min per request.
                             Default: 0 (off). Set to e.g. 300 to hide
                             the floor from long-run inter-arrival
                             statistics. (v3.24)
    --drain-on-close         When the client disconnects mid-stream,
                             keep consuming the upstream SSE to EOF
                             so Anthropic sees the same read-to-
                             completion pattern native Claude Code
                             produces. Trades tokens (the response
                             is fully generated even if nobody reads
                             it) for fingerprint fidelity. Bounded by
                             the 5-minute upstream timeout. (v3.25)
    --session-idle-rotate=MS Idle ms before the single-account session
                             id rotates (default: 900000 = 15 min).
                             Real CC rotates once per conversation, not
                             per call; the default matches its observed
                             cadence. Pool mode is unaffected. (v3.28)
    --session-rotate-jitter=MS
                             Max additional uniform-random jitter (ms)
                             added to the idle threshold, sampled once
                             per session at creation. Default: 0 (off).
                             Hides the exact threshold from long-run
                             rotation statistics. (v3.28)
    --session-max-age=MS     Hard cap on a session id's lifetime
                             regardless of activity. Default: off. Set
                             for always-on pipelines where an idle
                             window would never trigger. (v3.28)
    --session-per-client     Give each upstream client (keyed by
                             x-session-id / x-client-session-id
                             header) its own rotated session id.
                             Default: off (single session across all
                             clients, v3.27 behaviour). (v3.28)
    --preserve-orchestration-tags[=TAG,TAG]
                             Opt specific orchestration wrapper tags
                             (<system-reminder>, <env>, <thinking>,
                             etc.) out of the scrub. Bare flag =
                             preserve all. Value form = preserve only
                             those listed; everything else is still
                             stripped. Default: strip every tag in
                             ORCHESTRATION_TAG_NAMES. Env mirror:
                             DARIO_PRESERVE_ORCHESTRATION_TAGS=*
                             or =tag1,tag2. (v3.30.7, dario#78)
    --no-live-capture        Skip the background live-fingerprint
                             refresh entirely. dario uses the bundled
                             snapshot and will NOT spawn the installed
                             Claude Code binary. For air-gapped /
                             reproducible-build / CI-harness runs.
                             Env: DARIO_NO_LIVE_CAPTURE=1.
                             (v3.30.8, dario#77)
    --strict-template        Refuse to start if the loaded template
                             is the bundled snapshot (no live capture
                             ever succeeded) or drifts from the
                             installed CC version. Same philosophy
                             as --strict-tls: make the unsafe state
                             require intent. Env: DARIO_STRICT_TEMPLATE=1.
                             (v3.30.8, dario#77)
    --max-concurrent=N       Max in-flight requests (default: 10).
                             Env: DARIO_MAX_CONCURRENT. (dario#80)
    --max-queued=N           Max requests buffered waiting for a
                             concurrency slot before dario returns
                             429 "queue-full" (default: 128).
                             Env: DARIO_MAX_QUEUED. (dario#80)
    --queue-timeout=MS       Max ms a queued request waits before
                             dario returns 504 "queue-timeout"
                             (default: 60000).
                             Env: DARIO_QUEUE_TIMEOUT_MS. (dario#80)
    --effort=<low|medium|high|xhigh|client>
                             Override the outbound output_config.effort
                             on non-haiku requests. Default (unset)
                             pins 'high' — matches CC 2.1.116's wire
                             value. 'client' passes through what the
                             client sent (falls back to 'high' if none).
                             WARNING: non-'high' values may cause
                             Anthropic's classifier to flip requests
                             to 'overage' billing; watch -v logs for
                             representative-claim changes.
                             Env: DARIO_EFFORT. (dario#87)
    --max-tokens=<N|client>  Override outbound max_tokens. Default
                             (unset) pins 32000 (CC 2.1.116 wire default).
                             Set a number to pin that value; set 'client'
                             to pass through the client's requested
                             max_tokens (Hermes requests 64k–128k; the
                             default pin silently truncates its output
                             capacity). Anthropic enforces the per-model
                             ceiling server-side, so too-high values
                             return a clean 400.
                             Env: DARIO_MAX_TOKENS. (dario#88)
    --port=PORT              Port to listen on (default: 3456)
    --host=ADDRESS           Address to bind to (default: 127.0.0.1)
                             Use 0.0.0.0 for LAN; see README for DARIO_API_KEY
    --verbose, -v            Log all requests
    --verbose=2, -vv         Also dump redacted request bodies
                             (env: DARIO_LOG_BODIES=1)

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

async function subagent() {
  const sub = args[1] ?? 'status';
  const { installSubagent, removeSubagent, loadSubagentStatus, SUBAGENT_NAME } = await import('./subagent.js');

  if (sub === 'install') {
    const r = installSubagent();
    console.log('');
    console.log('  dario — Sub-agent install');
    console.log('  ─────────────────────────');
    console.log('');
    if (r.action === 'unchanged') {
      console.log(`  Already up to date at ${r.path} (v${r.version}).`);
    } else {
      console.log(`  ${r.action === 'created' ? 'Installed' : 'Updated'} at ${r.path} (v${r.version}).`);
    }
    console.log('');
    console.log('  Claude Code will pick up the new sub-agent on its next startup.');
    console.log(`  Invoke it from CC with: "Use the ${SUBAGENT_NAME} sub-agent to …"`);
    console.log('');
    return;
  }

  if (sub === 'remove' || sub === 'uninstall') {
    const r = removeSubagent();
    console.log('');
    console.log('  dario — Sub-agent remove');
    console.log('  ────────────────────────');
    console.log('');
    if (r.removed) {
      console.log(`  Removed ${r.path}.`);
    } else {
      console.log(`  Nothing to remove — ${r.path} was not present.`);
    }
    console.log('');
    return;
  }

  if (sub === 'status') {
    const s = loadSubagentStatus();
    console.log('');
    console.log('  dario — Sub-agent status');
    console.log('  ────────────────────────');
    console.log('');
    console.log(`  Path:             ${s.path}`);
    console.log(`  ~/.claude/agents: ${s.agentsDirExists ? 'exists' : 'missing (Claude Code not installed?)'}`);
    if (!s.installed) {
      console.log('  Installed:        no');
      console.log('');
      console.log('  Install with: dario subagent install');
    } else {
      console.log(`  Installed:        yes (v${s.fileVersion ?? 'unknown'})`);
      if (!s.current) {
        console.log('  Note:             file version does not match installed dario — run `dario subagent install` to refresh.');
      }
    }
    console.log('');
    return;
  }

  console.error('');
  console.error('  Usage: dario subagent <install | remove | status>');
  console.error('');
  console.error('  install   Write ~/.claude/agents/dario.md so Claude Code can');
  console.error('            delegate dario diagnostics to a named sub-agent.');
  console.error('  remove    Remove the installed sub-agent file.');
  console.error('  status    Report whether the sub-agent is installed (default).');
  console.error('');
  process.exit(1);
}

async function mcp() {
  // MCP-over-stdio: protocol frames on stdout ONLY. Any stray console.log
  // from downstream modules (doctor / oauth / accounts helpers) would
  // corrupt the frame stream, so redirect them to stderr defensively for
  // the lifetime of the server. Restored in the finally block for tests /
  // embedders that re-use the process after `dario mcp`.
  const origLog = console.log;
  const origInfo = console.info;
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = (...a: unknown[]) => console.error(...a);
  try {
    const [{ buildDefaultToolRegistry }, { runMcpServer }] = await Promise.all([
      import('./mcp/tools.js'),
      import('./mcp/server.js'),
    ]);
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const here = join(fileURLToPath(import.meta.url), '..', '..');
    let pkgVersion = 'unknown';
    try {
      const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf-8'));
      if (typeof pkg.version === 'string') pkgVersion = pkg.version;
    } catch {
      // package.json missing or malformed — fall back to 'unknown' but let
      // the server keep running so tool responses are still usable.
    }
    const tools = await buildDefaultToolRegistry();
    await runMcpServer({
      tools,
      server: { name: 'dario', version: pkgVersion },
    });
  } finally {
    console.log = origLog;
    console.info = origInfo;
  }
}

async function doctor() {
  const { runChecks, formatChecks, formatChecksJson, exitCodeFor, runAuthCheck } = await import('./doctor.js');
  const probe = args.includes('--probe');
  const asJson = args.includes('--json');
  const authCheck = args.includes('--auth-check');

  if (authCheck) {
    console.log('');
    console.log('  dario — Auth Check');
    console.log('  ──────────────────');
    console.log('');
    const timeoutArg = args.find((a) => a.startsWith('--timeout-ms='));
    const timeoutMs = timeoutArg ? Math.max(1000, parseInt(timeoutArg.split('=')[1]!, 10)) : 30_000;
    const result = await runAuthCheck({
      timeoutMs,
      onListening: (port) => {
        console.log(`  Listening on http://127.0.0.1:${port}/`);
        console.log(`  Waiting up to ${Math.round(timeoutMs / 1000)}s for ONE request from your client.`);
        console.log('  Any path and method are fine — dario only inspects the auth headers.');
        console.log('');
      },
    });
    console.log(`  Verdict:   ${result.verdict}`);
    console.log(`  Expected:  ${result.expected === '<unset>' ? '(unset)' : 'Bearer <key>  (DARIO_API_KEY matches)'}`);
    if (result.received) {
      const seen: string[] = [];
      if (result.authorization?.present) seen.push(`Authorization: ${result.authorization.redacted}${result.authorization.bearerPrefix === false ? ' (no Bearer prefix)' : ''}`);
      if (result.xApiKey?.present) seen.push(`x-api-key: ${result.xApiKey.redacted}`);
      console.log(`  Received:  ${seen.length > 0 ? seen.join(', ') : 'no auth headers'}`);
    } else {
      console.log(`  Received:  (no request within ${Math.round(timeoutMs / 1000)}s)`);
    }
    console.log('');
    console.log('  ' + result.diagnosis);
    console.log('');
    process.exit(result.verdict === 'match' ? 0 : 1);
  }

  const checks = await runChecks({ probe });
  if (asJson) {
    // JSON mode is meant for machine consumption (claude-bridge /status,
    // deepdive health checks, CI scripts) — no decorative header, no
    // trailing prose, stable shape. Exit code is also surfaced in the
    // JSON envelope for callers that can't read process exit codes.
    process.stdout.write(formatChecksJson(checks) + '\n');
    process.exit(exitCodeFor(checks));
  }
  console.log('');
  console.log('  dario — Doctor');
  console.log('  ─────────────');
  console.log('');
  console.log(formatChecks(checks));
  console.log('');
  const code = exitCodeFor(checks);
  if (code !== 0) {
    console.log('  One or more checks failed. Address the [FAIL] rows and re-run `dario doctor`.');
    if (!probe) {
      console.log('  For a live check against Anthropic\'s authorize endpoint, re-run with `--probe`.');
    }
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

async function config() {
  const { collectEffectiveConfig, formatEffectiveConfig, formatEffectiveConfigJson } = await import('./config-report.js');
  const asJson = args.includes('--json');
  const report = await collectEffectiveConfig();
  if (asJson) {
    process.stdout.write(formatEffectiveConfigJson(report) + '\n');
    return;
  }
  console.log('');
  console.log('  dario — Config');
  console.log('  ─────────────');
  console.log('');
  console.log(formatEffectiveConfig(report));
}

async function upgrade() {
  // Thin wrapper over `npm install -g @askalf/dario@latest`. The value
  // isn't in saving the user typing — it's in the pre-flight (print
  // current vs. latest version, refuse to run if already on latest,
  // fail with a clear hint if npm is missing).
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { readFile: rf } = await import('node:fs/promises');
  const dir = join(fileURLToPath(import.meta.url), '..', '..');
  let currentVersion = 'unknown';
  try {
    const pkg = JSON.parse(await rf(join(dir, 'package.json'), 'utf-8'));
    currentVersion = pkg.version ?? 'unknown';
  } catch { /* noop */ }

  console.log('');
  console.log('  dario — Upgrade');
  console.log('  ──────────────');
  console.log('');
  console.log(`  Current: v${currentVersion}`);

  // Probe npm for the latest version first — avoids a long npm install if
  // the user's already on @latest. 3s timeout keeps the pre-flight short.
  let latestVersion: string | null = null;
  try {
    const res = spawnSync('npm', ['view', '@askalf/dario', 'version'], {
      encoding: 'utf8',
      timeout: 3000,
      shell: process.platform === 'win32',
    });
    if (res.status === 0) {
      const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(res.stdout);
      latestVersion = m ? m[1]! : null;
    }
  } catch { /* noop */ }

  if (!latestVersion) {
    console.log('  Latest: (npm view failed — is npm on PATH? Continuing anyway.)');
  } else {
    console.log(`  Latest:  v${latestVersion}`);
    if (latestVersion === currentVersion) {
      console.log('');
      console.log('  Already on the latest release. Nothing to do.');
      console.log('');
      return;
    }
  }

  console.log('');
  console.log('  Running: npm install -g @askalf/dario@latest');
  console.log('');

  const install = spawnSync('npm', ['install', '-g', '@askalf/dario@latest'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (install.status !== 0) {
    console.error('');
    console.error('  npm install failed. If this is a permissions issue, try:');
    console.error('    sudo npm install -g @askalf/dario@latest     # POSIX');
    console.error('    npm install -g @askalf/dario@latest          # Windows (may need admin)');
    console.error('');
    process.exit(install.status ?? 1);
  }

  console.log('');
  console.log('  Upgrade complete. Run `dario --version` to confirm.');
  console.log('');
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
  subagent,
  mcp,
  doctor,
  config,
  upgrade,
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

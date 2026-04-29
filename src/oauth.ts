/**
 * Dario — Claude OAuth Engine
 *
 * Full PKCE OAuth flow for Claude subscriptions.
 * Handles authorization, token exchange, storage, and auto-refresh.
 */

import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { detectCCOAuthConfig } from './cc-oauth-detect.js';
import { redactSecrets } from './redact.js';

// Manual-flow redirect URI. Anthropic's authorize endpoint special-cases
// this value (also baked into CC as MANUAL_REDIRECT_URL) to render the
// authorization code + state on a copy-paste success page instead of
// redirecting back to a localhost callback. Used by startManualOAuthFlow
// for container / headless / SSH installs where a local bind won't work.
const MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// OAuth config is auto-detected at runtime from the installed Claude Code
// binary. This eliminates the "Anthropic rotated the client_id again" class
// of bugs — dario stays in sync with whatever CC version the user has
// installed, forever. See cc-oauth-detect.ts for the scanner.
//
// Hardcoded fallbacks live in cc-oauth-detect.ts and are the known-good
// CC v2.1.104 local-oauth flow values.
async function getOAuthConfig() {
  return detectCCOAuthConfig();
}

// Refresh 30 min before expiry
const REFRESH_BUFFER_MS = 30 * 60 * 1000;
// After a failed refresh, don't retry for 60s to avoid spam
let lastRefreshFailure = 0;
const REFRESH_COOLDOWN_MS = 60 * 1000;

// In-memory credential cache — avoids disk reads on every request
let credentialsCache: CredentialsFile | null = null;
let credentialsCacheTime = 0;
const CACHE_TTL_MS = 10_000; // Re-read from disk every 10s at most

// Mutex to prevent concurrent refresh races
let refreshInProgress: Promise<OAuthTokens> | null = null;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface CredentialsFile {
  claudeAiOauth: OAuthTokens;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function getDarioCredentialsPath(): string {
  return join(homedir(), '.dario', 'credentials.json');
}

function getClaudeCodeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/**
 * Read Claude Code credentials from the OS keychain.
 *
 * Modern CC versions (since ~1.0.17) store OAuth tokens in the OS credential
 * store instead of ~/.claude/.credentials.json:
 *   - macOS: Keychain, service "Claude Code-credentials"
 *   - Linux: libsecret / Secret Service D-Bus API via `secret-tool`
 *   - Windows: Windows Credential Manager via PowerShell + Win32 CredEnumerate
 */
const WIN_CRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @"
using System;
using System.Runtime.InteropServices;
public class CM {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED {
    public uint Flags; public uint Type; public string TargetName;
    public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LW;
    public uint BlobSize; public IntPtr Blob;
    public uint Persist; public uint AC; public IntPtr Attrs;
    public string Alias; public string UN;
  }
  [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredEnumerate(string filter, uint flag, out uint count, out IntPtr pCredentials);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void CredFree(IntPtr cred);
}
"@
Add-Type -TypeDefinition $sig
$count = 0
$ptr = [IntPtr]::Zero
if ([CM]::CredEnumerate('Claude Code-credentials*', 0, [ref]$count, [ref]$ptr)) {
  try {
    for ($i = 0; $i -lt $count; $i++) {
      $credPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size)
      $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][CM+CRED])
      if ($cred.BlobSize -gt 0) {
        $bytes = New-Object byte[] $cred.BlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.Blob, $bytes, 0, $cred.BlobSize)
        Write-Output ([System.Text.Encoding]::Unicode.GetString($bytes))
      }
    }
  } finally {
    [CM]::CredFree($ptr)
  }
}
`;

async function loadKeychainCredentials(): Promise<CredentialsFile | null> {
  try {
    if (platform() === 'darwin') {
      const raw = await new Promise<string>((resolve, reject) => {
        execFile(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { timeout: 5000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
        );
      });
      const parsed = JSON.parse(raw);
      if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) {
        return parsed as CredentialsFile;
      }
    } else if (platform() === 'linux') {
      const raw = await new Promise<string>((resolve, reject) => {
        execFile(
          'secret-tool',
          ['lookup', 'service', 'Claude Code-credentials'],
          { timeout: 5000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
        );
      });
      const parsed = JSON.parse(raw);
      if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) {
        return parsed as CredentialsFile;
      }
    } else if (platform() === 'win32') {
      // Windows Credential Manager via PowerShell + Win32 CredEnumerate.
      // Claude Code on Windows (via Node keytar) stores OAuth tokens as
      // Generic credentials with target prefix "Claude Code-credentials".
      // We enumerate matching credentials and return the first one that
      // parses as a valid CC credentials blob. The password field is
      // stored as UTF-16LE bytes (keytar convention on Windows).
      //
      // PowerShell CredEnumerate sets LastWin32Error=1168 (ERROR_NOT_FOUND)
      // when the filter matches nothing — we catch the non-zero exit and
      // return null so the caller falls back to the file-path checks.
      const raw = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_CRED_SCRIPT],
          { timeout: 5000, windowsHide: true },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      });
      // Script emits one JSON blob per matching credential, newline-separated.
      // Return the first one that parses with the expected CC shape.
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try {
          const parsed = JSON.parse(s);
          if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) {
            return parsed as CredentialsFile;
          }
        } catch { /* not a valid JSON credential blob — try next */ }
      }
    }
  } catch { /* keychain not available or no entry */ }
  return null;
}

export async function loadCredentials(): Promise<CredentialsFile | null> {
  // Return cached if fresh
  if (credentialsCache && Date.now() - credentialsCacheTime < CACHE_TTL_MS) {
    return credentialsCache;
  }

  // Read every available source (dario file, CC file, OS keychain) and
  // pick the freshest. Previously this returned the first source that
  // had both tokens regardless of expiry — which means a stale
  // ~/.dario/credentials.json (left over from a prior `dario login`
  // whose refresh_token has since been invalidated by Anthropic) would
  // shadow CC's still-fresh ~/.claude/.credentials.json forever, with
  // no automatic recovery. Picking the freshest makes auto-detection
  // work the way it did before any `dario login` had ever run, while
  // still preferring dario's own file when both sources are equivalent
  // (dario file wins ties on expiresAt by being checked first).
  const candidates: CredentialsFile[] = [];

  for (const path of [getDarioCredentialsPath(), getClaudeCodeCredentialsPath()]) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) {
        candidates.push(parsed as CredentialsFile);
      }
    } catch { /* try next */ }
  }

  // OS keychain (modern CC stores credentials here, not on disk).
  const keychainCreds = await loadKeychainCredentials();
  if (keychainCreds?.claudeAiOauth?.accessToken && keychainCreds?.claudeAiOauth?.refreshToken) {
    candidates.push(keychainCreds);
  }

  const best = pickFreshestCredentials(candidates);
  if (!best) return null;

  credentialsCache = best;
  credentialsCacheTime = Date.now();
  return credentialsCache;
}

/**
 * Pick the freshest of a set of `CredentialsFile` candidates by
 * `expiresAt` (unix-ms timestamp; missing/zero sorts last). Stable on
 * ties — the first-pushed candidate wins when expiresAt is equal,
 * which means the canonical call order
 * `[darioFile, ccFile, keychain]` keeps the dario-file source as the
 * tiebreaker preference. Exported for direct testing.
 */
export function pickFreshestCredentials(candidates: CredentialsFile[]): CredentialsFile | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestExp = best.claudeAiOauth.expiresAt ?? 0;
  for (let i = 1; i < candidates.length; i++) {
    const exp = candidates[i]!.claudeAiOauth.expiresAt ?? 0;
    if (exp > bestExp) {
      best = candidates[i]!;
      bestExp = exp;
    }
  }
  return best;
}

async function saveCredentials(creds: CredentialsFile): Promise<void> {
  const path = getDarioCredentialsPath();
  await mkdir(dirname(path), { recursive: true });
  // Write atomically: write to temp file, then rename
  const tmpPath = `${path}.tmp.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await rename(tmpPath, path);
  // Invalidate cache so next read picks up the new tokens
  credentialsCache = creds;
  credentialsCacheTime = Date.now();
}

/**
 * Automatic OAuth flow using a local callback server (same as Claude Code).
 * Opens browser, captures the authorization code automatically.
 */
export async function startAutoOAuthFlow(): Promise<OAuthTokens> {
  const { createServer } = await import('node:http');
  const { codeVerifier, codeChallenge } = generatePKCE();
  // 32 random bytes → 43-char base64url state. See dario#71 — Anthropic's
  // authorize endpoint rejects shorter states with "Invalid request format";
  // CC v2.1.116+ ships 32. Keep in lockstep with CC's entropy-per-state.
  const state = base64url(randomBytes(32));

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code) {
        res.writeHead(400);
        res.end('No authorization code received');
        server.close();
        reject(new Error('No authorization code received'));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('Invalid state parameter');
        server.close();
        reject(new Error('Invalid state parameter'));
        return;
      }

      // Redirect browser to success page
      res.writeHead(302, { Location: 'https://platform.claude.com/oauth/code/success?app=claude-code' });
      res.end();

      // Exchange the code for tokens
      server.close();
      exchangeCodeWithRedirect(code, codeVerifier, state, port)
        .then(resolve)
        .catch(reject);
    });

    let port = 0;
    server.listen(0, 'localhost', async () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;

      const cfg = await getOAuthConfig();
      const params = new URLSearchParams({
        code: 'true',
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: `http://localhost:${port}/callback`,
        scope: cfg.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      });

      const authUrl = `${cfg.authorizeUrl}?${params.toString()}`;

      // Open browser
      console.log('  Opening browser to sign in...');
      console.log(`  If the browser didn't open, visit: ${authUrl}`);
      console.log('');

      // Hardened: openBrowser uses execFile + argv array + URL protocol
      // allowlist. Previous inline `exec(\`start "" "${authUrl}"\`)`
      // would have shelled out any `&` / `|` / `^` / backtick / `$()` in
      // a URL — see src/open-browser.ts.
      const { openBrowser } = await import('./open-browser.js');
      try { openBrowser(authUrl); } catch { /* non-fatal: user has the URL printed above */ }
    });

    server.on('error', (err: Error) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out. Try again with `dario login`.'));
    }, 300_000);
  });
}

/**
 * Exchange code using the localhost redirect URI.
 */
async function exchangeCodeWithRedirect(code: string, codeVerifier: string, state: string, port: number): Promise<OAuthTokens> {
  const cfg = await getOAuthConfig();
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: `http://localhost:${port}/callback`,
      code_verifier: codeVerifier,
      state,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}). Try again with \`dario login\`.`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope?.split(' ') || ['user:inference'],
  };

  await saveCredentials({ claudeAiOauth: tokens });
  return tokens;
}

/**
 * Build the authorize URL used by the manual / headless flow. Exported
 * so tests can assert the shape (code=true, MANUAL_REDIRECT_URI, PKCE)
 * without exercising the full interactive flow.
 */
export function buildManualAuthorizeUrl(
  cfg: { clientId: string; authorizeUrl: string; scopes: string },
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: MANUAL_REDIRECT_URI,
    scope: cfg.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

/**
 * Parse whatever the user pastes back from Anthropic's success page.
 *
 * The success page renders the authorization code and state joined with
 * a `#` (the fragment-identifier convention CC itself uses for its
 * `claude setup-token` flow), so the happy-path paste is `code#state`.
 * Some browsers / copy UIs strip the fragment, so we also accept a bare
 * code. When state is present, callers should verify it matches the
 * state they generated; when absent, callers can prompt separately or
 * accept the trade-off (code + PKCE + client_id are still verified on
 * the token exchange).
 */
export function parseManualPaste(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  if (!trimmed) return { code: '', state: null };
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) return { code: trimmed, state: null };
  return {
    code: trimmed.slice(0, hashIdx).trim(),
    state: trimmed.slice(hashIdx + 1).trim(),
  };
}

/**
 * Heuristic for "dario is probably running somewhere the local-callback
 * OAuth flow won't work because the browser is on a different host."
 * Returns a short reason string when the heuristic fires, null otherwise.
 *
 * Callers use this to *offer* `--manual` to the user, never to force it —
 * false positives are more annoying than false negatives (the user can
 * always opt in explicitly).
 */
export function detectHeadlessEnvironment(): string | null {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return 'SSH session detected';
  }
  try {
    if (existsSync('/.dockerenv')) {
      return 'container detected (/.dockerenv)';
    }
    if (existsSync('/proc/1/cgroup')) {
      const cg = readFileSync('/proc/1/cgroup', 'utf-8');
      if (/\b(docker|containerd|lxc|kubepods)\b/.test(cg)) {
        return 'container detected (cgroup)';
      }
    }
  } catch { /* best-effort — /proc is Linux-only, absence is fine */ }
  return null;
}

/**
 * Manual / headless OAuth flow (dario #43).
 *
 * Mirrors Claude Code's own `claude setup-token` flow: asks Anthropic to
 * display the authorization code as text instead of redirecting to a
 * local callback server, then reads the code the user copies back.
 * Works for container installs (browser on host, dario in container),
 * SSH installs (no browser on the remote box), and any other setup
 * where a localhost redirect can't reach the dario process.
 *
 * Security posture is unchanged from the auto flow: PKCE + client_id +
 * single-use code + server-side code expiry. State parameter is
 * verified when the pasted input includes it; bare-code pastes still
 * exchange because state isn't load-bearing for the token endpoint
 * (it's CSRF protection for a redirect we don't have here).
 */
export async function startManualOAuthFlow(): Promise<OAuthTokens> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  // 32 bytes — same reason as startAutoOAuthFlow. See dario#71.
  const state = base64url(randomBytes(32));
  const cfg = await getOAuthConfig();
  const authUrl = buildManualAuthorizeUrl(cfg, codeChallenge, state);

  console.log('');
  console.log('  Open this URL in any browser (on any machine):');
  console.log('');
  console.log(`    ${authUrl}`);
  console.log('');
  console.log('  After you approve, Anthropic will display an authorization code.');
  console.log('  Paste it below (format: "code#state" or just the code).');
  console.log('');

  const pasted = await readLineFromStdin('  Code: ');
  const { code, state: returnedState } = parseManualPaste(pasted);

  if (!code) {
    throw new Error('No authorization code entered. Re-run `dario login --manual`.');
  }

  if (returnedState && returnedState !== state) {
    throw new Error('State mismatch — the pasted code is from a different login attempt. Re-run `dario login --manual` and paste the most recent code.');
  }

  return exchangeCodeManual(code, codeVerifier, state);
}

async function exchangeCodeManual(code: string, codeVerifier: string, state: string): Promise<OAuthTokens> {
  const cfg = await getOAuthConfig();
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: MANUAL_REDIRECT_URI,
      code_verifier: codeVerifier,
      state,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // See src/redact.ts — strip tokens / JWTs / Bearer values from upstream
    // body before they surface in the Error message.
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${redactSecrets(body.slice(0, 200))}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope?.split(' ') || ['user:inference'],
  };

  await saveCredentials({ claudeAiOauth: tokens });
  return tokens;
}

async function readLineFromStdin(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Refresh the access token using the refresh token.
 * Retries with exponential backoff on transient failures.
 * Uses a mutex to prevent concurrent refresh races.
 */
export async function refreshTokens(): Promise<OAuthTokens> {
  // Prevent concurrent refreshes — if one is already in progress, wait for it
  if (refreshInProgress) return refreshInProgress;
  refreshInProgress = doRefreshTokens();
  try {
    return await refreshInProgress;
  } finally {
    refreshInProgress = null;
  }
}

async function doRefreshTokens(): Promise<OAuthTokens> {
  const creds = await loadCredentials();
  if (!creds?.claudeAiOauth?.refreshToken) {
    throw new Error('No refresh token available. Run `dario login` first.');
  }

  const oauth = creds.claudeAiOauth;
  const cfg = await getOAuthConfig();

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));

    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: cfg.clientId,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[dario] Refresh attempt ${attempt + 1}/3 failed: HTTP ${res.status} — ${redactSecrets(errBody.slice(0, 200))}`);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Refresh token rejected (${res.status}). Run \`dario login\` to re-authenticate.`);
      }
      continue;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: oauth.scopes,
    };

    await saveCredentials({ claudeAiOauth: tokens });
    return tokens;
  }

  throw new Error('Token refresh failed after 3 attempts');
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getAccessToken(): Promise<string> {
  const creds = await loadCredentials();
  if (!creds?.claudeAiOauth) {
    throw new Error('Not authenticated. Run `dario login` first.');
  }

  const oauth = creds.claudeAiOauth;

  // Still valid
  if (oauth.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return oauth.accessToken;
  }

  // Need refresh — but don't spam if we just failed
  if (Date.now() - lastRefreshFailure < REFRESH_COOLDOWN_MS) {
    // Still in cooldown from a recent failure, use current token even if expiring
    return oauth.accessToken;
  }
  console.log('[dario] Token expiring soon, refreshing...');
  try {
    const refreshed = await refreshTokens();
    return refreshed.accessToken;
  } catch (err) {
    lastRefreshFailure = Date.now();
    console.error(`[dario] Refresh failed: ${err instanceof Error ? err.message : err}. Will retry in 60s. Run \`dario login\` if this persists.`);
    // Return current token — it might still work for a few more minutes
    return oauth.accessToken;
  }
}

/**
 * Get token status info.
 */
export async function getStatus(): Promise<{
  authenticated: boolean;
  status: 'healthy' | 'expiring' | 'expired' | 'none';
  expiresAt?: number;
  expiresIn?: string;
  canRefresh?: boolean;
}> {
  const creds = await loadCredentials();
  if (!creds?.claudeAiOauth?.accessToken) {
    return { authenticated: false, status: 'none' };
  }

  const { expiresAt } = creds.claudeAiOauth;
  const now = Date.now();

  if (expiresAt < now) {
    // Expired but has refresh token — can be refreshed
    const canRefresh = !!creds.claudeAiOauth.refreshToken;
    return { authenticated: false, status: 'expired', expiresAt, canRefresh };
  }

  const ms = expiresAt - now;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const expiresIn = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return {
    authenticated: true,
    status: ms < REFRESH_BUFFER_MS ? 'expiring' : 'healthy',
    expiresAt,
    expiresIn,
  };
}

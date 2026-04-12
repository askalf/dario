/**
 * Dario — Claude OAuth Engine
 *
 * Full PKCE OAuth flow for Claude subscriptions.
 * Handles authorization, token exchange, storage, and auto-refresh.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Claude Code's public OAuth client (PKCE, no secret needed) — extracted from CC v2.1.104 binary
const OAUTH_CLIENT_ID = '22422756-60c9-4084-8eb7-27705fd5cf9a';
// Max Plan OAuth (for Claude Pro/Max subscriptions) — claude.com/cai/oauth/authorize
const OAUTH_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Max plan scopes (excludes org:create_api_key which requires Console plan)
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

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

export async function loadCredentials(): Promise<CredentialsFile | null> {
  // Return cached if fresh
  if (credentialsCache && Date.now() - credentialsCacheTime < CACHE_TTL_MS) {
    return credentialsCache;
  }

  // Try dario's own credentials first, then fall back to Claude Code's
  for (const path of [getDarioCredentialsPath(), getClaudeCodeCredentialsPath()]) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) {
        credentialsCache = parsed as CredentialsFile;
        credentialsCacheTime = Date.now();
        return credentialsCache;
      }
    } catch { /* try next */ }
  }
  return null;
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
  const state = base64url(randomBytes(16));

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

      const params = new URLSearchParams({
        code: 'true',
        client_id: OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: `http://localhost:${port}/callback`,
        scope: OAUTH_SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      });

      const authUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;

      // Open browser
      console.log('  Opening browser to sign in...');
      console.log(`  If the browser didn't open, visit: ${authUrl}`);
      console.log('');

      // Open browser using platform-specific commands (no external deps)
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? `start "" "${authUrl}"`
        : process.platform === 'darwin' ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
      exec(cmd, () => {});
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
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
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

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[dario] Refresh attempt ${attempt + 1}/3 failed: HTTP ${res.status} — ${errBody.slice(0, 200)}`);
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

/**
 * Dario — Claude OAuth Engine
 *
 * Full PKCE OAuth flow for Claude subscriptions.
 * Handles authorization, token exchange, storage, and auto-refresh.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Claude CLI's public OAuth client (PKCE, no secret needed)
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// Refresh 30 min before expiry
const REFRESH_BUFFER_MS = 30 * 60 * 1000;

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

function getCredentialsPath(): string {
  return join(homedir(), '.dario', 'credentials.json');
}

export async function loadCredentials(): Promise<CredentialsFile | null> {
  try {
    const raw = await readFile(getCredentialsPath(), 'utf-8');
    return JSON.parse(raw) as CredentialsFile;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: CredentialsFile): Promise<void> {
  const path = getCredentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Start the OAuth flow. Returns the authorization URL and PKCE state
 * needed for the exchange step.
 */
export function startOAuthFlow(): { authUrl: string; state: string; codeVerifier: string } {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = base64url(randomBytes(16));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: 'user:inference user:profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    authUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    state,
    codeVerifier,
  };
}

/**
 * Exchange authorization code for tokens and save them.
 */
export async function exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
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
 */
export async function refreshTokens(): Promise<OAuthTokens> {
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
      ...oauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
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

  // Need refresh
  console.log('[dario] Token expiring soon, refreshing...');
  const refreshed = await refreshTokens();
  return refreshed.accessToken;
}

/**
 * Get token status info.
 */
export async function getStatus(): Promise<{
  authenticated: boolean;
  status: 'healthy' | 'expiring' | 'expired' | 'none';
  expiresAt?: number;
  expiresIn?: string;
}> {
  const creds = await loadCredentials();
  if (!creds?.claudeAiOauth?.accessToken) {
    return { authenticated: false, status: 'none' };
  }

  const { expiresAt } = creds.claudeAiOauth;
  const now = Date.now();

  if (expiresAt < now) {
    return { authenticated: false, status: 'expired', expiresAt };
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

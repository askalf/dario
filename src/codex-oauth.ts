/**
 * Codex OAuth primitives — the "altman" engine (dario#1009).
 *
 * A deliberately separate, standalone module from oauth.ts/accounts.ts,
 * not a generalization of them. Two providers isn't enough to know what a
 * good shared abstraction looks like yet; forcing one now would mean
 * guessing at the shape from a single example. See the dario#993/#1009
 * scoping discussion for the reasoning.
 *
 * Unlike Claude's OAuth config (auto-detected from the installed CC binary
 * — see cc-oauth-detect.ts — because Anthropic rotates client_id/URLs
 * between CC releases), Codex's values below are stable, publicly known
 * constants used by OpenAI's own `codex` CLI. Hardcoded here the same way
 * every other OSS OAuth client for this flow does (e.g.
 * numman-ali/opencode-openai-codex-auth), with an env override escape
 * hatch in case that changes.
 *
 * THE OPEN QUESTION THIS MODULE EXISTS TO ANSWER (see
 * test/manual/codex-refresh-race.mjs): does OpenAI invalidate the previous
 * refresh_token on every refresh, the way Anthropic does? That single fact
 * determines whether Codex needs pool/lock machinery at all, or something
 * much simpler. Not yet known — no public source documents it, because
 * every existing OAuth client for this flow (this codebase's own
 * inspiration included) is single-instance, single-user, and has never
 * had a reason to race two refreshes against the same token.
 */
import { randomBytes, createHash } from 'node:crypto';

// OAuth constants — from OpenAI's own `codex` CLI, reused unmodified by
// every third-party client for this flow (Cline, opencode's codex-auth
// plugin). Not dario-specific; not secret.
export const CODEX_CLIENT_ID = process.env.DARIO_CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = process.env.DARIO_CODEX_AUTHORIZE_URL || 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = process.env.DARIO_CODEX_TOKEN_URL || 'https://auth.openai.com/oauth/token';
export const CODEX_REDIRECT_URI = process.env.DARIO_CODEX_REDIRECT_URI || 'http://localhost:1455/auth/callback';
export const CODEX_SCOPE = 'openid profile email offline_access';

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodexPKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * Build the authorize URL for a manual-paste login flow (same shape as
 * accounts.ts's startAddAccount — dario has no localhost callback server
 * running by default, so the manual copy-paste flow is the primary path,
 * not a fallback).
 */
export function buildCodexAuthorizeUrl(codeChallenge: string, state: string): string {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_SCOPE);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

interface CodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

function parseTokenResponse(json: CodexTokenResponse): CodexTokens {
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
    throw new Error(`Codex token response missing required fields: ${JSON.stringify(Object.keys(json ?? {}))}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    idToken: json.id_token,
  };
}

export async function exchangeCodexAuthorizationCode(code: string, codeVerifier: string): Promise<CodexTokens> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Codex code->token exchange failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return parseTokenResponse(await res.json());
}

/**
 * Refresh a Codex access token. Deliberately NOT wrapped in any
 * single-flight/lock machinery yet — that's exactly the thing
 * test/manual/codex-refresh-race.mjs exists to determine the need for.
 * Adding pool/lock complexity before that answer is known would be
 * guessing at a solution to an unconfirmed problem.
 */
export async function refreshCodexAccessToken(refreshToken: string): Promise<CodexTokens> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Codex token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return parseTokenResponse(await res.json());
}

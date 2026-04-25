/**
 * Multi-account credential storage.
 *
 * Accounts live at `~/.dario/accounts/<alias>.json`. Single-account dario
 * uses `~/.dario/credentials.json` (plus the CC file + OS keychain fallback
 * paths in oauth.ts). When `~/.dario/accounts/` contains 2+ files the proxy
 * activates pool mode (see pool.ts). Each account has its own independent
 * OAuth lifecycle and can refresh without affecting the others.
 *
 * `ensureLoginCredentialsInPool` (below) bridges the two stores on the
 * first `dario accounts add` — it promotes the user's existing login
 * credentials into the pool under a reserved alias so that adding a
 * second account actually trips the 2+ threshold and activates pooling.
 *
 * OAuth config (client_id, scopes, authorize URL, token URL) comes from
 * dario's cc-oauth-detect scanner — the same source the single-account
 * path already uses. No hardcoded client IDs here.
 */
import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { detectCCOAuthConfig } from './cc-oauth-detect.js';
import { loadCredentials } from './oauth.js';
import { openBrowser } from './open-browser.js';
import { redactSecrets } from './redact.js';

const DARIO_DIR = join(homedir(), '.dario');
const ACCOUNTS_DIR = join(DARIO_DIR, 'accounts');

/**
 * Normalize a caller-supplied alias into a filesystem-safe leaf name.
 * Strips any directory component (traversal, absolute paths) and rejects
 * aliases that don't match the allowed charset. CLI input is already
 * constrained, but the accounts API is importable — defense in depth.
 */
function safeAliasPath(alias: string): string | null {
  if (typeof alias !== 'string' || alias.length === 0) return null;
  const leaf = basename(alias);
  if (leaf !== alias) return null;
  if (leaf === '.' || leaf === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/.test(leaf)) return null;
  return join(ACCOUNTS_DIR, `${leaf}.json`);
}

export interface AccountCredentials {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  deviceId: string;
  accountUuid: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
}

export async function listAccountAliases(): Promise<string[]> {
  try {
    await ensureDir();
    const entries = await readdir(ACCOUNTS_DIR);
    return entries.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

export async function loadAccount(alias: string): Promise<AccountCredentials | null> {
  const path = safeAliasPath(alias);
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as AccountCredentials;
  } catch {
    return null;
  }
}

export async function loadAllAccounts(): Promise<AccountCredentials[]> {
  const aliases = await listAccountAliases();
  const loaded = await Promise.all(aliases.map(a => loadAccount(a)));
  return loaded.filter((a): a is AccountCredentials => a !== null);
}

export async function saveAccount(creds: AccountCredentials): Promise<void> {
  const path = safeAliasPath(creds.alias);
  if (!path) throw new Error(`invalid account alias: ${creds.alias}`);
  await ensureDir();
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch {
    // Windows can fail renames on busy files — fall back to direct write
    await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
    try { await unlink(tmp); } catch { /* ignore */ }
  }
}

export async function removeAccount(alias: string): Promise<boolean> {
  const path = safeAliasPath(alias);
  if (!path) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** Detect deviceId + accountUuid from an installed Claude Code. */
async function detectClaudeIdentity(): Promise<{ deviceId: string; accountUuid: string } | null> {
  const paths = [
    join(homedir(), '.claude', '.claude.json'),
    join(homedir(), '.claude.json'),
  ];

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8');
      const data = JSON.parse(raw);
      const deviceId = data.userID || data.installId || data.deviceId || '';
      const accountUuid = data.oauthAccount?.accountUuid || data.accountUuid || '';
      if (deviceId || accountUuid) {
        return { deviceId, accountUuid };
      }
    } catch { /* try next */ }
  }
  return null;
}

// Per-alias single-flight map: if a refresh is in flight for an alias,
// concurrent callers share the same promise instead of issuing parallel
// refresh_token requests. The pool's 15-min background timer is the only
// production caller today, but a slow network + refresh-on-acquire path
// (a plausible future addition) could otherwise race two refreshes for
// the same alias. Mirrors the guard in `oauth.ts` for the single-account
// path.
const accountRefreshesInFlight = new Map<string, Promise<AccountCredentials>>();

/** Refresh an account's OAuth token using dario's auto-detected CC OAuth config. */
export async function refreshAccountToken(creds: AccountCredentials): Promise<AccountCredentials> {
  const inFlight = accountRefreshesInFlight.get(creds.alias);
  if (inFlight) return inFlight;
  const promise = doRefreshAccountToken(creds).finally(() => {
    // Clear only if nobody else has replaced it in the meantime (belt-and-
    // suspenders; current code paths never overlap).
    if (accountRefreshesInFlight.get(creds.alias) === promise) {
      accountRefreshesInFlight.delete(creds.alias);
    }
  });
  accountRefreshesInFlight.set(creds.alias, promise);
  return promise;
}

async function doRefreshAccountToken(creds: AccountCredentials): Promise<AccountCredentials> {
  const cfg = await detectCCOAuthConfig();
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: cfg.clientId,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    // Redact tokens / JWTs / Bearer values before they hit the Error
    // message — defense-in-depth against an upstream that ever echoes a
    // credential into a 4xx body. See src/redact.ts.
    throw new Error(`Refresh failed for ${creds.alias} (${res.status}): ${redactSecrets(errBody.slice(0, 200))}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: AccountCredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await saveAccount(updated);
  return updated;
}

/** Test-only — inspect the in-flight map. Production code has no business peeking. */
export function _accountRefreshesInFlightSizeForTest(): number {
  return accountRefreshesInFlight.size;
}

// ── PKCE OAuth flow for adding a new account ────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

// `openBrowser` lives in src/open-browser.ts — uses execFile + argv array
// + URL-protocol allowlist instead of shell interpolation. The previous
// inline `exec(\`start "" "${url}"\`)` pattern would have shelled out
// any `&` / `|` / `^` / backtick / `$()` in a URL.

/**
 * Interactive OAuth flow that adds a new account to the pool. Uses dario's
 * auto-detected CC OAuth config (same scanner the single-account path uses).
 * Saves to `~/.dario/accounts/<alias>.json` on success.
 */
export async function addAccountViaOAuth(alias: string): Promise<AccountCredentials> {
  const cfg = await detectCCOAuthConfig();
  const { codeVerifier, codeChallenge } = generatePKCE();
  // 32 random bytes → 43-char base64url state. Matches what CC v2.1.116+
  // ships in `/login` URLs; Anthropic's `/oauth/authorize` endpoint started
  // rejecting shorter states with "Invalid request format" on 2026-04-23
  // (dario#71 repro: URL was byte-equivalent to CC's except state was
  // 22 chars → reject, 43 chars → accept). RFC 6749 only requires
  // "non-guessable," so shorter is technically legal — Anthropic's stricter
  // than spec here. Keep in lockstep with CC's bytes-per-random.
  const state = base64url(randomBytes(32));

  return new Promise<AccountCredentials>((resolve, reject) => {
    let port = 0;
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
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
          reject(new Error('OAuth state mismatch — possible CSRF'));
          return;
        }

        res.writeHead(302, {
          Location: 'https://platform.claude.com/oauth/code/success?app=claude-code',
        });
        res.end();
        server.close();

        // Exchange code for tokens
        const tokenRes = await fetch(cfg.tokenUrl, {
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
          signal: AbortSignal.timeout(30_000),
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text().catch(() => '');
          throw new Error(`Token exchange failed (${tokenRes.status}): ${redactSecrets(body.slice(0, 200))}`);
        }

        const tokens = await tokenRes.json() as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
          scope?: string;
        };

        // Prefer CC identity if installed; otherwise generate fresh IDs.
        const identity = (await detectClaudeIdentity()) ?? {
          deviceId: randomUUID(),
          accountUuid: randomUUID(),
        };

        const creds: AccountCredentials = {
          alias,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          scopes: tokens.scope?.split(' ') ?? cfg.scopes.split(' '),
          deviceId: identity.deviceId,
          accountUuid: identity.accountUuid,
        };

        await saveAccount(creds);
        resolve(creds);
      } catch (err) {
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.listen(0, 'localhost', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;

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

      console.log(`  Opening browser to add account "${alias}"...`);
      console.log(`  If the browser didn't open, visit:`);
      console.log(`  ${authUrl}`);
      console.log();

      try { openBrowser(authUrl); } catch { /* non-fatal: user has the URL printed above */ }
    });

    server.on('error', (err: Error) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out after 5 minutes. Try `dario accounts add` again.'));
    }, 300_000);
    timeout.unref();
  });
}

export function getAccountsDir(): string {
  return ACCOUNTS_DIR;
}

/**
 * Alias reserved for credentials auto-migrated from the single-account
 * `dario login` store. Named `login` so it's semantically obvious where
 * the entry came from and unlikely to collide with user-chosen aliases
 * like `work`, `personal`, etc. If a user specifically requests `login`
 * as the alias for `dario accounts add`, the caller falls back to
 * `default` so the migration doesn't step on the user's intent.
 */
export const MIGRATED_LOGIN_ALIAS = 'login';

/**
 * Promote the user's existing single-account `dario login` credentials
 * (`~/.dario/credentials.json`, `~/.claude/.credentials.json`, or OS
 * keychain — whichever `loadCredentials` finds) into the pool under a
 * reserved alias.
 *
 * Why: the pool activation threshold is 2+ accounts in `~/.dario/accounts/`.
 * A user with one `dario login` account + one `dario accounts add bar`
 * ends up with only one account in `accounts/` (bar), pool mode never
 * trips, and the login account is effectively orphaned while pool is off.
 * Calling this on the first `dario accounts add` back-fills the login
 * account into the pool so the second `add` crosses the threshold.
 *
 * Idempotent: no-op if `accounts/` already has any entry, no-op if no
 * credentials are reachable anywhere. Returns the alias written to, or
 * `null` when nothing happened.
 *
 * The source `credentials.json` (if present) is left untouched — single-
 * account mode still reads it if the user later `accounts remove`s down
 * below the pool threshold. Migration is copy-only, never destructive.
 *
 * @param preferredAlias caller may request a specific alias. If it's
 *   already the reserved `login` (or collides), falls back to `default`.
 */
export async function ensureLoginCredentialsInPool(
  alias: string = MIGRATED_LOGIN_ALIAS,
): Promise<string | null> {
  if (!safeAliasPath(alias)) return null;

  const existing = await listAccountAliases();
  if (existing.length > 0) return null;

  const creds = await loadCredentials();
  const tok = creds?.claudeAiOauth;
  if (!tok?.accessToken || !tok?.refreshToken) return null;

  const identity = (await detectClaudeIdentity()) ?? {
    deviceId: randomUUID(),
    accountUuid: randomUUID(),
  };

  await saveAccount({
    alias,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: tok.expiresAt,
    scopes: tok.scopes ?? [],
    deviceId: identity.deviceId,
    accountUuid: identity.accountUuid,
  });

  return alias;
}

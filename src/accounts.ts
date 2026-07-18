/**
 * Multi-account credential storage.
 *
 * Accounts live at `~/.dario/accounts/<alias>.json`. Single-account dario
 * uses `~/.dario/credentials.json` (plus the CC file + OS keychain fallback
 * paths in oauth.ts). Any file in `~/.dario/accounts/` activates the proxy's
 * pool mode (one account is enough — dario#618; see pool.ts). Each account
 * has its own independent OAuth lifecycle and can refresh without affecting
 * the others.
 *
 * `ensureLoginCredentialsInPool` (below) bridges the two stores on the
 * first `dario accounts add` — it promotes the user's existing login
 * credentials into the pool under a reserved alias so the login account
 * keeps serving once pool routing takes over.
 *
 * OAuth config (client_id, scopes, authorize URL, token URL) comes from
 * dario's cc-oauth-detect scanner — the same source the single-account
 * path already uses. No hardcoded client IDs here.
 */
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { detectCCOAuthConfig } from './cc-oauth-detect.js';
import { loadCredentials, buildManualAuthorizeUrl, parseManualPaste, readLineFromStdin, enumerateKeychainCredentials, type KeychainEntry } from './oauth.js';
import { openBrowser } from './open-browser.js';
import { redactSecrets } from './redact.js';
import { durableWriteFile } from './durable-write.js';

const MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

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
  // Durable write (dario#790): fsync the temp file + parent dir so a rotated
  // refresh token survives an abrupt container recreate. A plain rename left
  // the data in the page cache; `docker rm -f` (SIGKILL) discarded it and the
  // bind-mounted file reverted to the mint content, stranding every recreate
  // after >8h on a rotated-away refresh token.
  await durableWriteFile(path, JSON.stringify(creds, null, 2), 0o600);
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
export async function detectClaudeIdentity(): Promise<{ deviceId: string; accountUuid: string } | null> {
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

/**
 * Manual / headless flow for `dario accounts add` — the pool-mode counterpart
 * to `startManualOAuthFlow` in oauth.ts. Prints the authorize URL, asks the
 * user to paste back `code#state` from Anthropic's success page, exchanges
 * for tokens, saves to `~/.dario/accounts/<alias>.json`.
 *
 * Used when a localhost-callback flow can't reach the dario process — SSH
 * sessions, containers — and as the on-Windows escape hatch when the URL
 * dispatch chain (rundll32 / explorer) can't be relied on to deliver the
 * full URL to the browser.
 */
export async function addAccountViaManualOAuth(alias: string): Promise<AccountCredentials> {
  const { authorizeUrl, codeVerifier, state } = await startAddAccount(alias);

  console.log('');
  console.log(`  Open this URL in any browser to add account "${alias}":`);
  console.log('');
  console.log(`    ${authorizeUrl}`);
  console.log('');
  console.log('  Sign in with the Claude account you want to add. After you approve,');
  console.log('  Anthropic will display an authorization code. Paste it below');
  console.log('  (format: "code#state" or just the code).');
  console.log('');

  const pasted = await readLineFromStdin('  Code: ');
  const { code, state: returnedState } = parseManualPaste(pasted);

  if (!code) {
    throw new Error(`No authorization code entered. Re-run \`dario accounts add ${alias} --manual\`.`);
  }

  if (returnedState && returnedState !== state) {
    throw new Error(`State mismatch — the pasted code is from a different login attempt. Re-run \`dario accounts add ${alias} --manual\` and paste the most recent code.`);
  }

  return completeAddAccount(alias, code, codeVerifier, state);
}

/**
 * Non-interactive first half of the manual add-account flow (#599): validate
 * the alias, generate PKCE + state, and build the authorize URL the user opens
 * in a browser. The caller keeps `codeVerifier` + `state` and passes them back
 * to `completeAddAccount` after the user supplies the displayed code. Shared by
 * the `dario accounts add --manual` CLI and the headless admin API — the secret
 * (codeVerifier) never leaves the process that started the flow.
 */
export async function startAddAccount(
  alias: string,
): Promise<{ authorizeUrl: string; codeVerifier: string; state: string }> {
  if (!safeAliasPath(alias)) {
    throw new Error(`invalid account alias "${alias}" (allowed: letters, digits, _-. — up to 64 chars, no path separators)`);
  }
  const cfg = await detectCCOAuthConfig();
  const { codeVerifier, codeChallenge } = generatePKCE();
  // 32-byte state — same constraint as the auto flow. See dario#71.
  const state = base64url(randomBytes(32));
  const authorizeUrl = buildManualAuthorizeUrl(cfg, codeChallenge, state);
  return { authorizeUrl, codeVerifier, state };
}

/**
 * Non-interactive second half (#599): exchange the authorization `code` for
 * tokens (PKCE-verified server-side), attach a device/account identity, and
 * persist the account to `~/.dario/accounts/<alias>.json`. Throws — with any
 * upstream secrets redacted — on a failed exchange. Shared by the CLI and the
 * admin API.
 */
export async function completeAddAccount(
  alias: string,
  code: string,
  codeVerifier: string,
  state: string,
): Promise<AccountCredentials> {
  if (!safeAliasPath(alias)) {
    throw new Error(`invalid account alias "${alias}"`);
  }
  const cfg = await detectCCOAuthConfig();
  const tokenRes = await fetch(cfg.tokenUrl, {
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
  return creds;
}

export function getAccountsDir(): string {
  return ACCOUNTS_DIR;
}

/**
 * Error subclass for the keychain-import path so the CLI can render
 * actionable guidance (list of candidates) without parsing message strings.
 */
export class KeychainImportError extends Error {
  constructor(message: string, public readonly kind: 'empty' | 'ambiguous' | 'no-match', public readonly candidates: string[] = []) {
    super(message);
    this.name = 'KeychainImportError';
  }
}

/**
 * Import a Claude Code keychain entry into the pool under `alias`. Skips
 * the OAuth flow entirely — reuses tokens the user already authorised
 * through Claude Code itself. See askalf/dario#237 for design rationale.
 *
 * Resolution rules:
 *  - 0 entries on this host → throws KeychainImportError(kind: 'empty')
 *  - 1 entry total → imports it; `target` argument ignored if supplied
 *  - 2+ entries + no target → throws KeychainImportError(kind: 'ambiguous',
 *    candidates: [<target1>, <target2>, ...]) so the CLI can list them
 *  - 2+ entries + target → imports the matching one, throws
 *    KeychainImportError(kind: 'no-match', candidates) if none match
 *
 * macOS currently only ever surfaces a single entry (see the comment in
 * enumerateKeychainCredentials in oauth.ts). Linux + Windows enumerate
 * all matching entries.
 */
export async function addAccountFromKeychain(alias: string, target?: string): Promise<AccountCredentials> {
  const entries = await enumerateKeychainCredentials();
  if (entries.length === 0) {
    throw new KeychainImportError(
      'No Claude Code keychain entries found on this host. Run `claude` (login flow) first, or use `dario accounts add ' + alias + '` to start a fresh OAuth.',
      'empty',
    );
  }
  let chosen: KeychainEntry | undefined;
  if (target) {
    chosen = entries.find(e => e.target === target);
    if (!chosen) {
      throw new KeychainImportError(
        `No keychain entry matches target "${target}".`,
        'no-match',
        entries.map(e => e.target),
      );
    }
  } else if (entries.length === 1) {
    chosen = entries[0];
  } else {
    throw new KeychainImportError(
      `Found ${entries.length} keychain entries — pick one with --from-keychain=<target>.`,
      'ambiguous',
      entries.map(e => e.target),
    );
  }

  const oauth = chosen.credentials.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.refreshToken) {
    throw new KeychainImportError(
      `Keychain entry "${chosen.target}" is missing accessToken/refreshToken — re-authenticate Claude Code.`,
      'empty',
    );
  }

  // Same identity preference as addAccountViaOAuth — prefer CC identity if
  // installed; otherwise generate fresh IDs.
  const identity = (await detectClaudeIdentity()) ?? {
    deviceId: randomUUID(),
    accountUuid: randomUUID(),
  };

  const creds: AccountCredentials = {
    alias,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes ?? ['user:inference'],
    deviceId: identity.deviceId,
    accountUuid: identity.accountUuid,
  };

  await saveAccount(creds);
  return creds;
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
 * Why: any entry in `~/.dario/accounts/` activates pool mode (dario#618),
 * and the pool routes only across `accounts/` entries. A user with one
 * `dario login` account who runs `dario accounts add bar` would otherwise
 * end up with a pool that serves only `bar` — the login account silently
 * dropped from routing. Calling this on the first `dario accounts add`
 * back-fills the login account so both keep serving.
 *
 * Idempotent: no-op if `accounts/` already has any entry, no-op if no
 * credentials are reachable anywhere. Returns the alias written to, or
 * `null` when nothing happened.
 *
 * The source `credentials.json` (if present) is left untouched — single-
 * account mode still reads it if the user later `accounts remove`s the
 * pool empty. Migration is copy-only, never destructive.
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

/**
 * Detect divergence between `accounts/login.json` and the current
 * `credentials.json` (or whichever store loadCredentials finds), and
 * re-sync if they differ. Returns one of:
 *   - 'no-pool'      : accounts/ is empty (pool inactive), nothing to do
 *   - 'no-login'     : pool active but no `login` alias — back-fill
 *                       was never run, nothing to do
 *   - 'no-creds'     : login.json exists but no current credentials
 *                       reachable to compare against — leave alone
 *   - 'in-sync'      : tokens match; no action
 *   - 'resynced'     : login.json was stale; overwrote with current
 *                       credentials. Caller should reload pool state
 *   - 'creds-stale'  : login.json is STRICTLY NEWER than credentials.json
 *                       (the pool refreshed it; the legacy file is stale) —
 *                       left login.json untouched. dario#805.
 *
 * Why: the single-account path keeps refreshing `credentials.json` in
 * the background (proxy startup auth check, periodic refresh in oauth.ts).
 * Each refresh issues new tokens and Anthropic invalidates the previous
 * refresh_token. The pool's `login.json` snapshot — frozen at back-fill
 * time — is now wrong on both fields, but its `expiresAt` metadata still
 * says "healthy" so the selector keeps picking it. Detect this at startup
 * and overwrite with the current canonical content. dario#235.
 *
 * BUT the divergence runs BOTH ways. In pool mode the pool's own refresh
 * loop advances `login.json` while `credentials.json` stays frozen (the
 * pool never writes it). Blindly overwriting login.json from credentials.json
 * would then clobber a live token with the stale legacy one whose refresh
 * Anthropic already rotated → invalid_grant on every startup → fleet-wide
 * auth outage. So we reconcile by FRESHNESS, not by assuming credentials.json
 * wins. dario#805 (the second outage of this class within 12h).
 *
 * Runs at any pool size ≥ 1: a lone `login` entry is a live pool member
 * since pool-at-one (dario#618) and can go stale exactly the same way —
 * e.g. after `accounts remove` shrinks a migrated pool back to just the
 * back-filled snapshot.
 */
export async function resyncLoginFromCredentialsIfStale(): Promise<
  'no-pool' | 'no-login' | 'no-creds' | 'in-sync' | 'resynced' | 'creds-stale'
> {
  const aliases = await listAccountAliases();
  if (aliases.length === 0) return 'no-pool';
  if (!aliases.includes(MIGRATED_LOGIN_ALIAS)) return 'no-login';

  const loginAcc = await loadAccount(MIGRATED_LOGIN_ALIAS);
  if (!loginAcc) return 'no-login';

  const creds = await loadCredentials();
  const tok = creds?.claudeAiOauth;
  if (!tok?.accessToken || !tok?.refreshToken) return 'no-creds';

  if (
    loginAcc.accessToken === tok.accessToken &&
    loginAcc.refreshToken === tok.refreshToken
  ) {
    return 'in-sync';
  }

  // Tokens diverged. Reconcile by FRESHNESS — a strictly-newer login.json is
  // the pool having refreshed it (credentials.json is the stale legacy copy),
  // and overwriting it from credentials.json would swap a live token for one
  // whose refresh Anthropic already rotated → invalid_grant → outage (#805).
  // Only the strict case is skipped; equal expiresAt keeps the #235 behaviour
  // (overwrite), since a real refresh always advances expiresAt.
  if (loginAcc.expiresAt > tok.expiresAt) {
    return 'creds-stale';
  }

  // credentials.json is the newer (or equal-age) token — the #235 case: the
  // single-account path refreshed it and the pool snapshot is stale. Overwrite,
  // preserving deviceId/accountUuid (they don't rotate with token refresh;
  // they're pool-internal identity).
  await saveAccount({
    alias: MIGRATED_LOGIN_ALIAS,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: tok.expiresAt,
    scopes: tok.scopes ?? loginAcc.scopes ?? [],
    deviceId: loginAcc.deviceId,
    accountUuid: loginAcc.accountUuid,
  });
  return 'resynced';
}

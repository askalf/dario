/**
 * Headless admin API (#599) — an opt-in HTTP control plane for managing the
 * account pool without console access. Mounted at `/admin/*` by the proxy
 * (src/proxy.ts) ONLY when `DARIO_ADMIN=1`.
 *
 * Endpoints (all require the admin bearer token — `DARIO_ADMIN_TOKEN`, or
 * `DARIO_API_KEY` as a fallback — even on loopback, since they add/remove
 * OAuth credentials):
 *
 *   POST   /admin/login/start     { alias }            -> { login_id, authorize_url, expires_at }
 *   POST   /admin/login/complete  { login_id, code }   -> { alias, status, expires_at }
 *   GET    /admin/accounts                              -> { accounts: [...], count }
 *   DELETE /admin/accounts/<alias>                      -> { alias, removed }
 *
 * The login flow mirrors `dario accounts add --manual` (PKCE + manual paste):
 * `/start` returns the authorize URL the operator opens in a browser; they POST
 * the code Anthropic displays back to `/complete`. The PKCE verifier + state
 * live in an in-memory map keyed by `login_id` with a short TTL — never on
 * disk, never returned to the client, single-use.
 *
 * Account changes take effect on the next proxy restart (the pool is built at
 * startup, src/proxy.ts). Hot-reload of a running pool is a deliberate
 * follow-up — keeping this surface small while it manipulates credentials.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  startAddAccount,
  completeAddAccount,
  removeAccount,
  listAccountAliases,
  loadAccount,
} from './accounts.js';
import { parseManualPaste } from './oauth.js';

export interface AdminDeps {
  /** Admin bearer token buffer; `null` = enabled but no token configured (fail closed). */
  adminTokenBuf: Buffer | null;
  /** Invoked after an account is added or removed (e.g. to log / signal a reload). */
  onAccountsChanged?: () => void;
}

interface PendingLogin {
  alias: string;
  codeVerifier: string;
  state: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 64; // backstop against unbounded growth from repeated /start
const ACCOUNTS_PREFIX = '/admin/accounts/';
const pendingLogins = new Map<string, PendingLogin>();

function prunePending(now: number): void {
  for (const [id, p] of pendingLogins) {
    if (p.expiresAt <= now) pendingLogins.delete(id);
  }
}

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(body));
}

/** Constant-time bearer / x-api-key check. Fails closed when no token configured. */
function adminAuthOk(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (!tokenBuf) return false;
  const provided = (req.headers['x-api-key'] as string)
    || (req.headers.authorization as string)?.replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  if (providedBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(providedBuf, tokenBuf);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw) as Record<string, unknown>); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * Handle an `/admin/*` request. Returns `true` if it owned the request (matched
 * one of its routes and wrote a response), `false` if the path isn't one of
 * ours — so the caller's existing routing (incl. the pre-existing
 * `/admin/resume`) and the `DARIO_API_KEY` gate still run.
 */
export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  deps: AdminDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const isAccountDelete =
    method === 'DELETE' && urlPath.startsWith(ACCOUNTS_PREFIX) && urlPath.length > ACCOUNTS_PREFIX.length;
  const known =
    urlPath === '/admin/login/start' ||
    urlPath === '/admin/login/complete' ||
    urlPath === '/admin/accounts' ||
    isAccountDelete;
  if (!known) return false;

  // Auth — always required, even on loopback (these mutate OAuth credentials).
  if (!adminAuthOk(req, deps.adminTokenBuf)) {
    if (!deps.adminTokenBuf) {
      send(res, 403, { error: 'admin API enabled but no token configured — set DARIO_ADMIN_TOKEN (or DARIO_API_KEY)' });
    } else {
      send(res, 401, { error: 'Unauthorized', message: 'invalid or missing admin token' });
    }
    return true;
  }

  const now = Date.now();
  prunePending(now);

  try {
    // POST /admin/login/start  { alias }
    if (urlPath === '/admin/login/start') {
      if (method !== 'POST') { send(res, 405, { error: 'Method not allowed (use POST)' }); return true; }
      const body = await readJsonBody(req);
      const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
      if (!alias) { send(res, 400, { error: 'missing "alias"' }); return true; }
      if (pendingLogins.size >= MAX_PENDING) { send(res, 429, { error: 'too many pending logins; complete or wait for one to expire' }); return true; }
      const { authorizeUrl, codeVerifier, state } = await startAddAccount(alias); // throws on invalid alias
      const loginId = randomUUID();
      const expiresAt = now + PENDING_TTL_MS;
      pendingLogins.set(loginId, { alias, codeVerifier, state, expiresAt });
      send(res, 200, {
        login_id: loginId,
        authorize_url: authorizeUrl,
        expires_at: new Date(expiresAt).toISOString(),
        instructions: 'Open authorize_url, approve, then POST the displayed code to /admin/login/complete with this login_id.',
      });
      return true;
    }

    // POST /admin/login/complete  { login_id, code }
    if (urlPath === '/admin/login/complete') {
      if (method !== 'POST') { send(res, 405, { error: 'Method not allowed (use POST)' }); return true; }
      const body = await readJsonBody(req);
      const loginId = typeof body.login_id === 'string' ? body.login_id : '';
      const rawCode = typeof body.code === 'string' ? body.code : '';
      if (!loginId || !rawCode) { send(res, 400, { error: 'missing "login_id" or "code"' }); return true; }
      const p = pendingLogins.get(loginId);
      if (!p || p.expiresAt <= now) {
        pendingLogins.delete(loginId);
        send(res, 410, { error: 'login_id unknown or expired — start a new login' });
        return true;
      }
      // Accept "code#state" or a bare code; verify the embedded state if present.
      const { code, state: pastedState } = parseManualPaste(rawCode);
      if (!code) { send(res, 400, { error: 'no authorization code found in "code"' }); return true; }
      if (pastedState && pastedState !== p.state) {
        send(res, 400, { error: 'state mismatch — code is from a different login attempt' });
        return true;
      }
      pendingLogins.delete(loginId); // single-use, regardless of exchange outcome
      const creds = await completeAddAccount(p.alias, code, p.codeVerifier, p.state);
      deps.onAccountsChanged?.();
      send(res, 200, { alias: creds.alias, status: 'added', expires_at: new Date(creds.expiresAt).toISOString() });
      return true;
    }

    // GET /admin/accounts
    if (urlPath === '/admin/accounts') {
      if (method !== 'GET') { send(res, 405, { error: 'Method not allowed (use GET)' }); return true; }
      const aliases = await listAccountAliases();
      const accounts = (await Promise.all(aliases.map(async (alias) => {
        const a = await loadAccount(alias);
        if (!a) return null;
        return { alias: a.alias, scopes: a.scopes, expires_in_ms: Math.max(0, a.expiresAt - now) };
      }))).filter((a): a is { alias: string; scopes: string[]; expires_in_ms: number } => a !== null);
      send(res, 200, {
        accounts,
        count: accounts.length,
        note: 'live rate-limit / utilization is at GET /accounts when pool mode is active',
      });
      return true;
    }

    // DELETE /admin/accounts/<alias>
    if (isAccountDelete) {
      const alias = decodeURIComponent(urlPath.slice(ACCOUNTS_PREFIX.length));
      const removed = await removeAccount(alias); // validates alias internally
      if (removed) deps.onAccountsChanged?.();
      send(res, removed ? 200 : 404, { alias, removed });
      return true;
    }

    send(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    // startAddAccount throws on an invalid alias; completeAddAccount throws
    // (with secrets redacted) on a failed token exchange; readJsonBody throws
    // on oversized / malformed bodies.
    send(res, 400, { error: (err as Error).message });
    return true;
  }
}

/** Test-only: clear the pending-login map between cases. */
export function _resetAdminStateForTest(): void {
  pendingLogins.clear();
}

/**
 * Headless admin API (#599) — an opt-in HTTP control plane for managing the
 * account pool without console access. Mounted at `/admin/*` by the proxy
 * (src/proxy.ts) ONLY when `DARIO_ADMIN=1`.
 *
 * Endpoints (all require the admin bearer token — `DARIO_ADMIN_TOKEN`, or
 * `DARIO_API_KEY` as a fallback — even on loopback, since they add/remove
 * OAuth credentials):
 *
 *   POST   /admin/login/start     { alias }        -> { authorize_url, expires_at }
 *   POST   /admin/login/complete  { alias, code }  -> { alias, status, expires_at }
 *   GET    /admin/accounts                          -> { accounts: [...], count }
 *   DELETE /admin/accounts/<alias>                  -> { alias, removed }
 *
 * The login flow mirrors `dario accounts add --manual` (PKCE + manual paste):
 * `/start` returns the authorize URL the operator opens in a browser; they POST
 * the code Anthropic displays back to `/complete`. The PKCE verifier + state
 * live in an in-memory map keyed by the account `alias` with a short TTL — never
 * on disk, never returned to the client, single-use. One pending login per
 * alias; a second `/start` for the same alias just replaces it (#599).
 *
 * `GET /admin/accounts` reports each account's persisted metadata — alias,
 * scopes, token expiry — plus its live pool status (5h/7d utilization,
 * representative-claim, routing status, request count) when the proxy supplies
 * a `poolStatus` snapshot, which it does whenever pool mode is active. It's the
 * headless, admin-token-gated equivalent of the `GET /accounts` pool view.
 *
 * Account changes take effect immediately: the proxy passes an
 * `onAccountsChanged` hook (src/proxy.ts) that hot-reloads the live pool from
 * disk, awaited before this handler responds, so an added account is routable
 * by the time the client sees its 200 — no proxy restart (#599).
 *
 * Every mutation (login start / complete, account removal) and every auth
 * reject is handed to an `audit` hook (src/proxy.ts) that records who did what
 * to the account pool — to the console always, and to the JSON log file when
 * one is configured. Secrets never reach it (#599).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  startAddAccount,
  completeAddAccount,
  removeAccount,
  listAccountAliases,
  loadAccount,
} from './accounts.js';
import { parseManualPaste } from './oauth.js';

/** Persisted account metadata surfaced by `GET /admin/accounts`. */
export interface AdminAccountRecord {
  alias: string;
  scopes: string[];
  expiresAt: number;
}

/** Live per-account pool status keyed by alias — see `AdminDeps.poolStatus`. */
export interface AdminAccountLive {
  util5h: number;
  util7d: number;
  claim: string;
  status: string;
  requestCount: number;
}

/** An audited admin action — see `AdminDeps.audit`. Never carries secrets. */
export interface AdminAuditEvent {
  action: 'login_start' | 'login_complete' | 'account_remove' | 'auth_reject';
  ok: boolean;
  status: number;
  /** Account alias, when the action targets one. */
  alias?: string;
  /** Client address (`req.socket.remoteAddress`), when known. */
  remote?: string;
}

export interface AdminDeps {
  /** Admin bearer token buffer; `null` = enabled but no token configured (fail closed). */
  adminTokenBuf: Buffer | null;
  /**
   * Invoked after an account is added or removed. Awaited before the response
   * is sent, so a handler that hot-reloads the live pool (src/proxy.ts) makes
   * the change routable by the time the client sees its 200.
   */
  onAccountsChanged?: () => void | Promise<void>;
  /**
   * Persisted-account inventory (alias, scopes, token expiry). Defaults to the
   * on-disk store at `~/.dario/accounts`; injectable for tests.
   */
  listAccounts?: () => Promise<AdminAccountRecord[]>;
  /**
   * Live per-account pool status keyed by alias, from the running AccountPool.
   * When present, `GET /admin/accounts` merges each account's 5h/7d headroom,
   * representative-claim, routing status, and request count onto its persisted
   * metadata. Returns `null` (or absent) in single-account mode — no pool.
   */
  poolStatus?: () => Map<string, AdminAccountLive> | null;
  /**
   * Audit sink for admin activity — every mutation (login start / complete,
   * account removal) and every auth reject. The proxy records it (console +
   * log file) so a headless operator has a trail of who provisioned or removed
   * an account. Never receives secrets.
   */
  audit?: (event: AdminAuditEvent) => void;
}

interface PendingLogin {
  codeVerifier: string;
  state: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 64; // backstop against unbounded growth (distinct aliases)
const ACCOUNTS_PREFIX = '/admin/accounts/';
// Keyed by account alias — one pending login per alias (#599).
const pendingLogins = new Map<string, PendingLogin>();

function prunePending(now: number): void {
  for (const [id, p] of pendingLogins) {
    if (p.expiresAt <= now) pendingLogins.delete(id);
  }
}

/** On-disk account inventory — the default `AdminDeps.listAccounts`. */
async function defaultListAccounts(): Promise<AdminAccountRecord[]> {
  const aliases = await listAccountAliases();
  const loaded = await Promise.all(aliases.map(async (alias) => {
    const a = await loadAccount(alias);
    return a ? { alias: a.alias, scopes: a.scopes, expiresAt: a.expiresAt } : null;
  }));
  return loaded.filter((a): a is AdminAccountRecord => a !== null);
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
  const remote = req.socket?.remoteAddress;
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
    const status = deps.adminTokenBuf ? 401 : 403;
    deps.audit?.({ action: 'auth_reject', ok: false, status, remote });
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
      // Only a brand-new alias grows the map; a repeat /start replaces in place.
      if (!pendingLogins.has(alias) && pendingLogins.size >= MAX_PENDING) {
        send(res, 429, { error: 'too many pending logins; complete or wait for one to expire' });
        return true;
      }
      const { authorizeUrl, codeVerifier, state } = await startAddAccount(alias); // throws on invalid alias
      const expiresAt = now + PENDING_TTL_MS;
      pendingLogins.set(alias, { codeVerifier, state, expiresAt });
      deps.audit?.({ action: 'login_start', ok: true, status: 200, alias, remote });
      send(res, 200, {
        authorize_url: authorizeUrl,
        expires_at: new Date(expiresAt).toISOString(),
        instructions: `Open authorize_url, approve, then POST { "alias": "${alias}", "code": "<displayed code>" } to /admin/login/complete.`,
      });
      return true;
    }

    // POST /admin/login/complete  { alias, code }
    if (urlPath === '/admin/login/complete') {
      if (method !== 'POST') { send(res, 405, { error: 'Method not allowed (use POST)' }); return true; }
      const body = await readJsonBody(req);
      const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
      const rawCode = typeof body.code === 'string' ? body.code : '';
      if (!alias || !rawCode) { send(res, 400, { error: 'missing "alias" or "code"' }); return true; }
      const p = pendingLogins.get(alias);
      if (!p || p.expiresAt <= now) {
        pendingLogins.delete(alias);
        send(res, 410, { error: 'no pending login for that alias (unknown or expired) — start a new login' });
        return true;
      }
      // Accept "code#state" or a bare code; verify the embedded state if present.
      const { code, state: pastedState } = parseManualPaste(rawCode);
      if (!code) { send(res, 400, { error: 'no authorization code found in "code"' }); return true; }
      if (pastedState && pastedState !== p.state) {
        send(res, 400, { error: 'state mismatch — code is from a different login attempt' });
        return true;
      }
      pendingLogins.delete(alias); // single-use, regardless of exchange outcome
      const creds = await completeAddAccount(alias, code, p.codeVerifier, p.state);
      await deps.onAccountsChanged?.();
      deps.audit?.({ action: 'login_complete', ok: true, status: 200, alias: creds.alias, remote });
      send(res, 200, { alias: creds.alias, status: 'added', expires_at: new Date(creds.expiresAt).toISOString() });
      return true;
    }

    // GET /admin/accounts — persisted metadata + live pool status (#599).
    if (urlPath === '/admin/accounts') {
      if (method !== 'GET') { send(res, 405, { error: 'Method not allowed (use GET)' }); return true; }
      const records = await (deps.listAccounts ?? defaultListAccounts)();
      const live = deps.poolStatus?.() ?? null;
      const accounts = records.map((r) => {
        const l = live?.get(r.alias);
        return {
          alias: r.alias,
          scopes: r.scopes,
          expires_in_ms: Math.max(0, r.expiresAt - now),
          // Inline the running pool's live status when this account is in it.
          ...(l ? {
            util5h: l.util5h,
            util7d: l.util7d,
            claim: l.claim,
            status: l.status,
            request_count: l.requestCount,
          } : {}),
        };
      });
      send(res, 200, {
        accounts,
        count: accounts.length,
        // Live util/claim/status is inlined above when the pool is active;
        // single-account mode has no pool, so point at the pool view instead.
        ...(live ? {} : { note: 'live rate-limit / utilization is at GET /accounts when pool mode is active' }),
      });
      return true;
    }

    // DELETE /admin/accounts/<alias>
    if (isAccountDelete) {
      const alias = decodeURIComponent(urlPath.slice(ACCOUNTS_PREFIX.length));
      const removed = await removeAccount(alias); // validates alias internally
      if (removed) await deps.onAccountsChanged?.();
      deps.audit?.({ action: 'account_remove', ok: removed, status: removed ? 200 : 404, alias, remote });
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

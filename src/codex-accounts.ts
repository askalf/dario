/**
 * Codex account storage — the "altman" engine (dario#1009).
 *
 * Deliberately isolated from accounts.ts: separate directory
 * (~/.dario/codex-accounts/), separate types, no shared code path with the
 * Claude pool. Not wired into pool.ts or proxy.ts's request routing —
 * this module only manages credentials on disk. Routing a request through
 * a Codex account is a later step, gated on actually knowing whether this
 * needs pool/lock machinery at all (see codex-oauth.ts's header comment
 * and test/manual/codex-refresh-race.mjs).
 */
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  generateCodexPKCE,
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  refreshCodexAccessToken,
  type CodexTokens,
} from './codex-oauth.js';
import { durableWriteFile } from './durable-write.js';

const DARIO_DIR = join(homedir(), '.dario');
const CODEX_ACCOUNTS_DIR = join(DARIO_DIR, 'codex-accounts');

export interface CodexAccountCredentials {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
}

/** Same alias charset/traversal guard as accounts.ts's safeAliasPath. */
function safeAliasPath(alias: string): string | null {
  if (typeof alias !== 'string' || alias.length === 0) return null;
  const leaf = basename(alias);
  if (leaf !== alias) return null;
  if (leaf === '.' || leaf === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/.test(leaf)) return null;
  return join(CODEX_ACCOUNTS_DIR, `${leaf}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(CODEX_ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
}

export async function listCodexAccountAliases(): Promise<string[]> {
  try {
    await ensureDir();
    const entries = await readdir(CODEX_ACCOUNTS_DIR);
    return entries.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

export async function loadCodexAccount(alias: string): Promise<CodexAccountCredentials | null> {
  const path = safeAliasPath(alias);
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as CodexAccountCredentials;
  } catch {
    return null;
  }
}

export async function loadAllCodexAccounts(): Promise<CodexAccountCredentials[]> {
  const aliases = await listCodexAccountAliases();
  const loaded = await Promise.all(aliases.map(a => loadCodexAccount(a)));
  return loaded.filter((a): a is CodexAccountCredentials => a !== null);
}

export async function saveCodexAccount(creds: CodexAccountCredentials): Promise<void> {
  const path = safeAliasPath(creds.alias);
  if (!path) throw new Error(`invalid codex account alias: ${creds.alias}`);
  await ensureDir();
  await durableWriteFile(path, JSON.stringify(creds, null, 2), 0o600);
}

export async function removeCodexAccount(alias: string): Promise<boolean> {
  const path = safeAliasPath(alias);
  if (!path) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export function getCodexAccountsDir(): string {
  return CODEX_ACCOUNTS_DIR;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startAddCodexAccount(
  alias: string,
): Promise<{ authorizeUrl: string; codeVerifier: string; state: string }> {
  if (!safeAliasPath(alias)) {
    throw new Error(`invalid account alias "${alias}" (allowed: letters, digits, _-. — up to 64 chars, no path separators)`);
  }
  const { codeVerifier, codeChallenge } = generateCodexPKCE();
  const state = base64url(randomBytes(32));
  const authorizeUrl = buildCodexAuthorizeUrl(codeChallenge, state);
  return { authorizeUrl, codeVerifier, state };
}

export async function completeAddCodexAccount(
  alias: string,
  code: string,
  codeVerifier: string,
): Promise<CodexAccountCredentials> {
  if (!safeAliasPath(alias)) {
    throw new Error(`invalid account alias "${alias}"`);
  }
  const tokens: CodexTokens = await exchangeCodexAuthorizationCode(code, codeVerifier);
  const creds: CodexAccountCredentials = {
    alias,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    idToken: tokens.idToken,
  };
  await saveCodexAccount(creds);
  return creds;
}

/**
 * Refresh 30 min before expiry — same buffer as oauth.ts's Claude path.
 * No single-flight or distributed-lock wrapping here (unlike accounts.ts's
 * refreshAccountToken) — see codex-oauth.ts's header for why.
 */
const REFRESH_BUFFER_MS = 30 * 60 * 1000;

export function codexAccountNeedsRefresh(creds: CodexAccountCredentials): boolean {
  return Date.now() >= creds.expiresAt - REFRESH_BUFFER_MS;
}

export async function refreshCodexAccount(creds: CodexAccountCredentials): Promise<CodexAccountCredentials> {
  const tokens = await refreshCodexAccessToken(creds.refreshToken);
  const updated: CodexAccountCredentials = {
    ...creds,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    idToken: tokens.idToken,
  };
  await saveCodexAccount(updated);
  return updated;
}

/**
 * In-process refresh serialization.
 *
 * dario#1010's open question is answered: test/manual/codex-refresh-race.mjs
 * was run twice against a live ChatGPT Plus account and came back TOLERANT both
 * times — two concurrent refreshes of the same refresh_token BOTH succeed, and
 * each returns a different new refresh_token. OpenAI does not invalidate the
 * previous one. So Codex needs none of the Claude engine's pool/lock/lease
 * machinery (#993/#1008): no Durable Object, no Redis, nothing cross-process.
 *
 * What's left is purely an efficiency concern — N concurrent requests arriving
 * on an expiring token shouldn't fire N identical refresh calls. One in-memory
 * promise per alias collapses them. If a second dario process refreshes the same
 * account at the same time, both simply succeed; last writer wins on disk and
 * the other process's token stays valid until its own expiry.
 */
const inflightRefresh = new Map<string, Promise<CodexAccountCredentials>>();

/**
 * Return credentials guaranteed fresh enough to send upstream, refreshing (once,
 * per alias, per process) when within the expiry buffer.
 */
export async function getFreshCodexAccount(creds: CodexAccountCredentials): Promise<CodexAccountCredentials> {
  if (!codexAccountNeedsRefresh(creds)) return creds;
  const existing = inflightRefresh.get(creds.alias);
  if (existing) return existing;
  const p = refreshCodexAccount(creds).finally(() => {
    inflightRefresh.delete(creds.alias);
  });
  inflightRefresh.set(creds.alias, p);
  return p;
}

/**
 * Pick the account to serve a request. Single account is the expected case (one
 * ChatGPT subscription); with several, `DARIO_CODEX_ACCOUNT` names one and
 * otherwise the first alphabetically wins. No rotation/least-recently-used
 * balancing — a subscription is per-seat, so spreading load across seats is the
 * user's decision to make explicitly, not something to do implicitly.
 */
export async function selectCodexAccount(preferredAlias?: string): Promise<CodexAccountCredentials | null> {
  const alias = preferredAlias || process.env.DARIO_CODEX_ACCOUNT;
  if (alias) {
    const one = await loadCodexAccount(alias);
    if (one) return one;
  }
  const all = await loadAllCodexAccounts();
  if (all.length === 0) return null;
  return [...all].sort((a, b) => a.alias.localeCompare(b.alias))[0];
}

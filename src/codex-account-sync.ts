/**
 * ChatGPT seats in the shared account registry (`--pool-shared-accounts`). The
 * sync and its rules are account-sync.ts; this is where these records live and
 * how to read them.
 *
 *   POST /codex-accounts/list            {}                -> { accounts, removed }
 *   POST /codex-accounts/<alias>/put     { credentials }   -> { stored }
 *   POST /codex-accounts/<alias>/remove  { removedAt }     -> { removed }
 *
 * The seats need no refresh lock (getFreshCodexAccount says why: two refreshes
 * of one token both succeed), so each replica refreshes on its own and the
 * later expiry wins here. Nothing holds a seat in memory either, since the
 * proxy reads the files on every request, so a sync only has to write the file:
 * there is no pool to attach.
 *
 * Credentials only. A seat's usage readings and cool-downs stay per instance.
 */
import { removeAccountEverywhere, type AccountRegistry, type AccountSyncStore, type SharedRemovalResult } from './account-sync.js';
import { extractChatGPTAccountId } from './codex-backend.js';
import {
  isValidCodexAlias, loadAllCodexAccounts, localCodexAccountRemovals, removeSharedCodexAccount, saveSharedCodexAccount,
  type CodexAccountCredentials,
} from './codex-accounts.js';

export const codexAccountFileStore: AccountSyncStore<CodexAccountCredentials> = {
  loadAll: loadAllCodexAccounts,
  save: saveSharedCodexAccount,
  remove: removeSharedCodexAccount,
  localRemovals: localCodexAccountRemovals,
};

/** A registry record complete enough to serve from, stored under its own alias. */
export function isCodexRegistryRecord(alias: string, rec: unknown): rec is CodexAccountCredentials {
  const r = rec as Partial<CodexAccountCredentials> | null;
  return !!r && typeof r === 'object' && r.alias === alias && isValidCodexAlias(alias)
    && typeof r.accessToken === 'string' && r.accessToken.length > 0
    && typeof r.refreshToken === 'string' && r.refreshToken.length > 0
    && typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt);
}

// Enough of the account id to tell two apart in a log, and no more.
function describeSeat(c: CodexAccountCredentials): string {
  const id = extractChatGPTAccountId(c.idToken);
  return id ? `ChatGPT account ending ${id.slice(-6)}` : 'ChatGPT seat';
}

export const CODEX_REGISTRY: AccountRegistry<CodexAccountCredentials> = {
  path: '/codex-accounts',
  noun: 'codex account',
  store: codexAccountFileStore,
  isRecord: isCodexRegistryRecord,
  describe: describeSeat,
  differ: (a, b) => {
    const x = extractChatGPTAccountId(a.idToken), y = extractChatGPTAccountId(b.idToken);
    return !!x && !!y && x !== y;
  },
};

/** removeAccountEverywhere for a ChatGPT seat, for `dario codex remove`. */
export function removeCodexAccountEverywhere(
  baseUrl: string, token: string, alias: string,
  opts: { store?: AccountSyncStore<CodexAccountCredentials>; removedAt?: number } = {},
): Promise<SharedRemovalResult> {
  return removeAccountEverywhere(baseUrl, token, alias, { ...opts, registry: CODEX_REGISTRY });
}

/**
 * Shared account registry (`--pool-shared-accounts`). Every instance merges
 * the Claude accounts in its `~/.dario/accounts/` with a registry on the
 * refresh-lock service, through three endpoints both reference backends
 * implement (redis-lock/, cloudflare/refresh-lock/):
 *
 *   POST /accounts/list            {}                → { accounts: { alias: AccountCredentials }, removed: { alias: removedAt } }
 *   POST /accounts/<alias>/put     { credentials }   → { stored }
 *   POST /accounts/<alias>/remove  { removedAt }     → { removed }
 *
 * A sync runs at startup, before the pool loads, then every 15 seconds and
 * after each admin API change. It publishes the removals this process made,
 * reads the registry, writes into the accounts directory every record newer
 * than the file there, removes the files a removal marker covers, pushes
 * every file newer than the registry's record, and hands the running pool
 * what changed, checked against the removals made here up to that moment.
 * Newer is credentialsAreNewer: the later grant, then the later expiry. A
 * removal marker beats every grant made before it and loses to every grant
 * made after it, so the instances' clocks must agree (NTP) to well under the
 * time between a removal and a later login.
 *
 * Every call fails open: with the service unreachable an instance serves the
 * accounts on its own disk, logging once per outage. The registry holds
 * every seat's full credentials, refresh tokens included, with no expiry, so
 * DARIO_REFRESH_LOCK_TOKEN reads every seat; that is why this is an opt-in
 * separate from `--pool-shared-state`.
 */

import {
  loadAllAccounts, saveSharedAccount, removeSharedAccount, localAccountRemovals,
  credentialsAreNewer, grantedAfter, isValidAccountAlias, type AccountCredentials,
} from './accounts.js';
import { maskEmail } from './pool.js';
import { clampTimerMs } from './timer-ms.js';

/** Where the sync reads and writes this instance's accounts. accounts.ts in production; a test passes its own. */
export interface AccountSyncStore {
  loadAll(): Promise<AccountCredentials[]>;
  save(creds: AccountCredentials, opts: { fetchedAt: number; removedAt?: number }): Promise<{ saved: boolean; replaced?: AccountCredentials }>;
  remove(alias: string, removedAt: number): Promise<boolean>;
  /** Removals this process made, alias to epoch ms. */
  localRemovals(): ReadonlyMap<string, number>;
}

export const accountFileStore: AccountSyncStore = {
  loadAll: loadAllAccounts,
  save: saveSharedAccount,
  remove: removeSharedAccount,
  localRemovals: localAccountRemovals,
};

/** What one sync changed on this instance, handed to the running proxy. */
export interface AccountSyncChange {
  /** Records the pool lacks or holds older credentials for. */
  records: AccountCredentials[];
  /** Seats the pool still holds whose account was removed. */
  removed: Array<{ alias: string; removedAt: number }>;
}

/** The credentials a live pool seat holds, as far as ordering them needs. */
export type LiveSeat = { expiresAt: number; grantedAt?: number };

export interface AccountSyncStatus {
  enabled: true;
  intervalMs: number;
  lastSyncAt: number | null;
  lastOkAt: number | null;
  /** Records and removal markers the registry held at the last good read. */
  registryAccounts: number | null;
  registryRemoved: number | null;
  /** Cumulative: records written from the registry, files removed, records pushed, removals published. */
  saved: number;
  removed: number;
  pushed: number;
  removalsPublished: number;
  errors: number;
  lastError: string | null;
}

export interface AccountSyncOptions {
  baseUrl: string;
  token: string;
  /** Sync interval, ms. Default 15000. */
  intervalMs?: number;
  store?: AccountSyncStore;
  log?: (line: string) => void;
}

export const DEFAULT_ACCOUNT_SYNC_INTERVAL_MS = 15_000;
const CALL_TIMEOUT_MS = 3_000;

export interface AccountSyncPlan {
  /** Registry records to write here, each with the removal time it must outlive. */
  save: Array<{ creds: AccountCredentials; removedAt?: number }>;
  /** Local files a removal covers. */
  remove: Array<{ alias: string; removedAt: number }>;
  /** Local records newer than the registry's. */
  push: AccountCredentials[];
}

/** The latest removal of `alias` either side knows of, or undefined. */
export function removalTime(
  alias: string,
  markers: ReadonlyMap<string, number>,
  localRemovals: ReadonlyMap<string, number>,
): number | undefined {
  const a = markers.get(alias), b = localRemovals.get(alias);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Merge this instance's account files with the registry, per alias. A record
 * counts only when it outlives the latest removal of its alias (the
 * registry's marker or one this process made); of the two that count, the
 * newer wins. The registry's goes to disk, ours goes to the registry, and a
 * local file no record outlives is removed.
 */
export function planAccountSync(
  local: readonly AccountCredentials[],
  registry: ReadonlyMap<string, AccountCredentials>,
  markers: ReadonlyMap<string, number>,
  localRemovals: ReadonlyMap<string, number>,
): AccountSyncPlan {
  const plan: AccountSyncPlan = { save: [], remove: [], push: [] };
  const localByAlias = new Map(local.map((a) => [a.alias, a]));
  for (const alias of new Set([...localByAlias.keys(), ...registry.keys()])) {
    const removedAt = removalTime(alias, markers, localRemovals);
    const mine = localByAlias.get(alias);
    const theirs = registry.get(alias);
    const mineCounts = mine !== undefined && grantedAfter(mine, removedAt);
    const theirsCount = theirs !== undefined && grantedAfter(theirs, removedAt);
    if (theirsCount && (!mineCounts || credentialsAreNewer(theirs, mine))) {
      plan.save.push(removedAt === undefined ? { creds: theirs } : { creds: theirs, removedAt });
    } else if (mineCounts) {
      if (!theirsCount || credentialsAreNewer(mine, theirs)) plan.push.push(mine);
    } else if (mine !== undefined && removedAt !== undefined) {
      plan.remove.push({ alias, removedAt });
    }
  }
  return plan;
}

/** A registry record complete enough to serve from, stored under its own alias. */
export function isRegistryRecord(alias: string, rec: unknown): rec is AccountCredentials {
  const r = rec as Partial<AccountCredentials> | null;
  return !!r && typeof r === 'object' && r.alias === alias && isValidAccountAlias(alias)
    && typeof r.accessToken === 'string' && r.accessToken.length > 0
    && typeof r.refreshToken === 'string' && r.refreshToken.length > 0
    && typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)
    && Array.isArray(r.scopes) && typeof r.deviceId === 'string' && typeof r.accountUuid === 'string';
}

function parseRegistry(raw: unknown): Map<string, AccountCredentials> {
  const out = new Map<string, AccountCredentials>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [alias, rec] of Object.entries(raw)) if (isRegistryRecord(alias, rec)) out.set(alias, rec);
  return out;
}

function parseMarkers(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [alias, at] of Object.entries(raw)) {
    if (isValidAccountAlias(alias) && typeof at === 'number' && Number.isFinite(at)) out.set(alias, at);
  }
  return out;
}

async function registryCall<T>(baseUrl: string, token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** How `dario accounts remove` ended with the shared account registry on. */
export type SharedRemovalResult =
  /** The registry took the removal, and the file here is gone. */
  | 'removed'
  /** The registry holds a login for the alias granted after the removal; nothing changed. */
  | 'registry-newer'
  /** The registry took the removal, but the file here holds a login granted after it, which stays. */
  | 'local-newer'
  /** The registry took the removal, but the file here, which it covers, could not be deleted. */
  | 'local-failed';

/**
 * Remove an account from the registry, then from this instance's disk, for
 * `dario accounts remove`. The removal is published first: a running
 * replica would otherwise push the account back from its own copy. The file
 * goes only once the registry took the removal, and only when it holds no
 * login granted after it. Throws when the service does not answer.
 */
export async function removeAccountEverywhere(
  baseUrl: string, token: string, alias: string,
  opts: { store?: AccountSyncStore; removedAt?: number } = {},
): Promise<SharedRemovalResult> {
  const store = opts.store ?? accountFileStore;
  const removedAt = opts.removedAt ?? Date.now();
  const res = await registryCall<{ removed?: boolean }>(baseUrl, token, `/accounts/${encodeURIComponent(alias)}/remove`, { removedAt });
  if (res.removed !== true) return 'registry-newer';
  if (await store.remove(alias, removedAt)) return 'removed';
  // Not removed by this call: a running proxy on this disk applied the
  // marker first, a login landed in the file after the removal, or the
  // file could not be deleted. Only an absent file counts as removed.
  const current = (await store.loadAll()).find((a) => a.alias === alias);
  if (!current) return 'removed';
  return grantedAfter(current, removedAt) ? 'local-newer' : 'local-failed';
}

function describeAccount(c: AccountCredentials): string {
  return maskEmail(c.accountEmail) ?? c.accountId ?? 'unknown account';
}

export class AccountSync {
  readonly intervalMs: number;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly store: AccountSyncStore;
  private readonly log: (line: string) => void;
  private onChange: ((change: AccountSyncChange) => Promise<void> | void) | null = null;
  private live: ((alias: string) => LiveSeat | undefined) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // One sync at a time, and at most one waiting: a call while one runs gets
  // the next run, which starts after it and so sees what it wrote.
  private running: Promise<unknown> = Promise.resolve();
  private queued: Promise<AccountSyncChange | null> | null = null;
  // Removal time last published per alias, so each removal goes out once.
  private readonly published = new Map<string, number>();
  private down = false;
  private stats = {
    lastSyncAt: null as number | null, lastOkAt: null as number | null,
    registryAccounts: null as number | null, registryRemoved: null as number | null,
    saved: 0, removed: 0, pushed: 0, removalsPublished: 0, errors: 0, lastError: null as string | null,
  };

  constructor(opts: AccountSyncOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.intervalMs = clampTimerMs(Math.max(1_000, opts.intervalMs ?? DEFAULT_ACCOUNT_SYNC_INTERVAL_MS));
    this.store = opts.store ?? accountFileStore;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /**
   * Connect a running pool: `live` reads a seat's credentials, `onChange`
   * gets what each later sync changed. Until then a sync updates the
   * accounts directory only, which is all the startup sync needs, since the
   * pool loads from that directory after it.
   */
  attach(live: (alias: string) => LiveSeat | undefined, onChange: (change: AccountSyncChange) => Promise<void> | void): void {
    this.live = live;
    this.onChange = onChange;
  }

  /** Sync on the interval. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.syncOnce(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): AccountSyncStatus {
    return { enabled: true, intervalMs: this.intervalMs, ...this.stats };
  }

  /** One sync. Null when the registry could not be read; never throws. */
  syncOnce(): Promise<AccountSyncChange | null> {
    if (this.queued) return this.queued;
    const next = this.running.then(() => {
      this.queued = null;
      return this.run().catch((err) => {
        this.stats.errors++;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        this.log(`[dario] shared accounts: sync failed (${this.stats.lastError}); retrying on the next sync`);
        return null;
      });
    });
    this.queued = next;
    this.running = next;
    return next;
  }

  private async run(): Promise<AccountSyncChange | null> {
    this.stats.lastSyncAt = Date.now();
    // Removals first: a list read after them no longer holds those records,
    // and one read before would hand them straight back.
    for (const [alias, at] of this.store.localRemovals()) {
      if ((this.published.get(alias) ?? -Infinity) >= at) continue;
      const res = await this.call<{ removed?: boolean }>(`/accounts/${encodeURIComponent(alias)}/remove`, { removedAt: at });
      if (!res) break;
      this.published.set(alias, at);
      this.stats.removalsPublished++;
    }

    const fetchedAt = Date.now();
    const res = await this.call<{ accounts?: unknown; removed?: unknown }>('/accounts/list', {});
    if (!res) return null;
    const registry = parseRegistry(res.accounts);
    const markers = parseMarkers(res.removed);
    this.stats.registryAccounts = registry.size;
    this.stats.registryRemoved = markers.size;

    const local = await this.store.loadAll();
    const localRemovals = this.store.localRemovals();
    const plan = planAccountSync(local, registry, markers, localRemovals);

    // The record each alias ends on here: the files that outlive their
    // alias's removal, then whatever the registry replaced.
    const kept = new Map<string, AccountCredentials>();
    for (const a of local) if (grantedAfter(a, removalTime(a.alias, markers, localRemovals))) kept.set(a.alias, a);
    const removed: AccountSyncChange['removed'] = [];

    for (const { alias, removedAt } of plan.remove) {
      // Kept when a login landed in the file since it was read; the next
      // sync takes that login to the pool.
      if (!(await this.store.remove(alias, removedAt))) continue;
      kept.delete(alias);
      removed.push({ alias, removedAt });
      this.stats.removed++;
      this.log(`[dario] shared accounts: removed account "${alias}"; it was removed on another instance`);
    }

    for (const { creds, removedAt } of plan.save) {
      const out = await this.store.save(creds, removedAt === undefined ? { fetchedAt } : { fetchedAt, removedAt });
      if (!out.saved) continue;
      kept.set(creds.alias, creds);
      this.stats.saved++;
      const was = out.replaced;
      if (!was) {
        this.log(`[dario] shared accounts: added account "${creds.alias}" (${describeAccount(creds)}) from the registry`);
      } else if (was.accountId && creds.accountId && was.accountId !== creds.accountId) {
        // Aliases are one namespace across every instance. Two instances
        // that each logged a different subscription in under one alias
        // (`login`, most often) keep only the newer grant.
        this.log(`[dario] shared accounts: account "${creds.alias}" here was ${describeAccount(was)} and is now ${describeAccount(creds)}, a newer login under the same alias on another instance; aliases are shared across instances, so give each subscription its own alias`);
      }
    }

    for (const creds of plan.push) {
      // A removal made here while this sync ran waits for the next one;
      // pushing the file it removed would bring the account back until then.
      const removedSince = this.store.localRemovals().get(creds.alias);
      if (!grantedAfter(creds, removedSince)) continue;
      const out = await this.call<{ stored?: boolean }>(`/accounts/${encodeURIComponent(creds.alias)}/put`, { credentials: creds });
      if (!out) break;
      if (!out.stored) continue;
      this.stats.pushed++;
      if (!registry.has(creds.alias)) this.log(`[dario] shared accounts: published account "${creds.alias}" to the registry`);
    }

    const change: AccountSyncChange = { records: [], removed };
    if (this.live) {
      // The pool gets the state as of now: a removal made here while this
      // sync waited on the service covers the records read before it.
      const removedNow = this.store.localRemovals();
      for (const [alias, rec] of kept) if (!grantedAfter(rec, removedNow.get(alias))) kept.delete(alias);
      for (const rec of kept.values()) {
        const seat = this.live(rec.alias);
        if (!seat || credentialsAreNewer(rec, seat)) change.records.push(rec);
      }
      // A seat whose file went another way (a CLI removal in another
      // process, or a peer on a shared accounts volume) is still in the pool.
      const planned = new Set(plan.remove.map((r) => r.alias));
      for (const alias of new Set([...markers.keys(), ...removedNow.keys()])) {
        if (kept.has(alias) || planned.has(alias)) continue;
        const removedAt = removalTime(alias, markers, removedNow)!;
        const seat = this.live(alias);
        if (seat && !grantedAfter(seat, removedAt)) removed.push({ alias, removedAt });
      }
    }
    if (this.onChange && (change.records.length > 0 || change.removed.length > 0)) await this.onChange(change);
    return change;
  }

  /**
   * One POST to the service. Null on any failure: the caller carries on with
   * the accounts on disk, which is the whole contract. Logged once per
   * transition into and out of the failed state, not per call.
   */
  private async call<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const out = await registryCall<T>(this.baseUrl, this.token, path, body);
      this.stats.lastOkAt = Date.now();
      if (this.down) {
        this.down = false;
        this.log(`[dario] shared accounts: service reachable again (${this.baseUrl})`);
      }
      return out;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      if (!this.down) {
        this.down = true;
        this.log(`[dario] shared accounts: ${this.baseUrl} unreachable (${this.stats.lastError}); serving the accounts on this instance's disk until it answers again`);
      }
      return null;
    }
  }
}

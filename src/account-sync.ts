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
 * Admin API logins that are started but not yet completed ride the same
 * service (`/logins/<claude|codex>/...`, see SharedPendingLogins below), so
 * a login started on one replica completes on another.
 *
 * Every call fails open: with the service unreachable an instance serves the
 * accounts on its own disk, logging once per outage. The registry holds
 * every seat's full credentials, refresh tokens included, with no expiry, so
 * DARIO_REFRESH_LOCK_TOKEN reads every seat; that is why this is an opt-in
 * separate from `--pool-shared-state`.
 *
 * ChatGPT seats ride the same switch and the same rules in a registry of their
 * own (`/codex-accounts/...`, codex-account-sync.ts), since aliases are a
 * namespace per engine: a second AccountSync, with an AccountRegistry that
 * says where its records live and how to read them.
 */

import {
  loadAllAccounts, saveSharedAccount, removeSharedAccount, localAccountRemovals,
  credentialsAreNewer, grantedAfter, isValidAccountAlias, type AccountCredentials,
} from './accounts.js';
import { maskEmail } from './pool.js';
import { clampTimerMs } from './timer-ms.js';

/** What the sync needs of a record, whichever engine it belongs to. */
export interface SyncedCredentials {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  grantedAt?: number;
}

/** Where the sync reads and writes this instance's accounts. accounts.ts in production; a test passes its own. */
export interface AccountSyncStore<R extends SyncedCredentials = AccountCredentials> {
  loadAll(): Promise<R[]>;
  save(creds: R, opts: { fetchedAt: number; removedAt?: number }): Promise<{ saved: boolean; replaced?: R }>;
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

/** A started, not yet completed admin API login: the PKCE secrets and when they lapse. */
export interface SharedLogin {
  codeVerifier: string;
  state: string;
  expiresAt: number;
}

/** Which engine's pending logins: they are separate namespaces, as the seats are. */
export type LoginEngine = 'claude' | 'codex';

/**
 * Pending admin API logins held on the shared service, so any instance can
 * complete one that another started. The verifier and state are secrets and
 * are stored as the registry stores credentials. 'failed' is the service
 * not answering or not knowing the endpoint (an older service); the caller
 * then keeps the login on this instance only.
 */
export interface SharedPendingLogins {
  /**
   * Publish a login for `alias`, replacing any other. 'full' when the service already holds its cap of other aliases.
   * With `create`, a live login under the alias is left alone and the answer is 'taken'.
   */
  put(engine: LoginEngine, alias: string, login: SharedLogin, ttlMs: number, create?: boolean): Promise<'stored' | 'full' | 'taken' | 'failed'>;
  /** The login for `alias`, null when the service holds none (or it lapsed). Does not consume it. */
  get(engine: LoginEngine, alias: string): Promise<SharedLogin | null | 'failed'>;
  /**
   * Delete the login for `alias` whose state is `state`, and only that one. True when this call removed
   * it live; false when none was there, it lapsed, or another login has replaced it (another instance
   * completed or restarted it first), which the caller must treat as lost.
   */
  remove(engine: LoginEngine, alias: string, state: string): Promise<boolean | 'failed'>;
  /** The aliases with a pending login on any instance. */
  aliases(engine: LoginEngine): Promise<string[] | 'failed'>;
}

function parseSharedLogin(raw: unknown): SharedLogin | null {
  const r = raw as Partial<SharedLogin> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.codeVerifier !== 'string' || r.codeVerifier.length === 0) return null;
  if (typeof r.state !== 'string' || r.state.length === 0) return null;
  if (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt)) return null;
  return { codeVerifier: r.codeVerifier, state: r.state, expiresAt: r.expiresAt };
}

/** What one sync changed on this instance, handed to the running proxy. */
export interface AccountSyncChange<R extends SyncedCredentials = AccountCredentials> {
  /** Records the pool lacks or holds older credentials for. */
  records: R[];
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

/** One engine's registry on the service: where its records live and how to read them. */
export interface AccountRegistry<R extends SyncedCredentials> {
  /** The service path it answers under: `<path>/list`, `<path>/<alias>/put`, `<path>/<alias>/remove`. */
  path: string;
  /** What the log calls one record. */
  noun: string;
  store: AccountSyncStore<R>;
  /** A registry record complete enough to serve from, stored under its own alias. */
  isRecord(alias: string, rec: unknown): rec is R;
  /** Names a record in a log line, never with its credentials. */
  describe(creds: R): string;
  /** Whether two records under one alias are different subscriptions. */
  differ(a: R, b: R): boolean;
}

export interface AccountSyncOptions<R extends SyncedCredentials = AccountCredentials> {
  baseUrl: string;
  token: string;
  /** Sync interval, ms. Default 15000. */
  intervalMs?: number;
  store?: AccountSyncStore<R>;
  log?: (line: string) => void;
  /** Default: the Claude accounts. */
  registry?: AccountRegistry<R>;
}

export const DEFAULT_ACCOUNT_SYNC_INTERVAL_MS = 15_000;
const CALL_TIMEOUT_MS = 3_000;

export interface AccountSyncPlan<R extends SyncedCredentials = AccountCredentials> {
  /** Registry records to write here, each with the removal time it must outlive. */
  save: Array<{ creds: R; removedAt?: number }>;
  /** Local files a removal covers. */
  remove: Array<{ alias: string; removedAt: number }>;
  /** Local records newer than the registry's. */
  push: R[];
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
export function planAccountSync<R extends SyncedCredentials>(
  local: readonly R[],
  registry: ReadonlyMap<string, R>,
  markers: ReadonlyMap<string, number>,
  localRemovals: ReadonlyMap<string, number>,
): AccountSyncPlan<R> {
  const plan: AccountSyncPlan<R> = { save: [], remove: [], push: [] };
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

function parseRegistry<R extends SyncedCredentials>(raw: unknown, isRecord: AccountRegistry<R>['isRecord']): Map<string, R> {
  const out = new Map<string, R>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [alias, rec] of Object.entries(raw)) if (isRecord(alias, rec)) out.set(alias, rec);
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
export async function removeAccountEverywhere<R extends SyncedCredentials = AccountCredentials>(
  baseUrl: string, token: string, alias: string,
  opts: { store?: AccountSyncStore<R>; removedAt?: number; registry?: AccountRegistry<R> } = {},
): Promise<SharedRemovalResult> {
  const registry = opts.registry ?? (CLAUDE_REGISTRY as unknown as AccountRegistry<R>);
  const store = opts.store ?? registry.store;
  const removedAt = opts.removedAt ?? Date.now();
  const res = await registryCall<{ removed?: boolean }>(baseUrl, token, `${registry.path}/${encodeURIComponent(alias)}/remove`, { removedAt });
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

const CLAUDE_REGISTRY: AccountRegistry<AccountCredentials> = {
  path: '/accounts',
  noun: 'account',
  store: accountFileStore,
  isRecord: isRegistryRecord,
  describe: describeAccount,
  differ: (a, b) => !!a.accountId && !!b.accountId && a.accountId !== b.accountId,
};

export class AccountSync<R extends SyncedCredentials = AccountCredentials> implements SharedPendingLogins {
  readonly intervalMs: number;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly registry: AccountRegistry<R>;
  private readonly store: AccountSyncStore<R>;
  private readonly log: (line: string) => void;
  private readonly tag: string;
  private onChange: ((change: AccountSyncChange<R>) => Promise<void> | void) | null = null;
  private live: ((alias: string) => LiveSeat | undefined) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // One sync at a time, and at most one waiting: a call while one runs gets
  // the next run, which starts after it and so sees what it wrote.
  private running: Promise<unknown> = Promise.resolve();
  private queued: Promise<AccountSyncChange<R> | null> | null = null;
  // Removal time last published per alias, so each removal goes out once.
  private readonly published = new Map<string, number>();
  // The registry's removal markers at the last good read.
  private markers: ReadonlyMap<string, number> = new Map();
  private down = false;
  private stats = {
    lastSyncAt: null as number | null, lastOkAt: null as number | null,
    registryAccounts: null as number | null, registryRemoved: null as number | null,
    saved: 0, removed: 0, pushed: 0, removalsPublished: 0, errors: 0, lastError: null as string | null,
  };

  constructor(opts: AccountSyncOptions<R>) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.intervalMs = clampTimerMs(Math.max(1_000, opts.intervalMs ?? DEFAULT_ACCOUNT_SYNC_INTERVAL_MS));
    this.registry = opts.registry ?? (CLAUDE_REGISTRY as unknown as AccountRegistry<R>);
    this.store = opts.store ?? this.registry.store;
    this.log = opts.log ?? ((line) => console.error(line));
    this.tag = `[dario] shared ${this.registry.noun}s:`;
  }

  /**
   * Connect a running pool: `live` reads a seat's credentials, `onChange`
   * gets what each later sync changed. Until then a sync updates the
   * accounts directory only, which is all the startup sync needs, since the
   * pool loads from that directory after it.
   */
  attach(live: (alias: string) => LiveSeat | undefined, onChange: (change: AccountSyncChange<R>) => Promise<void> | void): void {
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

  /**
   * The latest removal of `alias` this instance knows of: the registry's
   * marker at the last good read, or one this process made. A path that
   * writes account files outside the sync checks it, so it never restores a
   * login the sync just removed.
   */
  removalOf(alias: string): number | undefined {
    return removalTime(alias, this.markers, this.store.localRemovals());
  }

  private loginPath(engine: LoginEngine, alias: string, action: string): string {
    return `/logins/${engine}/${encodeURIComponent(alias)}/${action}`;
  }

  // Never logs the login: the line carries the alias and the transport error only.
  private loginFailed(what: string, alias: string): 'failed' {
    this.log(`${this.tag} could not ${what} the pending login for "${alias}" on the service (${this.stats.lastError ?? 'no answer'}); using this instance's copy`);
    return 'failed';
  }

  async put(engine: LoginEngine, alias: string, login: SharedLogin, ttlMs: number, create = false): Promise<'stored' | 'full' | 'taken' | 'failed'> {
    const out = await this.call<{ stored?: boolean; full?: boolean; taken?: boolean }>(this.loginPath(engine, alias, 'put'), create ? { login, ttlMs, create: true } : { login, ttlMs });
    if (!out) return this.loginFailed('publish', alias);
    if (out.stored === true) return 'stored';
    if (out.full === true) return 'full';
    return out.taken === true ? 'taken' : this.loginFailed('publish', alias);
  }

  async get(engine: LoginEngine, alias: string): Promise<SharedLogin | null | 'failed'> {
    const out = await this.call<{ login?: unknown }>(this.loginPath(engine, alias, 'get'), {});
    if (!out) return this.loginFailed('read', alias);
    return parseSharedLogin(out.login);
  }

  async remove(engine: LoginEngine, alias: string, state: string): Promise<boolean | 'failed'> {
    const out = await this.call<{ removed?: boolean }>(this.loginPath(engine, alias, 'remove'), { state });
    if (!out) return this.loginFailed('remove', alias);
    return out.removed === true;
  }

  async aliases(engine: LoginEngine): Promise<string[] | 'failed'> {
    const out = await this.call<{ aliases?: unknown }>(`/logins/${engine}/list`, {});
    if (!out) return 'failed';
    return Array.isArray(out.aliases) ? out.aliases.filter((a): a is string => typeof a === 'string') : [];
  }

  /** One sync. Null when the registry could not be read; never throws. */
  syncOnce(): Promise<AccountSyncChange<R> | null> {
    if (this.queued) return this.queued;
    const next = this.running.then(() => {
      this.queued = null;
      return this.run().catch((err) => {
        this.stats.errors++;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        this.log(`${this.tag} sync failed (${this.stats.lastError}); retrying on the next sync`);
        return null;
      });
    });
    this.queued = next;
    this.running = next;
    return next;
  }

  private async run(): Promise<AccountSyncChange<R> | null> {
    this.stats.lastSyncAt = Date.now();
    // Removals first: a list read after them no longer holds those records,
    // and one read before would hand them straight back.
    for (const [alias, at] of this.store.localRemovals()) {
      if ((this.published.get(alias) ?? -Infinity) >= at) continue;
      const res = await this.call<{ removed?: boolean }>(`${this.registry.path}/${encodeURIComponent(alias)}/remove`, { removedAt: at });
      if (!res) break;
      this.published.set(alias, at);
      this.stats.removalsPublished++;
    }

    const fetchedAt = Date.now();
    const res = await this.call<{ accounts?: unknown; removed?: unknown }>(`${this.registry.path}/list`, {});
    if (!res) return null;
    const registry = parseRegistry(res.accounts, this.registry.isRecord);
    const markers = parseMarkers(res.removed);
    this.markers = markers;
    this.stats.registryAccounts = registry.size;
    this.stats.registryRemoved = markers.size;

    const local = await this.store.loadAll();
    const localRemovals = this.store.localRemovals();
    const plan = planAccountSync(local, registry, markers, localRemovals);

    // The record each alias ends on here: the files that outlive their
    // alias's removal, then whatever the registry replaced.
    const kept = new Map<string, R>();
    for (const a of local) if (grantedAfter(a, removalTime(a.alias, markers, localRemovals))) kept.set(a.alias, a);
    const removed: AccountSyncChange<R>['removed'] = [];

    for (const { alias, removedAt } of plan.remove) {
      // Kept when a login landed in the file since it was read; the next
      // sync takes that login to the pool.
      if (!(await this.store.remove(alias, removedAt))) continue;
      kept.delete(alias);
      removed.push({ alias, removedAt });
      this.stats.removed++;
      this.log(`${this.tag} removed ${this.registry.noun} "${alias}"; it was removed on another instance`);
    }

    for (const { creds, removedAt } of plan.save) {
      const out = await this.store.save(creds, removedAt === undefined ? { fetchedAt } : { fetchedAt, removedAt });
      if (!out.saved) continue;
      kept.set(creds.alias, creds);
      this.stats.saved++;
      const was = out.replaced;
      if (!was) {
        this.log(`${this.tag} added ${this.registry.noun} "${creds.alias}" (${this.registry.describe(creds)}) from the registry`);
      } else if (this.registry.differ(was, creds)) {
        // Aliases are one namespace across every instance. Two instances
        // that each logged a different subscription in under one alias
        // (`login`, most often) keep only the newer grant.
        this.log(`${this.tag} ${this.registry.noun} "${creds.alias}" here was ${this.registry.describe(was)} and is now ${this.registry.describe(creds)}, a newer login under the same alias on another instance; aliases are shared across instances, so give each subscription its own alias`);
      }
    }

    for (const creds of plan.push) {
      // A removal made here while this sync ran waits for the next one;
      // pushing the file it removed would bring the account back until then.
      const removedSince = this.store.localRemovals().get(creds.alias);
      if (!grantedAfter(creds, removedSince)) continue;
      const out = await this.call<{ stored?: boolean }>(`${this.registry.path}/${encodeURIComponent(creds.alias)}/put`, { credentials: creds });
      if (!out) break;
      if (!out.stored) continue;
      this.stats.pushed++;
      if (!registry.has(creds.alias)) this.log(`${this.tag} published ${this.registry.noun} "${creds.alias}" to the registry`);
    }

    const change: AccountSyncChange<R> = { records: [], removed };
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
        this.log(`${this.tag} service reachable again (${this.baseUrl})`);
      }
      return out;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      if (!this.down) {
        this.down = true;
        this.log(`${this.tag} ${this.baseUrl} unreachable (${this.stats.lastError}); serving the accounts on this instance's disk until it answers again`);
      }
      return null;
    }
  }
}

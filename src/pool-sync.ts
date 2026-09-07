/**
 * Shared pool state across dario instances — the two things
 * docs/multi-instance.md called "not solved": rate-limit accounting and
 * session stickiness both lived in one process's memory, so two replicas
 * behind one Service each believed a seat had full headroom, each ate its own
 * 429 to learn otherwise, and a conversation re-cached its prefix on a
 * different seat per replica.
 *
 * This rides the refresh-lock service (dario#993) — the coordination point
 * two instances already share, reached through `DARIO_REFRESH_LOCK_URL` /
 * `DARIO_REFRESH_LOCK_TOKEN` — under three more endpoints, implemented by
 * both reference backends (redis-lock/, cloudflare/refresh-lock/):
 *
 *   POST /pool/seat/<alias>        { instance, at, snapshot, rejected }  → { ok }
 *   POST /pool/seats               { instance }                          → { seats: { alias: SharedSeat } }
 *   POST /pool/sticky/<key>/bind   { alias, ttlMs }                      → { ok }
 *   POST /pool/sticky/<key>/get    {}                                    → { alias | null }
 *
 * An instance reports every reading it takes itself, pulls the others'
 * readings on an interval and adopts any that is newer than its own, and
 * consults the shared sticky bindings before binding a conversation locally.
 * Everything fails open: with the service unreachable an instance behaves
 * exactly as it does with the feature off, and says so once per outage.
 *
 * What crosses the wire is rate-limit snapshots and sticky-key → alias
 * bindings. No token, no message content: the sticky key is a hash of the
 * first user message, the same one the proxy already keeps in memory.
 */

import { randomUUID } from 'node:crypto';
import { describeRateLimitSnapshot, rateLimitWindowPassed } from './pool.js';
import type { AccountPool, RateLimitSnapshot } from './pool.js';

/** One instance's last reading of one seat, as the service stores it. */
export interface SharedSeat {
  instance: string;
  /** Epoch ms the reading was taken (the snapshot's own `updatedAt`). */
  at: number;
  snapshot: RateLimitSnapshot;
  /** Whether that instance holds the seat parked on this reading. */
  rejected: boolean;
}

export interface PoolSyncStatus {
  enabled: true;
  instance: string;
  intervalMs: number;
  lastPullAt: number | null;
  lastOkAt: number | null;
  /** Readings taken from peers, cumulative. */
  adopted: number;
  /** Own readings pushed, cumulative. */
  reported: number;
  stickyPushed: number;
  stickyAdopted: number;
  errors: number;
  lastError: string | null;
}

export interface PoolSyncOptions {
  baseUrl: string;
  token: string;
  /** Identity of this instance in the shared state; random when omitted. */
  instance?: string;
  /** Pull interval, ms. Default 2000. */
  intervalMs?: number;
  /** Sticky binding lifetime on the service, ms. Default 6h (the local TTL). */
  stickyTtlMs?: number;
  log?: (line: string) => void;
}

export const DEFAULT_POOL_SYNC_INTERVAL_MS = 2_000;
/** A peer reading older than this describes windows that have long rolled. */
export const SHARED_SEAT_MAX_AGE_MS = 6 * 3_600_000;
const CALL_TIMEOUT_MS = 3_000;

/**
 * Whether a peer's reading should replace ours: a different instance, a
 * complete record, not stale, and strictly newer than what we hold. A
 * reading we adopted carries the peer's `at` as its `updatedAt`, so the
 * same record is never adopted twice, and our own later reading (newer
 * `updatedAt`) wins until a peer reports something newer still.
 */
export function shouldAdopt(local: RateLimitSnapshot, remote: SharedSeat, me: string, now: number): boolean {
  if (!remote || remote.instance === me) return false;
  if (!remote.snapshot || typeof remote.at !== 'number' || !(remote.at > 0)) return false;
  if (now - remote.at > SHARED_SEAT_MAX_AGE_MS) return false;
  return remote.at > (local.updatedAt || 0);
}

export class PoolSync {
  readonly instance: string;
  readonly intervalMs: number;
  private readonly stickyTtlMs: number;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reporting = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private down = false;
  private stats = { lastPullAt: null as number | null, lastOkAt: null as number | null, adopted: 0, reported: 0, stickyPushed: 0, stickyAdopted: 0, errors: 0, lastError: null as string | null };

  constructor(private readonly pool: AccountPool, opts: PoolSyncOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.instance = opts.instance ?? randomUUID();
    this.intervalMs = Math.max(200, opts.intervalMs ?? DEFAULT_POOL_SYNC_INTERVAL_MS);
    this.stickyTtlMs = opts.stickyTtlMs ?? 6 * 3_600_000;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** Start pulling peers' readings on the interval. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pullOnce(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): PoolSyncStatus {
    return { enabled: true, instance: this.instance, intervalMs: this.intervalMs, ...this.stats };
  }

  /**
   * Push our reading of `alias`. Fire-and-forget and coalesced: while one
   * push for the alias is in flight, further calls mark it dirty and one
   * more push follows with whatever the seat reads then — the latest reading
   * is the only one worth having.
   */
  reportSeat(alias: string): void {
    if (this.reporting.has(alias)) { this.dirty.add(alias); return; }
    const run = async (): Promise<void> => {
      const seat = this.pool.get(alias);
      if (!seat) return;
      const body: SharedSeat = {
        instance: this.instance,
        at: seat.rateLimit.updatedAt || Date.now(),
        snapshot: seat.rateLimit,
        rejected: seat.rateLimit.status === 'rejected',
      };
      const res = await this.call<{ ok?: boolean }>(`/pool/seat/${encodeURIComponent(alias)}`, body);
      if (res) this.stats.reported++;
    };
    const p = run().finally(() => {
      this.reporting.delete(alias);
      if (this.dirty.delete(alias)) this.reportSeat(alias);
    });
    this.reporting.set(alias, p);
  }

  /** Pull every peer's readings and adopt the newer ones. Returns how many were adopted. */
  async pullOnce(): Promise<number> {
    const now = Date.now();
    this.stats.lastPullAt = now;
    const res = await this.call<{ seats?: Record<string, SharedSeat> }>('/pool/seats', { instance: this.instance });
    if (!res || !res.seats || typeof res.seats !== 'object') return 0;
    let adopted = 0;
    for (const [alias, remote] of Object.entries(res.seats)) {
      const seat = this.pool.get(alias);
      if (!seat) continue;
      if (!shouldAdopt(seat.rateLimit, remote, this.instance, now)) continue;
      const wasParked = seat.rateLimit.status === 'rejected' && !rateLimitWindowPassed(seat.rateLimit, now);
      if (!this.pool.adoptSnapshot(alias, remote.snapshot, remote.rejected, remote.instance)) continue;
      adopted++;
      // Same event the proxy logs for its own 429s (dario#1244), so a seat
      // leaving rotation is visible on every instance, not only the one that
      // took the 429.
      if (remote.rejected && !wasParked) {
        this.log(`[dario] seat "${alias}" parked by peer ${remote.instance}'s reading: ${describeRateLimitSnapshot(remote.snapshot, now)} — parked until the window rolls`);
      }
    }
    this.stats.adopted += adopted;
    return adopted;
  }

  /** The alias a peer bound this conversation to, or null. */
  async lookupSticky(key: string): Promise<string | null> {
    const res = await this.call<{ alias?: string | null }>(`/pool/sticky/${encodeURIComponent(key)}/get`, {});
    const alias = res?.alias;
    if (typeof alias === 'string' && alias.length > 0) { this.stats.stickyAdopted++; return alias; }
    return null;
  }

  /** Publish a binding so a peer that sees the conversation next lands on the same seat. A null key (no conversation) is a no-op. */
  bindSticky(key: string | null, alias: string): void {
    if (!key) return;
    void this.call<{ ok?: boolean }>(`/pool/sticky/${encodeURIComponent(key)}/bind`, { alias, ttlMs: this.stickyTtlMs })
      .then((res) => { if (res) this.stats.stickyPushed++; });
  }

  /**
   * One POST to the service. Null on any failure — the caller carries on
   * with local state, which is the whole contract: an outage of the
   * coordination point must never stop the proxy serving. Logged once per
   * transition into and out of the failed state, not per call.
   */
  private async call<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = (await res.json()) as T;
      this.stats.lastOkAt = Date.now();
      if (this.down) {
        this.down = false;
        this.log(`[dario] pool shared state: service reachable again (${this.baseUrl})`);
      }
      return out;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      if (!this.down) {
        this.down = true;
        this.log(`[dario] pool shared state: ${this.baseUrl} unreachable (${this.stats.lastError}) — carrying on with this instance's own state until it answers again`);
      }
      return null;
    }
  }
}

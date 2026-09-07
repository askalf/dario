/**
 * Bounded request queue — replaces the simple in-process semaphore so that
 * overload conditions are visible and tunable instead of silently queuing
 * unbounded or rejecting with generic 429s before upstream had a chance.
 *
 * Three knobs:
 *   - maxConcurrent : in-flight requests allowed at once (default 10)
 *   - maxQueued     : buffered requests waiting for a concurrency slot
 *                     (default 128); beyond this, the queue is "full" and
 *                     admission is rejected with a clear 429 body.
 *   - queueTimeoutMs: how long a queued request waits before it 504s with
 *                     a "queue-timeout" reason (default 60_000).
 *
 * Behaviour:
 *   - active < maxConcurrent → admit immediately
 *   - else, queued < maxQueued → enqueue
 *   - else → reject with `queue-full`
 *   - queued > queueTimeoutMs → reject with `queue-timeout`
 *
 * The decision logic is split out as a pure `decideAdmit(state)` function so
 * tests can exercise all three branches without side effects or timers.
 *
 * dario#80 (Gemini review push-back).
 */

export interface QueueState {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

/**
 * QueueState plus the one derived field a monitor actually needs (dario#905).
 *
 * #910 put `active` / `queued` on /health so slot exhaustion stopped being
 * invisible. But a raw sample cannot distinguish the 14h wedge from a healthy
 * one-second burst — both read `active === maxConcurrent, queued > 0`. Polling
 * fast enough to tell them apart is the monitor's problem, and it shouldn't be.
 *
 * The distinguishing signal is TURNOVER, not depth. A busy dario runs at its
 * cap with a backlog all day and is perfectly healthy, because slots keep
 * being released. The #905 wedge held `active` at `maxConcurrent` for hours
 * with no release at all.
 *
 * So `stalledSince` is the epoch ms since which the queue has been at capacity
 * with requests waiting AND NOT ONE SLOT HAS BEEN RELEASED. Any release resets
 * it. Null when the queue isn't at capacity. A non-null value older than a
 * request could plausibly take means slots are not turning over — one sample
 * is enough to see it, and sustained legitimate load never trips it.
 *
 * This is also why the serving probe deliberately doesn't take a slot: the
 * concurrency axis is covered here, for free and without false positives.
 */
export interface QueueSnapshot extends QueueState {
  stalledSince: number | null;
  /** Per-consumer in-flight ceiling (`--max-concurrent-per-consumer`); 0 = off. */
  maxConcurrentPerConsumer: number;
  /** Distinct consumers with a request in flight right now. */
  consumersActive: number;
}

export type AdmitDecision =
  | { action: 'admit' }
  | { action: 'enqueue' }
  | { action: 'reject'; reason: 'queue-full' };

/** Pure admission decision — no side effects, no clock dep. */
export function decideAdmit(state: QueueState): AdmitDecision {
  if (state.active < state.maxConcurrent) return { action: 'admit' };
  if (state.queued < state.maxQueued) return { action: 'enqueue' };
  return { action: 'reject', reason: 'queue-full' };
}

/**
 * Pure per-consumer gate (dario#1244 follow-up — a team gateway where one
 * heavy user could hold every slot). A consumer already holding `cap` slots
 * waits even when the queue has room: `enqueue` if it does, `reject` if
 * not. Returns null when the gate does not apply (cap off, or the consumer
 * is under it), so `decideAdmit` decides as before.
 */
export function decideConsumerAdmit(activeForConsumer: number, cap: number, state: QueueState): AdmitDecision | null {
  if (cap <= 0 || activeForConsumer < cap) return null;
  if (state.queued < state.maxQueued) return { action: 'enqueue' };
  return { action: 'reject', reason: 'queue-full' };
}

/** Pure timeout check — separated so tests can pass an explicit clock. */
export function isQueueEntryExpired(enqueuedAt: number, now: number, timeoutMs: number): boolean {
  return (now - enqueuedAt) > timeoutMs;
}

export class QueueFullError extends Error {
  constructor() { super('queue-full'); this.name = 'QueueFullError'; }
}
export class QueueTimeoutError extends Error {
  constructor() { super('queue-timeout'); this.name = 'QueueTimeoutError'; }
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Who the request is for, when the caller named one. */
  consumer?: string;
}

export interface RequestQueueOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
  /**
   * In-flight ceiling per consumer (see `acquire(consumer)`). 0 / unset =
   * off. A consumer at its cap waits in the queue; its waiters never block
   * another consumer's — `release` admits the first waiter whose consumer
   * is under the cap, not the first waiter.
   */
  maxConcurrentPerConsumer?: number;
  /**
   * Whether timeout timers are `unref`'d so they don't by themselves keep
   * the Node event loop alive. Default `true` — appropriate for the proxy,
   * where a leaked queue entry should never hang shutdown. Pass `false` in
   * tests where the queue is the only pending work on the loop: an
   * `unref`'d timer won't fire in that case (Node exits with "unsettled
   * top-level await" before the 50ms timeout elapses), so the reject the
   * test is waiting for never arrives.
   */
  unrefTimers?: boolean;
  /** Clock source for `saturatedSince`. Injectable so tests need no timers. */
  now?: () => number;
}

export const DEFAULT_MAX_CONCURRENT = 10;
export const DEFAULT_MAX_QUEUED = 128;
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;

export class RequestQueue {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly queueTimeoutMs: number;
  readonly maxConcurrentPerConsumer: number;
  readonly unrefTimers: boolean;
  private active = 0;
  private activeByConsumer = new Map<string, number>();
  private queue: QueueEntry[] = [];
  private readonly now: () => number;
  private stalledSince: number | null = null;

  constructor(opts: RequestQueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.maxConcurrentPerConsumer = Math.max(0, opts.maxConcurrentPerConsumer ?? 0);
    this.unrefTimers = opts.unrefTimers ?? true;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Re-evaluate the stall stamp. Called after every state change, so it marks
   * when the stall BEGAN rather than when it was last observed — a caller that
   * never polls still reads an accurate duration.
   *
   * Arrivals must NOT refresh the stamp: under a steady arrival rate that
   * would reset the clock continuously and hide a permanent wedge. Only
   * `release()` refreshes it, by clearing first (see there).
   */
  private updateStall(): void {
    const atCapacity = this.active >= this.maxConcurrent && this.queue.length > 0;
    if (!atCapacity) { this.stalledSince = null; return; }
    if (this.stalledSince === null) this.stalledSince = this.now();
  }

  /** A consumer is under its cap when there is no cap, no consumer, or room. */
  private underCap(consumer: string | undefined): boolean {
    if (!consumer || this.maxConcurrentPerConsumer <= 0) return true;
    return (this.activeByConsumer.get(consumer) ?? 0) < this.maxConcurrentPerConsumer;
  }

  private admit(consumer: string | undefined): void {
    this.active++;
    if (consumer) this.activeByConsumer.set(consumer, (this.activeByConsumer.get(consumer) ?? 0) + 1);
    this.updateStall();
  }

  /**
   * Acquire a concurrency slot. Resolves when admitted; throws
   * `QueueFullError` when the queue is at its `maxQueued` cap, throws
   * `QueueTimeoutError` when a queued request waited longer than
   * `queueTimeoutMs`. `consumer` names who the request is for: with a
   * per-consumer cap set, a consumer at its cap waits even while slots are
   * free, and `release(consumer)` must be called with the same name.
   */
  async acquire(consumer?: string): Promise<void> {
    const state = this.snapshot();
    const gated = consumer ? decideConsumerAdmit(this.activeByConsumer.get(consumer) ?? 0, this.maxConcurrentPerConsumer, state) : null;
    const decision = gated ?? decideAdmit(state);
    if (decision.action === 'admit') {
      this.admit(consumer);
      return;
    }
    if (decision.action === 'reject') {
      throw new QueueFullError();
    }
    return new Promise<void>((resolve, reject) => {
      const enqueuedAt = this.now();
      const timeoutHandle = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          this.updateStall();
          reject(new QueueTimeoutError());
        }
      }, this.queueTimeoutMs);
      // Keep the timer from pinning the event loop open on shutdown. A queued
      // request waiting for a slot shouldn't by itself keep the process alive.
      // Opt-out for tests — see `unrefTimers` comment in RequestQueueOptions.
      if (this.unrefTimers) timeoutHandle.unref?.();
      const entry: QueueEntry = { resolve, reject, enqueuedAt, timeoutHandle, consumer };
      this.queue.push(entry);
      this.updateStall();
    });
  }

  /**
   * Release a slot. The first queued entry whose consumer is under its cap is
   * admitted — FIFO among the admissible, so a capped consumer's waiters do
   * not hold up anyone else's; they get in when that consumer releases.
   */
  release(consumer?: string): void {
    if (this.active > 0) this.active--;
    if (consumer) {
      const left = (this.activeByConsumer.get(consumer) ?? 0) - 1;
      if (left <= 0) this.activeByConsumer.delete(consumer); else this.activeByConsumer.set(consumer, left);
    }
    const idx = this.queue.findIndex((e) => this.underCap(e.consumer));
    if (idx >= 0) {
      const [next] = this.queue.splice(idx, 1);
      clearTimeout(next!.timeoutHandle);
      this.admit(next!.consumer);
      next!.resolve();
    }
    // A release IS turnover — the thing whose absence defines the wedge — so
    // clear the stamp unconditionally before re-evaluating. A queue that is
    // still at capacity immediately starts a FRESH stall window, which is why
    // a saturated-but-flowing dario never accumulates age here while a
    // genuinely wedged one does.
    this.stalledSince = null;
    this.updateStall();
  }

  /** Snapshot of queue state — exposed for /health + /analytics + tests. */
  snapshot(): QueueSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      stalledSince: this.stalledSince,
      maxConcurrentPerConsumer: this.maxConcurrentPerConsumer,
      consumersActive: this.activeByConsumer.size,
    };
  }
}

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
}

export interface RequestQueueOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
}

export const DEFAULT_MAX_CONCURRENT = 10;
export const DEFAULT_MAX_QUEUED = 128;
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;

export class RequestQueue {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly queueTimeoutMs: number;
  private active = 0;
  private queue: QueueEntry[] = [];

  constructor(opts: RequestQueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  }

  /**
   * Acquire a concurrency slot. Resolves when admitted; throws
   * `QueueFullError` when the queue is at its `maxQueued` cap, throws
   * `QueueTimeoutError` when a queued request waited longer than
   * `queueTimeoutMs`.
   */
  async acquire(): Promise<void> {
    const decision = decideAdmit(this.snapshot());
    if (decision.action === 'admit') {
      this.active++;
      return;
    }
    if (decision.action === 'reject') {
      throw new QueueFullError();
    }
    return new Promise<void>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const timeoutHandle = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new QueueTimeoutError());
        }
      }, this.queueTimeoutMs);
      // Keep the timer from pinning the event loop open on shutdown. A queued
      // request waiting for a slot shouldn't by itself keep the process alive.
      timeoutHandle.unref?.();
      const entry: QueueEntry = { resolve, reject, enqueuedAt, timeoutHandle };
      this.queue.push(entry);
    });
  }

  /** Release a slot. The next queued entry (if any) is admitted in FIFO order. */
  release(): void {
    if (this.active > 0) this.active--;
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timeoutHandle);
      this.active++;
      next.resolve();
    }
  }

  /** Snapshot of queue state — exposed for /analytics + tests. */
  snapshot(): QueueState {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }
}

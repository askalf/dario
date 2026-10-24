/**
 * The upstream timeout, in two phases.
 *
 * Until the response starts streaming, `ms` caps the whole wait: connect,
 * send, and the time to first byte (a retry inside the same request counts
 * against the same budget). Once a 2xx body is being read, `ms` is the
 * longest gap allowed between two chunks instead. A single timer armed for
 * the whole request used to abort agent turns that were still streaming
 * after five minutes (max_tokens is 64000), and the mid-stream guard then
 * re-sent the full prompt to continue, or truncated an open tool_use block.
 * A stream that stops sending still dies `ms` after its last chunk.
 *
 * `touch()` runs once per chunk, so it only records the time: the timer is
 * re-armed for the remainder when it fires early, not on every chunk.
 */
import { clampTimerMs } from './timer-ms.js';

/** Injectable clock and timers; tests drive them by hand. */
export interface DeadlineTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** A monotonic ms clock: a wall-clock jump must not end a live stream. */
  now: () => number;
}

const defaultTimers: DeadlineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export interface UpstreamDeadline {
  /**
   * The response is a 2xx and its body is about to be read: from here `ms`
   * is an idle gap, counted from now. Only the first call has an effect.
   */
  streaming(): void;
  /** A chunk arrived from upstream. Resets the idle gap; ignored before `streaming()`. */
  touch(): void;
  /** Disarm for good, without calling `onTimeout`. Safe to call more than once. */
  clear(): void;
  /** True once `onTimeout` has run. */
  readonly fired: boolean;
}

/**
 * Arms the headers phase at once. `ms` goes through clampTimerMs, so a value
 * past Node's timer ceiling waits as long as a timer can, not 1 ms.
 */
export function upstreamDeadline(
  ms: number,
  onTimeout: () => void,
  timers: DeadlineTimers = defaultTimers,
): UpstreamDeadline {
  const limit = clampTimerMs(ms);
  let phase: 'headers' | 'idle' | 'done' = 'headers';
  let lastChunkAt = 0;
  let handle: unknown = null;
  let fired = false;

  const disarm = (): void => {
    if (handle !== null) { timers.clearTimeout(handle); handle = null; }
  };
  const arm = (delay: number): void => {
    handle = timers.setTimeout(onFire, clampTimerMs(delay));
  };
  function onFire(): void {
    handle = null;
    if (phase === 'done') return;
    if (phase === 'idle') {
      const idle = timers.now() - lastChunkAt;
      if (idle < limit) { arm(limit - idle); return; }
    }
    phase = 'done';
    fired = true;
    onTimeout();
  }

  arm(limit);
  return {
    streaming() {
      if (phase !== 'headers') return;
      phase = 'idle';
      lastChunkAt = timers.now();
      disarm();
      arm(limit);
    },
    touch() {
      if (phase === 'idle') lastChunkAt = timers.now();
    },
    clear() {
      phase = 'done';
      disarm();
    },
    get fired() { return fired; },
  };
}

/**
 * Delays that reach setTimeout / setInterval from an operator's env var,
 * flag, config file or startProxy option.
 *
 * Node keeps a timer delay in a signed 32-bit int: anything above
 * 2^31 - 1 ms (about 24.8 days), and anything non-finite, is replaced with
 * 1 ms and a TimeoutOverflowWarning. A "very long" setting therefore becomes
 * the shortest one: DARIO_CODEX_USAGE_POLL_MS=3000000000 turned the idle-seat
 * poll into a 1 ms loop of account reloads and /wham/usage calls (dario#1400),
 * and a huge DARIO_SHUTDOWN_GRACE_MS fired the force-exit at once, skipping
 * the drain (dario#1370). Every such delay goes through clampTimerMs first.
 */

/** The longest delay setTimeout and setInterval honour. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `ms` held to [0, MAX_TIMER_MS]: above the ceiling (Infinity included) it is
 * the ceiling, the longest wait a timer can express; negative or NaN is 0.
 */
export function clampTimerMs(ms: number): number {
  if (Number.isNaN(ms) || ms <= 0) return 0;
  return ms >= MAX_TIMER_MS ? MAX_TIMER_MS : ms;
}

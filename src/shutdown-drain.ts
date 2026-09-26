/**
 * Shutdown drain (dario#1370).
 *
 * A SIGTERM used to give in-flight requests five seconds and then exit. The
 * fleet's agent runs are one long streamed response each, so a container
 * recreate — every within-minor autodeploy of a bot release — severed every
 * run that was in flight: three dropped executions in one night, each
 * re-armed a quarter of an hour later with its spend gone.
 *
 * `waitForIdle` is the wait `shutdown` now does between closing the listener
 * and exiting: poll the in-flight count until it reaches zero or the grace
 * runs out. It is pure over its inputs — the count, the clock and the sleep
 * are injected — so the policy is tested without a server or real timers.
 */

/** How long a SIGTERM waits for in-flight requests by default. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 90_000;

/** How often the drain re-reads the in-flight count. */
export const SHUTDOWN_POLL_MS = 250;

export interface DrainOptions {
  /** Longest the drain waits before giving up on the remaining requests. */
  graceMs: number;
  /** Poll interval; defaults to SHUTDOWN_POLL_MS. */
  pollMs?: number;
  /** Clock and sleep, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where the drain narrates; defaults to console.log. */
  log?: (line: string) => void;
}

export interface DrainResult {
  /** True when the in-flight count reached zero within the grace. */
  drained: boolean;
  /** How long the drain waited. */
  waitedMs: number;
  /** In-flight requests left when the drain returned. */
  remaining: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `getActive()` reports no in-flight request, or `graceMs` has
 * passed. Logs once when it starts waiting and once when it stops, never per
 * poll, so a long drain is two lines rather than a scroll.
 */
export async function waitForIdle(getActive: () => number, opts: DrainOptions): Promise<DrainResult> {
  const pollMs = Math.max(1, opts.pollMs ?? SHUTDOWN_POLL_MS);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((line: string) => console.log(line));

  let active = getActive();
  if (active <= 0) return { drained: true, waitedMs: 0, remaining: 0 };

  const started = now();
  log(`[dario] draining ${active} in-flight request(s) before exit (up to ${Math.round(opts.graceMs / 1000)}s)`);
  for (;;) {
    await sleep(pollMs);
    active = getActive();
    const waitedMs = now() - started;
    if (active <= 0) {
      log(`[dario] drained after ${(waitedMs / 1000).toFixed(1)}s`);
      return { drained: true, waitedMs, remaining: 0 };
    }
    if (waitedMs >= opts.graceMs) {
      log(`[dario] still ${active} in flight after ${Math.round(waitedMs / 1000)}s; exiting`);
      return { drained: false, waitedMs, remaining: active };
    }
  }
}

/**
 * The order `shutdown` runs its steps in: `before` and the drain start
 * together, and `after` runs only once the drain has returned.
 *
 * Anything a finishing request writes to belongs in `after`. The ledger
 * refuses rows once closed and an ended log stream drops lines, so closing
 * either before the drain loses exactly the requests the drain waits for:
 * the long streamed runs that finish inside the grace. A step that throws
 * or rejects is skipped; the others still run and shutdown still exits.
 */
export async function drainThenClose(
  drain: () => Promise<unknown>,
  steps: { before?: Array<() => unknown>; after?: Array<() => unknown> },
): Promise<void> {
  const run = (fns: Array<() => unknown> | undefined): Promise<unknown> =>
    Promise.all((fns ?? []).map((fn) => Promise.resolve().then(fn).catch(() => undefined)));
  await Promise.all([run(steps.before), drain().catch(() => undefined)]);
  await run(steps.after);
}

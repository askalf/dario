/**
 * Signal hand-off for the Bun relaunch.
 *
 * Under Node, the CLI relaunches itself under Bun as a child and parks (cli.ts). The
 * child owns the proxy and its graceful shutdown (drain, ledger and key flush), but a
 * SIGTERM sent to the wrapper never reached it. In a container the wrapper is PID 1,
 * and the kernel drops a signal PID 1 has no handler for, so `docker stop` waited out
 * its whole grace period and then SIGKILLed both processes: every recreate took the
 * full stop timeout and the shutdown flush never ran.
 *
 * `forwardSignals` passes SIGTERM and SIGINT on to the child, and `relaunchExitCode`
 * turns the child's exit into the wrapper's. Both take their process and child as
 * arguments, so they are tested without spawning anything.
 */

import { constants } from 'node:os';

/** The signals the wrapper passes on. Each one starts the child's graceful shutdown. */
export const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface RelaunchChild {
  kill(signal: NodeJS.Signals): boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * Pass each forwarded signal on to the child while it is still running. Once the
 * wrapper has a handler it no longer exits on the signal itself: it exits when the
 * child does, through the child's exit listener.
 */
export function forwardSignals(child: RelaunchChild, source: SignalSource = process): void {
  for (const signal of FORWARDED_SIGNALS) {
    source.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }
}

/**
 * The wrapper's exit code for how the child ended: its own code, or 128 plus the
 * signal number when a signal killed it, the way a shell reports it.
 */
export function relaunchExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return 0;
}

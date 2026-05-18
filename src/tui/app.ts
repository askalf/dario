/**
 * The TUI App — main render loop + lifecycle + key dispatch.
 *
 * The shape is deliberately simple: one render function (caller-
 * supplied) that takes `state + dimensions` and returns the full frame
 * as a string. The App drives the loop, manages stdin raw mode, handles
 * resize events, and flushes one write per frame. Tabs (M4) are
 * decoupled state machines that the caller's render() composes.
 *
 * Lifecycle invariants:
 *
 *   - Enters alt-screen on start, leaves on stop. The shell that
 *     spawned dario sees its prior content restored when the TUI quits.
 *   - Hides the cursor on start, restores it on stop. ALWAYS, even on
 *     uncaught exceptions or SIGINT — we install signal + exit hooks.
 *   - Sets stdin raw mode on start, restores it on stop.
 *
 * The hook chain is registered on process events; quit calls them all
 * synchronously so no terminal state leaks out.
 */

import { attachKeyHandler, type Key } from './input.js';
import {
  clearScreen, enterAltScreen, leaveAltScreen, hideCursor, showCursor,
} from './render.js';

export interface AppOptions<S> {
  /**
   * Initial state. The App holds a reference and re-renders when
   * `setState` is called.
   */
  initialState: S;
  /**
   * Pure function: state + dimensions → full screen content.
   * The App calls this on every redraw + flushes the returned string
   * to stdout in a single write.
   */
  render: (state: S, dim: { cols: number; rows: number }) => string;
  /**
   * Key dispatch. Receives every parsed key from stdin (after the
   * App has already handled global keys like Ctrl-C). Return a new
   * state (or undefined for no change) — same shape as React's
   * setState reducer.
   */
  onKey: (state: S, key: Key) => S | undefined;
  /**
   * Optional: called on every redraw after the new frame has been
   * written. Used by tabs that have async data (e.g. SSE-fed Hits
   * tab) to schedule periodic refreshes.
   */
  afterFrame?: (state: S) => void;
  /**
   * stdin / stdout — overridable for tests. Defaults to process.stdin
   * and process.stdout.
   */
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export class App<S> {
  private state: S;
  private renderFn: AppOptions<S>['render'];
  private keyFn: AppOptions<S>['onKey'];
  private afterFrameFn?: AppOptions<S>['afterFrame'];
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private cleanupFns: Array<() => void> = [];
  private running = false;
  // Coalesce setState calls that arrive in the same tick — only one
  // redraw per tick regardless of how many setStates fire.
  private redrawScheduled = false;

  constructor(opts: AppOptions<S>) {
    this.state = opts.initialState;
    this.renderFn = opts.render;
    this.keyFn = opts.onKey;
    this.afterFrameFn = opts.afterFrame;
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
  }

  /**
   * Replace state. If the new state differs from the old (shallow
   * equality), schedule a redraw. Tabs use this both for synchronous
   * key-driven updates and for async data arrivals (SSE 'record').
   *
   * The "differs" check is intentionally shallow — deep equality on
   * potentially-large analytics records would be expensive and the
   * caller almost always passes new object identity when it mutates.
   * If you mutate state in place and don't change identity, the
   * redraw won't fire (this is documented; sometimes desired).
   */
  setState(updater: Partial<S> | ((s: S) => S)): void {
    const next = typeof updater === 'function'
      ? (updater as (s: S) => S)(this.state)
      : { ...this.state, ...updater };
    if (next !== this.state) {
      this.state = next as S;
      this.scheduleRedraw();
    }
  }

  /** Read-only state accessor — for callers that need to compute next state from current. */
  getState(): S {
    return this.state;
  }

  /**
   * Start the TUI: enter alt-screen, hide cursor, raw stdin, attach
   * resize listener, render once, then idle until stop() or process
   * exit.
   *
   * Returns a Promise that resolves when stop() is called. Wires
   * process exit / signal hooks so a Ctrl-C / kill leaves the
   * terminal sane.
   */
  start(): Promise<void> {
    if (this.running) throw new Error('TUI already running');
    this.running = true;

    // Enter alt-screen + hide cursor in one write so the terminal
    // doesn't briefly show a normal screen with a hidden cursor.
    this.stdout.write(enterAltScreen + hideCursor + clearScreen);

    // Raw-mode key handler
    try {
      const detachKeys = attachKeyHandler(this.stdin, (key) => {
        // Global keys handled by the App itself; everything else
        // falls through to the user's onKey reducer.
        if (key.name === 'printable' && key.ctrl && key.ch === 'c') {
          // Ctrl-C → quit
          this.stop();
          return;
        }
        if (key.name === 'printable' && key.ctrl && key.ch === 'l') {
          // Ctrl-L → forced redraw (no state change, but force a
          // re-render which also re-clears the screen — clears any
          // garbage left by misbehaving processes that wrote past the
          // alt-screen boundary)
          this.scheduleRedraw(true);
          return;
        }
        const next = this.keyFn(this.state, key);
        if (next !== undefined && next !== this.state) {
          this.state = next;
          this.scheduleRedraw();
        }
      });
      this.cleanupFns.push(detachKeys);
    } catch (err) {
      // Couldn't attach to stdin (not a TTY). Restore screen state
      // before propagating so we don't leave the terminal in
      // alt-screen mode.
      this.stdout.write(leaveAltScreen + showCursor);
      this.running = false;
      throw err;
    }

    // Window resize → redraw with new dimensions
    const onResize = () => this.scheduleRedraw(true);
    this.stdout.on('resize', onResize);
    this.cleanupFns.push(() => this.stdout.off('resize', onResize));

    // Process-level safety net — any abnormal exit should leave the
    // terminal in a usable state.
    const finalCleanup = () => {
      if (this.running) this.stop();
    };
    process.once('SIGINT', finalCleanup);
    process.once('SIGTERM', finalCleanup);
    process.once('exit', finalCleanup);
    this.cleanupFns.push(() => {
      process.off('SIGINT', finalCleanup);
      process.off('SIGTERM', finalCleanup);
      process.off('exit', finalCleanup);
    });

    // First frame
    this.redraw();

    return new Promise<void>((resolve) => {
      this.cleanupFns.push(() => resolve());
    });
  }

  /** Stop the TUI — restore terminal state and resolve the start() promise. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    // Run cleanup fns in reverse order so most-recent goes first
    // (matches typical resource-stack semantics).
    while (this.cleanupFns.length > 0) {
      const fn = this.cleanupFns.pop()!;
      try { fn(); } catch { /* keep unwinding */ }
    }
    // Final state restore
    this.stdout.write(leaveAltScreen + showCursor);
  }

  private scheduleRedraw(force: boolean = false): void {
    if (this.redrawScheduled && !force) return;
    this.redrawScheduled = true;
    queueMicrotask(() => {
      this.redrawScheduled = false;
      if (!this.running) return;
      this.redraw();
    });
  }

  private redraw(): void {
    const cols = this.stdout.columns ?? 80;
    const rows = this.stdout.rows ?? 24;
    const frame = this.renderFn(this.state, { cols, rows });
    // Single write — minimizes flicker
    this.stdout.write(clearScreen + frame);
    if (this.afterFrameFn) this.afterFrameFn(this.state);
  }
}

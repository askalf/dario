/**
 * Common interface every tab implements.
 *
 * A tab is a self-contained state machine with:
 *   - its own slice of state (typed locally; opaque to the parent)
 *   - a render function: state + viewport → string
 *   - a key handler: state + key → next state or undefined (no change)
 *   - optional lifecycle hooks for mount / unmount / periodic tick
 *
 * The TuiApp composes a fixed set of tabs; it doesn't dynamically
 * register them at runtime. That keeps the type system happy (each
 * tab's state is statically known to the parent) while still letting
 * each tab evolve independently.
 *
 * Tabs that need to fetch data from the proxy receive a
 * `TabContext` with the ProxyClient. Tabs that don't (e.g. Status,
 * which reads local state only) can ignore it.
 */

import type { Key } from './input.js';
import type { ProxyClient } from './proxy-client.js';

export interface TabContext<S = unknown> {
  /** The proxy HTTP client. Tabs use it to fetch /analytics, subscribe to /analytics/stream, etc. */
  client: ProxyClient;
  /**
   * Update the active tab's state slice. Tabs use this from async
   * callbacks (HTTP responses, SSE messages, timers) — the synchronous
   * render/onKey path returns the next state directly. The parent
   * applies the updater to whatever tab is currently active.
   *
   * Loosely-typed across tab implementations; each tab passes its
   * own S as a generic, the parent's dispatcher takes care of the
   * type-erasure.
   */
  setState: (updater: Partial<S> | ((prev: S) => S)) => void;
  /**
   * Register a cleanup function that runs on tab unmount (user switches
   * away) or App shutdown. Tabs use this to close SSE subscriptions,
   * clear intervals, drop event listeners — anything stateful set up
   * in onMount that won't garbage-collect on its own.
   */
  registerCleanup: (fn: () => void) => void;
}

/**
 * A renderable tab. S is the tab's local state shape. The parent
 * TuiApp holds a record of all tab states and dispatches based on
 * the active tab id.
 */
export interface Tab<S> {
  /** Short id, must be unique. Used as the state-record key. */
  id: string;
  /** Human-readable label rendered in the tab strip. */
  label: string;
  /** Single-letter hotkey to jump to this tab. */
  hotkey?: string;
  /** Build the initial state. Called once on TuiApp construction. */
  initialState(): S;
  /**
   * Render the tab's body region into a single string. Caller passes
   * the dimensions of the body region (NOT the full screen — header,
   * footer, and tab strip are drawn by the parent).
   */
  render(state: S, dim: { cols: number; rows: number }): string;
  /**
   * Handle a keypress. Return the next state (or undefined for no
   * change). Global keys (Tab, q, Ctrl+C, hotkeys) are intercepted
   * by the parent before reaching this; the tab only sees keys the
   * parent didn't claim.
   */
  onKey?(state: S, key: Key): S | undefined;
  /**
   * Run once when this tab becomes active. May fire async work that
   * calls `ctx.setState(...)` to update the slice once the data lands.
   * The synchronous return value (if any) is applied before render.
   */
  onMount?(state: S, ctx: TabContext<S>): S | undefined | Promise<S | undefined>;
  /** Run once when this tab loses focus (user switched tabs). */
  onUnmount?(state: S): void;
  /**
   * Called by the parent's heartbeat (every 100ms by default). Tabs
   * that need periodic refresh (Analytics polling, Hits stale-check)
   * consult their state and decide whether to act. Don't do
   * expensive work synchronously here; kick off async + call
   * ctx.setState when it lands.
   */
  onTick?(state: S, ctx: TabContext<S>): void;
}

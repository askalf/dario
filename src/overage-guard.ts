/**
 * Overage-guard — halt the proxy on the first `representative-claim: overage`
 * response to prevent silent API-rate bleed.
 *
 * Subscribers should never see a single overage hit during normal
 * operation. One means something is wrong (wire-shape drift, classifier
 * change, account misconfig, billing-flip after a CC release) and
 * continuing to forward requests bleeds against per-token billing.
 *
 * The guard subscribes to the Analytics record stream — every completed
 * request emits a record carrying its `claim` (raw representative-claim
 * value). When `claim === 'overage'` lands, the guard transitions to a
 * halted state and emits a `'halt'` event. The HTTP request path checks
 * `isHalted()` on every incoming request and returns 503 with an
 * Anthropic-shaped error body when halted.
 *
 * Resume paths:
 *   - explicit:  `dario resume` CLI → POST /admin/resume → `clear('manual')`
 *   - automatic: cooldown expires (default 30 min) → `clear('cooldown')`
 *   - TUI:       `r` key on Status tab → POST /admin/resume (same as CLI)
 *
 * Behavior:
 *   - `halt` (default) — record halted state + return 503 on subsequent requests
 *   - `warn` — emit events + notify only; proxy keeps forwarding (visibility-only mode)
 *
 * See dario#288.
 */

import { EventEmitter } from 'node:events';
import type { Analytics, RequestRecord } from './analytics.js';

export interface HaltState {
  since: number;
  cooldownUntil: number;
  reason: 'overage_detected';
  request: {
    timestamp: number;
    model: string;
    account: string;
    claim: string;
  };
}

export interface OverageGuardOptions {
  enabled: boolean;
  behavior: 'halt' | 'warn';
  cooldownMs: number;
  notifyOs: boolean;
  /**
   * Best-effort native desktop notification dispatcher. Pass the function
   * from `./notify.ts` here. Optional — silent failure if absent. The
   * guard always emits the `'halt'` event for in-process subscribers
   * (the SSE stream, the TUI) regardless of whether OS-notify fired.
   */
  notifier?: (title: string, message: string) => void;
}

export class OverageGuard extends EventEmitter {
  private opts: OverageGuardOptions;
  private halted: HaltState | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private analyticsListener: ((r: RequestRecord) => void) | null = null;

  constructor(opts: OverageGuardOptions) {
    super();
    // /analytics/stream + TUI tabs each register a listener; the in-proc
    // event listeners ceiling matches the Analytics class's choice.
    this.setMaxListeners(100);
    this.opts = opts;
  }

  /**
   * Subscribe to an Analytics instance. Every record emitted with
   * `claim === 'overage'` triggers halt (when behavior === 'halt') or a
   * warn-only event (when behavior === 'warn').
   *
   * Idempotent — calling attach() a second time replaces the listener
   * rather than stacking; useful for tests.
   */
  attach(analytics: Analytics): void {
    if (this.analyticsListener) {
      analytics.off('record', this.analyticsListener);
    }
    if (!this.opts.enabled) {
      // Guard fully disabled — don't even register the listener. No
      // detection, no halt, no events.
      this.analyticsListener = null;
      return;
    }
    this.analyticsListener = (r: RequestRecord) => {
      if (r.claim === 'overage') {
        this.onOverageDetected(r);
      }
    };
    analytics.on('record', this.analyticsListener);
  }

  /**
   * Synthesize a halt event from a record. Public for the test harness;
   * production code reaches this via attach() + the live Analytics stream.
   */
  onOverageDetected(r: RequestRecord): void {
    if (this.halted) {
      // Already halted — don't re-fire halt events. The original halt
      // state stays in place until cleared. A second overage hit while
      // halted is expected (the client may not have noticed the 503
      // yet); silent.
      return;
    }

    const state: HaltState = {
      since: Date.now(),
      cooldownUntil: Date.now() + this.opts.cooldownMs,
      reason: 'overage_detected',
      request: {
        timestamp: r.timestamp,
        model: r.model,
        account: r.account,
        claim: r.claim,
      },
    };

    if (this.opts.behavior === 'halt') {
      this.halted = state;
      // Schedule auto-resume. Timer reference is held so we can cancel
      // it on a manual resume — otherwise a manual resume followed by
      // continued use, then the original cooldown firing, would emit a
      // spurious second 'resume' event.
      this.cooldownTimer = setTimeout(() => {
        if (this.halted && this.halted.since === state.since) {
          this.clear('cooldown');
        }
      }, this.opts.cooldownMs);
      this.cooldownTimer.unref();
    }

    // Always fire 'halt' (or 'warn') so SSE subscribers see the event
    // even in warn-only mode — the TUI's job is to surface this to the
    // user regardless of whether the proxy chose to block traffic.
    const eventName = this.opts.behavior === 'halt' ? 'halt' : 'warn';
    try {
      this.emit(eventName, state);
    } catch (err) {
      // A subscriber threw — log + swallow, don't crash on event side-effects.
      console.error('[dario] overage-guard subscriber threw:', (err as Error).message);
    }

    if (this.opts.notifyOs && this.opts.notifier) {
      try {
        const title = this.opts.behavior === 'halt' ? 'dario halted' : 'dario warning';
        const msg = `Request classified as 'overage' (per-token billing)${this.opts.behavior === 'halt' ? '. Proxy halted. Run `dario resume` to continue.' : ''}`;
        this.opts.notifier(title, msg);
      } catch {
        // Native notification failure is non-fatal. Already emitted to
        // SSE / TUI; the user gets the in-app banner regardless.
      }
    }
  }

  /**
   * Resume the proxy. Emits a 'resume' event with the reason.
   *
   * No-op when not currently halted. Safe to call from any path
   * (CLI, /admin/resume HTTP endpoint, TUI `r` key, cooldown timer).
   */
  clear(reason: 'manual' | 'cooldown'): void {
    if (!this.halted) return;
    const wasHaltedAt = this.halted.since;
    this.halted = null;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    try {
      this.emit('resume', { reason, previousSince: wasHaltedAt });
    } catch (err) {
      console.error('[dario] overage-guard resume subscriber threw:', (err as Error).message);
    }
  }

  /** Current halt state, or `null` if not halted. */
  state(): HaltState | null {
    return this.halted;
  }

  /** Quick boolean for the request hot-path. */
  isHalted(): boolean {
    return this.halted !== null && this.opts.behavior === 'halt';
  }

  /** Detach from Analytics. Used by tests and by graceful shutdown. */
  destroy(): void {
    this.removeAllListeners();
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.halted = null;
    this.analyticsListener = null;
  }

  /** Expose options for the /status endpoint + TUI Status tab. */
  config(): Readonly<OverageGuardOptions> {
    return this.opts;
  }
}

/**
 * The Anthropic-shaped error body returned by halted-503 responses. The
 * shape matches what `api.anthropic.com` emits for any 4xx so CC /
 * Cursor / Aider / Cline surface the message verbatim to the user — no
 * client-specific handling needed.
 */
export function buildHaltErrorBody(state: HaltState): {
  type: 'error';
  error: { type: string; message: string };
} {
  const isoCooldown = new Date(state.cooldownUntil).toISOString();
  return {
    type: 'error',
    error: {
      type: 'dario_overage_guard',
      message:
        `dario halted to prevent API-rate bleed. A request was classified ` +
        `as 'overage' (per-token billing) instead of your subscription pool. ` +
        `To resume: run \`dario resume\` in another terminal, or wait until ` +
        `${isoCooldown} for the cooldown to auto-clear. ` +
        `Details: github.com/askalf/dario/issues/288`,
    },
  };
}

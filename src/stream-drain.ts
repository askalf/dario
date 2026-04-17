/**
 * Stream-consumption replay (v3.25, direction #5 — behavioral fidelity).
 *
 * Native Claude Code, when it streams a response from `/v1/messages`, reads
 * the SSE to its final event before closing the socket — even when the
 * consumer logically already has enough. Third-party consumers routed
 * through dario's proxy often abort mid-stream (close their request the
 * instant they see the tool-use content block they wanted). Dario's
 * default has been to propagate that abort upstream by triggering
 * `upstreamAbort.abort()` from the `req.on('close')` handler — clean from
 * a billing standpoint (Anthropic stops generating, stops billing), but a
 * fingerprint axis: "connection closed mid-stream" vs CC's "connection
 * read to EOF" is visible on Anthropic's side.
 *
 * `--drain-on-close` / `DARIO_DRAIN_ON_CLOSE=1` flips the tradeoff: when
 * the downstream client disconnects, dario suppresses the upstream abort
 * and keeps the reader loop spinning until the upstream emits its final
 * event (or `UPSTREAM_TIMEOUT_MS` fires as a hard ceiling — we don't
 * linger on dead upstreams). Writes to the closed `res` are gated off;
 * the reads and any accumulator state (analytics, tool-map) continue so
 * the captured usage numbers are complete rather than truncated.
 *
 * This has a real cost — you pay tokens for a response your consumer
 * isn't going to read — so it's deliberately opt-in. Users on an
 * unmetered subscription who care more about fingerprint than wasted
 * generation can flip it on globally.
 *
 * This module exposes the *decision* as a pure function so the test
 * suite can exercise every branch without spinning up a socket. The
 * proxy wires the decision into its existing `onClientClose` handler.
 */

export type ClientCloseAction = 'abort' | 'drain' | 'noop';

/**
 * Decide what `onClientClose` should do when the client's `req.on('close')`
 * fires. Pure over its three inputs.
 *
 *   `writableEnded`      — `res.writableEnded` at the moment the handler
 *                          runs. `true` means the response is already
 *                          finished (the 'close' event is a normal
 *                          teardown notification after res.end()) — no
 *                          action needed.
 *   `upstreamAborted`    — whether upstream has already been aborted for
 *                          some other reason (timeout, overflow, pool
 *                          failover). Don't double-abort.
 *   `drainOnClose`       — the runtime-configured knob.
 *
 * Returns:
 *   `'noop'`  — already finished / already aborted; handler should return.
 *   `'abort'` — fire `upstreamAbort.abort()` (the v3.24-and-earlier default).
 *   `'drain'` — leave upstream alive; gate off client writes; let the
 *               read loop consume to EOF (bounded by UPSTREAM_TIMEOUT_MS).
 */
export function decideOnClientClose(
  writableEnded: boolean,
  upstreamAborted: boolean,
  drainOnClose: boolean,
): ClientCloseAction {
  if (writableEnded || upstreamAborted) return 'noop';
  return drainOnClose ? 'drain' : 'abort';
}

/**
 * Resolve the `drainOnClose` effective setting from explicit options +
 * `DARIO_DRAIN_ON_CLOSE` env var. Truthy env values: `'1'`, `'true'`,
 * `'yes'` (case-insensitive). Anything else (including unset) is false.
 * Explicit `true`/`false` on the options object always wins.
 */
export function resolveDrainOnClose(
  explicit: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const v = (env.DARIO_DRAIN_ON_CLOSE ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

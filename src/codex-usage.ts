/**
 * ChatGPT-seat utilisation, the Codex twin of the Claude pool's unified
 * rate-limit readings. Every Responses answer carries
 * `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}` (reset
 * in unix seconds; the family codex-rs/codex-api/src/rate_limits.rs parses),
 * and `/backend-api/wham/usage` answers the same without a model call.
 * Window shapes vary by plan (prolite: one weekly window), so nothing assumes
 * which slot is which. Pure and memory-only, so codex-accounts and
 * codex-backend can both import it without a cycle.
 */

import { clampTimerMs } from './timer-ms.js';

export interface CodexUsageWindow {
  /** As reported, 0–100. */
  usedPercent: number;
  /** Window length, when the backend states it. */
  windowMinutes: number | null;
  /** When the window rolls over, epoch ms. */
  resetAt: number | null;
}

export interface CodexUsage {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  /** The backend's own "you are at the limit" flag: a reached-type header, or `limit_reached` on the usage endpoint. */
  limitReached: string | null;
  observedAt: number;
  source: 'headers' | 'usage-endpoint';
}

/** Anything with a `get(name)` — a fetch `Headers`, or a stub in tests. */
export interface HeaderReader {
  get(name: string): string | null;
}

function finite(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/** Unix seconds → epoch ms. A value already in ms (> ~2286 in seconds) passes through. */
function toMs(raw: unknown): number | null {
  const n = finite(raw);
  if (n === null) return null;
  return n > 1e12 ? n : n * 1000;
}

function headerWindow(h: HeaderReader, prefix: string): CodexUsageWindow | null {
  const used = finite(h.get(`${prefix}-used-percent`));
  if (used === null) return null;
  const windowMinutes = finite(h.get(`${prefix}-window-minutes`));
  // A one-window plan sends the unused slot zeroed with an empty reset: no window, not 0%.
  if (windowMinutes !== null && windowMinutes <= 0) return null;
  return { usedPercent: used, windowMinutes, resetAt: toMs(h.get(`${prefix}-reset-at`)) };
}

/**
 * Read the default (`codex`) rate-limit header family off a backend response.
 * Null when the response carries no usage at all (an error body from a proxy
 * in front, a stub), so a header-less response never erases a real reading.
 */
export function parseCodexUsageHeaders(h: HeaderReader, now: number = Date.now()): CodexUsage | null {
  const primary = headerWindow(h, 'x-codex-primary');
  const secondary = headerWindow(h, 'x-codex-secondary');
  if (!primary && !secondary) return null;
  const reached = h.get('x-codex-rate-limit-reached-type');
  return { primary, secondary, limitReached: reached && reached.trim() ? reached.trim() : null, observedAt: now, source: 'headers' };
}

interface UsageEndpointWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

function endpointWindow(w: UsageEndpointWindow | null | undefined, now: number): CodexUsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  const used = finite(w.used_percent);
  if (used === null) return null;
  const secs = finite(w.limit_window_seconds);
  let resetAt = toMs(w.reset_at);
  if (resetAt === null) {
    const after = finite(w.reset_after_seconds);
    if (after !== null) resetAt = now + after * 1000;
  }
  return { usedPercent: used, windowMinutes: secs === null ? null : Math.round(secs / 60), resetAt };
}

/** Read a `GET /backend-api/wham/usage` body. Null when it carries no window. */
export function parseCodexUsageEndpoint(body: unknown, now: number = Date.now()): CodexUsage | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { rate_limit?: { primary_window?: UsageEndpointWindow | null; secondary_window?: UsageEndpointWindow | null; limit_reached?: unknown }; rate_limit_reached_type?: unknown };
  const rl = b.rate_limit;
  if (!rl || typeof rl !== 'object') return null;
  const primary = endpointWindow(rl.primary_window, now);
  const secondary = endpointWindow(rl.secondary_window, now);
  if (!primary && !secondary) return null;
  const type = typeof b.rate_limit_reached_type === 'string' && b.rate_limit_reached_type ? b.rate_limit_reached_type : null;
  const limitReached = type ?? (rl.limit_reached === true ? 'limit_reached' : null);
  return { primary, secondary, limitReached, observedAt: now, source: 'usage-endpoint' };
}

/** How often an IDLE seat is re-read from /wham/usage. A seat that is serving is read from every answer and never polled. */
export const DEFAULT_CODEX_USAGE_POLL_MS = 30 * 60 * 1000;

/**
 * `DARIO_CODEX_USAGE_POLL_MS`: unset/garbage → default, `0` → off, anything
 * else floored at one minute and capped at the longest interval a timer can
 * hold (timer-ms.ts), since a larger one fires every millisecond.
 */
export function resolveCodexUsagePollMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CODEX_USAGE_POLL_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CODEX_USAGE_POLL_MS;
  if (n === 0) return 0;
  return clampTimerMs(Math.max(60_000, Math.round(n)));
}

const readings = new Map<string, CodexUsage>();

/** Record a reading for a seat. A newer reading replaces an older one; an older one never replaces a newer one. */
export function recordCodexUsage(alias: string, usage: CodexUsage): void {
  const prev = readings.get(alias);
  if (prev && prev.observedAt > usage.observedAt) return;
  readings.set(alias, usage);
}

/** The response hook: parse and record in one call; a header-less response changes nothing. */
export function noteCodexUsageHeaders(alias: string, h: HeaderReader, now: number = Date.now()): void {
  const u = parseCodexUsageHeaders(h, now);
  if (u) recordCodexUsage(alias, u);
}

export function codexUsageFor(alias: string): CodexUsage | null {
  return readings.get(alias) ?? null;
}

/** Test seam. */
export function _resetCodexUsageForTest(): void {
  readings.clear();
}

/** A window whose reset time has passed has rolled over: it counts as empty until the next reading says otherwise. */
function effectiveUsed(w: CodexUsageWindow | null, now: number): number | null {
  if (!w) return null;
  if (w.resetAt !== null && w.resetAt <= now) return 0;
  return Math.min(100, Math.max(0, w.usedPercent));
}

/**
 * Fraction of the tightest window still available, 0–1; null when the seat
 * has no reading. A reached-limit flag reads as 0 until every window it could
 * refer to has rolled.
 */
export function codexHeadroom(alias: string, now: number = Date.now()): number | null {
  const u = readings.get(alias);
  if (!u) return null;
  const used = [effectiveUsed(u.primary, now), effectiveUsed(u.secondary, now)].filter((x): x is number => x !== null);
  if (used.length === 0) return null;
  const rolled = [u.primary, u.secondary].every((w) => !w || (w.resetAt !== null && w.resetAt <= now));
  if (u.limitReached && !rolled) return 0;
  return (100 - Math.max(...used)) / 100;
}

/**
 * When the seat's LONGEST window rolls over, epoch ms, if it is still ahead —
 * the codex mirror of the Claude pool's 7-day reset, for `expiring-first`.
 */
export function codexLongWindowResetAt(alias: string, now: number = Date.now()): number | null {
  const u = readings.get(alias);
  if (!u) return null;
  const windows = [u.primary, u.secondary].filter((w): w is CodexUsageWindow => w !== null);
  if (windows.length === 0) return null;
  const longest = windows.reduce((a, b) => ((b.windowMinutes ?? 0) > (a.windowMinutes ?? 0) ? b : a));
  return longest.resetAt !== null && longest.resetAt > now ? longest.resetAt : null;
}

/** The JSON shape surfaces print: numbers plus ISO times, never a credential. */
export interface CodexUsageView {
  headroom: number | null;
  limitReached: string | null;
  source: CodexUsage['source'];
  observedAt: string;
  windows: Array<{ slot: 'primary' | 'secondary'; usedPercent: number; windowMinutes: number | null; resetAt: string | null }>;
}

export function codexUsageView(alias: string, now: number = Date.now()): CodexUsageView | null {
  const u = readings.get(alias);
  if (!u) return null;
  const windows: CodexUsageView['windows'] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = u[slot];
    if (w) windows.push({ slot, usedPercent: w.usedPercent, windowMinutes: w.windowMinutes, resetAt: w.resetAt === null ? null : new Date(w.resetAt).toISOString() });
  }
  return { headroom: codexHeadroom(alias, now), limitReached: u.limitReached, source: u.source, observedAt: new Date(u.observedAt).toISOString(), windows };
}

/** "6% of 7d, resets in 6d 22h" — one window, human-sized. */
export function describeCodexWindow(w: { usedPercent: number; windowMinutes: number | null; resetAt: string | number | null }, now: number = Date.now()): string {
  const mins = w.windowMinutes;
  const span = mins === null ? 'window' : mins >= 1440 ? `${Math.round(mins / 1440)}d` : mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  const resetMs = w.resetAt === null ? null : typeof w.resetAt === 'number' ? w.resetAt : Date.parse(w.resetAt);
  let reset = '';
  if (resetMs !== null && Number.isFinite(resetMs)) {
    const left = resetMs - now;
    if (left <= 0) reset = ', rolled over';
    else {
      const h = Math.floor(left / 3_600_000);
      reset = h >= 24 ? `, resets in ${Math.floor(h / 24)}d ${h % 24}h` : `, resets in ${h}h ${Math.floor((left % 3_600_000) / 60_000)}m`;
    }
  }
  return `${Math.round(w.usedPercent)}% of ${span}${reset}`;
}

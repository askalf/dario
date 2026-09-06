/**
 * Refresh-token grant age.
 *
 * Anthropic's OAuth refresh token has a hard lifetime measured from the
 * ORIGINAL grant, not from the last rotation. A seat that refreshed every 8h
 * for four weeks still died with `invalid_grant "Refresh token expired"`
 * 28 days 10 hours after its grant (observed 2026-09-05; the only data point,
 * hence the conservative defaults below). The token itself is opaque and the
 * token endpoint reports no refresh expiry, so the calendar is the only
 * signal — and until this module existed dario did not keep the calendar:
 * `grantedAt` is recorded by every code path that performs a grant and
 * preserved across refreshes, and every surface (`/health`, `/accounts`,
 * `dario accounts list`, `dario doctor`, the background refresh loop) reads
 * the age through here.
 *
 * Levels:
 *   ok      age < warn
 *   warn    warn ≤ age < urgent   — re-grant this week
 *   urgent  urgent ≤ age          — re-grant today; the wall is ~lifetime
 *   unknown no grantedAt          — seat minted before this field existed
 *                                   (or hand-installed); re-grant to start
 *                                   the clock
 *
 * All three thresholds are env-tunable so an operator who observes a
 * different wall can move them without a release:
 *   DARIO_REFRESH_GRANT_LIFETIME_DAYS (28)
 *   DARIO_REFRESH_GRANT_WARN_DAYS     (21)
 *   DARIO_REFRESH_GRANT_URGENT_DAYS   (26)
 */

export type GrantLevel = 'ok' | 'warn' | 'urgent' | 'unknown';

export interface GrantThresholds {
  lifetimeDays: number;
  warnDays: number;
  urgentDays: number;
}

export interface GrantAge {
  level: GrantLevel;
  /** Whole days since the grant; null when unknown. */
  ageDays: number | null;
  /** Epoch ms of the projected wall (grantedAt + lifetime); null when unknown. */
  wallAt: number | null;
  /** Whole days until the wall (negative once past it); null when unknown. */
  daysToWall: number | null;
}

const DAY_MS = 86_400_000;

function envDays(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Thresholds from the environment, with the documented defaults. Ordering is
 *  enforced (warn ≤ urgent ≤ lifetime) so a misconfigured pair can never make
 *  a seat skip a level or page after the wall. */
export function grantThresholds(env: NodeJS.ProcessEnv = process.env): GrantThresholds {
  const lifetimeDays = envDays('DARIO_REFRESH_GRANT_LIFETIME_DAYS', 28, env);
  const urgentDays = Math.min(envDays('DARIO_REFRESH_GRANT_URGENT_DAYS', 26, env), lifetimeDays);
  const warnDays = Math.min(envDays('DARIO_REFRESH_GRANT_WARN_DAYS', 21, env), urgentDays);
  return { lifetimeDays, warnDays, urgentDays };
}

/** Age a single grant. `grantedAt` undefined/null/non-finite → unknown. */
export function grantAge(
  grantedAt: number | null | undefined,
  now: number,
  t: GrantThresholds = grantThresholds(),
): GrantAge {
  if (grantedAt === undefined || grantedAt === null || !Number.isFinite(grantedAt) || grantedAt <= 0) {
    return { level: 'unknown', ageDays: null, wallAt: null, daysToWall: null };
  }
  const ageDays = Math.floor(Math.max(0, now - grantedAt) / DAY_MS);
  const wallAt = grantedAt + t.lifetimeDays * DAY_MS;
  const daysToWall = Math.floor((wallAt - now) / DAY_MS);
  const level: GrantLevel = ageDays >= t.urgentDays ? 'urgent' : ageDays >= t.warnDays ? 'warn' : 'ok';
  return { level, ageDays, wallAt, daysToWall };
}

const LEVEL_RANK: Record<GrantLevel, number> = { ok: 0, unknown: 1, warn: 2, urgent: 3 };

/** The level a pool reports as a whole: the worst seat wins. `unknown` ranks
 *  between ok and warn — a pool whose seats are all unstamped is not healthy
 *  knowledge, but it is not a page either. */
export function worstGrantLevel(levels: readonly GrantLevel[]): GrantLevel {
  let worst: GrantLevel = 'ok';
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[worst]) worst = l;
  return worst;
}

/** One-line human summary, shared by `accounts list` and doctor. */
export function describeGrantAge(a: GrantAge, t: GrantThresholds = grantThresholds()): string {
  if (a.level === 'unknown' || a.ageDays === null || a.daysToWall === null) {
    return 'grant date unknown — re-grant to start the ~' + t.lifetimeDays + 'd refresh-token clock';
  }
  const wall = a.daysToWall >= 0 ? `~${a.daysToWall}d to the ~${t.lifetimeDays}d wall` : `${-a.daysToWall}d PAST the ~${t.lifetimeDays}d wall`;
  switch (a.level) {
    case 'ok': return `grant ${a.ageDays}d old, ${wall}`;
    case 'warn': return `grant ${a.ageDays}d old, ${wall} — re-grant this week`;
    case 'urgent': return `grant ${a.ageDays}d old, ${wall} — re-grant TODAY or the seat dies mid-refresh`;
  }
}

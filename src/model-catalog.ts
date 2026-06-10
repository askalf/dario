/**
 * model-catalog.ts — upstream model autodetection with a baked fallback.
 *
 * Single source of truth for "which models does dario advertise". Two
 * problems this solves (operator direction, 2026-06-10):
 *
 *  1. AUTODETECTION. `GET /v1/models` used to serve a hardcoded list that
 *     went stale every time Anthropic shipped a model (fable-5 needed a
 *     manual PR; `opus` was bumped to 4-8 in #389 while `opus1m` silently
 *     stayed on 4-7). The catalog now asks api.anthropic.com/v1/models
 *     what actually exists, TTL-cached, falling back to the baked list
 *     whenever upstream is unreachable — startup, offline, auth-broken,
 *     all serve the same baked set as before.
 *
 *  2. ONE METHOD FOR CONTEXT WINDOWS. The `[1m]` long-context variant was
 *     hand-sprinkled: the listing carried `claude-fable-5[1m]` but no
 *     opus/sonnet variants, while the alias map pinned each `<family>1m`
 *     to a hand-picked id. Now every family goes through the same two
 *     rules: `longContextEligible()` decides which bases take a `[1m]`
 *     variant (everything except haiku — real CC never offers 1M haiku),
 *     and `<family>1m` is DERIVED as `resolve(<family>) + '[1m]'`, so the
 *     pair can never drift apart again.
 *
 * The wire mechanics are unchanged and already uniform: `[1m]` is a
 * client-side label — proxy.ts strips it and rides `context-1m-2025-08-07`
 * on the request (see stripContext1mTag / betaForModel).
 */

import { modelFamily } from './pool.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Baked fallback — the catalog served when upstream has never answered.
 * Base ids only ([1m] variants are generated, never stored). Order is the
 * advertised order: family rank (fable, opus, sonnet, haiku), version desc
 * — the same ordering normalizeUpstreamIds() produces for live data.
 */
export const BAKED_BASE_MODELS: readonly string[] = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/**
 * THE long-context rule — applied identically to every family. A base id
 * takes a `[1m]` variant unless it's the haiku family (CC's picker never
 * offers 1M haiku; it's also the family CC strips the effort and
 * mid-conversation betas from). Already-tagged and non-Claude ids are
 * never eligible.
 */
export function longContextEligible(id: string): boolean {
  const m = id.toLowerCase();
  return m.startsWith('claude-') && !m.includes('haiku') && !m.endsWith('[1m]');
}

/**
 * Expand base ids into the advertised list: each eligible base is followed
 * by its `[1m]` variant (matching the historical fable-5 / fable-5[1m]
 * adjacency), ineligible bases pass through alone.
 */
export function withLongContextVariants(bases: readonly string[]): string[] {
  return bases.flatMap((b) => (longContextEligible(b) ? [b, `${b}[1m]`] : [b]));
}

/** Numeric segments of a model id (`claude-opus-4-8` → [4, 8]) for version ordering. */
export function modelVersionKey(id: string): number[] {
  const nums = id.match(/\d+/g);
  return nums ? nums.map(Number) : [];
}

/** Descending version compare on modelVersionKey output. */
function cmpVersionDesc(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

// Advertised order: CC lists the flagship first, then the big families.
// Unknown future families rank last (still advertised — a brand-new family
// shows up on the next catalog refresh without a dario release).
const FAMILY_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };

// Known families older than this generation are dropped from the advertised
// list (claude-3-x etc. — not what a CC-shaped proxy should offer). fable is
// exempt: its versioning is its own line (fable-5).
const MIN_GENERATION = 4;

/**
 * Normalize a raw upstream id listing into dario's advertised base set:
 *  - keep `claude-*` ids only (no [1m] tags — those are ours to generate)
 *  - drop legacy generations of known families (< 4; fable exempt)
 *  - prefer the CC-style short id when upstream lists both `claude-opus-4-8`
 *    and a dated `claude-opus-4-8-YYYYMMDD`; keep the dated id when it's the
 *    only form
 *  - deterministic order: family rank, then version desc, unknown families last
 */
export function normalizeUpstreamIds(ids: readonly string[]): string[] {
  let list = ids.filter(
    (id) => typeof id === 'string' && /^claude-/i.test(id) && !id.includes('['),
  );

  list = list.filter((id) => {
    const fam = modelFamily(id);
    if (fam === null || fam === 'fable') return true;
    return (modelVersionKey(id)[0] ?? 0) >= MIN_GENERATION;
  });

  const byKey = new Map<string, string>();
  for (const id of list) {
    const key = id.replace(/-\d{8}$/, '').toLowerCase();
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, id);
    } else if (id.toLowerCase() === key && existing.toLowerCase() !== key) {
      byKey.set(key, id); // short form wins over dated duplicate
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const ra = FAMILY_RANK[modelFamily(a) ?? ''] ?? 99;
    const rb = FAMILY_RANK[modelFamily(b) ?? ''] ?? 99;
    if (ra !== rb) return ra - rb;
    return cmpVersionDesc(modelVersionKey(a), modelVersionKey(b));
  });
}

/** Newest base id of a family within a base set, or null if absent. */
export function resolveFamilyBase(family: string, bases: readonly string[]): string | null {
  const candidates = bases.filter((b) => modelFamily(b) === family && !b.includes('['));
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => cmpVersionDesc(modelVersionKey(a), modelVersionKey(b)))[0]!;
}

const FAMILY_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku']);

/**
 * Resolve a family shorthand against a base set. `<family>` → the newest
 * base of that family; `<family>1m` → the SAME base + `[1m]` (one
 * derivation rule for every family — `opus` and `opus1m` can't disagree).
 * Returns null when the name isn't a family shorthand or the family is
 * absent/ineligible — callers fall back to their static map.
 */
export function resolveAliasAgainst(model: string, bases: readonly string[]): string | null {
  const m = model.toLowerCase().trim();
  if (FAMILY_ALIASES.has(m)) return resolveFamilyBase(m, bases);
  const match = m.match(/^([a-z]+)1m$/);
  if (match !== null && FAMILY_ALIASES.has(match[1]!)) {
    const base = resolveFamilyBase(match[1]!, bases);
    return base !== null && longContextEligible(base) ? `${base}[1m]` : null;
  }
  return null;
}

/** OpenAI-shape /v1/models payload for a list of advertised ids. */
export function buildOpenAIModelsList(ids: readonly string[]): {
  object: string;
  data: Array<{ id: string; object: string; created: number; owned_by: string }>;
} {
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'anthropic' })),
  };
}

// ---------------------------------------------------------------------------
// Cached upstream catalog
// ---------------------------------------------------------------------------

export interface ModelCatalog {
  bases: readonly string[];
  source: 'upstream' | 'baked';
  fetchedAt: number; // epoch ms of the successful upstream fetch; 0 for baked
}

export interface CatalogDeps {
  fetchImpl?: typeof fetch;
  /** OAuth bearer source (single-account getAccessToken). Ignored when upstreamApiKey is set. */
  getToken?: () => Promise<string>;
  /** Per-token API pool mode — forwarded as x-api-key, mirroring request-path auth. */
  upstreamApiKey?: string;
  now?: () => number;
  log?: (msg: string) => void;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

export const DEFAULT_CATALOG_TTL_MS = 3_600_000; // 1h — model launches are rare
export const DEFAULT_CATALOG_RETRY_MS = 300_000; // failed-fetch backoff: 5min
const DEFAULT_FETCH_TIMEOUT_MS = 4_000;

let cache: ModelCatalog | null = null;
let lastAttempt = 0;
let inflight: Promise<void> | null = null;

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

async function fetchUpstreamBases(deps: CatalogDeps): Promise<string[]> {
  const f = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (deps.upstreamApiKey) {
    headers['x-api-key'] = deps.upstreamApiKey;
  } else {
    if (!deps.getToken) throw new Error('no token source for catalog fetch');
    headers['authorization'] = `Bearer ${await deps.getToken()}`;
    headers['anthropic-beta'] = OAUTH_BETA;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const res = await f(`${ANTHROPIC_API}/v1/models?limit=100`, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`upstream /v1/models ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (json.data ?? [])
      .map((d) => d?.id)
      .filter((x): x is string => typeof x === 'string');
    const bases = normalizeUpstreamIds(ids);
    if (bases.length === 0) throw new Error('upstream /v1/models returned no usable claude ids');
    return bases;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(deps: CatalogDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  lastAttempt = now();
  const bases = await fetchUpstreamBases(deps);
  cache = { bases, source: 'upstream', fetchedAt: now() };
  deps.log?.(`[dario] model catalog: autodetected ${bases.length} base models upstream`);
}

function maybeRefreshInBackground(deps: CatalogDeps): void {
  const now = (deps.now ?? Date.now)();
  const ttl = deps.ttlMs ?? envInt('DARIO_MODEL_CATALOG_TTL_MS', DEFAULT_CATALOG_TTL_MS);
  const retry = deps.retryMs ?? DEFAULT_CATALOG_RETRY_MS;
  const fresh = cache !== null && cache.source === 'upstream' && now - cache.fetchedAt < ttl;
  if (fresh || inflight !== null || now - lastAttempt < retry) return;
  inflight = refresh(deps)
    .catch((err) => {
      deps.log?.(
        `[dario] model catalog refresh failed: ${(err as Error).message} — keeping ${cache?.source ?? 'baked'} list`,
      );
    })
    .finally(() => {
      inflight = null;
    });
}

/**
 * The catalog, stale-while-revalidate. Warm cache returns immediately
 * (kicking an async refresh when past TTL); a cold start tries upstream
 * once (bounded by timeoutMs) and falls back to the baked list. Never
 * throws — /v1/models must always answer.
 */
export async function getModelCatalog(deps: CatalogDeps = {}): Promise<ModelCatalog> {
  if (cache !== null) {
    maybeRefreshInBackground(deps);
    return cache;
  }
  const now = (deps.now ?? Date.now)();
  const retry = deps.retryMs ?? DEFAULT_CATALOG_RETRY_MS;
  if (now - lastAttempt >= retry) {
    try {
      await refresh(deps);
    } catch (err) {
      deps.log?.(
        `[dario] model catalog fetch failed: ${(err as Error).message} — serving baked list`,
      );
    }
  }
  if (cache === null) cache = { bases: [...BAKED_BASE_MODELS], source: 'baked', fetchedAt: 0 };
  return cache;
}

/**
 * Synchronous view for request-path alias resolution — whatever the last
 * catalog produced, or the baked set before the first fetch completes.
 * Never blocks the hot path on the network.
 */
export function getCachedBases(): readonly string[] {
  return cache?.bases ?? BAKED_BASE_MODELS;
}

/** Fire-and-forget warmup so the first client /v1/models call is served warm. */
export function prewarmModelCatalog(deps: CatalogDeps = {}): void {
  void getModelCatalog(deps);
}

export function _resetModelCatalogForTest(): void {
  cache = null;
  lastAttempt = 0;
  inflight = null;
}

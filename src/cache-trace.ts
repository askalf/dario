/**
 * Cache trace: what a Codex request shares with the previous request on the
 * same `prompt_cache_key`.
 *
 * The backend caches prompt prefixes and reports what it read back as
 * `cached_tokens`, and dario already records that number. What the number
 * cannot say is WHY a turn missed. Three things decide a hit, and each one is
 * visible to dario before the request goes out:
 *
 *   1. time: a cache write takes seconds to become readable, so a turn that
 *      follows the previous one too closely reads nothing it wrote;
 *   2. shape: a hit needs the previous input to be a strict prefix of this
 *      one, item for item, with the same instructions and tool names in
 *      front of it;
 *   3. seat: the cache is scoped to the serving account, so a conversation
 *      that moved seats starts over.
 *
 * `note()` answers all three for a request and remembers it for the next one.
 * It keeps hashes only: no content, no token counts. Pure except for the map
 * it keeps, with an injectable clock so the tests need no sleeping.
 */
import { createHash } from 'node:crypto';

/** One input item, as a short digest of its JSON form. */
export function itemHash(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item) ?? 'undefined').digest('hex').slice(0, 12);
}

/**
 * The stable front of a request: model, instructions and tool names, as a
 * short digest. The same material the derived cache key hashes, kept
 * separately so a changed system prompt between two turns of one
 * conversation shows up as such.
 */
export function prefixHash(body: { model?: unknown; instructions?: unknown; tools?: unknown }): string {
  const h = createHash('sha256');
  h.update(String(body.model ?? '')).update('\0');
  h.update(typeof body.instructions === 'string' ? body.instructions : '').update('\0');
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: unknown; type?: unknown }>) : [];
  for (const t of tools) h.update(typeof t?.name === 'string' ? t.name : String(t?.type ?? '')).update('\0');
  return h.digest('hex').slice(0, 12);
}

export interface CacheTraceInput {
  /** The `prompt_cache_key` the request goes out with. */
  key: string;
  /** The seat that serves it. */
  alias: string;
  /** `prefixHash()` of the outgoing body. */
  prefix: string;
  /** `itemHash()` of every input item, in order. */
  items: readonly string[];
  /** When it goes out, ms since the epoch. */
  at: number;
}

export interface CacheTraceResult {
  /** Input items in this request. */
  items: number;
  /** ms since the previous request on this key; null on the first. */
  sinceMs: number | null;
  /** Input items in the previous request on this key; null on the first. */
  prevItems: number | null;
  /**
   * The previous request's input is a strict prefix of this one: every item
   * equal, this one longer. The shape a cache hit needs. null on the first.
   */
  extends: boolean | null;
  /**
   * Index of the first input item that differs from the previous request,
   * when one does. null when the inputs agree as far as both go (the new one
   * extends, equals or shortens the old one) and on the first request.
   */
  divergedAt: number | null;
  /** The seat differs from the previous request's; null on the first. */
  seatChanged: boolean | null;
  /** Model, instructions or tool names differ from the previous request's; null on the first. */
  prefixChanged: boolean | null;
}

interface Remembered {
  alias: string;
  prefix: string;
  items: readonly string[];
  at: number;
}

export const CACHE_TRACE_MAX_KEYS = 1000;
/** Longer than the backend keeps a prefix, so a stale entry cannot look like a live conversation. */
export const CACHE_TRACE_TTL_MS = 60 * 60 * 1000;
/** Items remembered per key. A longer input is compared on its first this many items and its length. */
export const CACHE_TRACE_MAX_ITEMS = 2000;

export class CacheTrace {
  private readonly seen = new Map<string, Remembered>();
  private readonly maxKeys: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxKeys?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxKeys = opts.maxKeys ?? CACHE_TRACE_MAX_KEYS;
    this.ttlMs = opts.ttlMs ?? CACHE_TRACE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Compare a request with the previous one on its key, then remember it. */
  note(input: CacheTraceInput): CacheTraceResult {
    const prev = this.seen.get(input.key);
    const live = prev !== undefined && input.at - prev.at <= this.ttlMs;
    const items = input.items.length > CACHE_TRACE_MAX_ITEMS ? input.items.slice(0, CACHE_TRACE_MAX_ITEMS) : input.items;
    const result: CacheTraceResult = live
      ? {
          items: input.items.length,
          sinceMs: Math.max(0, input.at - prev.at),
          prevItems: prev.items.length,
          ...compare(prev.items, items),
          seatChanged: prev.alias !== input.alias,
          prefixChanged: prev.prefix !== input.prefix,
        }
      : { items: input.items.length, sinceMs: null, prevItems: null, extends: null, divergedAt: null, seatChanged: null, prefixChanged: null };
    // Re-insert so Map order is last-seen order; the sweep below drops the oldest.
    this.seen.delete(input.key);
    this.seen.set(input.key, { alias: input.alias, prefix: input.prefix, items, at: input.at });
    this.sweep(input.at);
    return result;
  }

  /** Keys remembered right now. */
  size(): number {
    return this.seen.size;
  }

  private sweep(at: number): void {
    for (const [key, r] of this.seen) {
      if (this.seen.size <= this.maxKeys && at - r.at <= this.ttlMs) break;
      this.seen.delete(key);
    }
  }
}

function compare(prev: readonly string[], cur: readonly string[]): { extends: boolean; divergedAt: number | null } {
  const shared = Math.min(prev.length, cur.length);
  for (let i = 0; i < shared; i++) {
    if (prev[i] !== cur[i]) return { extends: false, divergedAt: i };
  }
  return { extends: cur.length > prev.length, divergedAt: null };
}

/** The one-line trace for stdout: `key=... since=3.2s items=23 extends=yes read=0/44120 (0%)`. */
export function formatCacheTraceLine(
  requestCount: number,
  key: string,
  t: CacheTraceResult,
  usage: { inputTokens: number; cacheReadTokens: number },
  alias?: string,
): string {
  const prompt = usage.inputTokens + usage.cacheReadTokens;
  const pct = prompt > 0 ? Math.round((usage.cacheReadTokens / prompt) * 100) : 0;
  const yesNo = (v: boolean | null): string => (v === null ? '-' : v ? 'yes' : 'no');
  const since = t.sinceMs === null ? 'first' : `${(t.sinceMs / 1000).toFixed(1)}s`;
  const parts = [
    `key=${key.slice(0, 16)}`,
    alias ? `seat=${alias}` : '',
    `since=${since}`,
    `items=${t.items}${t.prevItems === null ? '' : `/${t.prevItems}`}`,
    `extends=${yesNo(t.extends)}`,
    t.divergedAt === null ? '' : `diverged_at=${t.divergedAt}`,
    t.seatChanged ? 'seat_changed' : '',
    t.prefixChanged ? 'prefix_changed' : '',
    `read=${usage.cacheReadTokens}/${prompt} (${pct}%)`,
  ].filter(Boolean);
  return `[dario] #${requestCount} cache: ${parts.join(' ')}`;
}

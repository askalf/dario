/**
 * Cache trace: what a Codex request shares with the previous request on the
 * same `prompt_cache_key`.
 *
 * The backend caches prompt prefixes and reports what it read back as
 * `cached_tokens`, and dario already records that number. What the number
 * cannot say is WHY a turn missed. The trace records three things that bear
 * on a hit and are visible to dario before the request goes out. They narrow
 * the cause down; they do not prove it:
 *
 *   1. time: a cache write is not readable at once, so a turn that follows
 *      the previous one closely may read nothing it wrote. The gap is
 *      measured here; when the backend's write became readable is not;
 *   2. shape: a hit needs the previous input to be a strict prefix of this
 *      one, item for item, with the same front in place. `extends` compares
 *      the input items only; the model, instructions and tool names are
 *      compared apart as `prefixChanged`, and tool schemas not at all;
 *   3. seat: the cache is scoped to the serving account, so a conversation
 *      that moved seats starts over.
 *
 * `note()` answers all three for a request and remembers it for the next one.
 * `peek()` and `remember()` are its two halves, for a caller that only knows
 * after the comparison whether the request was served. It keeps hashes only:
 * no content, no token counts. Pure except for the map it keeps, with an
 * injectable clock so the tests need no sleeping.
 */
import { createHash } from 'node:crypto';

/** One input item, as a short digest of its JSON form. */
export function itemHash(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item) ?? 'undefined').digest('hex').slice(0, 12);
}

/**
 * The key as the trace records it. A key dario derived itself
 * (codexPromptCacheKey) is already a digest and is kept as it went out, so a
 * trace matches the request; a caller-supplied key can be anything (a session
 * id, an email, a secret that happens to look like a derived key) and is
 * recorded only as a digest, stable per key so a run of traces still groups
 * by conversation. Only the caller knows which it is, so the shape of the key
 * decides nothing.
 */
export function traceKey(key: string, derived: boolean): string {
  if (derived) return key;
  return `key-${createHash('sha256').update('trace\0').update(key).digest('hex').slice(0, 16)}`;
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
  /**
   * Dispatch order, stamped by `peek()` when absent, so two requests that
   * went out in the same ms still order by which went out first.
   */
  seq?: number;
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
   * equal, this one longer. The shape a cache hit needs. null on the first,
   * and when this one is longer but the previous input ran past
   * CACHE_TRACE_MAX_ITEMS, so its tail was not kept to compare.
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
  /** The first CACHE_TRACE_MAX_ITEMS item hashes. */
  items: readonly string[];
  /** The full input length, which may exceed `items.length`. */
  count: number;
  at: number;
  seq: number;
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
  private dispatched = 0;

  constructor(opts: { maxKeys?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxKeys = opts.maxKeys ?? CACHE_TRACE_MAX_KEYS;
    this.ttlMs = opts.ttlMs ?? CACHE_TRACE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Compare a request with the previous one on its key, then remember it. */
  note(input: CacheTraceInput): CacheTraceResult {
    const result = this.peek(input);
    this.remember(input);
    return result;
  }

  /** Compare a request with the previous one on its key, remembering nothing but its dispatch order. */
  peek(input: CacheTraceInput): CacheTraceResult {
    if (input.seq === undefined) input.seq = ++this.dispatched;
    const prev = this.seen.get(input.key);
    const live = prev !== undefined && input.at - prev.at <= this.ttlMs;
    return live
      ? {
          items: input.items.length,
          sinceMs: Math.max(0, input.at - prev.at),
          prevItems: prev.count,
          ...compare(prev, kept(input.items), input.items.length),
          seatChanged: prev.alias !== input.alias,
          prefixChanged: prev.prefix !== input.prefix,
        }
      : { items: input.items.length, sinceMs: null, prevItems: null, extends: null, divergedAt: null, seatChanged: null, prefixChanged: null };
  }

  /**
   * Make a request the one the next request on its key compares with, unless
   * one that went out after it is already remembered: concurrent requests are
   * accepted in whatever order their upstream headers arrive, and the next
   * request compares with the latest to go out.
   */
  remember(input: CacheTraceInput): void {
    const seq = input.seq ?? 0;
    const prev = this.seen.get(input.key);
    if (prev !== undefined && (prev.at > input.at || (prev.at === input.at && prev.seq > seq))) return;
    this.seen.delete(input.key);
    this.seen.set(input.key, { alias: input.alias, prefix: input.prefix, items: kept(input.items), count: input.items.length, at: input.at, seq });
    this.sweep(input.at);
  }

  /** Keys remembered right now. */
  size(): number {
    return this.seen.size;
  }

  /**
   * Drop every expired entry, then, while over the cap, the entry that went
   * out earliest. By `at` rather than Map order: a request accepted late can
   * be older than entries inserted before it.
   */
  private sweep(at: number): void {
    for (const [key, r] of this.seen) {
      if (at - r.at > this.ttlMs) this.seen.delete(key);
    }
    while (this.seen.size > this.maxKeys) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [key, r] of this.seen) if (r.at < oldestAt) { oldest = key; oldestAt = r.at; }
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

function kept(items: readonly string[]): readonly string[] {
  return items.length > CACHE_TRACE_MAX_ITEMS ? items.slice(0, CACHE_TRACE_MAX_ITEMS) : items;
}

function compare(prev: Remembered, cur: readonly string[], curCount: number): { extends: boolean | null; divergedAt: number | null } {
  const shared = Math.min(prev.items.length, cur.length);
  for (let i = 0; i < shared; i++) {
    if (prev.items[i] !== cur[i]) return { extends: false, divergedAt: i };
  }
  if (curCount <= prev.count) return { extends: false, divergedAt: null };
  // Longer than the previous input and equal as far as it was kept; past
  // that, nothing was kept to say whether it still agrees.
  return { extends: prev.items.length < prev.count ? null : true, divergedAt: null };
}

/** The one-line trace for stdout: `key=... since=3.2s items=23 extends=yes read=0/44120 (0%)`. `key` is the `traceKey()` form. */
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

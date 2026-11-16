/**
 * Thinking blocks and the seat that produced them.
 *
 * Some models bind a thinking block to the organization that produced it.
 * Sent back through a seat in another organization, the API leaves the block
 * out of the request and still answers, and the response lists what it left
 * out in `input_transformations`. A conversation the pool moves between seats
 * can therefore lose its earlier reasoning with nothing on the wire saying so
 * unless the proxy reads that list.
 *
 * Nothing here changes a request. These helpers read the list, and decide
 * when a seat change is worth a log line.
 */

/** What one response said the API left out of the request, by the reason it gave. */
export interface ThinkingDrops {
  total: number;
  byReason: Record<string, number>;
}

/** A reason is copied into logs, so it must look like an identifier. */
const REASON_SHAPE = /^[a-z0-9_]{1,64}$/;
/** Distinct reasons kept per response; the rest are counted under `other`. */
const MAX_REASONS = 8;

/**
 * The `thinking_dropped` entries of a response's `input_transformations`.
 *
 * `holder` is whatever carries the field: a buffered message, the `message`
 * of a `message_start` event, or a `message_delta` event. Null when the field
 * is absent, so a caller that reads several frames can keep the last one that
 * had it. An empty list is a real answer (nothing was left out) and comes back
 * as a zero count. Entries of another type, and entries that are not objects,
 * are ignored.
 */
export function thinkingDropsFrom(holder: unknown): ThinkingDrops | null {
  if (!holder || typeof holder !== 'object') return null;
  const list = (holder as { input_transformations?: unknown }).input_transformations;
  if (!Array.isArray(list)) return null;
  const counts = new Map<string, number>();
  let total = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { type, reason } = entry as { type?: unknown; reason?: unknown };
    if (type !== 'thinking_dropped') continue;
    let key = typeof reason === 'string' && REASON_SHAPE.test(reason) ? reason : 'other';
    if (!counts.has(key) && counts.size >= MAX_REASONS) key = 'other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }
  return { total, byReason: Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

/** `organization_binding_mismatch 2, prefix_binding_mismatch 1` */
function reasonList(drops: ThinkingDrops): string {
  return Object.entries(drops.byReason).map(([reason, n]) => `${reason} ${n}`).join(', ');
}

/** One sentence for the console. Empty when nothing was left out. */
export function describeThinkingDrops(drops: ThinkingDrops | null, seat: string | undefined): string {
  if (!drops || drops.total === 0) return '';
  const blocks = drops.total === 1 ? '1 thinking block' : `${drops.total} thinking blocks`;
  return `upstream left ${blocks} out of this request${seat ? ` on seat ${seat}` : ''} (${reasonList(drops)}); the request was served without them`;
}

/** Fields for the request log line. Empty when nothing was left out. */
export function thinkingDropLogFields(drops: ThinkingDrops | null): { thinking_dropped?: number; thinking_dropped_reasons?: Record<string, number> } {
  if (!drops || drops.total === 0) return {};
  return { thinking_dropped: drops.total, thinking_dropped_reasons: drops.byReason };
}

/** A key that is the same for two responses reporting the same reasons. */
export function thinkingDropsKey(drops: ThinkingDrops): string {
  return Object.keys(drops.byReason).join(',');
}

/** True when an assistant turn in `messages` carries a thinking block of either kind. */
export function historyCarriesThinking(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const { role, content } = msg as { role?: unknown; content?: unknown };
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      const type = (block as { type?: unknown } | null)?.type;
      if (type === 'thinking' || type === 'redacted_thinking') return true;
    }
  }
  return false;
}

export interface SeatMove {
  fromAlias: string;
  fromOrganization: string | undefined;
  toAlias: string;
  toOrganization: string | undefined;
  /** The request forwards thinking blocks the first seat produced. */
  carriesThinking: boolean;
}

/**
 * The line to log when a conversation changes seats, or null when the change
 * costs it nothing the proxy can name: the same seat, no thinking going
 * upstream, or two seats known to share an organization. An organization the
 * proxy has not learned yet is not reported as a different one.
 */
export function seatMoveNote(move: SeatMove): string | null {
  if (move.fromAlias === move.toAlias || !move.carriesThinking) return null;
  if (!move.fromOrganization || !move.toOrganization) return null;
  if (move.fromOrganization === move.toOrganization) return null;
  return `conversation moved from seat ${move.fromAlias} to seat ${move.toAlias}, which is in another organization: `
    + 'a model that binds thinking to its organization cannot use the thinking blocks the first seat produced, '
    + 'so expect new reasoning over the visible history and a cold prompt cache';
}

/**
 * Says yes once per key. Bounded: past `max` keys it forgets them all, so a
 * long-lived process repeats a line rather than growing without limit.
 */
export class OncePerKey {
  private seen = new Set<string>();
  constructor(private readonly max: number = 2_000) {}
  first(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.max) this.seen.clear();
    this.seen.add(key);
    return true;
  }
}

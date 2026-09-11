/**
 * Mid-stream continuation (v6.1) — the answer does not stop when the plan does.
 *
 * Until now a streamed `/v1/messages` (or `/v1/chat/completions`) answer that
 * died part-way through — an upstream socket reset, an in-band
 * `overloaded_error`, a codex `response.failed` — ended with `res.end()` and
 * the client got a truncated stream: no `message_stop`, no `[DONE]`, an SDK
 * that throws "stream ended without producing a Message", and every word
 * already on screen wasted. Once bytes were on the wire the request was
 * treated as too late to hand to anyone else.
 *
 * This module finishes the SAME client stream from the other subscription
 * instead. It sits between the request handler and the client socket:
 *
 *   1. every frame written to the client passes through `write()`, which
 *      tracks what the client has already seen (message_start, the open
 *      content block, the text so far) and WITHHOLDS a terminal error frame
 *      rather than forwarding it;
 *   2. `finish()` replaces the site's `res.end()`. A clean stream ends as
 *      before. A stream that died with content on the wire re-issues the
 *      request through dario's own front door (a loopback POST — so the pool,
 *      the codex translator, cch and every other rule apply to the resume
 *      exactly as to any client request) at the OTHER provider, with the
 *      partial answer appended as the assistant turn and a resume notice as
 *      the user turn;
 *   3. the resume stream is spliced onto the client's still-open block: its
 *      message_start and thinking blocks are dropped, its first text block
 *      continues the open index, anything after that is renumbered, and it
 *      closes the message with its own message_delta / message_stop.
 *
 * Two things the spike (2026-09-11, prod 6.0.51, real Opus 5 + real ChatGPT
 * Plus) settled that are easy to get wrong again:
 *
 *   - NO assistant prefill. Claude 4.6+/5 answers a trailing assistant turn
 *     with a 400, and the Responses API never had the concept. The resume is
 *     instruction-driven on both providers, which works — zero restarts, zero
 *     preamble, zero repetition across ten real runs.
 *   - The seam is a WHITESPACE problem, not a content problem. Told merely to
 *     "continue", Claude-as-continuer dropped the boundary space 2/3 times
 *     (`replies<CUT>with`, a 3-vs-4-space indent). So the notice asks the model
 *     to begin by repeating the last ~40 characters verbatim, and `findAnchor`
 *     trims that repeat with a whitespace-normalized match. The model renders
 *     the seam inside its own token stream; we only cut. Matched exactly 5/5.
 *
 * Out of scope here, on purpose: a cut inside a tool_use block (the partial
 * JSON is not resumable), non-streaming requests (nothing is on the wire yet;
 * the existing pre-byte failover covers them), and the api-key OpenAI backend.
 * A stream that cannot be continued ends exactly as it did before this module.
 */

import type { ServerResponse } from 'node:http';

export type WireShape = 'anthropic' | 'openai';

/** Client-visible marker that a loopback request is a continuation, so the handler never nests one. */
export const CONTINUATION_HEADER = 'x-dario-continuation';

/** Characters of the partial the model is asked to repeat verbatim (the seam anchor). */
export const ANCHOR_CHARS = 40;

/** Upper bound on continuation text held back while looking for the anchor. */
const HOLD_CHARS = 240;

// ---------------------------------------------------------------------------
//  SSE frames
// ---------------------------------------------------------------------------

export interface SseFrame {
  /** The frame exactly as it will go on the wire, trailing blank line included. */
  raw: string;
  /** `event:` field, or the JSON `type` when the event line is absent. */
  event: string;
  /** Parsed `data:` payload, null for comments and non-JSON data. */
  data: Record<string, unknown> | null;
  /** The literal data text (`[DONE]` for the OpenAI sentinel). */
  dataText: string | null;
  comment: boolean;
}

/**
 * Splits a byte/text stream into complete SSE frames. A trailing partial frame
 * stays buffered until its blank line arrives. Frames are returned with their
 * original bytes, so forwarding `raw` is byte-identical to the input.
 */
export class SseFrameSplitter {
  private buf = '';
  private readonly decoder = new TextDecoder();

  feed(chunk: string | Uint8Array): SseFrame[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx + 2);
      this.buf = this.buf.slice(idx + 2);
      out.push(parseFrame(raw));
    }
    return out;
  }

  /** Whatever is buffered and not yet a complete frame. */
  flush(): string {
    const rest = this.buf + this.decoder.decode();
    this.buf = '';
    return rest;
  }
}

export function parseFrame(raw: string): SseFrame {
  let event = '';
  let dataText: string | null = null;
  let comment = true;
  for (const line of raw.split('\n')) {
    if (line === '' ) continue;
    if (line.startsWith(':')) continue;
    comment = false;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataText = (dataText === null ? '' : dataText + '\n') + line.slice(5).trim();
  }
  let data: Record<string, unknown> | null = null;
  if (dataText !== null && dataText !== '[DONE]') {
    try {
      const v = JSON.parse(dataText) as unknown;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) data = v as Record<string, unknown>;
    } catch { /* non-JSON data: forwarded verbatim, never interpreted */ }
  }
  if (!event && data && typeof data.type === 'string') event = data.type;
  return { raw, event, data, dataText, comment };
}

export function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
//  What the client has seen so far
// ---------------------------------------------------------------------------

interface BlockState { type: string; open: boolean; text: string }

/**
 * The client-side state a continuation has to pick up from. Both shapes are
 * tracked by ONE class so the guard has a single view: `blocks` carries
 * Anthropic content blocks; on the OpenAI shape there is exactly one implicit
 * text block (index 0) that opens on the first content delta.
 */
export class ClientStreamState {
  started = false;          // message_start seen / first chunk with choices seen
  finished = false;         // message_stop / [DONE] / finish_reason seen
  blocks: BlockState[] = [];
  /**
   * Frames the guard withheld instead of forwarding, in order: a terminal
   * error, and — once the site has flagged the upstream as failed — the
   * closing frames a translator emits for a failed turn. Released verbatim
   * if no continuation happens, so the client sees exactly what it would have.
   */
  withheld: SseFrame[] = [];
  /**
   * Set by the site when it KNOWS the upstream turn failed even though the
   * translator will close it politely (the codex Anthropic path answers
   * `response.failed` with message_delta + message_stop). The closing frames
   * are then withheld so the stream reads as unfinished, i.e. continuable.
   */
  upstreamFailed = false;
  /** True once anything non-continuable was seen (tool_use in progress, tool_calls). */
  toolInProgress = false;
  forwardedFrames = 0;
  /** message_start's message.model — kept so a continuation can name what the client believes it is talking to. */
  model: string | null = null;

  constructor(readonly shape: WireShape) {}

  get openIdx(): number { return this.blocks.findIndex((b) => b.open); }
  get openType(): string | null { const i = this.openIdx; return i < 0 ? null : this.blocks[i].type; }
  /** Every text emitted so far, blocks concatenated in order. */
  get textSoFar(): string { return this.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''); }
  /** Text of the open text block only — what the seam anchor is cut from. */
  get openText(): string { const i = this.openIdx; return i >= 0 && this.blocks[i].type === 'text' ? this.blocks[i].text : ''; }

  /**
   * Whether a stream that stopped HERE can be continued: bytes are on the
   * wire, the message is not finished, and nothing non-resumable is open.
   * An open tool_use block or an OpenAI tool call in flight is a definite no —
   * half a JSON argument object cannot be handed to another model.
   */
  get continuable(): boolean {
    if (!this.started || this.finished || this.toolInProgress) return false;
    const t = this.openType;
    return t === null || t === 'text' || t === 'thinking' || t === 'redacted_thinking';
  }

  /**
   * Observe one client-bound frame. Returns false when the frame is a terminal
   * error the guard should withhold (recorded in `withheld`), true to forward.
   */
  observe(f: SseFrame): boolean {
    if (f.comment || f.dataText === null) return true;
    if (this.shape === 'anthropic') return this.observeAnthropic(f);
    return this.observeOpenAI(f);
  }

  private observeAnthropic(f: SseFrame): boolean {
    const d = f.data;
    if (!d) return true;
    switch (d.type) {
      case 'message_start': {
        this.started = true;
        const m = d.message as { model?: string } | undefined;
        if (typeof m?.model === 'string') this.model = m.model;
        return true;
      }
      case 'content_block_start': {
        const idx = typeof d.index === 'number' ? d.index : this.blocks.length;
        const cb = d.content_block as { type?: string; text?: string } | undefined;
        const type = cb?.type ?? 'text';
        this.blocks[idx] = { type, open: true, text: cb?.text ?? '' };
        if (type === 'tool_use' || type === 'server_tool_use') this.toolInProgress = true;
        return true;
      }
      case 'content_block_delta': {
        const idx = typeof d.index === 'number' ? d.index : -1;
        const b = this.blocks[idx];
        const delta = d.delta as { type?: string; text?: string } | undefined;
        if (b && delta?.type === 'text_delta' && typeof delta.text === 'string') b.text += delta.text;
        return true;
      }
      case 'content_block_stop': {
        const idx = typeof d.index === 'number' ? d.index : -1;
        const b = this.blocks[idx];
        if (b) {
          b.open = false;
          // A tool_use block that CLOSED is a complete call the client can act
          // on; the message is no longer text-resumable though — the model's
          // next move after a tool call is the tool result, not more prose.
        }
        return true;
      }
      case 'message_delta':
        if (this.upstreamFailed) { this.withheld.push(f); return false; }
        return true;
      case 'message_stop':
        if (this.upstreamFailed) { this.withheld.push(f); return false; }
        this.finished = true;
        return true;
      case 'error':
        if (!this.started) return true;   // pre-byte errors are the existing failover paths' business
        this.withheld.push(f);
        return false;
      default:
        return true;
    }
  }

  private observeOpenAI(f: SseFrame): boolean {
    if (f.dataText === '[DONE]') {
      if (this.upstreamFailed && this.started) { this.withheld.push(f); return false; }
      this.finished = true;
      return true;
    }
    const d = f.data;
    if (!d) return true;
    if (d.error && this.started) { this.withheld.push(f); return false; }
    const choices = d.choices as Array<{ delta?: { content?: string; tool_calls?: unknown }; finish_reason?: string | null }> | undefined;
    if (!Array.isArray(choices)) return true;
    this.started = true;
    if (typeof d.model === 'string' && !this.model) this.model = d.model;
    const c = choices[0];
    if (!c) return true;
    if (c.delta?.tool_calls) this.toolInProgress = true;
    if (typeof c.delta?.content === 'string' && c.delta.content.length > 0) {
      if (this.blocks.length === 0) this.blocks.push({ type: 'text', open: true, text: '' });
      this.blocks[0].text += c.delta.content;
    }
    if (c.finish_reason) {
      if (this.upstreamFailed) { this.withheld.push(f); return false; }
      this.finished = true;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
//  The seam: anchor + trim
// ---------------------------------------------------------------------------

/**
 * The tail of the partial the model is told to repeat. Starts at a
 * non-whitespace character: the API strips a reply's leading whitespace, so an
 * anchor beginning with a space could never be matched exactly.
 */
export function anchorOf(partial: string): string {
  const a = partial.slice(-ANCHOR_CHARS);
  return a.slice(a.length - a.trimStart().length);
}

interface Normalized { out: string; map: number[] }

/** Collapse whitespace runs to one space and fold curly quotes, keeping a map back to raw offsets. */
function normalize(s: string): Normalized {
  const map: number[] = [];
  let out = '';
  let ws = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (/\s/.test(c)) { if (ws) continue; ws = true; c = ' '; } else ws = false;
    if (c === '‘' || c === '’') c = "'";
    if (c === '“' || c === '”') c = '"';
    out += c;
    map.push(i);
  }
  return { out, map };
}

/**
 * Locate the repeated anchor at the head of the continuation and return the
 * raw offset just past it, or null when the model did not repeat it. Tries the
 * whole anchor first, then shorter tails, tolerating whitespace and quote
 * differences; the match must sit at (or within a few characters of) the
 * start, so a genuine later recurrence of the phrase is never mistaken for it.
 */
export function findAnchor(partial: string, head: string): { cut: number; exact: boolean } | null {
  const full = anchorOf(partial);
  if (full.length < 8) return null;
  const H = normalize(head.slice(0, HOLD_CHARS * 3));
  for (const len of [full.length, 32, 24, 16, 12]) {
    if (len > full.length) continue;
    const tail = full.slice(-len);
    const a = normalize(tail).out.trim();
    if (a.length < 8) continue;
    const at = H.out.indexOf(a);
    if (at < 0 || at > 8) continue;
    const endNorm = at + a.length;
    const cut = endNorm < H.map.length ? H.map[endNorm] : head.length;
    return { cut, exact: head.slice(0, cut) === tail };
  }
  return null;
}

/** Longest suffix of `partial` that the continuation starts with (exact bytes), for the no-anchor fallback. */
export function tailOverlap(partial: string, head: string, min = 6): number {
  const max = Math.min(partial.length, head.length);
  for (let k = max; k >= min; k--) if (partial.endsWith(head.slice(0, k))) return k;
  return 0;
}

/** True when the partial has an odd number of ``` fences, i.e. the cut is inside a code block. */
export function insideCodeFence(partial: string): boolean {
  return ((partial.match(/```/g) ?? []).length % 2) === 1;
}

/**
 * The one seam defect the spike saw from a real model: Claude, resuming
 * prose that was cut mid-sentence, once started its continuation with a
 * paragraph break (`and<CUT>\n\nhere is where`). A sentence does not contain
 * a paragraph break, so when the partial ends mid-sentence and the
 * continuation opens with newlines outside a code fence, the break becomes
 * one space. Inside a fence a newline is content and is left alone.
 */
export function fixSeam(partial: string, continuation: string): string {
  if (!/^[ \t]*\n/.test(continuation)) return continuation;
  if (partial.length === 0 || /\s$/.test(partial)) return continuation;
  if (!/[A-Za-z0-9,;:]$/.test(partial)) return continuation;
  if (insideCodeFence(partial)) return continuation;
  return ' ' + continuation.replace(/^[ \t]*\n[ \t\n]*/, '');
}

// ---------------------------------------------------------------------------
//  The resume request
// ---------------------------------------------------------------------------

/** The anchor is quoted between these in the notice; the tests' mock providers read it back out. */
export const ANCHOR_OPEN = '«';
export const ANCHOR_CLOSE = '»';

/**
 * Written as the USER asking for the rest — which is what a continuation is —
 * not as an operator notice. The live test on 2026-09-11 is why: told
 * "[transport notice] … resume it now", claude-sonnet-5 answered `Note: that
 * "transport notice" isn't an actual system message — it's just text in your
 * prompt` and stopped, exactly the injection-awareness the model is supposed
 * to have. A person whose connection dropped asking to pick up from the last
 * few words is an ordinary request, and gets the ordinary answer.
 */
export function resumeNotice(anchor: string): string {
  if (anchor.length === 0) {
    return 'My connection dropped while you were writing that reply and I received none of it. Please write the reply again from the beginning.';
  }
  return 'My connection dropped while you were writing that reply, so I only received it up to this point: ' +
    `${ANCHOR_OPEN}${anchor}${ANCHOR_CLOSE}. ` +
    'Please pick up exactly where you left off. Start your reply by repeating that final fragment word for word, exactly as written (same spacing, line breaks and punctuation), ' +
    'then continue the interrupted word, sentence, line, or code block without a break. ' +
    'Do not start over, do not summarize what you already wrote, and do not comment on this message — just carry on so the two parts read as one uninterrupted reply, ' +
    'in the same language, tone and formatting. Only add a paragraph break at the join if the fragment ends a sentence.';
}

/**
 * The client's own request re-pointed at the continuation model with the
 * partial answer appended. `partial` empty means nothing usable reached the
 * client (the cut fell inside thinking, or before the first block): the
 * request is simply re-issued as it was and the resume stream restarts the
 * answer under the client's already-open message.
 */
export function buildResumeBody(
  shape: WireShape,
  clientBody: Record<string, unknown>,
  targetModel: string,
  partial: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...clientBody, model: targetModel, stream: true };
  const messages = Array.isArray(clientBody.messages) ? [...(clientBody.messages as unknown[])] : [];
  if (partial.length > 0) {
    const notice = resumeNotice(anchorOf(partial));
    if (shape === 'anthropic') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: partial }] });
      messages.push({ role: 'user', content: [{ type: 'text', text: notice }] });
    } else {
      messages.push({ role: 'assistant', content: partial });
      messages.push({ role: 'user', content: notice });
    }
  }
  body.messages = messages;
  // A resume never wants a forced tool call or a pinned seat: the first would
  // make the model call a tool instead of finishing its sentence, the second
  // is the very seat that just failed.
  delete body.tool_choice;
  return body;
}

// ---------------------------------------------------------------------------
//  Splicing the resume stream onto the client stream
// ---------------------------------------------------------------------------

/**
 * Turns the resume stream's frames into client-bound frames that continue the
 * message the client already has. One instance per continuation.
 */
export class Splicer {
  private readonly idxMap = new Map<number, number | 'skip'>();
  private nextIdx: number;
  private readonly clientOpenIdx: number;
  private readonly clientOpenType: string | null;
  private originalClosed = false;    // the block the client had open when the primary died
  private continuingClosed = false;  // the block the resume's first text block writes into
  private firstTextMapped = false;
  private continuingIdx = -1;        // client index the resume's first text block writes into
  private hold = '';
  private holding: boolean;
  private stopReasonSeen = false;    // anthropic: message_delta seen; openai: finish_reason seen
  private doneSeen = false;          // openai: [DONE] seen
  /**
   * Whether the resume stream delivered its OWN wire terminal — `message_stop`
   * on the Anthropic shape, `[DONE]` on the OpenAI shape. Only then has the
   * client been handed a finished message. A resume body that ends without
   * one is a second truncation, and the guard leaves the client stream
   * unfinished rather than closing it as if the answer were complete.
   */
  terminalSeen = false;
  /** Diagnostics for the log line. */
  readonly stats = { anchor: 'n/a' as 'n/a' | 'exact' | 'fuzzy' | 'overlap' | 'none', dropped: 0, emitted: 0 };

  constructor(
    private readonly shape: WireShape,
    state: ClientStreamState,
    private readonly partial: string,
  ) {
    this.clientOpenIdx = state.openIdx;
    this.clientOpenType = state.openType;
    this.nextIdx = state.blocks.length;
    this.holding = partial.length > 0;
  }

  /** Frames to write to the client for one resume frame. */
  feed(f: SseFrame): string[] {
    if (f.comment || f.dataText === null) return [];
    return this.shape === 'anthropic' ? this.feedAnthropic(f) : this.feedOpenAI(f);
  }

  /**
   * The resume stream ended WITHOUT its terminal event. Release whatever text
   * was still held for the anchor check — it is the second provider's real
   * output and the client may as well have it — but close nothing: no
   * content_block_stop, no message_delta/message_stop, no finish chunk, no
   * [DONE]. A synthesized clean end here would present a doubly-truncated
   * answer as a complete one (review finding on #1286).
   */
  abandon(): string[] {
    return this.releaseHold(true);
  }

  // ---- anthropic --------------------------------------------------------

  private feedAnthropic(f: SseFrame): string[] {
    const d = f.data;
    if (!d) return [];
    switch (d.type) {
      case 'ping':
        return [f.raw];
      case 'message_start':
        return [];                         // the client already has one
      case 'content_block_start': {
        const idx = d.index as number;
        const cb = d.content_block as { type?: string } | undefined;
        const type = cb?.type ?? 'text';
        if (type === 'thinking' || type === 'redacted_thinking') { this.idxMap.set(idx, 'skip'); return []; }
        if (type === 'text' && !this.firstTextMapped) {
          this.firstTextMapped = true;
          if (this.clientOpenIdx >= 0 && this.clientOpenType === 'text') {
            // Continue the block the client still has open — no start frame.
            this.continuingIdx = this.clientOpenIdx;
            this.idxMap.set(idx, this.continuingIdx);
            return [];
          }
          // Nothing text-open on the client side: close whatever is open (a
          // thinking block the cut fell in) and start a fresh text block.
          const out = this.closeOriginal();
          this.continuingIdx = this.nextIdx++;
          this.idxMap.set(idx, this.continuingIdx);
          out.push(formatFrame('content_block_start', { ...d, index: this.continuingIdx }));
          return out;
        }
        // Any further block (a second text block, a tool_use): whatever is
        // still open on the client side closes first — indices are sequential
        // and only one block is open at a time.
        const mapped = this.nextIdx++;
        this.idxMap.set(idx, mapped);
        const out = this.releaseHold(true);
        out.push(...this.closeContinuing());
        out.push(...this.closeOriginal());
        out.push(formatFrame('content_block_start', { ...d, index: mapped }));
        return out;
      }
      case 'content_block_delta': {
        const m = this.idxMap.get(d.index as number);
        if (m === undefined || m === 'skip') return [];
        const delta = d.delta as { type?: string; text?: string } | undefined;
        if (m === this.continuingIdx && delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.hold += delta.text;
          return this.releaseHold(false);
        }
        return [formatFrame('content_block_delta', { ...d, index: m })];
      }
      case 'content_block_stop': {
        const m = this.idxMap.get(d.index as number);
        if (m === undefined || m === 'skip') return [];
        if (m === this.continuingIdx) {
          const out = this.releaseHold(true);
          out.push(...this.closeContinuing());
          return out;
        }
        return [formatFrame('content_block_stop', { ...d, index: m })];
      }
      case 'message_delta': {
        this.stopReasonSeen = true;
        const out = this.releaseHold(true);
        out.push(...this.closeContinuing());
        out.push(...this.closeOriginal());
        out.push(f.raw);
        return out;
      }
      case 'message_stop':
        this.terminalSeen = true;
        return [f.raw];
      case 'error':
        // The resume itself failed mid-way. Let the site's finish() see it
        // as a dead stream: forwarding a second provider's error here would
        // still leave the client with an open message, so close honestly.
        return [];
      default:
        return [];
    }
  }

  /** Close the block the resume has been writing into, once. */
  private closeContinuing(): string[] {
    if (this.continuingIdx < 0 || this.continuingClosed) return [];
    this.continuingClosed = true;
    if (this.continuingIdx === this.clientOpenIdx) this.originalClosed = true;
    return [formatFrame('content_block_stop', { type: 'content_block_stop', index: this.continuingIdx })];
  }

  /** Close the block the client had open when the primary died, once, unless the resume is continuing it. */
  private closeOriginal(): string[] {
    if (this.clientOpenIdx < 0 || this.originalClosed) return [];
    if (this.continuingIdx === this.clientOpenIdx && !this.continuingClosed) return [];
    this.originalClosed = true;
    return [formatFrame('content_block_stop', { type: 'content_block_stop', index: this.clientOpenIdx })];
  }

  // ---- openai ------------------------------------------------------------

  private feedOpenAI(f: SseFrame): string[] {
    if (f.dataText === '[DONE]') {
      this.doneSeen = true;
      this.terminalSeen = true;
      const out = this.releaseHold(true);
      if (!this.stopReasonSeen) { this.stopReasonSeen = true; out.push(openaiChunk({}, 'stop')); }
      out.push(f.raw);
      return out;
    }
    const d = f.data;
    if (!d) return [];
    const choices = d.choices as Array<{ delta?: { content?: string; role?: string; tool_calls?: unknown }; finish_reason?: string | null }> | undefined;
    const c = choices?.[0];
    if (!c) return [];
    const out: string[] = [];
    if (typeof c.delta?.content === 'string' && c.delta.content.length > 0) {
      this.hold += c.delta.content;
      out.push(...this.releaseHold(false));
    } else if (c.delta?.tool_calls) {
      out.push(...this.releaseHold(true));
      out.push(openaiChunk({ tool_calls: c.delta.tool_calls }, null));
    }
    if (c.finish_reason) {
      this.stopReasonSeen = true;
      out.push(...this.releaseHold(true));
      out.push(openaiChunk({}, c.finish_reason));
    }
    return out;
  }

  // ---- the hold ----------------------------------------------------------

  /**
   * Text from the resume's first text block is held until the anchor is
   * found (or enough has arrived to give up looking), then trimmed and
   * released. After that every delta streams straight through.
   */
  private releaseHold(final: boolean): string[] {
    if (this.holding) {
      const found = findAnchor(this.partial, this.hold);
      if (!found && !final && this.hold.length < HOLD_CHARS) return [];
      if (found) {
        this.stats.anchor = found.exact ? 'exact' : 'fuzzy';
        this.stats.dropped = found.cut;
        this.hold = this.hold.slice(found.cut);
      } else {
        const k = tailOverlap(this.partial, this.hold);
        this.stats.anchor = k > 0 ? 'overlap' : 'none';
        this.stats.dropped = k;
        this.hold = this.hold.slice(k);
      }
      this.hold = fixSeam(this.partial, this.hold);
      this.holding = false;
    }
    if (this.hold.length === 0) return [];
    const text = this.hold;
    this.hold = '';
    this.stats.emitted += text.length;
    if (this.shape === 'anthropic') {
      if (this.continuingIdx < 0 || this.continuingClosed) return [];
      return [formatFrame('content_block_delta', { type: 'content_block_delta', index: this.continuingIdx, delta: { type: 'text_delta', text } })];
    }
    return [openaiChunk({ content: text }, null)];
  }
}

function openaiChunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'claude', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

// ---------------------------------------------------------------------------
//  The guard: what a request-handler site talks to
// ---------------------------------------------------------------------------

export interface ContinuationTarget {
  /** The model spelling the loopback request carries (`codex:gpt-5.6-terra:high`, `claude:claude-opus-5`). */
  model: string;
  /** Human-readable, for the log line and the SSE comment. */
  label: string;
}

export interface ResumeOptions {
  /**
   * The client's request as it arrived, before dario's own rewrites. A
   * function so the bytes are parsed only when a resume actually happens —
   * never on the hot path of a stream that ends normally.
   */
  clientBody: () => Record<string, unknown> | null;
  /** `http://127.0.0.1:<port>` — dario's own front door. */
  loopbackBase: string;
  /** Auth + attribution headers for the loopback request. */
  loopbackHeaders: Record<string, string>;
  /** Decides where to resume, once, at failure time. Null = nowhere; the stream ends as before. */
  resolveTarget: () => Promise<ContinuationTarget | null>;
  /** Called right before the loopback request is made — the site releases its own queue slot here. */
  onBeforeResume?: () => void;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface MidstreamGuardOptions {
  shape: WireShape;
  /** The site's client writer (already gated on client disconnect). */
  write: (chunk: string) => void;
  /** The real `res.end()`. */
  end: () => void;
  isClientGone: () => boolean;
  resume: ResumeOptions | null;
  requestNo: number;
  verbose: boolean;
  log?: (line: string) => void;
}

export type FinishOutcome = 'clean' | 'continued' | 'continued-unfinished' | 'ended' | 'not-continuable' | 'no-target' | 'resume-failed';

export class MidstreamGuard {
  readonly state: ClientStreamState;
  private readonly splitter = new SseFrameSplitter();
  private finished = false;

  constructor(private readonly o: MidstreamGuardOptions) {
    this.state = new ClientStreamState(o.shape);
  }

  /**
   * The site knows the upstream turn failed (a codex `response.failed`, a
   * terminal payload with an error status) before the translator's polite
   * closing frames go out. From here on those frames are withheld, so the
   * stream is treated as unfinished — and finished from the other provider.
   */
  markUpstreamFailed(): void {
    this.state.upstreamFailed = true;
  }

  /** Forward a client-bound chunk, withholding a terminal error frame. */
  write(chunk: string | Uint8Array): void {
    if (this.finished) return;
    for (const f of this.splitter.feed(chunk)) {
      if (this.state.observe(f)) { this.o.write(f.raw); this.state.forwardedFrames++; }
    }
  }

  /**
   * End the client response. Replaces the site's `res.end()` on the streaming
   * exits. Resolves once the client stream is closed either way.
   */
  async finish(): Promise<FinishOutcome> {
    if (this.finished) return 'ended';
    this.finished = true;
    const s = this.state;
    const tail = this.splitter.flush();
    const cleanEnd = (): void => {
      if (tail.length > 0) this.o.write(tail);
      for (const f of s.withheld) this.o.write(f.raw);
      this.o.end();
    };
    if (s.finished || !s.started) { cleanEnd(); return s.finished ? 'clean' : 'ended'; }
    if (this.o.isClientGone()) { this.o.end(); return 'ended'; }
    if (!s.continuable || !this.o.resume) { cleanEnd(); return 'not-continuable'; }

    let target: ContinuationTarget | null = null;
    try { target = await this.o.resume.resolveTarget(); } catch { target = null; }
    if (!target) {
      this.log(`#${this.o.requestNo} stream died after ${s.textSoFar.length} chars — no continuation target (set --pool-fallback with an entry for the other provider)`);
      cleanEnd();
      return 'no-target';
    }
    const partial = s.textSoFar;
    this.log(`#${this.o.requestNo} stream died after ${partial.length} chars → continuing as ${target.label}`);
    const outcome = await this.continueFrom(target, partial);
    if (outcome === 'failed') { cleanEnd(); return 'resume-failed'; }
    this.o.end();
    return outcome === 'finished' ? 'continued' : 'continued-unfinished';
  }

  /**
   * 'failed': nothing of the resume reached the client — the site ends the
   * stream exactly as it would have. 'finished': the resume delivered its
   * terminal event and the client holds one complete message. 'unfinished':
   * the resume put content on the wire and then died too; the stream is left
   * open-ended (no synthesized close) so the client sees the truncation.
   */
  private async continueFrom(target: ContinuationTarget, partial: string): Promise<'failed' | 'finished' | 'unfinished'> {
    const r = this.o.resume!;
    const s = this.state;
    const fetchImpl = r.fetchImpl ?? fetch;
    const path = this.o.shape === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    const clientBody = r.clientBody();
    if (!clientBody) { this.log(`#${this.o.requestNo} continuation skipped: client body is not a JSON object`); return 'failed'; }
    const body = buildResumeBody(this.o.shape, clientBody, target.model, partial);
    const splicer = new Splicer(this.o.shape, s, partial);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), r.timeoutMs);
    const startedAt = Date.now();
    try {
      r.onBeforeResume?.();
      const res = await fetchImpl(`${r.loopbackBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CONTINUATION_HEADER]: String(this.o.requestNo), ...r.loopbackHeaders },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        this.log(`#${this.o.requestNo} continuation refused: HTTP ${res.status} ${detail.slice(0, 200)}`);
        return 'failed';
      }
      // An SSE comment, ignored by every parser, so a raw capture shows where
      // the second provider took over.
      this.o.write(`: dario continuation ${target.label} after ${partial.length} chars\n\n`);
      const reader = res.body.getReader();
      const split = new SseFrameSplitter();
      let sawContent = false;
      let resumeError: SseFrame | null = null;
      try {
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.o.isClientGone()) { abort.abort(); break; }
          for (const f of split.feed(value)) {
            if (f.data && (f.data.type === 'error' || f.data.error)) { resumeError = f; break outer; }
            for (const out of splicer.feed(f)) { this.o.write(out); sawContent = true; }
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* released by abort */ }
      }
      const st = splicer.stats;
      if (resumeError) {
        // The second provider failed too. Nothing spliced yet: report failure
        // so the site ends the stream exactly as before. Something spliced:
        // forward this error as the terminal frame — closing the message with
        // a synthetic end_turn would make a truncated answer look finished.
        if (!sawContent) return 'failed';
        this.o.write(resumeError.raw);
        this.log(`#${this.o.requestNo} continuation died too after +${st.emitted} chars`);
        return 'unfinished';
      }
      if (splicer.terminalSeen) {
        this.log(`#${this.o.requestNo} continuation done: +${st.emitted} chars in ${Date.now() - startedAt}ms (anchor ${st.anchor}, trimmed ${st.dropped})`);
        return 'finished';
      }
      // The resume body ended without its terminal event — a reset on the
      // second provider, or the client left and the loopback was aborted.
      // Hand over what was held and stop there: no synthesized close.
      for (const out of splicer.abandon()) { this.o.write(out); sawContent = true; }
      if (!sawContent) return 'failed';
      this.log(`#${this.o.requestNo} continuation ended without its terminal event after +${st.emitted} chars — stream left unfinished`);
      return 'unfinished';
    } catch (err) {
      this.log(`#${this.o.requestNo} continuation failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  private log(line: string): void {
    (this.o.log ?? ((l: string) => console.log(`[dario] ${l}`)))(line);
  }
}

/** Convenience for sites that hold a ServerResponse: the guard writes through `write`, ends through `res.end()`. */
export function guardFor(res: ServerResponse, o: Omit<MidstreamGuardOptions, 'end'>): MidstreamGuard {
  return new MidstreamGuard({ ...o, end: () => { if (!res.writableEnded) res.end(); } });
}

/**
 * The loopback origin for a bound listen address. A wildcard bind is reached
 * on the loopback interface; a specific address is reached on itself.
 */
export function loopbackBaseFor(host: string, port: number): string {
  const h = host.trim().toLowerCase();
  if (h === '' || h === '0.0.0.0' || h === '127.0.0.1' || h === 'localhost') return `http://127.0.0.1:${port}`;
  if (h === '::' || h === '::1') return `http://[::1]:${port}`;
  return h.includes(':') ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

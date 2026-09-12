/**
 * Inbound OpenAI Responses API (v6.3) — `POST /v1/responses` on dario.
 *
 * Codex CLI 0.154 dropped `wire_api = "chat"` (openai/codex discussion 7782):
 * a custom provider must speak the Responses API or it cannot be used at all.
 * The OpenAI Agents SDK and everything newer from OpenAI speak the same shape.
 * This module makes dario a Responses endpoint, so those clients run on a
 * Claude subscription — and on a ChatGPT one, through the codex leg.
 *
 * Shape of the work: the request is translated ONCE at the front door into
 * the Anthropic Messages body every other dario path already understands
 * (`responsesRequestToAnthropic`), the request then runs as an ordinary
 * Anthropic-shape request — pool, template, codex leg, mid-stream
 * continuation, all of it — and every byte written back to the client passes
 * through `ResponsesOut`, which turns Anthropic SSE (or a buffered Anthropic
 * message, or an Anthropic error body) into the Responses wire shape. Nothing
 * downstream of the front door knows the client is a Responses client.
 *
 * The reverse direction — an Anthropic-shape request served by the codex
 * backend — has lived in anthropic-responses-translate.ts since 5.5.87. The
 * two translators share types and nothing else on purpose: each direction is
 * read against the wire captures that motivated it.
 *
 * What is dropped, and said so once per process at verbose: hosted tool types
 * the pool cannot run (`web_search`, `file_search`, `mcp`, …), `reasoning`
 * items on the way in (the encrypted content is OpenAI's, and the pool does
 * not need them back), `text.format`, `previous_response_id` (dario is
 * stateless; a 400, not a silent ignore).
 */

import type { ServerResponse } from 'node:http';
import { SseFrameSplitter, type SseFrame } from './midstream.js';

// ---------------------------------------------------------------------------
//  Request: Responses → Anthropic Messages
// ---------------------------------------------------------------------------

export interface InboundTranslation {
  body: Record<string, unknown>;
  /** Things that did not survive the translation, one line each. */
  warnings: string[];
}

export class ResponsesRequestError extends Error {
  constructor(message: string, readonly param?: string) { super(message); }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

const EFFORTS: Record<string, string> = {
  none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

type Part = Record<string, unknown>;
type Msg = { role: 'user' | 'assistant'; content: Part[] };

function textPart(text: string): Part { return { type: 'text', text }; }

function imagePart(url: string, warnings: string[]): Part | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  warnings.push(`input_image with an unsupported image_url dropped (${url.slice(0, 24)}…)`);
  return null;
}

/** Content of a Responses message → Anthropic content blocks. */
function contentParts(content: unknown, warnings: string[]): Part[] {
  if (typeof content === 'string') return content.length > 0 ? [textPart(content)] : [];
  if (!Array.isArray(content)) return [];
  const out: Part[] = [];
  for (const p of content as Array<Record<string, unknown>>) {
    switch (p?.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        if (typeof p.text === 'string' && p.text.length > 0) out.push(textPart(p.text));
        break;
      case 'refusal':
        if (typeof p.refusal === 'string') out.push(textPart(p.refusal));
        break;
      case 'input_image': {
        const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url as { url?: string } | undefined)?.url;
        if (typeof url === 'string') { const img = imagePart(url, warnings); if (img) out.push(img); }
        else warnings.push('input_image without image_url dropped (file_id images are not supported)');
        break;
      }
      default:
        warnings.push(`content part ${String(p?.type)} dropped`);
    }
  }
  return out;
}

/** A tool's output as a tool_result `content` — string when it is only text. */
function toolOutput(output: unknown, warnings: string[]): string | Part[] {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts = contentParts(output, warnings);
    return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text as string).join('') : parts;
  }
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

function parseArguments(args: unknown, name: string, warnings: string[]): Record<string, unknown> {
  if (typeof args !== 'string' || args.trim() === '') return {};
  try {
    const v = JSON.parse(args) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    warnings.push(`function_call ${name}: arguments is not a JSON object, sent as {}`);
  } catch {
    warnings.push(`function_call ${name}: arguments is not valid JSON, sent as {}`);
  }
  return {};
}

/** Function tools, with `namespace` groups flattened; hosted tool types dropped. */
function translateTools(tools: unknown, warnings: string[]): Part[] {
  if (!Array.isArray(tools)) return [];
  const out: Part[] = [];
  const add = (t: Record<string, unknown>): void => {
    switch (t?.type) {
      case 'function': {
        if (typeof t.name !== 'string' || t.name.length === 0) { warnings.push('function tool without a name dropped'); break; }
        const tool: Part = { name: t.name, input_schema: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object', properties: {} } };
        if (typeof t.description === 'string') tool.description = t.description;
        out.push(tool);
        break;
      }
      case 'namespace':
        for (const inner of (Array.isArray(t.tools) ? t.tools : []) as Record<string, unknown>[]) add(inner);
        break;
      case 'custom':
        warnings.push(`custom tool ${String(t.name)} dropped (freeform tools have no Anthropic equivalent)`);
        break;
      default:
        warnings.push(`${String(t?.type)} tool dropped (hosted tools do not run on the Claude pool)`);
    }
  };
  for (const t of tools as Record<string, unknown>[]) add(t);
  return out;
}

function translateToolChoice(choice: unknown, parallel: unknown): Part | undefined {
  let out: Part | undefined;
  if (choice === undefined || choice === 'auto') out = { type: 'auto' };
  else if (choice === 'required') out = { type: 'any' };
  else if (choice === 'none') out = { type: 'none' };
  else if (choice && typeof choice === 'object') {
    const c = choice as { type?: string; name?: string };
    if (c.type === 'function' && typeof c.name === 'string') out = { type: 'tool', name: c.name };
    else out = { type: 'auto' };   // allowed_tools and hosted-tool choices: let the model decide
  }
  if (parallel === false && out && out.type !== 'none') out.disable_parallel_tool_use = true;
  // Anthropic's default is auto; only send the field when it says something.
  if (out && out.type === 'auto' && !out.disable_parallel_tool_use) return undefined;
  return out;
}

/**
 * The Responses request as the Anthropic Messages body the rest of dario
 * serves. Throws ResponsesRequestError for shapes that cannot be served
 * honestly (no model, no input, `previous_response_id`).
 */
export function responsesRequestToAnthropic(req: Record<string, unknown>): InboundTranslation {
  const warnings: string[] = [];
  const model = typeof req.model === 'string' ? req.model.trim() : '';
  if (!model) throw new ResponsesRequestError('model is required', 'model');
  if (req.previous_response_id !== undefined && req.previous_response_id !== null) {
    throw new ResponsesRequestError('previous_response_id is not supported: dario is stateless — send the full input each turn (set store: false)', 'previous_response_id');
  }

  const systemParts: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions.length > 0) systemParts.push(req.instructions);

  const messages: Msg[] = [];
  // Tools declared inside the input (`additional_tools` items — what Codex
  // CLI sends for models it has metadata for) join the top-level list.
  const extraTools: unknown[] = [];
  const push = (role: 'user' | 'assistant', parts: Part[]): void => {
    if (parts.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...parts); else messages.push({ role, content: parts });
  };

  const input = req.input;
  if (typeof input === 'string') {
    push('user', [textPart(input)]);
  } else if (Array.isArray(input)) {
    for (const raw of input as Record<string, unknown>[]) {
      const type = typeof raw?.type === 'string' ? raw.type : (raw?.role ? 'message' : '');
      switch (type) {
        case 'message': {
          const role = String(raw.role ?? 'user');
          if (role === 'system' || role === 'developer') {
            const text = contentParts(raw.content, warnings).filter((p) => p.type === 'text').map((p) => p.text as string).join('\n');
            if (text) systemParts.push(text);
          } else {
            push(role === 'assistant' ? 'assistant' : 'user', contentParts(raw.content, warnings));
          }
          break;
        }
        case 'function_call': {
          const name = String(raw.name ?? '');
          const callId = String(raw.call_id ?? raw.id ?? '');
          if (!name || !callId) { warnings.push('function_call without name/call_id dropped'); break; }
          push('assistant', [{ type: 'tool_use', id: callId, name, input: parseArguments(raw.arguments, name, warnings) }]);
          break;
        }
        case 'function_call_output': {
          const callId = String(raw.call_id ?? '');
          if (!callId) { warnings.push('function_call_output without call_id dropped'); break; }
          push('user', [{ type: 'tool_result', tool_use_id: callId, content: toolOutput(raw.output, warnings) }]);
          break;
        }
        case 'reasoning':
          break;   // OpenAI's encrypted reasoning; the pool has its own
        case 'additional_tools':
          if (Array.isArray(raw.tools)) extraTools.push(...(raw.tools as unknown[]));
          break;
        default:
          warnings.push(`input item ${type || '(untyped)'} dropped`);
      }
    }
  } else {
    throw new ResponsesRequestError('input must be a string or an array of items', 'input');
  }
  if (messages.length === 0) throw new ResponsesRequestError('input carries no user or assistant content', 'input');
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: [textPart('(continue)')] });

  const body: Record<string, unknown> = { model, messages };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  const maxOut = typeof req.max_output_tokens === 'number' && req.max_output_tokens > 0 ? Math.floor(req.max_output_tokens) : DEFAULT_MAX_OUTPUT_TOKENS;
  body.max_tokens = maxOut;
  if (req.stream === true) body.stream = true;
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.top_p === 'number') body.top_p = req.top_p;
  const tools = translateTools([...(Array.isArray(req.tools) ? req.tools as unknown[] : []), ...extraTools], warnings);
  if (tools.length > 0) body.tools = tools;
  const choice = translateToolChoice(req.tool_choice, req.parallel_tool_calls);
  if (choice && tools.length > 0) body.tool_choice = choice;
  const effort = (req.reasoning as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === 'string' && EFFORTS[effort]) {
    // dario's own per-request effort spelling (model:high), parsed on the
    // Claude path and the codex path alike — see parseEffortSuffix.
    body.model = `${model}:${EFFORTS[effort]}`;
  }
  const text = req.text as { format?: { type?: string } } | undefined;
  if (text?.format && text.format.type && text.format.type !== 'text') warnings.push(`text.format ${text.format.type} dropped (structured output is not translated on this route)`);
  for (const k of ['metadata', 'include', 'truncation', 'user', 'service_tier']) if (req[k] !== undefined) { /* accepted, unused */ }
  return { body, warnings };
}

// ---------------------------------------------------------------------------
//  Response: Anthropic → Responses
// ---------------------------------------------------------------------------

type OutItem = Record<string, unknown>;

interface AnthropicUsageLike {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}

function responsesUsage(u: AnthropicUsageLike | undefined): Record<string, unknown> {
  const cached = u?.cache_read_input_tokens ?? 0;
  const input = (u?.input_tokens ?? 0) + cached + (u?.cache_creation_input_tokens ?? 0);
  const output = u?.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

function statusFor(stopReason: string | null | undefined): { status: string; incomplete_details: { reason: string } | null } {
  if (stopReason === 'max_tokens') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  return { status: 'completed', incomplete_details: null };
}

/** Anthropic message id `msg_01AB…` → a Responses response id. */
function responseIdFrom(messageId: unknown): string {
  const raw = typeof messageId === 'string' && messageId.length > 0 ? messageId.replace(/^msg_/, '') : Math.random().toString(36).slice(2);
  return `resp_${raw}`;
}

function baseResponse(id: string, createdAt: number, model: string): Record<string, unknown> {
  return {
    id, object: 'response', created_at: createdAt, status: 'in_progress', error: null, incomplete_details: null,
    model, output: [], parallel_tool_calls: true, tool_choice: 'auto', tools: [], store: false, usage: null,
  };
}

/** A buffered Anthropic message → a Responses response object. */
export function anthropicMessageToResponses(msg: Record<string, unknown>, createdAt = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const id = responseIdFrom(msg.id);
  const model = typeof msg.model === 'string' ? msg.model : '';
  const output: OutItem[] = [];
  let n = 0;
  for (const block of (Array.isArray(msg.content) ? msg.content : []) as Record<string, unknown>[]) {
    n++;
    switch (block.type) {
      case 'text':
        output.push({ id: `msg_${id.slice(5)}_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: String(block.text ?? ''), annotations: [] }] });
        break;
      case 'tool_use':
        output.push({ id: `fc_${id.slice(5)}_${n}`, type: 'function_call', status: 'completed', call_id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) });
        break;
      case 'thinking': {
        const t = typeof block.thinking === 'string' ? block.thinking : '';
        output.push({ id: `rs_${id.slice(5)}_${n}`, type: 'reasoning', summary: t ? [{ type: 'summary_text', text: t }] : [] });
        break;
      }
      default: break;   // redacted_thinking, server tool blocks: nothing a Responses client can use
    }
  }
  const st = statusFor(msg.stop_reason as string | null | undefined);
  return { ...baseResponse(id, createdAt, model), status: st.status, incomplete_details: st.incomplete_details, output, usage: responsesUsage(msg.usage as AnthropicUsageLike | undefined) };
}

/** An Anthropic error body → the OpenAI error envelope. */
export function anthropicErrorToResponses(body: Record<string, unknown>): Record<string, unknown> {
  // Anthropic: { type: 'error', error: { type, message } }. dario's own
  // pre-upstream errors: { error: 'Proxy error', message: '…' }.
  const e = body.error;
  if (typeof e === 'string') return { error: { message: typeof body.message === 'string' ? body.message : e, type: 'api_error', code: null, param: null } };
  const err = (e ?? {}) as { type?: string; message?: string };
  return { error: { message: err.message ?? 'upstream error', type: err.type ?? 'api_error', code: err.type ?? null, param: null } };
}

/**
 * Anthropic SSE → Responses SSE, incrementally. One instance per response.
 * Comments (`: dario continuation …`) ride through untouched; `ping` is
 * dropped; `error` becomes `response.failed` + an `error` event.
 */
export class ResponsesOutStream {
  private seq = 0;
  private id = '';
  private createdAt = Math.floor(Date.now() / 1000);
  private model: string;
  private started = false;
  private readonly output: OutItem[] = [];
  private readonly open = new Map<number, { item: OutItem; kind: 'message' | 'function_call' | 'reasoning'; text: string; summaryOpened: boolean }>();
  private usage: AnthropicUsageLike = {};
  private stopReason: string | null = null;
  private done = false;
  private readonly splitter = new SseFrameSplitter();

  constructor(requestModel: string) { this.model = requestModel; }

  private ev(type: string, payload: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...payload })}\n\n`;
  }

  private snapshot(status: string): Record<string, unknown> {
    return { ...baseResponse(this.id, this.createdAt, this.model), status, output: this.output.map((o) => ({ ...o })) };
  }

  feed(chunk: string | Uint8Array): string {
    let out = '';
    for (const f of this.splitter.feed(chunk)) out += this.frame(f);
    return out;
  }

  /** Whatever is still buffered (a partial frame) — nothing a Responses client can use. */
  end(): string { this.splitter.flush(); return ''; }

  get finished(): boolean { return this.done; }

  private frame(f: SseFrame): string {
    if (f.comment) return f.raw;
    const d = f.data;
    if (!d) return '';
    switch (d.type) {
      case 'ping': return '';
      case 'message_start': {
        const m = (d.message ?? {}) as Record<string, unknown>;
        this.id = responseIdFrom(m.id);
        if (typeof m.model === 'string' && m.model) this.model = m.model;
        this.usage = { ...(m.usage as AnthropicUsageLike | undefined) };
        this.started = true;
        return this.ev('response.created', { response: this.snapshot('in_progress') }) + this.ev('response.in_progress', { response: this.snapshot('in_progress') });
      }
      case 'content_block_start': return this.blockStart(d);
      case 'content_block_delta': return this.blockDelta(d);
      case 'content_block_stop': return this.blockStop(d);
      case 'message_delta': {
        const delta = d.delta as { stop_reason?: string | null } | undefined;
        if (delta?.stop_reason !== undefined) this.stopReason = delta.stop_reason;
        const u = d.usage as AnthropicUsageLike | undefined;
        if (u) this.usage = { ...this.usage, ...u };
        return '';
      }
      case 'message_stop': {
        if (!this.started) return '';
        this.done = true;
        const st = statusFor(this.stopReason);
        const response = { ...this.snapshot(st.status), incomplete_details: st.incomplete_details, usage: responsesUsage(this.usage) };
        return this.ev('response.completed', { response });
      }
      case 'error': {
        const err = (d.error ?? {}) as { type?: string; message?: string };
        this.done = true;
        if (!this.started) { this.id = responseIdFrom(undefined); this.started = true; }
        const response = { ...this.snapshot('failed'), error: { code: err.type ?? 'server_error', message: err.message ?? 'upstream error' } };
        return this.ev('response.failed', { response }) + this.ev('error', { code: err.type ?? 'server_error', message: err.message ?? 'upstream error', param: null });
      }
      default: return '';
    }
  }

  private blockStart(d: Record<string, unknown>): string {
    const idx = typeof d.index === 'number' ? d.index : this.output.length;
    const cb = (d.content_block ?? {}) as Record<string, unknown>;
    const n = this.output.length + 1;
    const outputIndex = this.output.length;
    switch (cb.type) {
      case 'text': {
        const item: OutItem = { id: `msg_${this.id.slice(5)}_${n}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
        this.output.push(item);
        this.open.set(idx, { item, kind: 'message', text: typeof cb.text === 'string' ? cb.text : '', summaryOpened: false });
        return this.ev('response.output_item.added', { output_index: outputIndex, item: { ...item } })
          + this.ev('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      case 'tool_use': {
        const item: OutItem = { id: `fc_${this.id.slice(5)}_${n}`, type: 'function_call', status: 'in_progress', call_id: String(cb.id ?? ''), name: String(cb.name ?? ''), arguments: '' };
        this.output.push(item);
        this.open.set(idx, { item, kind: 'function_call', text: '', summaryOpened: false });
        return this.ev('response.output_item.added', { output_index: outputIndex, item: { ...item } });
      }
      case 'thinking': {
        const item: OutItem = { id: `rs_${this.id.slice(5)}_${n}`, type: 'reasoning', summary: [] };
        this.output.push(item);
        this.open.set(idx, { item, kind: 'reasoning', text: '', summaryOpened: false });
        return this.ev('response.output_item.added', { output_index: outputIndex, item: { ...item } });
      }
      default:
        return '';   // redacted_thinking, server tools: not surfaced
    }
  }

  private blockDelta(d: Record<string, unknown>): string {
    const idx = typeof d.index === 'number' ? d.index : -1;
    const o = this.open.get(idx);
    if (!o) return '';
    const delta = (d.delta ?? {}) as Record<string, unknown>;
    const outputIndex = this.output.indexOf(o.item);
    if (o.kind === 'message' && delta.type === 'text_delta' && typeof delta.text === 'string') {
      o.text += delta.text;
      return this.ev('response.output_text.delta', { item_id: o.item.id, output_index: outputIndex, content_index: 0, delta: delta.text });
    }
    if (o.kind === 'function_call' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      o.text += delta.partial_json;
      return this.ev('response.function_call_arguments.delta', { item_id: o.item.id, output_index: outputIndex, delta: delta.partial_json });
    }
    if (o.kind === 'reasoning' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      let out = '';
      if (!o.summaryOpened) {
        o.summaryOpened = true;
        out += this.ev('response.reasoning_summary_part.added', { item_id: o.item.id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      o.text += delta.thinking;
      return out + this.ev('response.reasoning_summary_text.delta', { item_id: o.item.id, output_index: outputIndex, summary_index: 0, delta: delta.thinking });
    }
    return '';
  }

  private blockStop(d: Record<string, unknown>): string {
    const idx = typeof d.index === 'number' ? d.index : -1;
    const o = this.open.get(idx);
    if (!o) return '';
    this.open.delete(idx);
    const outputIndex = this.output.indexOf(o.item);
    switch (o.kind) {
      case 'message': {
        const part = { type: 'output_text', text: o.text, annotations: [] };
        o.item.status = 'completed';
        o.item.content = [part];
        return this.ev('response.output_text.done', { item_id: o.item.id, output_index: outputIndex, content_index: 0, text: o.text })
          + this.ev('response.content_part.done', { item_id: o.item.id, output_index: outputIndex, content_index: 0, part })
          + this.ev('response.output_item.done', { output_index: outputIndex, item: { ...o.item } });
      }
      case 'function_call': {
        const args = o.text.trim() === '' ? '{}' : o.text;
        o.item.arguments = args;
        o.item.status = 'completed';
        return this.ev('response.function_call_arguments.done', { item_id: o.item.id, output_index: outputIndex, arguments: args })
          + this.ev('response.output_item.done', { output_index: outputIndex, item: { ...o.item } });
      }
      case 'reasoning': {
        let out = '';
        if (o.summaryOpened) {
          out += this.ev('response.reasoning_summary_text.done', { item_id: o.item.id, output_index: outputIndex, summary_index: 0, text: o.text })
            + this.ev('response.reasoning_summary_part.done', { item_id: o.item.id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: o.text } });
          o.item.summary = [{ type: 'summary_text', text: o.text }];
        }
        return out + this.ev('response.output_item.done', { output_index: outputIndex, item: { ...o.item } });
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  The write boundary
// ---------------------------------------------------------------------------

/**
 * Everything dario writes to a Responses client passes through here. The
 * first bytes decide the mode: SSE frames are translated as they arrive; a
 * JSON body (a buffered message, or an error) is held and translated at end().
 */
export class ResponsesOut {
  private mode: 'undecided' | 'sse' | 'json' = 'undecided';
  private json = '';
  private readonly stream: ResponsesOutStream;
  private readonly decoder = new TextDecoder();

  constructor(requestModel: string) { this.stream = new ResponsesOutStream(requestModel); }

  write(chunk: string | Uint8Array): string {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.mode === 'undecided') {
      const head = text.trimStart();
      if (head.length === 0) return '';
      this.mode = head.startsWith('event:') || head.startsWith('data:') || head.startsWith(':') ? 'sse' : 'json';
    }
    if (this.mode === 'sse') return this.stream.feed(text);
    this.json += text;
    return '';
  }

  end(): string {
    if (this.mode === 'sse') return this.stream.end();
    if (this.mode === 'json') {
      this.json += this.decoder.decode();
      try {
        const parsed = JSON.parse(this.json) as Record<string, unknown>;
        if (parsed.type === 'message' && Array.isArray(parsed.content)) return JSON.stringify(anthropicMessageToResponses(parsed));
        // Already the OpenAI envelope (dario answered this route in the
        // client's shape itself): leave it alone.
        if (parsed.type !== 'error' && parsed.error && typeof parsed.error === 'object' && 'param' in (parsed.error as object)) return this.json;
        if (parsed.type === 'error' || parsed.error) return JSON.stringify(anthropicErrorToResponses(parsed));
        return this.json;
      } catch { return this.json; }
    }
    return '';
  }
}

/**
 * The ServerResponse a Responses client is served through: every write is
 * translated, everything else reaches the real response untouched (headers,
 * events, `writableEnded`, `destroyed`). Bound methods, so `res.on('close')`
 * and friends keep working on the real object.
 */
export function wrapResponsesClient(res: ServerResponse, out: ResponsesOut): ServerResponse {
  const target = res as unknown as Record<string | symbol, unknown> & { write: (...a: unknown[]) => boolean; end: (...a: unknown[]) => unknown };
  return new Proxy(res, {
    get(_t, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) => {
          const translated = out.write(chunk as string | Uint8Array);
          const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
          if (translated.length === 0) { cb?.(); return true; }
          return target.write(translated, ...(typeof rest[0] === 'string' ? rest : rest.filter((r) => typeof r === 'function')));
        };
      }
      if (prop === 'end') {
        return (chunk?: unknown, ...rest: unknown[]) => {
          if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
            const t = out.write(chunk as string | Uint8Array);
            if (t.length > 0) target.write(t);
          }
          const tail = out.end();
          if (tail.length > 0) target.write(tail);
          return target.end(...(typeof chunk === 'function' ? [chunk] : rest.filter((r) => typeof r === 'function')));
        };
      }
      // Getters run with `this` = the real response, never the proxy: Node's
      // internals read symbol-keyed state off `this`.
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as ServerResponse;
}

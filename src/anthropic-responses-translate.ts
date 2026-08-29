/**
 * Anthropic Messages ⇄ OpenAI Responses translator, ported into dario so that a
 * ChatGPT-subscription (codex) account can serve Anthropic-shape `/v1/messages`
 * requests. It was developed and live-probe-validated outside this repo, then
 * copied here with no change to any translation logic. The only port edits: the
 * Anthropic-side types and the reasoning-effort thresholds it used to import
 * from a sibling module are inlined below, making this file self-contained.
 */
/**
 * Anthropic Messages ⇄ OpenAI *Responses API* translation.
 *
 * Targets the Responses API (not Chat Completions): the ChatGPT Codex
 * backend speaks Responses, and reasoning models reject tools on
 * chat/completions. This
 * module targets the newer `/v1/responses` shape, which is REQUIRED for
 * the reasoning-model + function-tools combination: gpt-5.6-sol (and the
 * o-series) REJECT function tools together with reasoning on
 * `/chat/completions`, but accept both on `/responses`. That combination
 * is exactly Claude Code's case — CC always sends its 30+ tools and often
 * has thinking enabled — so this is the path dario 5.1 needs to drive a
 * reasoning model as a Claude backend.
 *
 * Pure data transforms — no network, no fs, no timers. A later wiring
 * phase will translate an inbound Messages request with
 * `anthropicToResponsesRequest`, POST it to `{baseUrl}/responses`, and
 * translate the reply back with `responsesToAnthropicResponse`
 * (non-streaming) — streaming is deferred (see the P0.6 stub below).
 *
 * The Responses shape is item-array based and sits closer to Anthropic's
 * block model than chat completions does. Field names CONFIRMED against
 * the OpenAI SDK type sources (openai-python `types/responses/*`); the
 * shapes that differ from the chat-completions translator are called out
 * where they occur:
 *
 *   - system  → top-level `instructions` (a string), NOT a role message.
 *   - messages → `input[]` items. User text/images become one message
 *     item with `input_text` / `input_image` parts (image_url is a bare
 *     string here, not `{url}`). Assistant text replays as a message item
 *     with a plain string. Assistant tool_use blocks become top-level
 *     `function_call` items; user tool_result blocks become top-level
 *     `function_call_output` items. Anthropic `tool_use_id` ↔ Responses
 *     `call_id` threads the two.
 *   - tools    → FLATTENED function tools `{type,name,description,
 *     parameters}` (chat nests these under `.function`).
 *   - tool_choice forced form → FLATTENED `{type:'function', name}`
 *     (chat uses `{type:'function', function:{name}}`).
 *   - thinking → `reasoning:{effort}` (+ `summary:'auto'` so a reasoning
 *     summary comes back and can round-trip to a thinking block). Unlike
 *     chat completions, reasoning + tools together is ALLOWED here — the
 *     whole reason this module exists.
 *   - max_tokens → `max_output_tokens`; `store:false` (stateless — dario
 *     keeps no server-side conversation).
 *
 * Deliberate lossy edges (documented at the relevant function):
 *   - `cache_control` is dropped silently (no Responses analog).
 *   - Reasoning models reject sampling params: `temperature`/`top_p` are
 *     omitted whenever reasoning is enabled.
 *   - assistant `thinking` / `redacted_thinking` blocks are dropped from
 *     the OUTBOUND request (no faithful inbound slot; encrypted_content
 *     round-tripping is a later concern). Reasoning that the model
 *     returns IS surfaced (as thinking blocks) on the response side.
 *   - Anthropic server tools (entries without `input_schema`) are skipped.
 *   - images inside `tool_result` content are dropped
 *     (`function_call_output.output` is a string); sibling text survives.
 */

// ─────────────────────────────────────────────────────────────────────
// Anthropic-side types (Messages API, as Claude Code sends it)
// ─────────────────────────────────────────────────────────────────────

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<Record<string, unknown>>;
  is_error?: boolean;
  cache_control?: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  /** Server-tool discriminator (`bash_20250124`, …). Untranslatable. */
  type?: string;
  cache_control?: unknown;
}

export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
  disable_parallel_tool_use?: boolean;
}

export interface AnthropicThinkingConfig {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
}

export interface AnthropicRequest {
  model: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: AnthropicThinkingConfig;
  metadata?: { user_id?: string | null };
}

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/**
 * Thinking-budget → reasoning_effort thresholds. Claude Code's thinking
 * tiers land at ~4k ("think"), ~10k ("think hard") and 31999
 * ("ultrathink") budget_tokens, so the cut points sit between those
 * tiers:
 *
 *   budget_tokens ≤ 4096            → 'low'
 *   4096 < budget_tokens ≤ 16384    → 'medium'
 *   budget_tokens > 16384           → 'high'
 *
 * `thinking` absent, disabled, or without a positive budget → no
 * `reasoning_effort` in the output (upstream default applies).
 */
export const REASONING_EFFORT_LOW_MAX = 4096;
export const REASONING_EFFORT_MEDIUM_MAX = 16384;

// ─────────────────────────────────────────────────────────────────────
// Anthropic-side extension: a thinking content block on the RESPONSE.
// AnthropicResponse.content above is text|tool_use only;
// the Responses API can return reasoning, so we widen the content union
// for this module's output while reusing AnthropicResponse for the rest.
// ─────────────────────────────────────────────────────────────────────

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ResponsesAnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock;

/** AnthropicResponse but with a content union that admits thinking blocks. */
export type AnthropicResponseWithThinking = Omit<AnthropicResponse, 'content'> & {
  content: ResponsesAnthropicContentBlock[];
};

// ─────────────────────────────────────────────────────────────────────
// OpenAI Responses-side types (request)
// ─────────────────────────────────────────────────────────────────────

export interface ResponsesInputText {
  type: 'input_text';
  text: string;
}

/** Responses `input_image`: image_url is a bare string (URL or data URI). */
export interface ResponsesInputImage {
  type: 'input_image';
  image_url: string;
  detail?: 'auto' | 'low' | 'high';
}

export type ResponsesInputContentPart = ResponsesInputText | ResponsesInputImage;

/** A role message input item (the "EasyInputMessage" form). */
export interface ResponsesInputMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesInputContentPart[];
}

/** Assistant tool call, replayed as a top-level input item. */
export interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
}

/** Tool result, fed back as a top-level input item (output is a string). */
export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

/** Flattened function tool — NOT nested under `.function` like chat. */
export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean | null;
}

export type ResponsesToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string };

export interface ResponsesReasoningConfig {
  effort?: 'low' | 'medium' | 'high';
  summary?: 'auto' | 'concise' | 'detailed';
}

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesFunctionTool[];
  tool_choice?: ResponsesToolChoice;
  parallel_tool_calls?: boolean;
  reasoning?: ResponsesReasoningConfig;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  store?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// OpenAI Responses-side types (response / output items)
// ─────────────────────────────────────────────────────────────────────

export interface ResponsesOutputText {
  type: 'output_text';
  text: string;
  annotations?: unknown[];
}

export interface ResponsesRefusal {
  type: 'refusal';
  refusal: string;
}

export type ResponsesMessageContentPart =
  | ResponsesOutputText
  | ResponsesRefusal
  | { type: string; [key: string]: unknown };

export interface ResponsesMessageItem {
  type: 'message';
  id?: string;
  role: 'assistant';
  status?: string;
  content?: ResponsesMessageContentPart[];
}

/** Response-side function_call: carries BOTH `id` (item id) and `call_id`. */
export interface ResponsesResponseFunctionCall {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  status?: string;
}

export interface ResponsesReasoningSummaryPart {
  type: 'summary_text';
  text: string;
}

export interface ResponsesReasoningContentPart {
  type: 'reasoning_text';
  text: string;
}

export interface ResponsesReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: ResponsesReasoningSummaryPart[];
  content?: ResponsesReasoningContentPart[];
  encrypted_content?: string | null;
  status?: string;
}

export type ResponsesOutputItem =
  | ResponsesMessageItem
  | ResponsesResponseFunctionCall
  | ResponsesReasoningItem
  | { type: string; [key: string]: unknown };

export interface ResponsesUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

export interface ResponsesResponse {
  id?: string;
  object?: string;
  model?: string;
  /** completed | failed | in_progress | cancelled | queued | incomplete (Azure also: requires_action). */
  status?: string;
  output?: ResponsesOutputItem[];
  output_text?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  usage?: ResponsesUsage | null;
}

// ─────────────────────────────────────────────────────────────────────
// Small local helpers.
// Thresholds are IMPORTED so the two translators stay in lock-step.
// ─────────────────────────────────────────────────────────────────────

/** thinking → reasoning effort, at the same cut points as the chat path. */
function thinkingToReasoningEffort(
  thinking: AnthropicThinkingConfig | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!thinking || thinking.type !== 'enabled') return undefined;
  const budget = thinking.budget_tokens;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    return undefined;
  }
  if (budget <= REASONING_EFFORT_LOW_MAX) return 'low';
  if (budget <= REASONING_EFFORT_MEDIUM_MAX) return 'medium';
  return 'high';
}

/** Flatten a Messages `system` field (string or text-block array). */
function flattenSystem(system: AnthropicRequest['system']): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts: string[] = [];
  for (const block of system) {
    // cache_control dropped silently — no Responses analog.
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Stringify a tool_result's content for a `function_call_output.output`,
 * which carries a string. Text blocks join with newlines; images/other
 * non-text blocks are dropped unless there is no text at all, in which
 * case the raw array is JSON-stringified so the data survives.
 */
function toolResultContentToString(
  content: AnthropicToolResultBlock['content'],
): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const texts: string[] = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  if (texts.length > 0) return texts.join('\n');
  return content.length > 0 ? JSON.stringify(content) : '';
}

function imageBlockToResponsesPart(block: AnthropicImageBlock): ResponsesInputImage | null {
  const source = block.source;
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return { type: 'input_image', image_url: `data:${media};base64,${source.data}` };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'input_image', image_url: source.url };
  }
  return null;
}

/** JSON-stringify tool_use input defensively (circular → `{}`). */
function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}

/**
 * Parse function-call arguments defensively. Upstreams occasionally emit
 * truncated or malformed JSON (notably on truncation); rather than throw
 * mid-response, unparseable arguments degrade to `{}` — the client's own
 * tool validation reports the missing fields.
 */
function safeParseArguments(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function anthropicMessageId(id: string | undefined): string {
  if (typeof id === 'string' && id.length > 0) {
    return id.startsWith('msg_') ? id : `msg_${id}`;
  }
  return 'msg_responses_translate';
}

// ─────────────────────────────────────────────────────────────────────
// Request translation: Anthropic → Responses
// ─────────────────────────────────────────────────────────────────────

/**
 * Translate one Anthropic user message (block form) into Responses input
 * items. tool_result blocks become top-level `function_call_output`
 * items and are emitted FIRST — they answer the previous assistant
 * turn's `function_call`s and must precede any fresh user content.
 * Remaining text/image blocks collapse into one user message item (a
 * plain string when it is a single text block, else `input_text` /
 * `input_image` parts).
 */
function translateUserBlocks(blocks: AnthropicContentBlock[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  const parts: ResponsesInputContentPart[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      const tr = block as AnthropicToolResultBlock;
      out.push({
        type: 'function_call_output',
        call_id: typeof tr.tool_use_id === 'string' ? tr.tool_use_id : '',
        output: toolResultContentToString(tr.content),
      });
    } else if (block.type === 'text' && typeof (block as AnthropicTextBlock).text === 'string') {
      parts.push({ type: 'input_text', text: (block as AnthropicTextBlock).text });
    } else if (block.type === 'image') {
      const part = imageBlockToResponsesPart(block as AnthropicImageBlock);
      if (part) parts.push(part);
    }
    // Unknown block types (document, search_result, …) are dropped.
  }

  const only = parts.length === 1 ? parts[0] : undefined;
  if (only && only.type === 'input_text') {
    out.push({ role: 'user', content: only.text });
  } else if (parts.length > 0) {
    out.push({ role: 'user', content: parts });
  }
  return out;
}

/**
 * Translate one Anthropic assistant message (block form) into Responses
 * input items: joined text becomes a single assistant message item (plain
 * string); each tool_use becomes a top-level `function_call` item whose
 * `call_id` mirrors the Anthropic tool_use `id`. thinking /
 * redacted_thinking blocks are dropped — no faithful inbound slot.
 */
function translateAssistantBlocks(blocks: AnthropicContentBlock[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  const texts: string[] = [];
  const calls: ResponsesFunctionCallItem[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof (block as AnthropicTextBlock).text === 'string') {
      texts.push((block as AnthropicTextBlock).text);
    } else if (block.type === 'tool_use') {
      const tu = block as AnthropicToolUseBlock;
      calls.push({
        type: 'function_call',
        call_id: typeof tu.id === 'string' ? tu.id : '',
        name: typeof tu.name === 'string' ? tu.name : '',
        arguments: stringifyToolInput(tu.input),
      });
    }
  }

  if (texts.length > 0) out.push({ role: 'assistant', content: texts.join('\n\n') });
  for (const call of calls) out.push(call);
  return out;
}

function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
): ResponsesToolChoice | undefined {
  if (!choice || typeof choice !== 'object') return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      // Responses forced form is FLATTENED: {type:'function', name}.
      return typeof choice.name === 'string'
        ? { type: 'function', name: choice.name }
        : 'required';
    default:
      return undefined;
  }
}

/**
 * Extra max_output_tokens reserved for reasoning tokens, by effort, so the
 * client's intended visible-output budget survives on a reasoning model
 * (max_output_tokens caps reasoning + output combined on the Responses API).
 */
export const REASONING_HEADROOM = { low: 12000, medium: 25000, high: 50000 } as const;
/** gpt-5.x / o-series output ceiling (tokens). */
export const RESPONSES_MAX_OUTPUT_CAP = 128000;

export interface AnthropicToResponsesOptions {
  /**
   * `reasoning.summary` value when reasoning is enabled. Default 'auto':
   * without a summary, the reasoning items come back with an empty
   * `summary[]` and there is nothing to round-trip into a thinking block.
   * Pass `null` to omit `summary` entirely.
   */
  reasoningSummary?: 'auto' | 'concise' | 'detailed' | null;
  /**
   * `store`. Default false — dario is stateless and keeps no server-side
   * conversation. Set true only if a caller wants OpenAI-side retention.
   */
  store?: boolean;
}

/**
 * Translate an Anthropic Messages request into an OpenAI Responses
 * request body for `{baseUrl}/responses`.
 *
 * Anthropic `input_schema` is already JSON Schema, which is what the
 * Responses `parameters` field expects — it passes through unchanged.
 * Tool entries without an `input_schema` (Anthropic server tools such as
 * `web_search_20250305`) have no function-tool equivalent and are
 * skipped. `cache_control` is dropped wherever it appears.
 */
export function anthropicToResponsesRequest(
  body: AnthropicRequest,
  targetModel: string,
  options: AnthropicToResponsesOptions = {},
): ResponsesRequest {
  const input: ResponsesInputItem[] = [];

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      input.push(...translateAssistantBlocks(msg.content));
    } else {
      input.push(...translateUserBlocks(msg.content));
    }
  }

  const out: ResponsesRequest = {
    model: targetModel,
    input,
    store: options.store ?? false,
  };

  const instructions = flattenSystem(body.system);
  if (instructions.length > 0) out.instructions = instructions;

  if (Array.isArray(body.tools)) {
    const tools: ResponsesFunctionTool[] = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool.name !== 'string') continue;
      if (!tool.input_schema || typeof tool.input_schema !== 'object') continue;
      const fn: ResponsesFunctionTool = {
        type: 'function',
        name: tool.name,
        parameters: tool.input_schema,
      };
      if (typeof tool.description === 'string') fn.description = tool.description;
      tools.push(fn);
    }
    if (tools.length > 0) out.tools = tools;
  }

  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice !== undefined && out.tools) out.tool_choice = toolChoice;
  if (body.tool_choice?.disable_parallel_tool_use === true && out.tools) {
    out.parallel_tool_calls = false;
  }

  const effort = thinkingToReasoningEffort(body.thinking);
  if (effort) {
    out.reasoning = { effort };
    const summary = options.reasoningSummary === undefined ? 'auto' : options.reasoningSummary;
    if (summary !== null) out.reasoning.summary = summary;
  }

  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) {
    // CRITICAL: on the Responses API, max_output_tokens caps reasoning +
    // visible output COMBINED, but the client's max_tokens is its intended
    // *visible-output* budget. With reasoning on, the model can spend the
    // whole budget thinking and return status `incomplete` with NO message —
    // the client then renders an empty turn. Reserve reasoning headroom so
    // the client's output budget survives, capped at the model output ceiling.
    const headroom = effort ? REASONING_HEADROOM[effort] : 0;
    out.max_output_tokens = Math.min(RESPONSES_MAX_OUTPUT_CAP, body.max_tokens + headroom);
  }

  // Reasoning models reject sampling params — only forward temperature /
  // top_p when reasoning is OFF. (With reasoning on, dropping them is
  // what keeps the request acceptable at all.)
  if (!effort) {
    if (typeof body.temperature === 'number') out.temperature = body.temperature;
    if (typeof body.top_p === 'number') out.top_p = body.top_p;
  }

  if (body.stream === true) out.stream = true;

  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Response translation: Responses → Anthropic (non-streaming)
// ─────────────────────────────────────────────────────────────────────

/** Extract displayable reasoning text: summary_text first, else reasoning_text. */
function reasoningItemText(item: ResponsesReasoningItem): string {
  const parts: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const s of item.summary) {
      if (s && typeof s === 'object' && s.type === 'summary_text' && typeof s.text === 'string') {
        parts.push(s.text);
      }
    }
  }
  if (parts.length === 0 && Array.isArray(item.content)) {
    for (const c of item.content) {
      if (c && typeof c === 'object' && c.type === 'reasoning_text' && typeof c.text === 'string') {
        parts.push(c.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Derive an Anthropic stop_reason from the Responses status. A tool call
 * anywhere in the output wins → 'tool_use' (Anthropic's rule). Otherwise
 * an `incomplete` status maps to 'max_tokens' (the common truncation
 * case), except a content-filter incompletion, which has no length
 * analog and degrades to 'end_turn'. Everything else is 'end_turn'.
 */
function deriveStopReason(resp: ResponsesResponse, sawToolCall: boolean): AnthropicStopReason {
  if (sawToolCall) return 'tool_use';
  if (resp.status === 'incomplete') {
    return resp.incomplete_details?.reason === 'content_filter' ? 'end_turn' : 'max_tokens';
  }
  return 'end_turn';
}

/**
 * Translate a non-streaming Responses reply into an Anthropic Messages
 * response. `requestModel` is echoed back as `model` so the client sees
 * the model it asked for, not the upstream alias. Output items are walked
 * in order:
 *   - message      → its `output_text` parts become text blocks; a
 *                    `refusal` part surfaces as a text block so the client
 *                    sees why the turn produced no content.
 *   - function_call → a tool_use block, id = `call_id` (Anthropic threads
 *                    the tool_result back on this id), input = parsed
 *                    `arguments` (bad JSON → `{}`).
 *   - reasoning     → a thinking block IF it carries summary/reasoning
 *                    text; an empty reasoning item is dropped.
 * Other item types (web_search_call, code_interpreter_call, …) are
 * dropped. If nothing produced content but `output_text` is present, it
 * is used as a single text block fallback.
 */
export function responsesToAnthropicResponse(
  resp: ResponsesResponse,
  requestModel: string,
): AnthropicResponseWithThinking {
  const content: ResponsesAnthropicContentBlock[] = [];
  let sawToolCall = false;

  for (const item of Array.isArray(resp.output) ? resp.output : []) {
    if (!item || typeof item !== 'object') continue;
    const type = (item as { type?: unknown }).type;

    if (type === 'message') {
      const msg = item as ResponsesMessageItem;
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (!part || typeof part !== 'object') continue;
        const pt = (part as { type?: unknown }).type;
        if (pt === 'output_text') {
          const text = (part as ResponsesOutputText).text;
          if (typeof text === 'string' && text.length > 0) content.push({ type: 'text', text });
        } else if (pt === 'refusal') {
          const refusal = (part as ResponsesRefusal).refusal;
          if (typeof refusal === 'string' && refusal.length > 0) {
            content.push({ type: 'text', text: refusal });
          }
        }
      }
    } else if (type === 'function_call') {
      const fc = item as ResponsesResponseFunctionCall;
      sawToolCall = true;
      const id =
        typeof fc.call_id === 'string' && fc.call_id.length > 0
          ? fc.call_id
          : typeof fc.id === 'string' && fc.id.length > 0
            ? fc.id
            : 'toolu_responses_translate';
      content.push({
        type: 'tool_use',
        id,
        name: typeof fc.name === 'string' ? fc.name : '',
        input: safeParseArguments(fc.arguments),
      });
    } else if (type === 'reasoning') {
      const text = reasoningItemText(item as ResponsesReasoningItem);
      if (text.length > 0) content.push({ type: 'thinking', thinking: text });
    }
    // Other item types are dropped.
  }

  if (content.length === 0 && typeof resp.output_text === 'string' && resp.output_text.length > 0) {
    content.push({ type: 'text', text: resp.output_text });
  }

  return {
    id: anthropicMessageId(resp.id),
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: deriveStopReason(resp, sawToolCall),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Streaming translation: Responses SSE → Anthropic SSE
// ─────────────────────────────────────────────────────────────────────
//
// The Responses stream is a TYPED event stream: every SSE record is an
// `event: <type>` / `data: <json>` pair whose JSON carries a matching
// `type` discriminator — unlike chat completions' homogeneous delta
// chunks. Event names + field shapes CONFIRMED against the OpenAI SDK
// type sources (openai-python `types/responses/*`):
//
//   response.created / response.in_progress    → prime message_start (response.id/model)
//   response.output_item.added   (message)     → nothing yet; text arrives via deltas
//   response.output_item.added   (function_call)→ content_block_start {tool_use}      (item.call_id, item.name)
//   response.output_item.added   (reasoning)   → content_block_start {thinking}
//   response.output_text.delta                 → content_block_delta {text_delta}      (fragment field: `delta`)
//   response.function_call_arguments.delta     → content_block_delta {input_json_delta}(fragment field: `delta`)
//   response.reasoning_summary_text.delta      → content_block_delta {thinking_delta}  (fragment field: `delta`)
//   response.reasoning_text.delta              → content_block_delta {thinking_delta}  (fragment field: `delta`)
//   response.output_item.done                  → content_block_stop
//   response.completed / .incomplete / .failed → message_delta (stop_reason + usage) + message_stop
//   error                                      → clean terminal (message_delta + message_stop)
//
// Notes that differ from a first guess: the item-index field is
// `output_index` (NOT `item_index`); the arg/text/reasoning fragment
// rides a field literally named `delta`; the reasoning-summary delta also
// carries `summary_index`, function-call-args deltas carry NO
// content_index; and the stream error event's `type` is the bare string
// `"error"` (not `response.error`). Anthropic thinking deltas use
// `{type:'thinking_delta', thinking}` — the exact shape dario's own
// analytics parser reads (proxy.ts). Responses emits items strictly in
// order, so the one-open-block discipline is naturally satisfied; the
// translator still tracks output_index → block index and closes the
// previous block whenever a new one opens.

/**
 * Anthropic SSE event objects this translator emits. A superset of
 * The Anthropic stream-event shape: content blocks and deltas
 * also admit `thinking` / `thinking_delta` (the Responses API can stream
 * reasoning, which chat completions cannot).
 */
export type ResponsesAnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponseWithThinking }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: AnthropicStopReason; stop_sequence: null };
      usage: { output_tokens: number; input_tokens?: number };
    }
  | { type: 'message_stop' };

/**
 * One parsed Responses SSE event — a typed superset of the fields this
 * translator consumes. Every event carries a `type`; the rest are present
 * only on the events that use them.
 */
export interface ResponsesStreamEvent {
  type: string;
  sequence_number?: number;
  /** created | in_progress | completed | incomplete | failed carry a full response. */
  response?: ResponsesResponse;
  /** output_item.added | output_item.done carry the item. */
  item?: ResponsesOutputItem;
  /** Index of the item within `response.output` — the field is `output_index`. */
  output_index?: number;
  item_id?: string;
  content_index?: number;
  summary_index?: number;
  /** Text / argument / reasoning fragment on `*.delta` events. */
  delta?: string;
  /** error event fields. */
  code?: string | null;
  message?: string;
  param?: string | null;
  [key: string]: unknown;
}

export interface ResponsesStreamTranslatorOptions {
  /** Model echoed in message_start. Defaults to the created event's `response.model`. */
  requestModel?: string;
}

export interface ResponsesStreamTranslator {
  /** Feed one parsed Responses event; returns the Anthropic events it produced. */
  push(event: ResponsesStreamEvent): ResponsesAnthropicStreamEvent[];
  /** Signal end-of-stream; returns the closing events. Idempotent. */
  end(): ResponsesAnthropicStreamEvent[];
}

const strOr = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Build a streaming translator from parsed OpenAI Responses events to
 * Anthropic SSE event objects. Same interface + discipline as
 * `openAIStreamToAnthropicSSE`: `push(event)` / `end()`, exactly one
 * content block open at a time, strictly increasing indices, event name
 * === data.type. Callers parse the upstream SSE themselves
 * (`parseResponsesSSEEvent` / `createResponsesSSEParser`), push each
 * event, and serialize the returned events (`formatResponsesAnthropicSSE`
 * produces the wire framing).
 *
 *   - message_start fires once, on the first event, with an empty-content
 *     envelope and usage 0/0 (usage is known only at response.completed).
 *   - A `function_call` item opens a tool_use block on
 *     output_item.added; a `reasoning` item opens a thinking block there
 *     (eager, so block order matches upstream item order even before the
 *     first summary fragment — a reasoning item that streams no text thus
 *     yields an empty thinking block bracketed by start/stop, which
 *     Anthropic clients tolerate). A `message` item opens its text block
 *     lazily on the first output_text.delta.
 *   - output_item.done closes that item's block; response.completed (or
 *     .incomplete / .failed, or a stream `error`) closes any open block
 *     and emits message_delta (stop_reason + usage) + message_stop, then
 *     marks the stream ended.
 *   - `end()` repeats the closing sequence only if no terminal event was
 *     seen (a cut-off stream), and is otherwise idempotent — so callers
 *     can always call it safely.
 *
 * stop_reason: a tool call anywhere → 'tool_use'; else an `incomplete`
 * status → 'max_tokens' (content-filter incompletion → 'end_turn'); else
 * 'end_turn' (via the shared deriveStopReason).
 */
export function responsesStreamToAnthropicSSE(
  options: ResponsesStreamTranslatorOptions = {},
): ResponsesStreamTranslator {
  let started = false;
  let ended = false;
  let model = options.requestModel;
  let messageId = 'msg_responses_translate';
  let nextIndex = 0;
  let open: { kind: 'text' | 'thinking' | 'tool'; index: number; outputIndex: number } | null = null;
  /** Responses `output_index` → the Anthropic block it maps to. */
  const blockByOutputIndex = new Map<number, { kind: 'text' | 'thinking' | 'tool'; index: number }>();
  let sawToolCall = false;
  let syntheticToolSeq = 0;

  function ensureStarted(
    event: ResponsesStreamEvent | null,
    events: ResponsesAnthropicStreamEvent[],
  ): void {
    if (started) return;
    started = true;
    messageId = anthropicMessageId(event?.response?.id);
    const resolvedModel = model ?? (strOr(event?.response?.model) || 'unknown');
    model = resolvedModel;
    events.push({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: resolvedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeOpenBlock(events: ResponsesAnthropicStreamEvent[]): void {
    if (open) {
      events.push({ type: 'content_block_stop', index: open.index });
      open = null;
    }
  }

  function openToolBlock(
    item: ResponsesOutputItem | undefined,
    outputIndex: number,
    events: ResponsesAnthropicStreamEvent[],
  ): number {
    const index = nextIndex++;
    open = { kind: 'tool', index, outputIndex };
    blockByOutputIndex.set(outputIndex, { kind: 'tool', index });
    sawToolCall = true;
    const fc = (item ?? {}) as { call_id?: unknown; id?: unknown; name?: unknown };
    const id = strOr(fc.call_id) || strOr(fc.id) || `toolu_responses_${syntheticToolSeq++}`;
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name: strOr(fc.name), input: {} },
    });
    return index;
  }

  function openThinkingBlock(outputIndex: number, events: ResponsesAnthropicStreamEvent[]): number {
    const index = nextIndex++;
    open = { kind: 'thinking', index, outputIndex };
    blockByOutputIndex.set(outputIndex, { kind: 'thinking', index });
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '' },
    });
    return index;
  }

  /** Reuse or lazily open the text block for `outputIndex`. */
  function ensureTextBlock(outputIndex: number, events: ResponsesAnthropicStreamEvent[]): number {
    if (open && open.kind === 'text' && open.outputIndex === outputIndex) return open.index;
    closeOpenBlock(events);
    const index = nextIndex++;
    open = { kind: 'text', index, outputIndex };
    blockByOutputIndex.set(outputIndex, { kind: 'text', index });
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    return index;
  }

  /**
   * Resolve the block a tool/reasoning delta targets. Normally it is the
   * currently-open block (opened at output_item.added); the map lookup and
   * defensive open cover an upstream that emitted a delta without a
   * preceding item (never observed, but keeps the stream well-formed).
   */
  function resolveBlock(
    outputIndex: number,
    kind: 'tool' | 'thinking',
    events: ResponsesAnthropicStreamEvent[],
  ): number {
    if (open && open.kind === kind && open.outputIndex === outputIndex) return open.index;
    const existing = blockByOutputIndex.get(outputIndex);
    if (existing && existing.kind === kind) return existing.index;
    return kind === 'tool'
      ? openToolBlock(undefined, outputIndex, events)
      : openThinkingBlock(outputIndex, events);
  }

  function finalize(
    resp: ResponsesResponse | undefined,
    events: ResponsesAnthropicStreamEvent[],
  ): void {
    closeOpenBlock(events);
    const r = resp ?? {};
    const usageOut: { output_tokens: number; input_tokens?: number } = {
      output_tokens: numOr(r.usage?.output_tokens, 0),
    };
    if (typeof r.usage?.input_tokens === 'number') usageOut.input_tokens = r.usage.input_tokens;
    events.push({
      type: 'message_delta',
      delta: { stop_reason: deriveStopReason(r, sawToolCall), stop_sequence: null },
      usage: usageOut,
    });
    events.push({ type: 'message_stop' });
    ended = true;
  }

  return {
    push(event: ResponsesStreamEvent): ResponsesAnthropicStreamEvent[] {
      const events: ResponsesAnthropicStreamEvent[] = [];
      if (ended || !event || typeof event !== 'object' || typeof event.type !== 'string') {
        return events;
      }
      const type = event.type;

      if (
        type === 'response.completed' ||
        type === 'response.incomplete' ||
        type === 'response.failed'
      ) {
        ensureStarted(event, events);
        finalize(event.response, events);
        return events;
      }
      if (type === 'error') {
        // Upstream stream error — terminate cleanly so the client sees a
        // well-formed end, not a hang. HTTP-level errors are surfaced by
        // the transport layer, not this pure translator.
        ensureStarted(event, events);
        finalize(undefined, events);
        return events;
      }

      ensureStarted(event, events);

      switch (type) {
        case 'response.created':
        case 'response.in_progress':
          break; // message_start already emitted by ensureStarted
        case 'response.output_item.added': {
          const outputIndex = numOr(event.output_index, 0);
          closeOpenBlock(events); // a new item boundary closes the previous block
          const itemType =
            event.item && typeof event.item === 'object'
              ? (event.item as { type?: unknown }).type
              : undefined;
          if (itemType === 'function_call') openToolBlock(event.item, outputIndex, events);
          else if (itemType === 'reasoning') openThinkingBlock(outputIndex, events);
          // message → nothing; the text block opens on the first delta.
          break;
        }
        case 'response.output_text.delta': {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            const index = ensureTextBlock(numOr(event.output_index, 0), events);
            events.push({
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: event.delta },
            });
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            const index = resolveBlock(numOr(event.output_index, 0), 'tool', events);
            events.push({
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: event.delta },
            });
          }
          break;
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            const index = resolveBlock(numOr(event.output_index, 0), 'thinking', events);
            events.push({
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: event.delta },
            });
          }
          break;
        }
        case 'response.output_item.done': {
          const outputIndex = numOr(event.output_index, 0);
          if (open && open.outputIndex === outputIndex) closeOpenBlock(events);
          break;
        }
        default:
          // content_part.added/done, output_text.done,
          // reasoning_summary_part.*, function_call_arguments.done,
          // refusal.*, … — no-ops: the deltas already carried the content
          // and the *.done markers are redundant with output_item.done /
          // response.completed.
          break;
      }
      return events;
    },

    end(): ResponsesAnthropicStreamEvent[] {
      if (ended) return [];
      const events: ResponsesAnthropicStreamEvent[] = [];
      ensureStarted(null, events);
      finalize(undefined, events);
      return events;
    },
  };
}

/**
 * Serialize one emitted Anthropic stream event into SSE wire framing:
 * `event: <type>\ndata: <json>\n\n` — the same `event:`/`data:` pairing
 * dario's streaming path produces. Structural twin of
 * Anthropic SSE formatting, widened to this module's
 * thinking-aware event union.
 */
export function formatResponsesAnthropicSSE(event: ResponsesAnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parse one Responses SSE record's `event:` and `data:` lines into an
 * event object. Unlike chat completions (data-only), Responses SSE pairs
 * an `event: <type>` line with a `data: <json>` line; the JSON already
 * carries a matching `type`, so `dataLine` alone is usually enough — the
 * `eventLine` is used only to backfill `type` if the JSON somehow omits
 * it. Returns null for keep-alive/comment lines, `data: [DONE]`, and
 * unparseable payloads. Callers that own real SSE framing (multi-line
 * buffering, CRLF, cross-chunk boundaries) should use
 * `createResponsesSSEParser` instead.
 */
export function parseResponsesSSEEvent(
  eventLine: string | undefined,
  dataLine: string,
): ResponsesStreamEvent | null {
  if (typeof dataLine !== 'string') return null;
  const dtrim = dataLine.endsWith('\r') ? dataLine.slice(0, -1) : dataLine;
  if (!dtrim.startsWith('data:')) return null;
  const payload = dtrim.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const ev = obj as ResponsesStreamEvent;
  if (typeof ev.type !== 'string' && typeof eventLine === 'string') {
    const etrim = eventLine.endsWith('\r') ? eventLine.slice(0, -1) : eventLine;
    if (etrim.startsWith('event:')) ev.type = etrim.slice(6).trim();
  }
  return typeof ev.type === 'string' ? ev : null;
}

/**
 * Buffered Responses SSE parser: feed raw stream chunks (which do NOT
 * align to event boundaries), get back the complete events decoded so
 * far. Records are separated by a blank line (`\n\n` or `\r\n\r\n`);
 * multiple `data:` lines in one record join with `\n` per the SSE spec.
 * Call `flush()` at end-of-stream to parse any trailing record that was
 * not blank-line terminated. Pure and offline-testable.
 */
export function createResponsesSSEParser(): {
  push(chunk: string): ResponsesStreamEvent[];
  flush(): ResponsesStreamEvent[];
} {
  let buffer = '';
  const boundary = /\r?\n\r?\n/;

  function parseRecord(record: string): ResponsesStreamEvent | null {
    let eventLine: string | undefined;
    const dataParts: string[] = [];
    for (const raw of record.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('event:')) eventLine = line;
      else if (line.startsWith('data:')) dataParts.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataParts.length === 0) return null;
    return parseResponsesSSEEvent(eventLine, `data: ${dataParts.join('\n')}`);
  }

  return {
    push(chunk: string): ResponsesStreamEvent[] {
      const events: ResponsesStreamEvent[] = [];
      if (typeof chunk !== 'string' || chunk.length === 0) return events;
      buffer += chunk;
      let m: RegExpExecArray | null;
      while ((m = boundary.exec(buffer)) !== null) {
        const record = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const ev = parseRecord(record);
        if (ev) events.push(ev);
      }
      return events;
    },
    flush(): ResponsesStreamEvent[] {
      const events: ResponsesStreamEvent[] = [];
      const rest = buffer.trim();
      buffer = '';
      if (rest.length > 0) {
        const ev = parseRecord(rest);
        if (ev) events.push(ev);
      }
      return events;
    },
  };
}

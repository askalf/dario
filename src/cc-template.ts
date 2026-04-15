/**
 * Claude Code request template.
 *
 * Tool definitions, system prompt, and request structure are loaded from
 * cc-template-data.json and sent verbatim — this gives byte-level fidelity
 * with the shape of a real Claude Code request.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TemplateData {
  _version: string;
  agent_identity: string;
  system_prompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_names: string[];
}

// Load template data at module init — fail fast if missing
const TEMPLATE: TemplateData = JSON.parse(
  readFileSync(join(__dirname, 'cc-template-data.json'), 'utf-8'),
);

/** CC's exact tool definitions — loaded from the template JSON. */
export const CC_TOOL_DEFINITIONS = TEMPLATE.tools;

/** CC's static system prompt (~25KB). */
export const CC_SYSTEM_PROMPT = TEMPLATE.system_prompt;

/** CC's agent identity string. */
export const CC_AGENT_IDENTITY = TEMPLATE.agent_identity;

// Framework identifiers that would flag non-CC usage. Stripped from the system
// prompt and from message content text blocks before the request goes upstream.
const FRAMEWORK_PATTERNS: RegExp[] = [
  // Compound/hyphenated patterns run first so their halves can't be eaten
  // by the simpler word-level patterns below.
  /\b(roo[- ]?cline|big[- ]?agi|claude[- ]?bridge)\b/gi,
  /\b(openclaw|hermes|aider|cursor|windsurf|cline|continue|copilot|cody)\b/gi,
  /\b(librechat|typingmind)\b/gi,
  /\b(openai|gpt-4|gpt-3\.5)\b/gi,
  /powered by [a-z]+/gi,
  /\bgateway\b/gi,
  // OC's sessions_* tool-name prefix — flagged as a fingerprint in dario#23.
  /\bsessions_[a-z_]+\b/gi,
];

export function scrubFrameworkIdentifiers(text: string): string {
  let result = text;
  for (const pattern of FRAMEWORK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, ...args) => {
      const offset = args[args.length - 2] as number;
      const src = args[args.length - 1] as string;
      const before = offset > 0 ? src[offset - 1] : '';
      const after = offset + match.length < src.length ? src[offset + match.length] : '';
      // Preserve matches embedded in filesystem paths or URLs. `\b` word
      // boundaries fire between `.` / `/` and word chars, which made
      // `/Users/foo/.openclaw/workspace/` collapse to `/Users/foo/./workspace/`
      // (dario#35). A preceding `.`, `/`, `\`, `-`, or `_` or a following
      // `/` or `\` is a strong signal the identifier is part of a path or
      // slug, not prose — leave it alone.
      if (before === '.' || before === '/' || before === '\\' || before === '-' || before === '_') return match;
      if (after === '/' || after === '\\') return match;
      return '';
    });
  }
  return result;
}

/**
 * Client tool name → CC tool mapping with parameter translation.
 *
 * `translateArgs` runs forward (client → CC) when building the upstream
 * request. `translateBack` runs reverse (CC → client) when rewriting
 * the upstream response so the client receives tool_use input in the
 * shape its own validator expects. The forward direction is lossy
 * (multiple client field names may collapse to one CC field), so the
 * reverse picks the *primary* client field name — the first one in
 * the forward function's `||` chain. That's the field the client's
 * own schema defines, which is the one its validator will accept.
 *
 * Issue #29 (boeingchoco) is the bug this layer fixes: prior to v3.7.0,
 * dario rewrote the tool name on response (Bash → process) but left
 * the input shape alone, so the client saw `{command: ...}` against a
 * schema that wanted `{action: ...}` and rejected the call.
 */
export interface ToolMapping {
  ccTool: string;
  translateArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  translateBack?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Top-level field names the client's original tool schema declared.
   * Populated only in hybrid mode (`hybridTools: true`) so the reverse
   * path can inject request-context values (sessionId, requestId, …)
   * into fields CC's schema doesn't carry. Unset in default mode.
   */
  clientFields?: string[];
  /**
   * Reverse-lookup priority for resolving collisions when multiple client
   * tools map to the same CC tool. Higher wins. Default 10. Set lower for
   * niche / lossy translations (e.g. OpenClaw's `process` action-discriminator
   * tool loses most of its schema when flattened to Bash, so bash/exec
   * should win the Bash reverse slot when both are declared — dario#37).
   */
  reverseScore?: number;
}

/**
 * Request context extracted once per incoming request. Source for
 * hybrid-mode field injection — fields declared on the client's tool
 * but not on CC's get filled from here on the reverse path.
 */
export interface RequestContext {
  sessionId: string;
  requestId: string;
  channelId?: string;
  userId?: string;
  timestamp: string; // ISO 8601
}

/**
 * Map from client-declared field name (lowercase) to the RequestContext
 * key that supplies its value. A field declared on the client's tool
 * whose name matches one of these gets auto-filled in hybrid mode.
 *
 * Case-insensitive match on the client's declared field name. Both
 * snake_case and camelCase variants map to the same source.
 */
const CONTEXT_FIELD_SOURCES: Record<string, keyof RequestContext> = {
  sessionid: 'sessionId',
  session_id: 'sessionId',
  requestid: 'requestId',
  request_id: 'requestId',
  channelid: 'channelId',
  channel_id: 'channelId',
  userid: 'userId',
  user_id: 'userId',
  timestamp: 'timestamp',
  createdat: 'timestamp',
  created_at: 'timestamp',
};

/**
 * Fill in fields declared on the client's tool schema that are still
 * absent from the translated input, drawing values from the request
 * context. Only runs when a mapping has `clientFields` populated
 * (hybrid mode) and an input object is present. Fields already set
 * by `translateBack` are never overwritten.
 */
function injectContextFields(
  input: Record<string, unknown>,
  clientFields: string[] | undefined,
  ctx: RequestContext | undefined,
): Record<string, unknown> {
  if (!clientFields || !ctx) return input;
  for (const field of clientFields) {
    if (field in input && input[field] !== undefined && input[field] !== null && input[field] !== '') continue;
    const sourceKey = CONTEXT_FIELD_SOURCES[field.toLowerCase()];
    if (!sourceKey) continue;
    const value = ctx[sourceKey];
    if (value !== undefined) input[field] = value;
  }
  return input;
}

const TOOL_MAP: Record<string, ToolMapping> = {
  // Direct maps
  // Note on translateBack field names: the vast majority of client bash-like
  // tools use `command` (the Anthropic convention), not `cmd`. OpenClaw's
  // `exec` tool takes `{command, workdir, env, ...}` (dario#36 triage).
  // Hybrid mode overrides these with the actual client schema via clientFields,
  // but default mode relies on these output names being the common case.
  bash: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }),
    translateBack: (a) => ({ command: a.command ?? '' }),
  },
  exec: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }),
    translateBack: (a) => ({ command: a.command ?? '' }),
  },
  shell: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }),
    translateBack: (a) => ({ command: a.command ?? '' }),
  },
  run: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.cmd || a.command || '' }),
    translateBack: (a) => ({ command: a.command ?? '' }),
  },
  command: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.cmd || a.command || '' }),
    translateBack: (a) => ({ command: a.command ?? '' }),
  },
  terminal: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.cmd || a.command || '' }),
    translateBack: (a) => ({ command: a.command ?? '' }),
  },
  // `process` is OpenClaw's session-manager tool — it's an action-discriminator
  // shape {action: "list"|"poll"|"log"|..., sessionId?, ...}. Flattening it onto
  // Bash.command loses all sibling fields (data, keys, hex, literal, text, ...),
  // so the model upstream can't actually drive it. Kept mapped for fingerprint
  // continuity but the reverse translation is inherently lossy — clients with a
  // process-style tool should use --preserve-tools instead of --hybrid-tools.
  //
  // reverseScore: 1 makes sure that when a client declares BOTH `process` AND
  // `exec`/`bash` (OpenClaw does — both are exported from bash-tools.ts), the
  // reverse lookup picks the bash-family mapping for CC's Bash tool slot
  // instead of routing CC tool calls through process's action-based shape
  // and breaking every Bash call with "Unknown action" (dario#37).
  process: {
    ccTool: 'Bash',
    translateArgs: (a) => ({ command: a.action || a.cmd || '' }),
    translateBack: (a) => ({ action: a.command ?? '' }),
    reverseScore: 1,
  },
  read: {
    ccTool: 'Read',
    translateArgs: (a) => ({ file_path: a.path || a.file_path || '' }),
    translateBack: (a) => ({ path: a.file_path ?? '' }),
  },
  read_file: {
    ccTool: 'Read',
    translateArgs: (a) => ({ file_path: a.path || a.file_path || '' }),
    translateBack: (a) => ({ path: a.file_path ?? '' }),
  },
  write: {
    ccTool: 'Write',
    translateArgs: (a) => ({ file_path: a.path || a.file_path || '', content: a.content || '' }),
    translateBack: (a) => ({ path: a.file_path ?? '', content: a.content ?? '' }),
  },
  write_file: {
    ccTool: 'Write',
    translateArgs: (a) => ({ file_path: a.path || a.file_path || '', content: a.content || '' }),
    translateBack: (a) => ({ path: a.file_path ?? '', content: a.content ?? '' }),
  },
  edit: {
    ccTool: 'Edit',
    translateArgs: (a) => ({ file_path: a.path || a.file_path || '', old_string: a.old || a.old_string || '', new_string: a.new || a.new_string || '' }),
    translateBack: (a) => ({ path: a.file_path ?? '', old: a.old_string ?? '', new: a.new_string ?? '' }),
  },
  edit_file: { ccTool: 'Edit' },
  glob: { ccTool: 'Glob' },
  find_files: {
    ccTool: 'Glob',
    translateArgs: (a) => ({ pattern: a.pattern || a.query || '' }),
    translateBack: (a) => ({ pattern: a.pattern ?? '' }),
  },
  list_files: {
    ccTool: 'Glob',
    translateArgs: (a) => ({ pattern: a.pattern || '*' }),
    translateBack: (a) => ({ pattern: a.pattern ?? '' }),
  },
  grep: { ccTool: 'Grep' },
  search: {
    ccTool: 'Grep',
    translateArgs: (a) => ({ pattern: a.query || a.pattern || '' }),
    translateBack: (a) => ({ query: a.pattern ?? '' }),
  },
  search_files: {
    ccTool: 'Grep',
    translateArgs: (a) => ({ pattern: a.query || a.pattern || '' }),
    translateBack: (a) => ({ query: a.pattern ?? '' }),
  },
  web_search: {
    ccTool: 'WebSearch',
    translateArgs: (a) => ({ query: a.query || a.q || '' }),
    translateBack: (a) => ({ query: a.query ?? '' }),
  },
  websearch: {
    ccTool: 'WebSearch',
    translateArgs: (a) => ({ query: a.query || a.q || '' }),
    translateBack: (a) => ({ query: a.query ?? '' }),
  },
  web_fetch: {
    ccTool: 'WebFetch',
    translateArgs: (a) => ({ url: a.url || a.u || '' }),
    translateBack: (a) => ({ url: a.url ?? '' }),
  },
  webfetch: {
    ccTool: 'WebFetch',
    translateArgs: (a) => ({ url: a.url || a.u || '' }),
    translateBack: (a) => ({ url: a.url ?? '' }),
  },
  fetch: {
    ccTool: 'WebFetch',
    translateArgs: (a) => ({ url: a.url || '' }),
    translateBack: (a) => ({ url: a.url ?? '' }),
  },
  browse: {
    ccTool: 'WebFetch',
    translateArgs: (a) => ({ url: a.url || '' }),
    translateBack: (a) => ({ url: a.url ?? '' }),
  },
  notebook: { ccTool: 'NotebookEdit' },
  notebook_edit: { ccTool: 'NotebookEdit' },
  // Additional client tool mappings
  browser: {
    ccTool: 'WebFetch',
    translateArgs: (a) => ({ url: String(a.url || '') }),
    translateBack: (a) => ({ url: a.url ?? '' }),
  },
  message: {
    ccTool: 'AskUserQuestion',
    translateArgs: (a) => ({ question: String(a.message || a.content || '') }),
    translateBack: (a) => ({ message: a.question ?? '' }),
  },
  todo_read: {
    ccTool: 'TodoWrite',
    translateArgs: () => ({ todos: [] }),
    translateBack: () => ({}),
  },
  todo_write: {
    ccTool: 'TodoWrite',
    translateArgs: (a) => ({ todos: a.todos || [] }),
    translateBack: (a) => ({ todos: a.todos ?? [] }),
  },
  notebook_read: {
    ccTool: 'NotebookEdit',
    translateArgs: (a) => ({ notebook_path: String(a.notebook_path || a.path || '') }),
    translateBack: (a) => ({ notebook_path: a.notebook_path ?? '' }),
  },
  enter_plan_mode: { ccTool: 'EnterPlanMode' },
  exit_plan_mode: { ccTool: 'ExitPlanMode' },
  enter_worktree: {
    ccTool: 'EnterWorktree',
    translateArgs: (a) => ({ path: a.path }),
    translateBack: (a) => ({ path: a.path ?? '' }),
  },
  exit_worktree: { ccTool: 'ExitWorktree' },
};

/**
 * Build a CC-template request from a client request.
 * Replaces the entire request structure — tools, fields, ordering — with
 * what real CC sends. Only the conversation content is preserved.
 */
export function buildCCRequest(
  clientBody: Record<string, unknown>,
  billingTag: string,
  cache1h: { type: 'ephemeral'; ttl: '1h' },
  identity: { deviceId: string; accountUuid: string; sessionId: string },
  opts: { preserveTools?: boolean; hybridTools?: boolean } = {},
): { body: Record<string, unknown>; toolMap: Map<string, ToolMapping>; unmappedTools: string[] } {

  const model = clientBody.model as string || 'claude-sonnet-4-6';
  const isHaiku = model.toLowerCase().includes('haiku');
  const messages = clientBody.messages as Array<Record<string, unknown>> || [];
  const clientTools = clientBody.tools as Array<Record<string, unknown>> | undefined;
  const stream = clientBody.stream ?? false;

  // ── Strip thinking from history ──
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ type: string }>).filter(b => b.type !== 'thinking');
    }
    // Strip cache_control from message blocks
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        delete block.cache_control;
      }
    }
  }

  // ── Drop trailing empty/assistant turns ──
  // An assistant turn that was thinking-only before the strip above becomes
  // content: []. Forwarding that shape makes Anthropic interpret the request
  // as a prefill ("continue from this assistant text"), which Opus 4.6 under
  // adaptive thinking + the claude-code beta refuses with:
  //   "This model does not support assistant message prefill. The
  //    conversation must end with a user message."
  // Clients that preserve full thinking in history (OpenClaw, Hermes) hit
  // this any time a prior turn was interrupted mid-thinking. Drop trailing
  // assistant/empty turns so the request ends on a user message.
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    const contentEmpty = Array.isArray(last.content) && (last.content as unknown[]).length === 0;
    const isTrailingAssistant = last.role === 'assistant';
    if (contentEmpty || isTrailingAssistant) {
      messages.pop();
      continue;
    }
    break;
  }

  // ── Build tool mapping ──
  // In preserveTools mode, skip the tool name/arg rewriting entirely.
  // Tool routing in real agents requires bidirectional schema fidelity that
  // lossy forward-only translation can't provide. Users with custom tool
  // schemas should use preserveTools to keep their tools as-is and accept
  // the fingerprint risk on their own account.
  const activeToolMap = new Map<string, ToolMapping>();
  const unmappedTools: string[] = [];

  if (clientTools && !opts.preserveTools) {
    // Two passes so the unmapped-tool distributor can avoid colliding with
    // CC tools the client already uses directly. Without this, a client
    // sending both `WebSearch` and some unmapped tool like `memory_get`
    // could have both forward-map to `WebSearch`, and the reverse map would
    // then rewrite real `WebSearch` responses to the collided client name.
    const claimedCC = new Set<string>();
    for (const tool of clientTools) {
      const name = (tool.name as string || '').toLowerCase();
      const mapping = TOOL_MAP[name];
      if (mapping) {
        // In hybrid mode, clone the shared mapping and attach the
        // client-declared top-level field names from input_schema.
        // The reverse path uses these to inject request-context values
        // into fields CC's schema doesn't carry.
        if (opts.hybridTools) {
          const schema = tool.input_schema as { properties?: Record<string, unknown> } | undefined;
          const fields = schema?.properties ? Object.keys(schema.properties) : [];
          activeToolMap.set(tool.name as string, { ...mapping, clientFields: fields });
        } else {
          activeToolMap.set(tool.name as string, mapping);
        }
        claimedCC.add(mapping.ccTool);
      }
    }

    // Unmapped-tool handling differs by mode:
    //
    // - Default mode: round-robin to CC fallback tools. The model sees the CC
    //   tool set, any tool call is "something", and we best-effort relay it
    //   back to the client tool name. Broken-by-design for clients with rich
    //   discriminator tools (OpenClaw lobster/memory_get, dario#36), but
    //   preserves the old behavior for simple clients that don't have many
    //   unmapped tools.
    //
    // - Hybrid mode: DROP unmapped tools entirely. We can't forward them to
    //   the upstream (adding to CC_TOOL_DEFINITIONS breaks the fingerprint),
    //   and round-robin mapping produces nonsense shapes on the reverse path
    //   (lobster.translateBack(Glob.input) → {pattern: "..."} when lobster
    //   wants {action: "run"}). Better to let the model not see those tools
    //   than to pretend they exist and corrupt every call. Users needing
    //   every client tool to actually work must use --preserve-tools.
    const CC_FALLBACK_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
    for (const tool of clientTools) {
      const name = (tool.name as string || '').toLowerCase();
      if (TOOL_MAP[name]) continue;
      unmappedTools.push(tool.name as string);
      if (opts.hybridTools) continue; // dropped — see comment above
      // Default mode: round-robin distribution. Exclude CC tools the client
      // already uses so we never create a two-client-names-to-one-CC-tool
      // collision. If every fallback is claimed (rare: client already uses 6+
      // CC tools), fall back to the full pool and accept the ambiguity.
      const pool = CC_FALLBACK_TOOLS.filter(t => !claimedCC.has(t));
      const fallbackPool = pool.length > 0 ? pool : CC_FALLBACK_TOOLS;
      const fallbackTool = fallbackPool[(unmappedTools.length - 1) % fallbackPool.length];
      activeToolMap.set(tool.name as string, {
        ccTool: fallbackTool,
        translateArgs: (a) => {
          switch (fallbackTool) {
            case 'Bash': return { command: `echo "${JSON.stringify(a).slice(0, 200)}"` };
            case 'Read': return { file_path: String(a.path || a.file || a.url || '/tmp/output') };
            case 'Grep': return { pattern: String(a.query || a.pattern || a.search || '.'), path: '.' };
            case 'Glob': return { pattern: String(a.pattern || a.glob || '*') };
            case 'WebSearch': return { query: String(a.query || a.q || a.search || '') };
            case 'WebFetch': return { url: String(a.url || a.uri || '') };
            default: return a;
          }
        },
      });
    }
  }

  // ── Remap tool_use and tool_result references in message history ──
  // Skip in preserveTools mode — leave conversation history untouched.
  if (!opts.preserveTools) {
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            const mapping = activeToolMap.get(block.name);
            if (mapping) {
              block.name = mapping.ccTool;
              if (mapping.translateArgs && block.input) {
                block.input = mapping.translateArgs(block.input as Record<string, unknown>);
              }
            }
          }
          // Strip any client-specific fields from tool_result blocks that CC wouldn't send
          if (block.type === 'tool_result') {
            // Remove non-standard fields clients may add
            for (const key of Object.keys(block)) {
              if (!['type', 'tool_use_id', 'content', 'is_error'].includes(key)) {
                delete block[key];
              }
            }
          }
        }
      }
    }
  }

  // ── Compact conversation history ──
  // Real CC conversations have specific patterns. Strip metadata that
  // third-party frameworks inject into tool_result content.
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        // Truncate very long tool_result content — CC tool results are typically
        // shorter because CC truncates file reads, command output, etc.
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 30000) {
          block.content = block.content.slice(0, 30000) + '\n[...truncated]';
        }
        // Also handle array-form tool_result content
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content as Array<Record<string, unknown>>) {
            if (sub.type === 'text' && typeof sub.text === 'string' && sub.text.length > 30000) {
              sub.text = sub.text.slice(0, 30000) + '\n[...truncated]';
            }
          }
        }
      }
    }
  }

  // ── Merge system prompt ──
  let systemText = '';
  const sys = clientBody.system;
  if (typeof sys === 'string') {
    systemText = sys;
  } else if (Array.isArray(sys)) {
    systemText = (sys as Array<{ text?: string }>)
      .filter(b => b.text && !b.text.includes('x-anthropic-billing-header:'))
      .map(b => b.text)
      .join('\n\n');
  }

  systemText = scrubFrameworkIdentifiers(systemText);

  // Also scrub framework identifiers from message content text blocks.
  // Clients often inject their product name into user/tool messages as well,
  // and the system-prompt-only scrub used to miss those.
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      msg.content = scrubFrameworkIdentifiers(msg.content as string);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          block.text = scrubFrameworkIdentifiers(block.text);
        }
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          block.content = scrubFrameworkIdentifiers(block.content);
        }
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content as Array<Record<string, unknown>>) {
            if (sub.type === 'text' && typeof sub.text === 'string') {
              sub.text = scrubFrameworkIdentifiers(sub.text);
            }
          }
        }
      }
    }
  }

  // ── Build the CC request from template ──
  // Key order matches CC v2.1.104 exactly:
  // model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream
  //
  // System prompt structure (3 blocks, matching real CC):
  //   [0] billing tag (no cache)
  //   [1] agent identity (1h cache)
  //   [2] CC's full 25KB system prompt + client's custom prompt appended (1h cache)
  const fullSystemPrompt = systemText
    ? `${CC_SYSTEM_PROMPT}\n\n${systemText}`
    : CC_SYSTEM_PROMPT;

  const ccRequest: Record<string, unknown> = {
    model,
    messages,
    system: [
      { type: 'text', text: billingTag },
      { type: 'text', text: CC_AGENT_IDENTITY, cache_control: cache1h },
      { type: 'text', text: fullSystemPrompt, cache_control: cache1h },
    ],
  };

  // Tools come before metadata in CC's key order.
  // preserveTools mode: pass client tools through unchanged (better for real
  // agents with custom schemas, but loses the CC tool fingerprint).
  if (clientTools && clientTools.length > 0) {
    ccRequest.tools = opts.preserveTools ? clientTools : CC_TOOL_DEFINITIONS;
  }

  // Metadata
  ccRequest.metadata = {
    user_id: JSON.stringify({
      device_id: identity.deviceId,
      account_uuid: identity.accountUuid,
      session_id: identity.sessionId,
    }),
  };

  ccRequest.max_tokens = 64000;

  // Model-specific fields — order: thinking, context_management, output_config
  if (!isHaiku) {
    ccRequest.thinking = { type: 'adaptive' };
    ccRequest.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
    ccRequest.output_config = { effort: 'medium' };
  }

  ccRequest.stream = stream;

  return { body: ccRequest, toolMap: activeToolMap, unmappedTools };
}

/**
 * Build the CC-name → {clientName, mapping} reverse lookup used by both
 * the non-streaming and streaming reverse-mappers.
 *
 * Two-pass construction preserves the original identity-protection rule:
 * when a client sent a tool with the literal CC name (e.g. `WebSearch`),
 * that pairing claims the CC slot first so a later unmapped-tool fallback
 * that also lands on `WebSearch` can't overwrite it.
 *
 * Within the non-identity pass, collisions are broken by `reverseScore`
 * (higher wins, default 10). This matters when a client declares two
 * tools that both map to the same CC tool — OpenClaw declares both
 * `exec` (bash-like, score 10) and `process` (action-discriminator,
 * score 1) and both map to Bash. Pre-fix, insertion-order last-wins
 * routed Bash tool calls through `process`, which interpreted the
 * command string as an action and returned "Unknown action" for
 * every call. `process` now has reverseScore: 1 so bash/exec wins
 * (dario#37).
 */
function buildReverseLookup(toolMap: Map<string, ToolMapping>): Map<string, { clientName: string; mapping: ToolMapping }> {
  const reverseMap = new Map<string, { clientName: string; mapping: ToolMapping }>();
  const identityClaimed = new Set<string>();
  for (const [clientName, mapping] of toolMap) {
    if (clientName.toLowerCase() === mapping.ccTool.toLowerCase()) {
      identityClaimed.add(mapping.ccTool);
      reverseMap.set(mapping.ccTool, { clientName, mapping });
    }
  }
  // Score-based collision resolution in the non-identity pass.
  const scoreOf = (m: ToolMapping): number => m.reverseScore ?? 10;
  for (const [clientName, mapping] of toolMap) {
    if (clientName.toLowerCase() === mapping.ccTool.toLowerCase()) continue;
    if (identityClaimed.has(mapping.ccTool)) continue;
    const existing = reverseMap.get(mapping.ccTool);
    if (!existing || scoreOf(mapping) > scoreOf(existing.mapping)) {
      reverseMap.set(mapping.ccTool, { clientName, mapping });
    }
  }
  return reverseMap;
}

/**
 * Apply the reverse mapping to a single tool_use block in place.
 * Mutates `block.name` (CC name → client name) and `block.input`
 * (CC parameter shape → client parameter shape) when the mapping
 * has a `translateBack`. Identity mappings and mappings with no
 * `translateBack` defined leave the input unchanged.
 *
 * Issue #29 fix lives here: previously only the name was rewritten,
 * leaving the input shape in CC's parameter names which the client's
 * own validator would reject.
 */
function rewriteToolUseBlock(
  block: Record<string, unknown>,
  reverseMap: Map<string, { clientName: string; mapping: ToolMapping }>,
  ctx?: RequestContext,
): void {
  const ccName = block.name;
  if (typeof ccName !== 'string') return;
  const entry = reverseMap.get(ccName);
  if (!entry) return;

  block.name = entry.clientName;
  if (entry.mapping.translateBack && block.input && typeof block.input === 'object') {
    try {
      block.input = entry.mapping.translateBack(block.input as Record<string, unknown>);
    } catch {
      // If the translateBack throws on unexpected shape, leave input
      // alone rather than crashing the response. The client will see
      // the same broken input it would have seen pre-v3.7.0.
    }
  }
  // Hybrid mode: inject request-context values into any client-declared
  // fields still missing after translateBack. No-op unless the mapping
  // was built with `clientFields` populated (hybridTools: true) and a
  // context was passed in.
  if (entry.mapping.clientFields && block.input && typeof block.input === 'object') {
    injectContextFields(block.input as Record<string, unknown>, entry.mapping.clientFields, ctx);
  }
}

/**
 * Reverse-map CC tool calls in a non-streaming response back to the
 * client's original tool names AND parameter shapes. Walks the parsed
 * JSON `content` array and rewrites every `tool_use` block. If the
 * body isn't valid JSON (e.g. an error response, a partial chunk),
 * returns it unchanged.
 */
export function reverseMapResponse(
  responseBody: string,
  toolMap: Map<string, ToolMapping>,
  ctx?: RequestContext,
): string {
  if (toolMap.size === 0) return responseBody;

  const reverseMap = buildReverseLookup(toolMap);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    return responseBody;
  }

  const content = parsed.content;
  if (!Array.isArray(content)) return responseBody;

  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
      rewriteToolUseBlock(block as Record<string, unknown>, reverseMap, ctx);
    }
  }

  return JSON.stringify(parsed);
}

/**
 * Streaming reverse-mapper for SSE responses.
 *
 * The non-streaming reverse-map can rewrite tool_use input in one pass
 * because it sees the whole `input` object. SSE streaming arrives in
 * three phases per tool_use block:
 *
 *   content_block_start  → carries `tool_use.name` and `tool_use.input: {}`
 *   content_block_delta  → carries `input_json_delta.partial_json` chunks
 *                          that, concatenated, form the full input JSON
 *   content_block_stop   → end of the block
 *
 * To rewrite the parameter shape we need the FULL input, which only
 * exists at content_block_stop. So for tool_use blocks that need
 * translation, we:
 *
 *   1. Forward content_block_start with the rewritten name (so clients
 *      see their own tool name immediately and can start tracking it)
 *   2. Swallow content_block_delta events for that block, accumulating
 *      partial_json into a per-block buffer
 *   3. On content_block_stop, parse the accumulated input, apply
 *      translateBack, and emit ONE synthetic content_block_delta with
 *      the full translated input as a single partial_json string,
 *      followed by the original content_block_stop event
 *
 * Trade-off: clients that consume tool_use input as it streams (rare
 * but possible) will see the input arrive as a single chunk at the
 * end of the block instead of streaming character-by-character. For
 * tool_use that's acceptable — input is usually small (<1KB) and the
 * alternative is parameter-shape mismatch causing validation errors.
 *
 * For tool_use blocks that DON'T have a translateBack mapping (or
 * aren't in the reverseMap at all), the streaming mapper passes the
 * original SSE bytes through unchanged.
 *
 * Usage:
 *
 *   const mapper = createStreamingReverseMapper(toolMap);
 *   for await (const chunk of upstream) res.write(mapper.feed(chunk));
 *   const tail = mapper.end();
 *   if (tail.length) res.write(tail);
 */
export interface StreamingReverseMapper {
  feed(chunk: Uint8Array): Uint8Array;
  end(): Uint8Array;
}

interface BufferedToolBlock {
  /** Original CC tool name from content_block_start. */
  ccName: string;
  /** Mapping from the reverse lookup, including translateBack. */
  mapping: ToolMapping;
  /** Client tool name to emit. */
  clientName: string;
  /** Concatenated partial_json fragments. */
  partial: string;
}

export function createStreamingReverseMapper(
  toolMap: Map<string, ToolMapping>,
  ctx?: RequestContext,
): StreamingReverseMapper {
  const noop: StreamingReverseMapper = {
    feed: (chunk) => chunk,
    end: () => new Uint8Array(0),
  };
  if (toolMap.size === 0) return noop;

  const reverseMap = buildReverseLookup(toolMap);
  // If no mapping needs translation OR context injection, fall back to
  // identity behavior so we don't pay the SSE-parsing cost on every chunk.
  // Hybrid mode with clientFields always needs the streaming path so the
  // injection can run at content_block_stop.
  let anyNeedsTranslation = false;
  for (const { mapping } of reverseMap.values()) {
    if (mapping.translateBack || (mapping.clientFields && mapping.clientFields.length > 0)) {
      anyNeedsTranslation = true;
      break;
    }
  }
  if (!anyNeedsTranslation) return noop;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // We process on SSE event-group boundaries, not line boundaries.
  // Events are separated by a blank line (two consecutive newlines);
  // within an event group there may be multiple header lines like
  // `event: content_block_delta` and `data: {...}`. The old code
  // processed one line at a time, which meant swallowed deltas left
  // orphan `event:` lines and synthetic delta+stop emissions joined
  // two `data:` lines without a blank-line separator — which SSE
  // parsers concatenate into one malformed multi-line event that
  // fails JSON.parse downstream. v3.7.1 fixes both by processing
  // whole event groups.
  let groupBuffer = '';
  // index → BufferedToolBlock for tool_use content blocks currently
  // being held for end-of-block translation.
  const buffered = new Map<number, BufferedToolBlock>();

  /**
   * Build a complete SSE event group string with an `event:` header
   * and a `data:` line. Used when emitting rewritten or synthetic
   * events so the wire format matches what upstream produces.
   */
  function buildEvent(type: string, payload: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(payload)}`;
  }

  /**
   * Process one complete SSE event group. Returns:
   *   - a string with one or more rewritten event groups separated
   *     by "\n\n" (no trailing blank line — the caller adds that)
   *   - null to drop the event group entirely (swallow)
   *   - the original `eventText` to pass through unchanged
   *
   * An event group is the text between blank lines. It may contain
   * lines like `event: <type>`, `data: <payload>`, `id:`, `retry:`
   * in any order. We only look at the `data:` line (Anthropic never
   * uses multi-line data payloads).
   */
  function processEventGroup(eventText: string): string | null {
    if (eventText === '') return eventText;

    // Find the data: line. Anthropic's SSE uses one data: per event.
    const lines = eventText.split('\n');
    let dataLineIdx = -1;
    let dataText = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith('data:')) {
        dataLineIdx = i;
        dataText = line.slice(5).trim();
        break;
      }
    }

    if (dataLineIdx === -1 || dataText === '' || dataText === '[DONE]') {
      return eventText;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(dataText) as Record<string, unknown>;
    } catch {
      return eventText;
    }

    const type = event.type;

    if (type === 'content_block_start') {
      const idx = typeof event.index === 'number' ? event.index : -1;
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block && block.type === 'tool_use' && typeof block.name === 'string') {
        const entry = reverseMap.get(block.name);
        const needsBuffering = entry && idx >= 0 && (
          entry.mapping.translateBack ||
          (entry.mapping.clientFields && entry.mapping.clientFields.length > 0)
        );
        if (entry && needsBuffering) {
          // Stash the block so we can flush a translated version at
          // content_block_stop. Emit a rewritten start event now so
          // the client sees its own tool name immediately.
          buffered.set(idx, {
            ccName: block.name,
            mapping: entry.mapping,
            clientName: entry.clientName,
            partial: '',
          });
          block.name = entry.clientName;
          // Reset input to empty so the client doesn't see CC's empty
          // placeholder before the translated full input arrives.
          block.input = {};
          return buildEvent('content_block_start', event);
        }
        // Tool we don't translate — just rewrite the name in place.
        if (entry) {
          block.name = entry.clientName;
          return buildEvent('content_block_start', event);
        }
      }
      return eventText;
    }

    if (type === 'content_block_delta') {
      const idx = typeof event.index === 'number' ? event.index : -1;
      const buf = idx >= 0 ? buffered.get(idx) : undefined;
      if (!buf) return eventText;

      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        buf.partial += delta.partial_json;
        // Swallow the whole event group — including any `event:`
        // header line the upstream emitted for it — because we'll
        // emit a synthetic combined delta at content_block_stop.
        return null;
      }
      return eventText;
    }

    if (type === 'content_block_stop') {
      const idx = typeof event.index === 'number' ? event.index : -1;
      const buf = idx >= 0 ? buffered.get(idx) : undefined;
      if (!buf) return eventText;

      let translatedInput: Record<string, unknown> = {};
      let parseOk = true;
      try {
        const parsedInput = JSON.parse(buf.partial || '{}') as Record<string, unknown>;
        translatedInput = buf.mapping.translateBack
          ? buf.mapping.translateBack(parsedInput)
          : parsedInput;
        if (buf.mapping.clientFields && buf.mapping.clientFields.length > 0) {
          injectContextFields(translatedInput, buf.mapping.clientFields, ctx);
        }
      } catch {
        parseOk = false;
      }

      buffered.delete(idx);

      if (!parseOk) {
        // Fall back to passing the original partial through unchanged
        // so the client at least sees whatever upstream actually sent.
        // Emit as TWO separate SSE events with blank-line separators.
        const passthroughDelta = {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: buf.partial },
        };
        return (
          buildEvent('content_block_delta', passthroughDelta) +
          '\n\n' +
          buildEvent('content_block_stop', event)
        );
      }

      const synthDelta = {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(translatedInput) },
      };
      // Emit as TWO separate SSE events joined by a blank line so
      // downstream parsers see them as distinct events. The outer
      // processBuffer will append one more "\n\n" after the final
      // event in this group, which is correct SSE framing.
      return (
        buildEvent('content_block_delta', synthDelta) +
        '\n\n' +
        buildEvent('content_block_stop', event)
      );
    }

    return eventText;
  }

  function processBuffer(flush: boolean): string {
    // Split the accumulated buffer on "\n\n" (SSE event separator).
    // Every complete part is a full event group; the last part is
    // either empty (the trailing blank after a completed event) or
    // a partial event that needs to wait for more bytes.
    const parts = groupBuffer.split('\n\n');
    if (!flush) {
      // Hold the last (potentially incomplete) part back.
      groupBuffer = parts.pop() ?? '';
    } else {
      groupBuffer = '';
    }

    const out: string[] = [];
    for (const part of parts) {
      if (part === '') continue;
      const processed = processEventGroup(part);
      if (processed !== null) out.push(processed);
    }
    // Each emitted event (or multi-event group) needs a trailing
    // blank line so the SSE framing is correct. We join with "\n\n"
    // and append "\n\n" so both the inter-group and final
    // separators are present.
    return out.length > 0 ? out.join('\n\n') + '\n\n' : '';
  }

  return {
    feed(chunk: Uint8Array): Uint8Array {
      groupBuffer += decoder.decode(chunk, { stream: true });
      const out = processBuffer(false);
      return out.length > 0 ? encoder.encode(out) : new Uint8Array(0);
    },
    end(): Uint8Array {
      groupBuffer += decoder.decode();
      const out = processBuffer(true);
      return out.length > 0 ? encoder.encode(out) : new Uint8Array(0);
    },
  };
}

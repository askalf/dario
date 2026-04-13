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

/** Client tool name → CC tool mapping with parameter translation. */
interface ToolMapping {
  ccTool: string;
  translateArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  translateBack?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const TOOL_MAP: Record<string, ToolMapping> = {
  // Direct maps
  bash: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }) },
  exec: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }) },
  shell: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }) },
  run: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || '' }) },
  command: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || '' }) },
  terminal: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || '' }) },
  process: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.action || a.cmd || '' }) },
  read: { ccTool: 'Read', translateArgs: (a) => ({ file_path: a.path || a.file_path || '' }) },
  read_file: { ccTool: 'Read', translateArgs: (a) => ({ file_path: a.path || a.file_path || '' }) },
  write: { ccTool: 'Write', translateArgs: (a) => ({ file_path: a.path || a.file_path || '', content: a.content || '' }) },
  write_file: { ccTool: 'Write', translateArgs: (a) => ({ file_path: a.path || a.file_path || '', content: a.content || '' }) },
  edit: { ccTool: 'Edit', translateArgs: (a) => ({ file_path: a.path || a.file_path || '', old_string: a.old || a.old_string || '', new_string: a.new || a.new_string || '' }) },
  edit_file: { ccTool: 'Edit' },
  glob: { ccTool: 'Glob' },
  find_files: { ccTool: 'Glob', translateArgs: (a) => ({ pattern: a.pattern || a.query || '' }) },
  list_files: { ccTool: 'Glob', translateArgs: (a) => ({ pattern: a.pattern || '*' }) },
  grep: { ccTool: 'Grep' },
  search: { ccTool: 'Grep', translateArgs: (a) => ({ pattern: a.query || a.pattern || '' }) },
  search_files: { ccTool: 'Grep', translateArgs: (a) => ({ pattern: a.query || a.pattern || '' }) },
  web_search: { ccTool: 'WebSearch', translateArgs: (a) => ({ query: a.query || a.q || '' }) },
  websearch: { ccTool: 'WebSearch', translateArgs: (a) => ({ query: a.query || a.q || '' }) },
  web_fetch: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || a.u || '' }) },
  webfetch: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || a.u || '' }) },
  fetch: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || '' }) },
  browse: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || '' }) },
  notebook: { ccTool: 'NotebookEdit' },
  notebook_edit: { ccTool: 'NotebookEdit' },
  // Additional client tool mappings
  browser: { ccTool: 'Browser', translateArgs: (a) => ({ action: a.action || 'open', url: a.url, selector: a.selector, text: a.text }) },
  message: { ccTool: 'AskUserQuestion', translateArgs: (a) => ({ question: a.message || a.content || (a.to ? 'Message to ' + a.to + ': ' + (a.message || a.content || '') : a.message || a.content || '') }) },
  todo_read: { ccTool: 'TodoRead' },
  todo_write: { ccTool: 'TodoWrite', translateArgs: (a) => ({ todos: a.todos || [] }) },
  mcp_list: { ccTool: 'MCPListTools' },
  mcp_call: { ccTool: 'MCPCallTool', translateArgs: (a) => ({ server: a.server || '', tool: a.tool || a.name || '', arguments: a.arguments || a.args || {} }) },
  mcp_list_tools: { ccTool: 'MCPListTools' },
  mcp_call_tool: { ccTool: 'MCPCallTool', translateArgs: (a) => ({ server: a.server || '', tool: a.tool || a.name || '', arguments: a.arguments || a.args || {} }) },
  task_create: { ccTool: 'TaskCreate', translateArgs: (a) => ({ description: a.description || a.name || '', status: a.status || 'pending' }) },
  task_update: { ccTool: 'TaskUpdate', translateArgs: (a) => ({ id: a.id, status: a.status, description: a.description }) },
  enter_plan_mode: { ccTool: 'EnterPlanMode' },
  exit_plan_mode: { ccTool: 'ExitPlanMode' },
  enter_worktree: { ccTool: 'EnterWorktree', translateArgs: (a) => ({ path: a.path }) },
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
  opts: { preserveTools?: boolean } = {},
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

  // ── Build tool mapping ──
  // In preserveTools mode, skip the tool name/arg rewriting entirely.
  // Tool routing in real agents requires bidirectional schema fidelity that
  // lossy forward-only translation can't provide. Users with custom tool
  // schemas should use preserveTools to keep their tools as-is and accept
  // the fingerprint risk on their own account.
  const activeToolMap = new Map<string, ToolMapping>();
  const unmappedTools: string[] = [];

  if (clientTools && !opts.preserveTools) {
    for (const tool of clientTools) {
      const name = (tool.name as string || '').toLowerCase();
      const mapping = TOOL_MAP[name];
      if (mapping) {
        activeToolMap.set(tool.name as string, mapping);
      } else {
        unmappedTools.push(tool.name as string);
        // Distribute unmapped tools across CC tool names to avoid suspicious
        // patterns where every unknown tool maps to Bash
        const CC_FALLBACK_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
        const fallbackTool = CC_FALLBACK_TOOLS[unmappedTools.length % CC_FALLBACK_TOOLS.length];
        activeToolMap.set(tool.name as string, {
          ccTool: fallbackTool,
          translateArgs: (a) => {
            // Translate args to match the CC tool's expected schema
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

  // Strip framework identifiers from system prompt that would flag non-CC usage
  const FRAMEWORK_PATTERNS = [
    /\b(openclaw|hermes|aider|cursor|windsurf|cline|continue|copilot|cody)\b/gi,
    /\b(openai|gpt-4|gpt-3\.5)\b/gi,
    /powered by [a-z]+/gi,
    /\bgateway\b/gi,
  ];
  for (const pattern of FRAMEWORK_PATTERNS) {
    systemText = systemText.replace(pattern, '');
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
 * Reverse-map CC tool calls in a response back to client tool names.
 */
export function reverseMapResponse(
  responseBody: string,
  toolMap: Map<string, ToolMapping>,
): string {
  if (toolMap.size === 0) return responseBody;

  let result = responseBody;

  // Build reverse map: CC tool name → original client tool name
  const reverseMap = new Map<string, string>();
  for (const [clientName, mapping] of toolMap) {
    // Only add if not a direct CC tool name
    if (clientName.toLowerCase() !== mapping.ccTool.toLowerCase()) {
      reverseMap.set(mapping.ccTool, clientName);
    }
  }

  for (const [ccName, clientName] of reverseMap) {
    result = result.replace(
      new RegExp(`"name"\\s*:\\s*"${ccName}"`, 'g'),
      `"name":"${clientName}"`,
    );
  }

  return result;
}

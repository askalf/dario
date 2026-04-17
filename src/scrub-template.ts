/**
 * Template scrubber — sanitize a captured TemplateData before baking it
 * into `src/cc-template-data.json`.
 *
 * The bundled template is consumed by every brand-new dario install on
 * its very first proxy request, before the background live capture has
 * had a chance to refresh the cache. Whatever user-identifying data sits
 * in the baked file reaches Anthropic on that first request — so baked
 * captures must never carry host-specific paths, usernames, or the
 * capturing user's MCP tool set.
 *
 * Scrubbing preserves fingerprint-sensitive fields verbatim:
 *   - `header_order`, `header_values`, `anthropic_beta` — wire-level
 *   - `tools[].name`, `tools[].input_schema` structure — CC canonical
 *
 * Scrubbing modifies user-identifying fields:
 *   - `system_prompt` — removes the sections CC populates with host-
 *     specific state (`# Environment`, `# auto memory`, `# claudeMd`,
 *     `# userEmail`, `# currentDate`, `# gitStatus`), then replaces any
 *     residual user-dir paths with a `user` placeholder
 *   - `agent_identity` — same path replacement as a defensive measure
 *   - `tools[].description` — same path replacement
 *   - `tools` — drops any tool whose name begins with `mcp__` (those are
 *     the capturing user's MCP server tools, not CC-canonical)
 *
 * Stripped sections return to the live capture on first refresh — the
 * baked fallback is only consumed by a brand-new install's very first
 * request, before the background refresh has had time to run.
 *
 * Idempotent: scrub(scrub(x)) === scrub(x).
 */

import type { TemplateData } from './live-fingerprint.js';

/**
 * Full scrub pass on a captured template. Returns a new object; the input
 * is not mutated. Safe to run on an already-scrubbed template.
 */
export function scrubTemplate(data: TemplateData): TemplateData {
  const cloned: TemplateData = JSON.parse(JSON.stringify(data));
  cloned.system_prompt = scrubText(removeHostContextSections(cloned.system_prompt));
  cloned.agent_identity = scrubText(cloned.agent_identity);
  cloned.tools = cloned.tools
    .filter((t) => !t.name.startsWith('mcp__'))
    .map((t) => ({
      name: t.name,
      description: scrubText(t.description),
      input_schema: scrubObjectStrings(t.input_schema) as Record<string, unknown>,
    }));
  cloned.tool_names = cloned.tools.map((t) => t.name);
  return cloned;
}

/**
 * Replace user-identifying filesystem paths with a generic `user`
 * placeholder. Exported so `scripts/check-cc-drift.mjs` can reuse the same
 * detection to flag regressions.
 */
export function scrubText(text: string): string {
  let out = text;
  for (const [re, replacement] of USER_PATH_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Regex patterns matching user-identifying path segments alongside their
 * generic replacement. The order matters: the flattened CC form
 * (`C--Users-<name>-<project>`) is collapsed whole because disambiguating
 * a hyphenated username from the project tail isn't possible from the
 * string alone, and the replacement only needs to mask identity — not
 * preserve the project layout.
 */
const USER_PATH_PATTERNS: Array<[RegExp, string]> = [
  // Windows: C:\Users\<name>\... → C:\Users\user\...
  [/(C:\\Users\\)[^\\/\s`'")\]]+/gi, '$1user'],
  // macOS: /Users/<name>/...    → /Users/user/...
  [/(\/Users\/)[^/\s`'")\]]+/g, '$1user'],
  // Linux: /home/<name>/...     → /home/user/...
  [/(\/home\/)[^/\s`'")\]]+/g, '$1user'],
  // CC flattened path convention (used under ~/.claude/projects):
  //   C--Users-<name>-<project-segments> → C--Users-user-project
  [/C--Users-[^\s\\`'")\]]+/g, 'C--Users-user-project'],
];

/**
 * Section headings CC populates with host-specific state. Each one is a
 * `# <name>` top-level heading in the system prompt; the section runs
 * from the heading to the next `# ` heading (or EOF).
 *
 *   - `# Environment` — working directory, OS, git status, commit log
 *   - `# auto memory` — path to the user's memory directory
 *   - `# claudeMd` — contents of CLAUDE.md files on the host
 *   - `# userEmail` — the capturing user's email address
 *   - `# currentDate` — today's date (per-session)
 *   - `# gitStatus` — git repo state (rarely a top-level heading; kept
 *     here defensively in case CC refactors the Environment block)
 *
 * A live capture on the user's own machine replaces the baked system
 * prompt entirely on first refresh, so stripping these sections does
 * not affect runtime behavior. Static content (agent role, tool usage,
 * tone, guidance) is preserved.
 */
const HOST_CONTEXT_SECTION_HEADINGS = [
  'Environment',
  'auto memory',
  'claudeMd',
  'userEmail',
  'currentDate',
  'gitStatus',
] as const;

function removeHostContextSections(systemPrompt: string): string {
  let out = systemPrompt;
  for (const name of HOST_CONTEXT_SECTION_HEADINGS) {
    out = removeSection(out, name);
  }
  return out;
}

/**
 * Strip one named top-level section (`\n# <name>\n` through the next
 * `\n# ` heading, or EOF) from a system prompt. Applied repeatedly in
 * case a section appears more than once.
 */
function removeSection(systemPrompt: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`\\n# ${escaped}\\n`);
  let out = systemPrompt;
  while (true) {
    const m = heading.exec(out);
    if (!m) return out;
    const sectionStart = m.index;
    const afterHeading = out.slice(sectionStart + m[0].length);
    const nextHeading = /\n# /.exec(afterHeading);
    const sectionEnd = nextHeading
      ? sectionStart + m[0].length + nextHeading.index
      : out.length;
    out = out.slice(0, sectionStart) + out.slice(sectionEnd);
  }
}

/**
 * Walk an arbitrary JSON-shaped value and run `scrubText` on every string
 * leaf. Preserves structure (keys, array order, numbers, booleans, nulls).
 * Used to clean tool `input_schema` without disturbing its shape.
 */
function scrubObjectStrings(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubObjectStrings(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubObjectStrings(v);
    }
    return out;
  }
  return value;
}

/**
 * Run over a string and report any user-identifying patterns that remain.
 * Used by `scripts/check-cc-drift.mjs` to verify the baked template
 * passes scrubbing before a release goes out.
 */
export function findUserPathHits(text: string): string[] {
  const hits: string[] = [];
  const detectors: RegExp[] = [
    /(C:\\Users\\)(?!user\b)[^\\/\s`'")\]]+/gi,
    /(\/Users\/)(?!user\b)[^/\s`'")\]]+/g,
    /(\/home\/)(?!user\b)[^/\s`'")\]]+/g,
    /C--Users-(?!user-project\b)[^\s\\`'")\]]+/g,
  ];
  for (const re of detectors) {
    const matches = text.match(re);
    if (matches) hits.push(...matches);
  }
  return hits;
}

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
  // Identity is masked by now, but the path SHAPE is still the bake host's.
  // Canonicalize it so a bundle is byte-identical wherever it was produced.
  return canonicalizeClaudeProjectPaths(out);
}

/**
 * The one form every host's `~/.claude/projects/...` path is rewritten to.
 *
 * Chosen over keeping each platform's own shape because the shape is what broke
 * reproducibility: the identity rules above already collapse the username and
 * the project slug, but they leave `C:\\Users\\user\\...` on Windows and
 * `/root/...` on Linux — 60 bytes against 38 for the same logical path. That
 * 22-byte difference is a REAL byte difference, so computeDrift is right to
 * report it; the bug is that it exists at all. A Windows bake and a Linux CI
 * bake therefore each flagged the other and re-baked, indefinitely
 * (dario#854 -> auto-rebake #860). Sibling case, already fixed: #856 stopped
 * replaying the bake host's OS/arch headers onto every request.
 */
const CANONICAL_PROJECT_DIR = '/home/user/.claude/projects/project';

/**
 * A `~/.claude/projects/<slug>/...` path in EITHER separator style, anchored on
 * the already-scrubbed home forms so it cannot match an unscrubbed path (which
 * must keep failing findUserPathHits rather than be quietly canonicalized into
 * looking clean). Consumes the trailing segments too, because `memory\\` and
 * `memory/` are equal in length but differ in bytes.
 */
const CLAUDE_PROJECT_PATH =
  /(?:[A-Za-z]:[\\/]Users[\\/]user|\/root|\/home\/user|\/Users\/user)[\\/]\.claude[\\/]projects[\\/][^\s`'")\]]*/g;

function canonicalizeClaudeProjectPaths(text: string): string {
  return text.replace(CLAUDE_PROJECT_PATH, (match) => {
    const tail = match.split(/[\\/]projects[\\/]/)[1] ?? '';
    // drop the project slug, keep whatever addressed dir followed it
    const segments = tail.split(/[\\/]/).filter((s) => s.length > 0).slice(1);
    const trailing = /[\\/]$/.test(match) ? '/' : '';
    return segments.length > 0
      ? `${CANONICAL_PROJECT_DIR}/${segments.join('/')}${trailing}`
      : `${CANONICAL_PROJECT_DIR}${trailing}`;
  });
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
  // CC flattened path, POSIX/forward-slash form: the project dir under
  // `~/.claude/projects/` is the capturing user's absolute path with every
  // separator turned into `-` (e.g. a self-hosted runner bakes
  // `/root/.claude/projects/-root-actions-runner--work-dario-dario/memory/`).
  // The `C--Users-` rule above only catches the Windows form; this collapses
  // the POSIX slug — under any home, including `/root` — to a stable
  // placeholder so the bundle carries no host path and no longer drifts by
  // working directory. Forward-slash anchored, so it never touches the
  // already-collapsed Windows backslash form.
  [/(\/\.claude\/projects\/)[^/\s`'")\]]+/g, '$1project'],
];

/**
 * Section headings CC populates with host-specific state. Each one is a
 * `# <name>` top-level heading in the system prompt; the section runs
 * from the heading to the next `# ` heading (or EOF).
 *
 *   - `# Environment` — working directory, OS, platform
 *   - `# auto memory` — path to the user's memory directory
 *   - `# claudeMd` — contents of CLAUDE.md files on the host
 *   - `# userEmail` — the capturing user's email address
 *   - `# currentDate` — today's date (per-session)
 *
 * Plus one non-markdown block:
 *
 *   - `gitStatus:` — branch, modified-file list, recent commits. CC
 *     emits this as a plain-text label (no `#`), appended after the
 *     markdown sections. Stripped separately by `removeGitStatusBlock`.
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
] as const;

function removeHostContextSections(systemPrompt: string): string {
  let out = systemPrompt;
  for (const name of HOST_CONTEXT_SECTION_HEADINGS) {
    out = removeSection(out, name);
  }
  out = removeGitStatusBlock(out);
  return out;
}

/**
 * Strip CC's gitStatus block. Unlike the markdown-heading sections,
 * gitStatus is a plain-text label (`\ngitStatus:`), appended after the
 * `# Environment` / `# Context management` markdown headings. Runs until
 * the next `\n# ` markdown heading or end of string — whichever comes
 * first. In current CC builds the block is at the very end of the
 * system prompt; the `\n# ` terminator is defensive against a future
 * refactor that appends a markdown section after it.
 *
 * v4.2.2's `--check` drift detector flagged this as a small recurring
 * delta in the bundled vs. live-captured prompt — branch state and
 * modified-file list legitimately differ between bakes even on the
 * same machine, so leaving it in the bundle produces false-positive
 * drift signals and leaks the bake host's repo state.
 */
function removeGitStatusBlock(systemPrompt: string): string {
  return systemPrompt.replace(/\r?\ngitStatus:[\s\S]*?(?=\r?\n# |$)/, '');
}

/**
 * Strip one named top-level section (`\n# <name>\n` through the next
 * `\n# ` heading, or EOF) from a system prompt. Applied repeatedly in
 * case a section appears more than once.
 */
function removeSection(systemPrompt: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \r?\n tolerates a CRLF capture; [ \t]* tolerates trailing whitespace on the
  // heading line — either would otherwise leave a host-context section unstripped.
  const heading = new RegExp(`\\r?\\n# ${escaped}[ \\t]*\\r?\\n`);
  let out = systemPrompt;
  while (true) {
    const m = heading.exec(out);
    if (!m) return out;
    const sectionStart = m.index;
    const afterHeading = out.slice(sectionStart + m[0].length);
    const nextHeading = /\r?\n# /.exec(afterHeading);
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
 * Prose CC emits when it injects user- or project-level instruction files
 * (CLAUDE.md, memory, environment) into a prompt. The section strip above is
 * keyed on the `# claudeMd` heading shape; these are keyed on the wrapper text
 * itself, so a reshaped or renamed heading still gets caught.
 *
 * Both halves are load-bearing. `removeSection` and the heading detector in
 * findUserPathHits read the SAME heading list, so a heading CC renames strips
 * nothing and flags nothing — two silent failures — and once paths are scrubbed
 * the leftover prose carries no user path for the other detectors to catch.
 * dario#872 saw one capture in six come back carrying another session's
 * instruction text; this is the half that does not depend on the heading.
 *
 * Every marker is verified absent from the real baked template — base, fable,
 * opus-5 and sonnet-5 prompts plus every tool description. Do NOT add bare
 * `CLAUDE.md` or `system-reminder`: CC's own system prompt and tool
 * descriptions both mention them, so either would fail every bake. Verified,
 * not assumed, and test/context-bleed.mjs pins it.
 */
const INSTRUCTION_INJECTION_MARKERS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'instruction-file wrapper', re: /Codebase and user instructions are shown below/ },
  { label: 'instruction-file wrapper', re: /IMPORTANT: These instructions OVERRIDE any default behavior/ },
  // Straight and typographic apostrophe both — CC emits the straight one today,
  // and a marker that a quote-style change silently disarms is not a guard.
  { label: 'instruction-file annotation', re: /user['’]s private global instructions/ },
  { label: 'memory-file annotation', re: /auto-memory, persists across conversations/ },
  { label: 'instruction-file heading', re: /\bContents of [^\n]{1,300}\.md\b/ },
  { label: 'project-instruction wrapper', re: /Here are useful instructions from/ },
];

/**
 * Run over a string and report anything that must not survive into a bake:
 * user-identifying paths, host-context sections the strip missed, and
 * instruction-file prose (dario#872). Despite the name the contract has never
 * been paths-only. Used by `scripts/check-cc-drift.mjs` to gate a release and
 * by `scripts/capture-and-bake.mjs` to fail a bake.
 *
 * Deliberately NOT called from `extractTemplate`: that serves the live-capture
 * path too, and the live fingerprint keeps host context on purpose — it exists
 * to replay the operator's own CC install faithfully. Only the bake publishes.
 */
export function findUserPathHits(text: string): string[] {
  const hits: string[] = [];
  const detectors: RegExp[] = [
    /(C:\\Users\\)(?!user\b)[^\\/\s`'")\]]+/gi,
    /(\/Users\/)(?!user\b)[^/\s`'")\]]+/g,
    /(\/home\/)(?!user\b)[^/\s`'")\]]+/g,
    /C--Users-(?!user-project\b)[^\s\\`'")\]]+/g,
    /(\/\.claude\/projects\/)(?!project\b)[^/\s`'")\]]+/g,
  ];
  for (const re of detectors) {
    const matches = text.match(re);
    if (matches) hits.push(...matches);
  }
  // A host-context section still present here means removeSection failed to
  // strip it (e.g. a CRLF capture or a renamed heading). Flag it so the drift-
  // gate fails the release rather than shipping the leak (#642-audit).
  for (const name of HOST_CONTEXT_SECTION_HEADINGS) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\r?\\n# ${esc}[ \\t]*\\r?\\n`).test(text)) {
      hits.push(`# ${name} (host-context section not stripped)`);
    }
  }
  // Instruction-file prose, matched on the wrapper rather than the heading.
  // Excerpt is bounded: a hit is printed by the bake, and the whole point is
  // that the matched text may be somebody's private instructions.
  for (const { label, re } of INSTRUCTION_INJECTION_MARKERS) {
    const m = text.match(re);
    if (m) hits.push(`${m[0].slice(0, 60)} (${label} not stripped)`);
  }
  return hits;
}

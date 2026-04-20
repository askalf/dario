#!/usr/bin/env node
/**
 * Tool-schema contract test (dario#43).
 *
 * Every TOOL_MAP entry's translateArgs output must satisfy the
 * corresponding CC tool's input_schema (loaded from cc-template-data.json).
 * This catches:
 *   • WebFetch entries that forgot to supply `prompt` (required by CC).
 *   • AskUserQuestion entries that produce `{question: ...}` instead of
 *     the required `{questions: [...]}` nested shape.
 *   • Edit/Write/Glob/Grep entries whose output drops a required field.
 *
 * Runs entirely in-process — no OAuth, no network, no live proxy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCCRequest } from '../dist/cc-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, '..', 'src', 'cc-template-data.json');
const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
const ccSchemas = new Map();
for (const t of template.tools) ccSchemas.set(t.name, t.input_schema);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// Sample client-side input per mapped client tool. One realistic shape
// per entry — enough to exercise the forward translation. Tools whose
// translateArgs is arg-independent (e.g. enter_plan_mode) tolerate {}.
const samples = {
  bash: { command: 'ls' },
  exec: { command: 'ls' },
  shell: { command: 'ls' },
  run: { command: 'ls' },
  command: { command: 'ls' },
  terminal: { command: 'ls' },
  execute_command: { command: 'ls' },
  run_terminal_cmd: { command: 'ls', explanation: 'list files' },
  run_command: { CommandLine: 'ls' },
  builtin_run_terminal_command: { command: 'ls' },
  run_in_terminal: { command: 'ls', explanation: 'list' },
  execute_bash: { command: 'ls' },
  process: { action: 'list' },
  read: { path: '/tmp/x' },
  read_file: { target_file: '/tmp/x' },
  view_file: { AbsolutePath: '/tmp/x', StartLine: 1, EndLine: 20 },
  builtin_read_file: { path: '/tmp/x' },
  write: { path: '/tmp/x', content: 'hi' },
  write_file: { path: '/tmp/x', content: 'hi' },
  write_to_file: { path: '/tmp/x', content: 'hi' },
  builtin_create_new_file: { path: '/tmp/x', content: 'hi' },
  create_file: { filePath: '/tmp/x', content: 'hi' },
  edit: { path: '/tmp/x', old: 'a', new: 'b' },
  edit_file: { path: '/tmp/x', old_str: 'a', new_str: 'b' },
  replace_in_file: { path: '/tmp/x', old_string: 'a', new_string: 'b' },
  apply_diff: { path: '/tmp/x', old_string: 'a', new_string: 'b' },
  search_replace: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
  builtin_edit_existing_file: { path: '/tmp/x', old_string: 'a', replacement: 'b' },
  insert_edit_into_file: { filePath: '/tmp/x', code: 'b' },
  str_replace_editor: { path: '/tmp/x', old_str: 'a', new_str: 'b' },
  patch: { path: '/tmp/x', old_string: 'a', new_string: 'b' },
  glob: { pattern: '*.ts' },
  find_files: { pattern: '*.ts' },
  list_files: { pattern: '*', path: '.' },
  file_search: { query: 'main.ts' },
  list_dir: { target_directory: '.' },
  find_by_name: { Pattern: '*.ts', SearchDirectory: '.' },
  builtin_file_glob_search: { glob: '*.ts' },
  builtin_ls: { path: '.' },
  grep: { pattern: 'TODO' },
  search: { query: 'TODO' },
  search_files: { query: 'TODO' },
  grep_search: { query: 'TODO' },
  codebase_search: { query: 'auth flow' },
  builtin_grep_search: { pattern: 'TODO' },
  semantic_search: { query: 'auth flow' },
  web_search: { query: 'news' },
  websearch: { query: 'news' },
  web_fetch: { url: 'https://example.com' },
  webfetch: { url: 'https://example.com' },
  fetch: { url: 'https://example.com' },
  browse: { url: 'https://example.com' },
  read_url_content: { Url: 'https://example.com' },
  web_extract: { urls: ['https://example.com'] },
  fetch_webpage: { url: 'https://example.com', query: 'news' },
  search_web: { query: 'news' },
  builtin_search_web: { query: 'news' },
  notebook: { notebook_path: '/tmp/n.ipynb' },
  notebook_edit: { notebook_path: '/tmp/n.ipynb' },
  browser: { url: 'https://example.com' },
  todo_read: {},
  todo_write: { todos: [{ content: 'x', status: 'pending', activeForm: 'doing x' }] },
  enter_plan_mode: {},
  exit_plan_mode: {},
  enter_worktree: { path: '/tmp/w' },
  exit_worktree: {},
  // Intentionally unmapped — declared so buildCCRequest registers them in
  // unmappedTools. The schema-validation loop skips anything listed in
  // unmappedTools; the regression guard at the bottom asserts they stay
  // dropped. No valid CC shape exists for these client tools (dario#43).
  message: { message: 'what should I do?' },
  ask_followup_question: { question: 'what should I do?' },
  clarify: { question: 'what should I do?' },
  notebook_read: { notebook_path: '/tmp/n.ipynb' },
};

// Tools intentionally dropped from TOOL_MAP in v3.18.0 (dario#43).
// Their samples above exist only to exercise the unmapped-tool path.
const INTENTIONALLY_UNMAPPED = new Set([
  'message',
  'ask_followup_question',
  'clarify',
  'notebook_read',
]);

// Minimal JSON-Schema subset — covers every construct used in
// cc-template-data.json: type, required, properties, items, minItems.
function validate(value, schema, path = '$') {
  const errs = [];
  if (schema.type === 'object' || schema.properties) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errs.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return errs;
    }
    for (const req of schema.required || []) {
      if (!(req in value)) errs.push(`${path}.${req}: missing required field`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[k];
      if (sub) errs.push(...validate(v, sub, `${path}.${k}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errs.push(`${path}: expected array, got ${typeof value}`);
    } else {
      if (schema.minItems != null && value.length < schema.minItems) {
        errs.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) errs.push(...validate(value[i], schema.items, `${path}[${i}]`));
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') errs.push(`${path}: expected string, got ${typeof value}`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number') errs.push(`${path}: expected number, got ${typeof value}`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errs.push(`${path}: expected boolean, got ${typeof value}`);
  }
  return errs;
}

header('Tool-schema contract (dario#43)');

// Declare every sample-listed client tool in one request. buildCCRequest
// returns a toolMap keyed by client name → ToolMapping for every *mapped*
// tool; unmapped tools show up in unmappedTools instead.
const clientTools = Object.keys(samples).map((name) => ({
  name,
  description: `Stub ${name}`,
  input_schema: { type: 'object', properties: {}, additionalProperties: true },
}));

const { toolMap, unmappedTools } = buildCCRequest(
  {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'probe' }],
    tools: clientTools,
    stream: false,
  },
  'billing-tag',
  { type: 'ephemeral' },
  { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
  {},
);

// No regression: every non-dropped sample must resolve to a real mapping.
for (const name of Object.keys(samples)) {
  if (INTENTIONALLY_UNMAPPED.has(name)) continue;
  check(`mapped: ${name}`, toolMap.has(name) && !unmappedTools.includes(name));
}

// Contract: every mapped translateArgs output satisfies CC's input_schema.
for (const [clientName, mapping] of toolMap.entries()) {
  if (!mapping.translateArgs) continue;
  if (unmappedTools.includes(clientName)) continue; // fallback round-robin
  const sample = samples[clientName];
  if (!sample) {
    check(`schema: ${clientName} → ${mapping.ccTool}`, false, 'no test sample defined');
    continue;
  }
  let ccInput;
  try {
    ccInput = mapping.translateArgs(sample);
  } catch (err) {
    check(`schema: ${clientName} → ${mapping.ccTool}`, false, `translateArgs threw: ${err.message}`);
    continue;
  }
  const ccSchema = ccSchemas.get(mapping.ccTool);
  if (!ccSchema) {
    check(`schema: ${clientName} → ${mapping.ccTool}`, false, 'CC schema not found in template');
    continue;
  }
  const errs = validate(ccInput, ccSchema);
  check(`schema: ${clientName} → ${mapping.ccTool}`, errs.length === 0, errs.slice(0, 3).join('; '));
}

// Regression guard: the three ask-user mappings must stay dropped — re-adding
// them without fixing the shape would silently break every upstream request
// carrying one of those client tools.
for (const name of INTENTIONALLY_UNMAPPED) {
  check(`dropped (dario#43): ${name}`, unmappedTools.includes(name));
}

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

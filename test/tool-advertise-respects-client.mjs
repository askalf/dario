#!/usr/bin/env node
/**
 * Regression: dario must not advertise CC tools the client didn't declare.
 *
 * Bug: in default (template) mode buildCCRequest set ccRequest.tools to the FULL
 * CC_TOOL_DEFINITIONS (31 tools incl. AskUserQuestion), REPLACING the client's
 * list. A CC session with AskUserQuestion disabled (headless / SDK) sent a tool
 * array WITHOUT it; dario re-added it; the model emitted an AskUserQuestion
 * tool_use; the client harness rejected it with
 *   "AskUserQuestion exists but is not enabled in this context".
 *
 * Fix: in default mode advertise only the CC-native tools the client actually
 * declared (a real reduced-tool CC client sends exactly that array).
 *
 * In-process — no proxy / OAuth / upstream.
 */

import { buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const billingTag = 'x-anthropic-billing-header: cc_version=test;';
const cache1h = { type: 'ephemeral' };
const identity = { deviceId: 'd', accountUuid: 'u', sessionId: 's' };

// A real CC client (PascalCase native tools → detected CC → default mode) that
// has AskUserQuestion DISABLED, so it never appears in its declared tools.
const reducedCC = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'list files' }],
  tools: [
    { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'Grep', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
    { name: 'Edit', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'Write', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'Glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  ],
};

header('reduced CC client (AskUserQuestion disabled)');
{
  const { body } = buildCCRequest(reducedCC, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((t) => t.name);
  check('AskUserQuestion is NOT advertised', !names.includes('AskUserQuestion'));
  check('no undeclared CC tool leaks in (Agent/Workflow/Task* absent)',
    !['Agent', 'Workflow', 'TaskCreate', 'CronCreate'].some((n) => names.includes(n)));
  check('the 6 declared tools ARE advertised', ['Read', 'Bash', 'Grep', 'Edit', 'Write', 'Glob'].every((n) => names.includes(n)));
  check('advertises exactly the declared set (6, not the full 31-tool template)', names.length === 6);
  const readTool = (body.tools || []).find((t) => t.name === 'Read');
  check('uses CANONICAL CC defs (Read carries the CC description, not the client stub)',
    !!readTool && typeof readTool.description === 'string' && readTool.description.length > 0);
}

header('full CC client (sends AskUserQuestion) — still advertised');
{
  const fullCC = {
    ...reducedCC,
    tools: [
      ...reducedCC.tools,
      { name: 'AskUserQuestion', input_schema: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] } },
    ],
  };
  const { body } = buildCCRequest(fullCC, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((t) => t.name);
  check('AskUserQuestion IS advertised when the client declares it', names.includes('AskUserQuestion'));
  check('full-tool client unaffected (7 declared → 7 advertised)', names.length === 7);
}

console.log(`\ntool-advertise-respects-client: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

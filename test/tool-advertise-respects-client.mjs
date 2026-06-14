#!/usr/bin/env node
/**
 * Regression: dario must not advertise CC tools the client didn't declare.
 *
 * Bug: in default (template) mode buildCCRequest set ccRequest.tools to the FULL
 * CC_TOOL_DEFINITIONS (all CC tools incl. AskUserQuestion), REPLACING the
 * client's list. A CC session with AskUserQuestion disabled (headless / SDK)
 * sent a tool array WITHOUT it; dario re-added it; the model emitted an
 * AskUserQuestion tool_use; the client harness rejected it with
 *   "AskUserQuestion exists but is not enabled in this context".
 *
 * Fix: in default mode advertise only the CC-native tools the client declared.
 *
 * Tools used here are all CROSS-PLATFORM (avoid PowerShell/Glob/Grep, which are
 * win32-only per PLATFORM_ONLY_TOOLS) so assertions hold on Linux CI and Windows
 * alike. The primary check is the platform-agnostic SUBSET invariant.
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

const t = (name, props) => ({ name, input_schema: { type: 'object', properties: props, required: Object.keys(props) } });
// Cross-platform CC-native tools only (no PowerShell/Glob/Grep).
const DECLARED = [
  t('Read', { file_path: { type: 'string' } }),
  t('Bash', { command: { type: 'string' } }),
  t('Edit', { file_path: { type: 'string' } }),
  t('Write', { file_path: { type: 'string' } }),
  t('WebSearch', { query: { type: 'string' } }),
];
const declaredNames = new Set(DECLARED.map((x) => x.name.toLowerCase()));

header('reduced CC client (AskUserQuestion disabled)');
{
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: DECLARED };
  const { body } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((x) => x.name);
  // Core invariant (platform-agnostic): every advertised tool was declared.
  check('SUBSET invariant: no undeclared tool is advertised',
    names.every((n) => declaredNames.has(n.toLowerCase())));
  check('AskUserQuestion specifically NOT advertised', !names.includes('AskUserQuestion'));
  check('no undeclared CC tool leaks (Agent/Workflow/Task*/Cron* absent)',
    !['Agent', 'Workflow', 'TaskCreate', 'CronCreate', 'NotebookEdit'].some((n) => names.includes(n)));
  check('the declared cross-platform tools ARE advertised',
    ['Read', 'Bash', 'Edit', 'Write', 'WebSearch'].every((n) => names.includes(n)));
  check('advertises exactly the declared set (not the full template)', names.length === DECLARED.length);
  const readTool = (body.tools || []).find((x) => x.name === 'Read');
  check('uses CANONICAL CC defs (Read carries the CC description, not the client stub)',
    !!readTool && typeof readTool.description === 'string' && readTool.description.length > 0);
}

header('full CC client (sends AskUserQuestion) — still advertised');
{
  const withAsk = [...DECLARED, t('AskUserQuestion', { questions: { type: 'array' } })];
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: withAsk };
  const { body } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((x) => x.name);
  check('AskUserQuestion IS advertised when the client declares it', names.includes('AskUserQuestion'));
  check('still a strict subset of declared', names.every((n) => withAsk.some((d) => d.name.toLowerCase() === n.toLowerCase())));
  check('exactly the declared set', names.length === withAsk.length);
}

console.log(`\ntool-advertise-respects-client: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

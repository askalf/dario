#!/usr/bin/env node
/**
 * The bundled CC template keeps the tools CC loads on demand through ToolSearch
 * (DEFERRED_TOOLS), so a client that declares one of them mid-session is still
 * identity-mapped, and a capture that omits them is merged rather than refused.
 *
 * In-process, no proxy / OAuth / upstream.
 */

import {
  CC_TEMPLATE,
  CC_TOOL_DEFINITIONS,
  CC_NATIVE_NAMES_UNION,
  CONFIG_SCOPED_TOOLS,
  DEFERRED_TOOLS,
  INTERACTIVE_ONLY_TOOLS,
  PLATFORM_ONLY_TOOLS,
} from '../dist/cc-template.js';
import { preservedToolReason, unclassifiedToolDrops, mergePreservedTools } from '../dist/live-fingerprint.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const EXPECTED = [
  'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'EnterWorktree', 'ExitWorktree',
  'Monitor', 'NotebookEdit', 'PushNotification', 'SendMessage', 'WebFetch', 'WebSearch',
];

header('DEFERRED_TOOLS names exactly the twelve CC 2.1.304 stopped declaring');
{
  check('size is 12', DEFERRED_TOOLS.size === EXPECTED.length);
  for (const name of EXPECTED) check(`${name} is deferred`, DEFERRED_TOOLS.has(name));
}

header('bundled template carries every deferred tool');
{
  const templateNames = new Set((CC_TEMPLATE.tools || []).map((t) => t.name));
  for (const name of DEFERRED_TOOLS) {
    check(`template tools[] contains ${name}`, templateNames.has(name));
    const def = (CC_TEMPLATE.tools || []).find((t) => t.name === name);
    check(`${name} has a non-empty description`, !!def && typeof def.description === 'string' && def.description.length > 0);
    check(`${name} has an input_schema.type`, !!def && !!def.input_schema && typeof def.input_schema.type === 'string');
  }
}

header('deferred tools identity-map (the thing dropping them breaks)');
{
  for (const name of DEFERRED_TOOLS) {
    check(`CC_NATIVE_NAMES_UNION contains ${name}`, CC_NATIVE_NAMES_UNION.has(name));
  }
}

header('deferred tools are NOT platform-filtered (present on every host)');
{
  const platformScoped = new Set(Object.values(PLATFORM_ONLY_TOOLS).flatMap((s) => [...s]));
  const ccNames = new Set(CC_TOOL_DEFINITIONS.map((t) => t.name));
  for (const name of DEFERRED_TOOLS) {
    check(`${name} is not platform-scoped`, !platformScoped.has(name));
    check(`CC_TOOL_DEFINITIONS (platform ${process.platform}) contains ${name}`, ccNames.has(name));
  }
}

header('the preservation sets stay disjoint');
{
  const platformScoped = new Set(Object.values(PLATFORM_ONLY_TOOLS).flatMap((s) => [...s]));
  check('DEFERRED_TOOLS ∩ CONFIG_SCOPED_TOOLS is empty', [...DEFERRED_TOOLS].every((n) => !CONFIG_SCOPED_TOOLS.has(n)));
  check('DEFERRED_TOOLS ∩ INTERACTIVE_ONLY_TOOLS is empty', [...DEFERRED_TOOLS].every((n) => !INTERACTIVE_ONLY_TOOLS.has(n)));
  check('DEFERRED_TOOLS ∩ PLATFORM_ONLY_TOOLS is empty', [...DEFERRED_TOOLS].every((n) => !platformScoped.has(n)));
}

header('preservedToolReason classifies them as deferred on every platform');
{
  for (const name of DEFERRED_TOOLS) {
    check(`${name}: deferred on linux`, preservedToolReason(name, 'linux') === 'deferred');
    check(`${name}: deferred on win32`, preservedToolReason(name, 'win32') === 'deferred');
  }
  check('Read stays unclassified', preservedToolReason('Read', 'linux') === null);
  check('TaskCreate keeps its own reason', preservedToolReason('TaskCreate', 'linux') === 'config-scoped');
  check('AskUserQuestion keeps its own reason', preservedToolReason('AskUserQuestion', 'linux') === 'interactive');
  check('PowerShell keeps its own reason on linux', preservedToolReason('PowerShell', 'linux') === 'platform');
}

header('a capture shaped like CC 2.1.304 drops nothing unclassified');
{
  // The 15 tools the 2.1.304 request declared on Windows.
  const WIN32_CAPTURE = ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'ListAgents', 'PowerShell', 'Read',
    'ReportFindings', 'ScheduleWakeup', 'Skill', 'ToolSearch', 'Workflow', 'DeferredToolPlaceholder', 'Write']
    .map((name) => ({ name }));
  const bundle = CC_TEMPLATE.tools;
  check('win32 capture vs the bundle: unclassifiedToolDrops is []',
    unclassifiedToolDrops(WIN32_CAPTURE, bundle, 'win32').length === 0);
  const linuxCapture = WIN32_CAPTURE.filter((t) => !['PowerShell', 'Glob', 'Grep'].includes(t.name));
  check('linux-shaped capture vs the bundle: unclassifiedToolDrops is []',
    unclassifiedToolDrops(linuxCapture, bundle, 'linux').length === 0);

  // The merge restores them with the full definition, sorted into wire order.
  const { tools, preserved } = mergePreservedTools(WIN32_CAPTURE, bundle, 'win32');
  const merged = new Set(tools.map((t) => t.name));
  check('merge restores all twelve deferred tools', EXPECTED.every((n) => merged.has(n)));
  check('merge reports each as deferred', EXPECTED.every((n) => preserved.some((p) => p.name === n && p.reason === 'deferred')));
  check('merged tools stay alphabetical', tools.every((t, i) => i === 0 || tools[i - 1].name.localeCompare(t.name) <= 0));
  check("restored definitions are the bundle's own",
    EXPECTED.every((n) => tools.find((t) => t.name === n) === bundle.find((t) => t.name === n)));
}

console.log(`\ntemplate-deferred-tools: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

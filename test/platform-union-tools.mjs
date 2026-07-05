#!/usr/bin/env node
/**
 * Regression: platform-scoped CC natives must map by the CLIENT's declaration,
 * not the proxy HOST's process.platform.
 *
 * Bug (pre-v4.8.136): CC_NATIVE_NAMES / CC_TOOL_DEFINITIONS are filtered by
 * the host's process.platform, so a Linux-hosted dario serving a win32 CC
 * client treated PowerShell/Glob/Grep as non-native — PowerShell fell to the
 * unmapped round-robin (junk translateArgs), Glob/Grep translated via the
 * lowercase TOOL_MAP aliases, and none of the three were advertised upstream
 * (the model never saw them). The client's own declaration already encodes
 * its platform, so the identity/detection/advertise paths now intersect with
 * the bundled UNION; the host filter still governs the no-declaration
 * fallbacks (full template, merge base, Fable no-tools).
 *
 * On win32 hosts the filtered set equals the union, so the interesting
 * assertions only bite on POSIX CI — same platform caveat as
 * tool-advertise-respects-client.mjs, inverted.
 *
 * In-process — no proxy / OAuth / upstream.
 */

import {
  buildCCRequest, detectNonCCByTools,
  CC_TOOL_DEFINITIONS, CC_TOOL_DEFINITIONS_UNION, CC_NATIVE_NAMES_UNION,
} from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const billingTag = 'x-anthropic-billing-header: cc_version=test;';
const cache1h = { type: 'ephemeral' };
const identity = { deviceId: 'd', accountUuid: 'u', sessionId: 's' };
const t = (name, props) => ({ name, description: `client def for ${name}`, input_schema: { type: 'object', properties: props, required: Object.keys(props) } });

const WIN32_CLIENT = [
  t('Read', { file_path: { type: 'string' } }),
  t('Bash', { command: { type: 'string' } }),
  t('PowerShell', { command: { type: 'string' } }),
  t('Glob', { pattern: { type: 'string' } }),
  t('Grep', { pattern: { type: 'string' } }),
];

header('union invariants');
{
  check('union is a superset of the host-filtered set',
    CC_TOOL_DEFINITIONS.every((d) => CC_NATIVE_NAMES_UNION.has(d.name)));
  check('union carries the win32-scoped tools on every host (bundle superset guarantee)',
    ['PowerShell', 'Glob', 'Grep'].every((n) => CC_NATIVE_NAMES_UNION.has(n)));
  check('union export matches the union name set',
    CC_TOOL_DEFINITIONS_UNION.length === CC_NATIVE_NAMES_UNION.size);
}

header('win32 CC client through any-platform host');
{
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'PowerShell', input: { command: 'Get-ChildItem' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  ];
  const clientBody = { model: 'claude-sonnet-4-6', messages, tools: WIN32_CLIENT };
  const { body, toolMap, unmappedTools } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((x) => x.name);

  check('PowerShell/Glob/Grep ARE advertised', ['PowerShell', 'Glob', 'Grep'].every((n) => names.includes(n)));
  check('advertised defs are CANONICAL (template description, not the client stub)',
    ['PowerShell', 'Glob', 'Grep'].every((n) => {
      const d = (body.tools || []).find((x) => x.name === n);
      return !!d && d.description !== `client def for ${n}`;
    }));
  check('exactly the declared set — nothing undeclared leaks',
    names.length === WIN32_CLIENT.length && names.every((n) => WIN32_CLIENT.some((d) => d.name === n)));
  check('no tool fell to the unmapped round-robin', unmappedTools.length === 0);
  check('PowerShell identity-maps', toolMap.get('PowerShell')?.ccTool === 'PowerShell');
  check('Glob identity-maps (exact case beats the lowercase alias)', toolMap.get('Glob')?.ccTool === 'Glob');

  const histToolUse = (body.messages || []).flatMap((m) => Array.isArray(m.content) ? m.content : []).find((b) => b.type === 'tool_use');
  check('history PowerShell tool_use survives name+input intact',
    !!histToolUse && histToolUse.name === 'PowerShell' && histToolUse.input.command === 'Get-ChildItem');
}

header('detection: platform-scoped natives are not foreign');
{
  check('PowerShell/Glob/Grep-only surface is NOT flagged non-CC',
    detectNonCCByTools([t('PowerShell', { command: { type: 'string' } }), t('Glob', { pattern: { type: 'string' } }), t('Grep', { pattern: { type: 'string' } })]) === null);
  check('genuinely foreign surface still flags',
    detectNonCCByTools([t('lobster', { a: { type: 'string' } }), t('memory_get', { k: { type: 'string' } }), t('canvas', { p: { type: 'string' } })]) === 'unknown-non-cc');
}

header('lowercase aliases still route via TOOL_MAP (non-CC clients unaffected)');
{
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: [t('glob', { pattern: { type: 'string' } }), t('read', { path: { type: 'string' } }), t('bash', { command: { type: 'string' } })] };
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  check('lowercase glob routes through its alias, not union identity',
    toolMap.get('glob')?.ccTool === 'Glob');
}

console.log(`\nplatform-union-tools: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

#!/usr/bin/env node
/**
 * Regression: MCP tools (mcp__<server>__<tool>) must pass through verbatim
 * in default mode, not round-robin onto CC fallback slots.
 *
 * Bug (pre-v4.8.135): a CC session with an MCP server attached declares its
 * built-ins PLUS mcp__* tools. The mcp__* names are in neither CC_NATIVE_NAMES
 * nor TOOL_MAP, so default mode (a) dropped them from the advertised array —
 * the model never saw the session's MCP surface — and (b) renamed mcp__*
 * tool_use blocks in history onto Bash/Read/… with junk args. Seen live as
 * "[dario] tool substitution: 28/52 client tools not in TOOL_MAP".
 *
 * Real CC advertises session-attached MCP schemas verbatim after its
 * built-ins, so passthrough IS the CC wire shape; the remap was the
 * divergence.
 *
 * Tools used here are all CROSS-PLATFORM (avoid PowerShell/Glob/Grep,
 * win32-only per PLATFORM_ONLY_TOOLS) so assertions hold on Linux CI.
 *
 * In-process — no proxy / OAuth / upstream.
 */

import { buildCCRequest, detectNonCCByTools, reverseMapResponse, isMcpToolName } from '../dist/cc-template.js';

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
const NATIVES = [
  t('Read', { file_path: { type: 'string' } }),
  t('Bash', { command: { type: 'string' } }),
  t('Edit', { file_path: { type: 'string' } }),
  t('Write', { file_path: { type: 'string' } }),
  t('WebSearch', { query: { type: 'string' } }),
];
const MCP = [
  t('mcp__mcp-tools__db_query', { sql: { type: 'string' } }),
  t('mcp__mcp-tools__browser_use', { action: { type: 'string' }, url: { type: 'string' } }),
  t('mcp__other-server__deploy_ops', { target: { type: 'string' } }),
];

header('isMcpToolName');
{
  check('mcp__server__tool matches', isMcpToolName('mcp__mcp-tools__db_query'));
  check('CC native does not match', !isMcpToolName('Read'));
  check('lowercase alias does not match', !isMcpToolName('bash'));
  check('non-string does not match', !isMcpToolName(undefined) && !isMcpToolName(42));
}

header('CC client with MCP server attached (the live 28/52 case)');
{
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__mcp-tools__db_query', input: { sql: 'SELECT 1' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  ];
  const clientBody = { model: 'claude-sonnet-4-6', messages, tools: [...NATIVES, ...MCP] };
  const { body, toolMap, unmappedTools } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((x) => x.name);

  check('every declared MCP tool IS advertised', MCP.every((m) => names.includes(m.name)));
  check('declared natives still advertised', ['Read', 'Bash', 'Edit', 'Write', 'WebSearch'].every((n) => names.includes(n)));
  check('nothing undeclared leaks in', names.every((n) => [...NATIVES, ...MCP].some((d) => d.name.toLowerCase() === n.toLowerCase())));
  check('MCP tools counted as mapped, not unmapped (no substitution warn)', unmappedTools.length === 0);

  const dbq = (body.tools || []).find((x) => x.name === 'mcp__mcp-tools__db_query');
  check('MCP def forwarded VERBATIM (client schema, not a template stub)',
    !!dbq && dbq.description === 'client def for mcp__mcp-tools__db_query'
    && JSON.stringify(dbq.input_schema.properties) === JSON.stringify({ sql: { type: 'string' } }));
  const readTool = (body.tools || []).find((x) => x.name === 'Read');
  check('natives still use CANONICAL CC defs (not the client stub)',
    !!readTool && readTool.description !== 'client def for Read');

  const firstMcpIdx = Math.min(...MCP.map((m) => names.indexOf(m.name)));
  const lastNativeIdx = Math.max(...['Read', 'Bash', 'Edit', 'Write', 'WebSearch'].map((n) => names.indexOf(n)));
  check('MCP tools appended AFTER the native set (CC array order)', firstMcpIdx > lastNativeIdx);

  const mapping = toolMap.get('mcp__mcp-tools__db_query');
  check('toolMap identity-maps MCP names', !!mapping && mapping.ccTool === 'mcp__mcp-tools__db_query');

  const histToolUse = (body.messages || []).flatMap((m) => Array.isArray(m.content) ? m.content : []).find((b) => b.type === 'tool_use');
  check('history tool_use keeps MCP name (no fallback rename)', !!histToolUse && histToolUse.name === 'mcp__mcp-tools__db_query');
  check('history tool_use input untouched (no junk translateArgs)', !!histToolUse && histToolUse.input && histToolUse.input.sql === 'SELECT 1');
}

header('detection: MCP-heavy CC client stays in default mode');
{
  const manyMcp = Array.from({ length: 20 }, (_, i) => t(`mcp__srv__tool_${i}`, { x: { type: 'string' } }));
  // 2 natives + 20 mcp = 91% non-native — would have flipped to preserve pre-fix.
  check('CC + heavy MCP mix is NOT flagged non-CC',
    detectNonCCByTools([t('Read', { file_path: { type: 'string' } }), t('Bash', { command: { type: 'string' } }), ...manyMcp]) === null);
  check('all-mcp surface is NOT flagged non-CC (verbatim advertise covers it)',
    detectNonCCByTools(manyMcp) === null);
  check('genuinely foreign surface still flags',
    detectNonCCByTools([t('lobster', { a: { type: 'string' } }), t('memory_get', { k: { type: 'string' } }), t('canvas', { p: { type: 'string' } })]) === 'unknown-non-cc');
}

header('all-mcp declaration advertises verbatim, not the full template');
{
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: MCP, };
  const { body } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  const names = (body.tools || []).map((x) => x.name);
  check('exactly the declared MCP set', names.length === MCP.length && MCP.every((m) => names.includes(m.name)));
  check('no undeclared CC native advertised (AskUserQuestion failure mode)',
    !names.some((n) => ['Bash', 'Read', 'AskUserQuestion', 'Agent'].includes(n)));
}

header('foreign tools still warn; MCP names stay out of the unmapped list');
{
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: [...NATIVES, ...MCP, t('lobster', { a: { type: 'string' } })] };
  const { unmappedTools } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  check('only the genuinely foreign tool is unmapped', unmappedTools.length === 1 && unmappedTools[0] === 'lobster');
}

header('reverse path: MCP tool_use flows back unchanged');
{
  const clientBody = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], tools: [...NATIVES, ...MCP] };
  const { toolMap } = buildCCRequest(clientBody, billingTag, cache1h, identity, {});
  const upstream = JSON.stringify({
    content: [
      { type: 'text', text: 'querying' },
      { type: 'tool_use', id: 'tu_9', name: 'mcp__mcp-tools__db_query', input: { sql: 'SELECT 2' } },
    ],
  });
  const mapped = JSON.parse(reverseMapResponse(upstream, toolMap));
  const tu = mapped.content.find((b) => b.type === 'tool_use');
  check('name unchanged', tu.name === 'mcp__mcp-tools__db_query');
  check('input unchanged', tu.input.sql === 'SELECT 2');
}

console.log(`\nmcp-tool-passthrough: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

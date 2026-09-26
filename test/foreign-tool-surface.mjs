#!/usr/bin/env node
// A /v1/messages client whose tool names overlap TOOL_MAP's lowercase aliases
// (askalf/dario#1429). The Redline reviewer sent list_files, read_file, grep and
// submit_review; every tool must reach the model, under a name the client can
// read back.
//
// Covers the detector (a foreign tool, no CC-native name and an alias sharing a
// CC tool's name is non-CC), the default-mode request that follows from it, and
// the remap-mode advertise step for a surface that is all aliases.

import { buildCCRequest, detectNonCCByTools } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}

const billingTag = 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;';
const cache = { type: 'ephemeral' };
const identity = { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' };
const tool = (name) => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: { path: { type: 'string' } } } });
const request = (names, extra = {}) => ({
  model: 'claude-sonnet-5',
  system: 'You review pull requests.',
  messages: [{ role: 'user', content: 'review this' }],
  tools: names.map(tool),
  ...extra,
});
const names = (tools) => (tools ?? []).map((t) => t.name).join(',');

console.log('\n  detectNonCCByTools');
check('aliases plus one foreign tool, no CC-native name → unknown-non-cc',
  detectNonCCByTools(['list_files', 'read_file', 'grep', 'submit_review'].map(tool)) === 'unknown-non-cc');
check('one alias plus one foreign tool → unknown-non-cc',
  detectNonCCByTools(['bash', 'custom_x'].map(tool)) === 'unknown-non-cc');
check('CC-native names plus one foreign tool → null (stays CC)',
  detectNonCCByTools(['Bash', 'Read', 'Grep', 'custom_x'].map(tool)) === null);
check('aliases that share no CC name plus a foreign tool → null (OpenClaw stays in remap)',
  detectNonCCByTools(['exec', 'process', 'web_search', 'web_fetch', 'browser', 'message'].map(tool)) === null);
check('aliases only, nothing foreign → null (remap)',
  detectNonCCByTools(['list_files', 'read_file', 'grep'].map(tool)) === null);
check('MCP tools plus CC natives plus one foreign tool → null',
  detectNonCCByTools(['Bash', 'mcp__srv__one', 'mcp__srv__two', 'custom_x'].map(tool)) === null);

console.log('\n  buildCCRequest, default mode');
{
  const built = buildCCRequest(request(['list_files', 'read_file', 'grep', 'submit_review']), billingTag, cache, identity, {});
  check('the reviewer surface is preserved', built.detectedClient === 'unknown-non-cc', built.detectedClient);
  check('all four tools go out under their own names', names(built.body.tools) === 'list_files,read_file,grep,submit_review', names(built.body.tools));
  check('no tool is remapped', built.toolMap.size === 0, built.toolMap.size);
}
{
  // A CC-shaped surface is untouched by the new rule.
  const built = buildCCRequest(request(['Bash', 'Read', 'Grep']), billingTag, cache, identity, {});
  check('CC natives stay in remap mode', built.detectedClient === undefined, built.detectedClient);
  check('CC natives go out as the CC definitions', names(built.body.tools) === 'Bash,Grep,Read', names(built.body.tools));
}

console.log('\n  buildCCRequest, remap mode with aliases');
{
  const built = buildCCRequest(request(['list_files', 'read_file', 'grep'], { tool_choice: { type: 'tool', name: 'read_file' } }), billingTag, cache, identity, {});
  const out = new Set((built.body.tools ?? []).map((t) => t.name));
  check('stays in remap mode', built.detectedClient === undefined, built.detectedClient);
  check('list_files maps to Glob and Glob is advertised', built.toolMap.get('list_files')?.ccTool === 'Glob' && out.has('Glob'), names(built.body.tools));
  check('read_file maps to Read and Read is advertised', built.toolMap.get('read_file')?.ccTool === 'Read' && out.has('Read'), names(built.body.tools));
  check('grep maps to Grep and Grep is advertised', built.toolMap.get('grep')?.ccTool === 'Grep' && out.has('Grep'), names(built.body.tools));
  check('nothing the client did not declare is advertised', out.size === 3, names(built.body.tools));
  check('a forced read_file goes out as Read', built.body.tool_choice?.type === 'tool' && built.body.tool_choice?.name === 'Read', JSON.stringify(built.body.tool_choice));
}
{
  // OpenClaw's surface names no CC tool: the full template goes out, so the
  // fallback slot `message` rides is visible to the model.
  const built = buildCCRequest(request(['exec', 'process', 'web_search', 'web_fetch', 'browser', 'message']), billingTag, cache, identity, {});
  check('OpenClaw stays in remap mode', built.detectedClient === undefined, built.detectedClient);
  check('OpenClaw gets the full template', (built.body.tools ?? []).length > 5, (built.body.tools ?? []).length);
  const slot = built.toolMap.get('message')?.ccTool;
  check("the slot message rides is advertised", (built.body.tools ?? []).some((t) => t.name === slot), slot);
}
{
  // A declaration that names no CC tool keeps the full template, as before.
  const built = buildCCRequest(request(['execute_command', 'write_to_file']), billingTag, cache, identity, {});
  check('aliases that name no CC tool keep the full template', (built.body.tools ?? []).length > 5, (built.body.tools ?? []).length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

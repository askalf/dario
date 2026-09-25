#!/usr/bin/env node

import { buildCCRequest, passthroughToolChoice } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

const billingTag = 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;';
const cache = { type: 'ephemeral' };
const identity = { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' };
const customTools = ['list_files', 'read_file', 'grep', 'submit_review'].map((name) => ({
  name, description: `${name} tool`, input_schema: { type: 'object', properties: {} },
}));
// tools: the client's array, or null for a tool-less request.
const body = (tool_choice, tools = customTools) => ({
  model: 'claude-fable-5-1',
  messages: [{ role: 'user', content: 'review this' }],
  ...(tools ? { tools } : {}),
  ...(tool_choice ? { tool_choice } : {}),
});

console.log('\n  passthroughToolChoice');
const outgoing = customTools;
check('auto passes', passthroughToolChoice({ type: 'auto' }, outgoing)?.type === 'auto');
check('any passes', passthroughToolChoice({ type: 'any' }, outgoing)?.type === 'any');
check('none passes', passthroughToolChoice({ type: 'none' }, outgoing)?.type === 'none');
check('a forced tool that is going out passes', passthroughToolChoice({ type: 'tool', name: 'submit_review' }, outgoing)?.name === 'submit_review');
check('a forced tool that is not going out is dropped', passthroughToolChoice({ type: 'tool', name: 'Bash' }, outgoing) === null);
check('remap mode: the forced name is translated through the tool map', passthroughToolChoice({ type: 'tool', name: 'read_file' }, [{ name: 'Read' }], new Map([['read_file', { ccTool: 'Read' }]]))?.name === 'Read');
check('remap mode: a translated name that is not going out is dropped', passthroughToolChoice({ type: 'tool', name: 'read_file' }, [{ name: 'Grep' }], new Map([['read_file', { ccTool: 'Read' }]])) === null);
check('a forced tool with no tools going out is dropped', passthroughToolChoice({ type: 'tool', name: 'submit_review' }, undefined) === null);
check('junk is dropped', [null, undefined, 'any', 7, [], { type: 'tool' }, { type: 'nope' }].every((v) => passthroughToolChoice(v, outgoing) === null));

console.log('\n  buildCCRequest (a non-CC client with its own tools)');
{
  // Default (remap) mode: `grep` is advertised as CC's `Grep`, so a client forcing `grep` must
  // reach upstream as `Grep`. Without the tool map wired into the call the name stays `grep`,
  // which is not among the tools going out, and the choice is dropped: this case fails.
  const { body: out, toolMap } = buildCCRequest(body({ type: 'tool', name: 'grep' }), billingTag, cache, identity, {});
  check('remap mode: grep is advertised as Grep', toolMap.get('grep')?.ccTool === 'Grep' && out.tools.some((t) => t.name === 'Grep'));
  check('remap mode: the forced client name comes out as the advertised name', out.tool_choice?.type === 'tool' && out.tool_choice?.name === 'Grep');
}
{
  // Default (remap) mode: a client tool that is not among the tools going out cannot be forced.
  const { body: out } = buildCCRequest(body({ type: 'tool', name: 'submit_review' }), billingTag, cache, identity, {});
  check('remap mode: a forced tool that did not go out is dropped', out.tool_choice === undefined && !out.tools.some((t) => t.name === 'submit_review'));
}
{
  const { body: out } = buildCCRequest(body({ type: 'tool', name: 'submit_review' }), billingTag, cache, identity, { preserveTools: true });
  check("preserve mode: the client's tools go out as declared", out.tools.some((t) => t.name === 'submit_review'));
  check('preserve mode: the forced tool_choice goes out unchanged', out.tool_choice?.type === 'tool' && out.tool_choice?.name === 'submit_review');
}
{
  const { body: out } = buildCCRequest(body({ type: 'any' }), billingTag, cache, identity, {});
  check('tool_choice any goes out', out.tool_choice?.type === 'any');
}
{
  const { body: out } = buildCCRequest(body(undefined), billingTag, cache, identity, {});
  check('no client tool_choice: none is added', out.tool_choice === undefined);
}
{
  const { body: out } = buildCCRequest(body({ type: 'tool', name: 'submit_review' }, null), billingTag, cache, identity, {});
  check("a tool-less fable request keeps the template's own pin, whatever the client sent", out.tool_choice?.type === 'none');
  check('and its tools are the CC array', Array.isArray(out.tools) && out.tools.length > 5);
}
{
  const { body: out } = buildCCRequest(body({ type: 'tool', name: 'submit_review' }), billingTag, cache, identity, { mergeTools: true });
  check('merge mode: the forced client tool is in the union and the choice goes out', out.tools.some((t) => t.name === 'submit_review') && out.tool_choice?.name === 'submit_review');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

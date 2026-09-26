#!/usr/bin/env node
// A request that names Claude Code's own tools and also declares a tool dario
// cannot map (askalf/dario#1429). Remap mode advertises only the CC tools such a
// request declares, so a tool round-robined onto a fallback slot never reached
// the model. The tool now goes out the way real Claude Code sends a tool beyond
// its built-ins, under an mcp__<server>__<tool> name with the client's own
// schema, and comes back under the client's name. A tool that cannot be carried
// that way fails the request with its name.
//
// Pure function calls: no proxy, no network.

import * as tpl from '../dist/cc-template.js';

const { buildCCRequest, detectNonCCByTools, reverseMapResponse, createStreamingReverseMapper } = tpl;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}

const billingTag = 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;';
const cache = { type: 'ephemeral' };
const identity = { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' };
const tool = (name, props = { path: { type: 'string' } }) => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: props } });
const REVIEW = tool('submit_review', { verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'] }, body: { type: 'string' } });
const request = (tools, extra = {}) => ({
  model: 'claude-sonnet-5',
  system: 'You review pull requests.',
  messages: [{ role: 'user', content: 'review this' }],
  tools,
  ...extra,
});
const names = (tools) => (tools ?? []).map((t) => t.name);
const build = (body, opts = {}) => buildCCRequest(JSON.parse(JSON.stringify(body)), billingTag, cache, identity, opts);
const throwsUnsupported = (fn) => {
  try { fn(); return null; } catch (err) { return err; }
};

console.log('\n  a CC-classified request with one tool outside CC\'s set');
{
  const tools = [tool('Grep'), tool('Read'), tool('Bash'), REVIEW];
  check('the surface is classified as CC', detectNonCCByTools(tools) === null);
  const built = build(request(tools, { tool_choice: { type: 'tool', name: 'submit_review' } }));
  const out = names(built.body.tools);
  check('it stays in remap mode', built.detectedClient === undefined, built.detectedClient);
  check('submit_review maps to mcp__client__submit_review', built.toolMap.get('submit_review')?.ccTool === 'mcp__client__submit_review', built.toolMap.get('submit_review')?.ccTool);
  check('mcp__client__submit_review is advertised', out.includes('mcp__client__submit_review'), out.join(','));
  const carried = (built.body.tools ?? []).find((t) => t.name === 'mcp__client__submit_review');
  check("it carries the client's own schema", JSON.stringify(carried?.input_schema) === JSON.stringify(REVIEW.input_schema), JSON.stringify(carried?.input_schema));
  check("it carries the client's own description", carried?.description === REVIEW.description);
  check('it follows the CC tools, as MCP tools do', out.indexOf('mcp__client__submit_review') === out.length - 1, out.join(','));
  check('no fallback slot the client did not declare is advertised',
    out.length === 4 && ['Bash', 'Grep', 'Read'].every((n) => out.includes(n)), out.join(','));
  check('the forced submit_review goes out under the carried name',
    built.body.tool_choice?.type === 'tool' && built.body.tool_choice?.name === 'mcp__client__submit_review', JSON.stringify(built.body.tool_choice));
  check('carriedAsMcp names it', JSON.stringify(built.carriedAsMcp) === '["submit_review"]', JSON.stringify(built.carriedAsMcp));
  check('unmappedTools still lists it', built.unmappedTools.includes('submit_review'));
}

console.log('\n  the round trip');
{
  const history = request([tool('Grep'), tool('Read'), REVIEW], {
    messages: [
      { role: 'user', content: 'review this' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_review', input: { verdict: 'APPROVE', body: 'ok' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'recorded' }] },
    ],
  });
  const built = build(history);
  const prior = built.body.messages[1].content[0];
  check('a prior submit_review call in history goes out under the carried name', prior.name === 'mcp__client__submit_review', prior.name);
  check('its input is unchanged', JSON.stringify(prior.input) === '{"verdict":"APPROVE","body":"ok"}', JSON.stringify(prior.input));

  const upstream = JSON.stringify({ content: [{ type: 'tool_use', id: 'tu_2', name: 'mcp__client__submit_review', input: { verdict: 'REQUEST_CHANGES', body: 'fix' } }] });
  const back = JSON.parse(reverseMapResponse(upstream, built.toolMap)).content[0];
  check("the model's call comes back as submit_review", back.name === 'submit_review', back.name);
  check('with its input unchanged', JSON.stringify(back.input) === '{"verdict":"REQUEST_CHANGES","body":"fix"}', JSON.stringify(back.input));

  const mapper = createStreamingReverseMapper(built.toolMap);
  const sse = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_3","name":"mcp__client__submit_review","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"verdict\\":\\"APPROVE\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  ].join('');
  const streamed = Buffer.from(mapper.feed(Buffer.from(sse))).toString() + Buffer.from(mapper.end()).toString();
  check('a streamed call comes back as submit_review', streamed.includes('"name":"submit_review"') && !streamed.includes('mcp__client__'), streamed.slice(0, 300));
}

console.log('\n  next to real MCP tools');
{
  const built = build(request([tool('Read'), tool('mcp__srv__lookup'), REVIEW]));
  const out = names(built.body.tools);
  check('the MCP tool goes out verbatim', out.includes('mcp__srv__lookup') && built.toolMap.get('mcp__srv__lookup')?.ccTool === 'mcp__srv__lookup', out.join(','));
  check('the carried tool follows it', out.join(',') === 'Read,mcp__srv__lookup,mcp__client__submit_review', out.join(','));
}

console.log('\n  a tool that cannot be carried fails the request by name');
{
  const Unsupported = tpl.UnsupportedClientToolError;
  check('UnsupportedClientToolError is exported', typeof Unsupported === 'function');
  const isUnsupported = (err) => typeof Unsupported === 'function' && err instanceof Unsupported;

  const serverTool = throwsUnsupported(() => build(request([tool('Read'), { type: 'computer_20251124', name: 'computer', display_width_px: 1024, display_height_px: 768 }])));
  check('an Anthropic-defined tool throws UnsupportedClientToolError', isUnsupported(serverTool), String(serverTool));
  check('the message names it', /"computer"/.test(serverTool?.message ?? ''), serverTool?.message);

  const noSchema = throwsUnsupported(() => build(request([tool('Read'), { name: 'no_schema', description: 'x' }])));
  check('a tool with no input_schema throws', isUnsupported(noSchema) && /"no_schema"/.test(noSchema.message), String(noSchema));

  const longName = 'a'.repeat(60);
  const tooLong = throwsUnsupported(() => build(request([tool('Read'), tool(longName)])));
  check('a name too long once MCP-shaped throws', isUnsupported(tooLong) && tooLong.message.includes(longName), String(tooLong));

  const clash = throwsUnsupported(() => build(request([tool('Read'), tool('x_tool'), tool('mcp__client__x_tool')])));
  check('a name the client also declares MCP-shaped throws', isUnsupported(clash) && /"x_tool"/.test(clash.message), String(clash));

  const both = throwsUnsupported(() => build(request([tool('Read'), { name: 'no_schema' }, { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' }])));
  check('every tool that cannot be carried is named',
    isUnsupported(both) && both.tools?.length === 2 && /"no_schema"/.test(both.message) && /"str_replace_based_edit_tool"/.test(both.message), String(both));
}

console.log('\n  paths the change leaves alone');
{
  const built = build(request([tool('Grep'), tool('Read'), REVIEW]), { hybridTools: true });
  check('hybrid mode still drops the unmapped tool', !built.toolMap.has('submit_review') && !names(built.body.tools).some((n) => n.includes('submit_review')), names(built.body.tools).join(','));
}
{
  const built = build(request([tool('Grep'), tool('Read'), REVIEW]), { preserveTools: true });
  check('preserve mode sends it verbatim', names(built.body.tools).join(',') === 'Grep,Read,submit_review', names(built.body.tools).join(','));
}
{
  // Names no CC tool: the full template goes out and the fallback slot is visible (OpenClaw).
  const built = build(request(['exec', 'process', 'web_search', 'web_fetch', 'browser', 'message'].map((n) => tool(n))));
  const slot = built.toolMap.get('message')?.ccTool;
  check('a surface naming no CC tool keeps the fallback slot', ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(slot), slot);
}
{
  const built = build(request([tool('Grep'), tool('Read'), tool('mcp__srv__lookup')]));
  check('a surface with nothing outside CC and MCP carries nothing', (built.carriedAsMcp ?? []).length === 0 && built.unmappedTools.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

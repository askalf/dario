#!/usr/bin/env node
/**
 * An Anthropic-defined tool entry for a name the bundle knows, dario#1812.
 *
 * `advisor` sits in the bundle as an empty stub (dario#1376), so its template
 * definition is never advertised. The client's `advisor_20260301` entry is the
 * only definition there is, and it used to be dropped with no error: the
 * request succeeded and the server never ran the tool.
 *
 * Runs in-process. No proxy, no OAuth, no upstream.
 */

import {
  buildCCRequest,
  reverseMapResponse,
  createStreamingReverseMapper,
  UnsupportedClientToolError,
} from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const identity = { deviceId: 'd'.repeat(64), accountUuid: 'acct', sessionId: 'sess' };
const cache = { type: 'ephemeral', ttl: '1h' };
const advisor = { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_tokens: 256 };
const schema = { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] };
const custom = (name) => ({ name, description: `the ${name} tool`, input_schema: schema });

function build(tools, opts = {}, messages = [{ role: 'user', content: 'hi' }]) {
  return buildCCRequest({ model: 'claude-sonnet-5-5', max_tokens: 64, tools, messages }, 'tag', cache, identity, opts);
}
const names = (built) => built.body.tools.map((t) => t.name);
const sent = (built) => built.body.tools.find((t) => t.name === 'advisor');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

header('the entry goes out as the client declared it');
{
  const alone = build([advisor]);
  check('alone: it is the whole tools array, not the template', alone.body.tools.length === 1 && same(alone.body.tools[0], advisor));
  check('alone: no client flip', !alone.detectedClient);

  const cc = build([custom('Bash'), custom('Read'), advisor]);
  check('beside Claude Code tools: carried, in the name order Claude Code sends', same(names(cc), ['advisor', 'Bash', 'Read']) && same(sent(cc), advisor));
  check('beside Claude Code tools: still the Claude Code path', !cc.detectedClient);

  const aliases = build([custom('bash'), custom('read'), advisor]);
  check('beside aliases: carried, aliases still remap', same(names(aliases), ['advisor', 'Bash', 'Read']) && same(sent(aliases), advisor));

  const wide = build(['Write', 'Agent', 'TaskCreate', 'Bash', 'Glob', 'Read'].map(custom));
  check('without it, the Claude Code tools stay in template order',
    same(names(wide), ['Agent', 'Bash', 'Glob', 'Read', 'TaskCreate', 'Write']));

  const hybrid = build([custom('Bash'), advisor], { hybridTools: true });
  check('hybrid mode: carried', same(sent(hybrid), advisor));
}

header('a client tool beside it stays visible');
{
  const built = build([advisor, custom('get_time')]);
  const wire = built.body.tools.find((t) => t.name === 'mcp__client__get_time');
  check('goes out under the MCP name with its own schema', Boolean(wire) && same(wire.input_schema, schema));
  check('the template is not substituted', built.body.tools.length === 2 && same(sent(built), advisor));

  const reply = JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'mcp__client__get_time', input: { intent: 'now' } }] });
  const back = JSON.parse(reverseMapResponse(reply, built.toolMap));
  check('a call comes back under the client name, arguments untouched',
    back.content[0].name === 'get_time' && same(back.content[0].input, { intent: 'now' }));
}

header('what the server sends back reaches the client, and returns intact');
{
  const use = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} };
  const result = { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'advisor_result', text: 'take the smaller change' } };
  const { toolMap } = build([custom('Bash'), advisor]);

  const reply = JSON.stringify({ content: [{ type: 'text', text: 'asking' }, use, result, { type: 'text', text: 'done' }] });
  check('non-streaming: blocks unchanged', same(JSON.parse(reverseMapResponse(reply, toolMap)).content.slice(1, 3), [use, result]));

  const mapper = createStreamingReverseMapper(toolMap);
  const events = [
    { type: 'content_block_start', index: 0, content_block: { ...use, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: result },
    { type: 'content_block_stop', index: 1 },
  ];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let out = '';
  for (const e of events) out += dec.decode(mapper.feed(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)));
  out += dec.decode(mapper.end());
  const seen = out.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  check('streaming: every event passes, in order', same(seen, events));

  const history = [
    { role: 'user', content: [{ type: 'text', text: 'plan this' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'asking' }, use, result, { type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'go on' }] },
  ];
  const next = build([custom('Bash'), advisor], {}, JSON.parse(JSON.stringify(history)));
  const assistant = next.body.messages.find((m) => m.role === 'assistant');
  check('next turn: both blocks stay in the history', same(assistant.content.slice(1, 3), [use, result]));
}

header('the rest of the rule did not move');
{
  const computer = { type: 'computer_20250124', name: 'computer', display_width_px: 1024, display_height_px: 768 };
  let refused = null;
  try { build([custom('Bash'), computer]); } catch (err) { refused = err; }
  check('an entry for a name outside the bundle still fails the request by name',
    refused instanceof UnsupportedClientToolError && /computer/.test(refused.message));
  check('alone, it is still a foreign surface and goes out verbatim', same(build([computer]).body.tools, [computer]));

  const clientAdvisor = custom('advisor');
  check('a client advisor with its own schema still goes out as declared', same(build([clientAdvisor]).body.tools, [clientAdvisor]));

  const mapped = build([{ type: 'bash_20250124', name: 'bash' }]);
  check('an entry whose name maps still takes the mapped tool', same(names(mapped), ['Bash']));

  const stub = build([{ name: 'advisor' }]);
  check('a bare name with no type or schema is still not advertised', !stub.body.tools.some((t) => t.name === 'advisor'));
}

console.log(`\nanthropic-defined-tools: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

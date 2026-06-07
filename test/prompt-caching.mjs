#!/usr/bin/env node
// Unit test for CC-style prompt-cache breakpoint placement (applyCcPromptCaching
// + buildCCRequest integration). dario previously cached only the system prompt
// and stripped message breakpoints, so tools + conversation re-billed as fresh
// input every turn (fleet cache-read ~1.9% vs CC ~70-90%). This caches the last
// tool + the last message, mirroring CC, for the 4-breakpoint max.

import { applyCcPromptCaching, buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}`); fail++; }
}
const CC = { type: 'ephemeral' };
const hasCC = (o) => !!(o && o.cache_control && o.cache_control.type === 'ephemeral');

console.log('\n=== applyCcPromptCaching (unit) ===');
{
  const body = {
    tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ],
  };
  applyCcPromptCaching(body, CC);
  check('last tool is cached', hasCC(body.tools[2]));
  check('non-last tools are NOT cached', !hasCC(body.tools[0]) && !hasCC(body.tools[1]));
  check('last message last block is cached', hasCC(body.messages[2].content[0]));
  check('earlier messages NOT cached', !hasCC(body.messages[0].content[0]) && !hasCC(body.messages[1].content[0]));
  const toolBp = body.tools.filter(hasCC).length;
  const msgBp = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('exactly 1 tool + 1 message breakpoint (2 added; +2 system = 4 max)', toolBp === 1 && msgBp === 1);
}
{
  // string content is left untouched (no wire-shape change); only block-array content is cached
  const body = { messages: [{ role: 'user', content: 'plain string' }] };
  applyCcPromptCaching(body, CC);
  check('string content left unchanged (not wrapped/cached)', body.messages[0].content === 'plain string');
}
{
  // does not mutate a shared tools array (clones)
  const shared = [{ name: 'x' }];
  const body = { tools: shared };
  applyCcPromptCaching(body, CC);
  check('shared tools array is cloned, not mutated', !hasCC(shared[0]) && body.tools !== shared);
}

console.log('\n=== build + cache integration — 4 breakpoints (the proxy flow) ===');
{
  const clientBody = { model: 'claude-sonnet-4-6', tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const { body } = buildCCRequest(clientBody, 'billing', CC, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }, { preserveTools: true });
  // buildCCRequest stays pure — it caches ONLY the system prompt:
  check('buildCCRequest caches only system (no tool/msg breakpoints)', (body.tools || []).filter(hasCC).length === 0);
  // The proxy applies the tool + conversation breakpoints after build:
  applyCcPromptCaching(body, CC);
  const sysBp = (body.system || []).filter(hasCC).length;
  const toolBp = (body.tools || []).filter(hasCC).length;
  const msgBp = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('system breakpoints = 2 (unchanged)', sysBp === 2);
  check('tools breakpoint = 1 (added at proxy)', toolBp === 1);
  check('message breakpoint = 1 (added at proxy)', msgBp === 1);
  check('total breakpoints = 4 (Anthropic max, CC-matching)', sysBp + toolBp + msgBp === 4);
}
{
  // opt-out = the proxy simply doesn't call the helper → body stays system-only
  const clientBody = { model: 'claude-sonnet-4-6', tools: [{ name: 't' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const { body } = buildCCRequest(clientBody, 'billing', CC, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }, { preserveTools: true });
  // (DARIO_SKIP_FIELDS=prompt_cache → applyCcPromptCaching NOT called)
  const toolBp = (body.tools || []).filter(hasCC).length;
  const msgBp = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('skip (helper not called) → no tool/message breakpoints', toolBp === 0 && msgBp === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Unit test for CC-style prompt-cache breakpoint placement (applyCcPromptCaching
// + buildCCRequest integration). Placement mirrors a live capture of CC v2.1.203
// (dario#678): 2 system breakpoints + rolling breakpoint on the last USER message
// + anchor on the previous user message; tools carry NO breakpoint; every
// breakpoint is plain {type:'ephemeral'} (5m — no ttl field).

import { applyCcPromptCaching, buildCCRequest, CC_CACHE_CONTROL } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}`); fail++; }
}
const CC = { type: 'ephemeral' };
const hasCC = (o) => !!(o && o.cache_control && o.cache_control.type === 'ephemeral');
const ttlOf = (o) => o && o.cache_control && o.cache_control.ttl;

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
  check('tools carry NO breakpoint (CC v2.1.203 sends tools unstamped)', body.tools.filter(hasCC).length === 0);
  check('last user message last block is cached (rolling breakpoint)', hasCC(body.messages[2].content[0]));
  check('previous user message is anchored (>20-block fan-out protection)', hasCC(body.messages[0].content[0]));
  check('assistant messages NOT cached', !hasCC(body.messages[1].content[0]));
  const msgBp = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('exactly 2 message breakpoints (+2 system = 4 max)', msgBp === 2);
}
{
  // Trailing role:"system" injections (agent-type updates etc.) are skipped —
  // CC stamps the last USER turn. Stamping "the last message" (pre-4.8.142)
  // wrote no conversation entry on these turns, so the next request re-paid
  // the whole history as fresh input (dario#678).
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'system', content: 'Available agent types: ...' },
    ],
  };
  applyCcPromptCaching(body, CC);
  check('trailing role:system skipped; last USER message cached instead', hasCC(body.messages[0].content[0]));
  check('role:system message left unstamped', body.messages[1].content === 'Available agent types: ...');
}
{
  // string content is left untouched (no wire-shape change); only block-array content is cached
  const body = { messages: [{ role: 'user', content: 'plain string' }] };
  applyCcPromptCaching(body, CC);
  check('string content left unchanged (not wrapped/cached)', body.messages[0].content === 'plain string');
}
{
  // strips stray client tool breakpoints without mutating shared element objects
  const shared = [{ name: 'x', cache_control: { type: 'ephemeral' } }];
  const body = { tools: shared };
  applyCcPromptCaching(body, CC);
  check('stray client tool breakpoint stripped', body.tools.filter(hasCC).length === 0);
  check('shared tools array not mutated', hasCC(shared[0]) && body.tools !== shared);
}
{
  // single user turn — only the rolling breakpoint, no anchor to place
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  applyCcPromptCaching(body, CC);
  const msgBp = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('single user turn → 1 message breakpoint', msgBp === 1);
}

console.log('\n=== build + cache integration — the proxy flow ===');
{
  const clientBody = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  };
  const { body } = buildCCRequest(clientBody, 'billing', CC, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }, { preserveTools: true });
  // buildCCRequest stays pure — it caches ONLY the system prompt:
  check('buildCCRequest caches only system (no tool/msg breakpoints)', (body.tools || []).filter(hasCC).length === 0);
  // The proxy applies the conversation breakpoints after build:
  applyCcPromptCaching(body, CC);
  const sysBp = (body.system || []).filter(hasCC).length;
  const toolBp = (body.tools || []).filter(hasCC).length;
  const msgBp = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('system breakpoints = 2 (unchanged)', sysBp === 2);
  check('tools breakpoints = 0 (CC sends tools unstamped)', toolBp === 0);
  check('message breakpoints = 2 (rolling + anchor)', msgBp === 2);
  check('total breakpoints = 4 (Anthropic max, CC-matching)', sysBp + toolBp + msgBp === 4);
}
{
  // opt-out = the proxy simply doesn't call the helper → body stays system-only
  const clientBody = { model: 'claude-sonnet-4-6', tools: [{ name: 't' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const { body } = buildCCRequest(clientBody, 'billing', CC, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }, { preserveTools: true });
  // (DARIO_SKIP_FIELDS=prompt_cache → applyCcPromptCaching NOT called)
  const toolBp = (body.tools || []).filter(hasCC).length;
  const msgBp = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('skip (helper not called) → no message breakpoints', toolBp === 0 && msgBp === 0);
}

console.log('\n=== cache TTL — plain 5m ephemeral, matching real CC (dario#678) ===');
{
  // Real CC v2.1.203 sends {type:'ephemeral'} with NO ttl field (live capture).
  // v4.8.140 stamped ttl:'1h', whose cache WRITES bill 2x vs 1.25x for 5m —
  // the reporter's cold-start burn went +8% -> +19% on that build.
  check('CC_CACHE_CONTROL.type === "ephemeral"', CC_CACHE_CONTROL.type === 'ephemeral');
  check('CC_CACHE_CONTROL carries NO ttl (5m default, matching CC)', CC_CACHE_CONTROL.ttl === undefined);
}
{
  // Every emitted breakpoint is plain ephemeral without a ttl field.
  const clientBody = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  };
  const { body } = buildCCRequest(clientBody, 'billing', CC_CACHE_CONTROL, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' }, { preserveTools: true });
  applyCcPromptCaching(body, CC_CACHE_CONTROL);
  const cached = [
    ...(body.system || []),
    ...(body.tools || []),
    ...(body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []),
  ].filter(hasCC);
  check('4 breakpoints present (2 system + 2 conversation)', cached.length === 4);
  check('no breakpoint carries a ttl field', cached.every(o => ttlOf(o) === undefined));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Empty text blocks in message history — dario#1066, the request-level half.
//
// Ground truth (live A/B against api.anthropic.com, 2026-08-22): upstream
// rejects empty text blocks OUTRIGHT, stamped or not — "messages: text
// content blocks must be non-empty" — and treats whitespace-only text the
// same way. With a breakpoint on the block the error is "cache_control
// cannot be set for empty text blocks" instead. Either way the request dies,
// so the breakpoint guard in applyCcPromptCaching (the first half of #1067)
// cannot fix the session-killer on its own: the block itself must never
// reach the wire. These tests pin the rebuild-side filter.
import { buildCCRequest, applyCcPromptCaching, CC_CACHE_CONTROL } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
const ID = { deviceId: 'd', accountUuid: 'a', sessionId: 's' };
const TAG = 'x-anthropic-billing-header: tag';

const emptyTextBlocks = (body) =>
  (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'text' && (typeof b.text !== 'string' || b.text.trim() === ''));

console.log('\n=== empty text blocks are filtered out of the rebuilt request (dario#1066) ===');
{
  // Trailing empty after real text — the shape #1067's first half targeted.
  const { body } = buildCCRequest({
    model: 'claude-haiku-4-5-20251001', max_tokens: 32,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }, { type: 'text', text: '' }] },
    ],
  }, TAG, CC_CACHE_CONTROL, ID);
  applyCcPromptCaching(body, CC_CACHE_CONTROL);
  check('no empty text block survives the rebuild', emptyTextBlocks(body).length === 0);
  const lastUser = body.messages[body.messages.length - 1];
  check('the real text block of the turn is kept', lastUser.content.some((b) => b.text === 'q2'));
}
{
  // Whitespace-only counts as empty — upstream trims before validating.
  const { body } = buildCCRequest({
    model: 'claude-haiku-4-5-20251001', max_tokens: 32,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }, { type: 'text', text: '  \n ' }] },
    ],
  }, TAG, CC_CACHE_CONTROL, ID);
  check('whitespace-only text block is filtered', emptyTextBlocks(body).length === 0);
  check('the non-empty sibling survives', body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.text === 'q1')));
}

console.log('\n=== a MID-conversation user turn emptied by the filter is dropped ===');
{
  // The actual #1066 session-killer: the lone-empty turn sits in HISTORY, so
  // every later request carries it. Mid-conversation the API combines the
  // now-adjacent same-role turns, so dropping the message is safe.
  const { body } = buildCCRequest({
    model: 'claude-haiku-4-5-20251001', max_tokens: 32,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: [{ type: 'text', text: 'q3' }] },
    ],
  }, TAG, CC_CACHE_CONTROL, ID);
  applyCcPromptCaching(body, CC_CACHE_CONTROL);
  check('the emptied mid-history user turn is gone', !body.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.length === 0));
  check('surrounding turns survive in order', JSON.stringify(body.messages.map((m) => m.role)).includes('"user","assistant","assistant","user"'));
  check('no empty text block anywhere', emptyTextBlocks(body).length === 0);
}

console.log('\n=== the FINAL user turn is deliberately NOT dropped (dario#1033) ===');
{
  // Popping the final user turn would expose the assistant turn behind it and
  // convert an honest "content must contain at least one block" upstream
  // error into a misleading prefill rejection. Leave it; never stamp it.
  const { body } = buildCCRequest({
    model: 'claude-haiku-4-5-20251001', max_tokens: 32,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
    ],
  }, TAG, CC_CACHE_CONTROL, ID);
  applyCcPromptCaching(body, CC_CACHE_CONTROL);
  const last = body.messages[body.messages.length - 1];
  check('final emptied user turn is kept (as an empty-content turn)', last.role === 'user' && Array.isArray(last.content) && last.content.length === 0);
  check('nothing in that turn carries a breakpoint', !last.content.some((b) => b && b.cache_control));
  check('stamping fell through to an earlier turn', body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b && b.cache_control)));
}

console.log('\n=== non-text blocks are untouched ===');
{
  const { body } = buildCCRequest({
    model: 'claude-haiku-4-5-20251001', max_tokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'use the tool' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'calc', input: { expr: '2+2' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '4' }, { type: 'text', text: '' }] },
    ],
    tools: [{ name: 'calc', description: 'calc', input_schema: { type: 'object', properties: {} } }],
  }, TAG, CC_CACHE_CONTROL, ID);
  applyCcPromptCaching(body, CC_CACHE_CONTROL);
  const lastUser = body.messages[body.messages.length - 1];
  check('tool_result block survives', lastUser.content.some((b) => b.type === 'tool_result'));
  check('trailing empty text sibling is filtered', emptyTextBlocks(body).length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

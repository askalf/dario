#!/usr/bin/env node
/**
 * test/thinking-binding.mjs
 *
 * Thinking blocks and the seat that produced them: reading what a response
 * says the API left out of the request, deciding when a seat change is worth
 * a log line, and the history strip for clients whose thinking is not
 * forwarded.
 *
 * Imports dist/thinking-binding.js and dist/cc-template.js only. No proxy is
 * started and no network is used.
 */
import {
  thinkingDropsFrom, describeThinkingDrops, thinkingDropLogFields, thinkingDropsKey,
  historyCarriesThinking, seatMoveNote, OncePerKey,
} from '../dist/thinking-binding.js';
import { buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const dropped = (reason, path = 'messages.1.content.0') => ({ type: 'thinking_dropped', path, reason });

header('thinkingDropsFrom: where the field is absent');
{
  check('no holder', thinkingDropsFrom(undefined) === null && thinkingDropsFrom(null) === null);
  check('a holder that is not an object', thinkingDropsFrom('input_transformations') === null && thinkingDropsFrom(7) === null);
  check('a message without the field', thinkingDropsFrom({ id: 'msg_1', usage: {} }) === null);
  check('a field that is not a list', thinkingDropsFrom({ input_transformations: { type: 'thinking_dropped' } }) === null);
}

header('thinkingDropsFrom: counting');
{
  const none = thinkingDropsFrom({ input_transformations: [] });
  check('an empty list is a zero count, not an absent field', none !== null && none.total === 0 && Object.keys(none.byReason).length === 0, JSON.stringify(none));

  const mixed = thinkingDropsFrom({ input_transformations: [
    dropped('organization_binding_mismatch'),
    dropped('organization_binding_mismatch', 'messages.3.content.0'),
    dropped('prefix_binding_mismatch', 'messages.5.content.0'),
    { type: 'thinking_mismatch_allowed', path: 'messages.7.content.0', reason: 'prefix_binding_mismatch' },
    null, 'thinking_dropped', 4,
  ] });
  check('only thinking_dropped entries count', mixed.total === 3, JSON.stringify(mixed));
  check('counted by reason', mixed.byReason.organization_binding_mismatch === 2 && mixed.byReason.prefix_binding_mismatch === 1, JSON.stringify(mixed.byReason));
  check('reasons come back in a fixed order', JSON.stringify(Object.keys(mixed.byReason)) === JSON.stringify(['organization_binding_mismatch', 'prefix_binding_mismatch']));

  const odd = thinkingDropsFrom({ input_transformations: [
    { type: 'thinking_dropped' },
    { type: 'thinking_dropped', reason: 12 },
    { type: 'thinking_dropped', reason: 'has spaces and\nnewlines' },
    { type: 'thinking_dropped', reason: 'x'.repeat(65) },
    { type: 'thinking_dropped', reason: '__proto__' },
    { type: 'thinking_dropped', reason: 'constructor' },
  ] });
  check('a reason that is missing or not identifier-shaped counts as other', odd.byReason.other === 4, JSON.stringify(odd.byReason));
  check('a reason named like an object member is an ordinary key', Object.hasOwn(odd.byReason, '__proto__') && odd.byReason['__proto__'] === 1
    && Object.hasOwn(odd.byReason, 'constructor') && odd.byReason.constructor === 1, JSON.stringify(odd.byReason));
  check('every entry is in the total', odd.total === 6, String(odd.total));

  const many = thinkingDropsFrom({ input_transformations: Array.from({ length: 30 }, (_, i) => dropped(`reason_${String(i).padStart(2, '0')}`)) });
  check('distinct reasons are bounded, the total is not', Object.keys(many.byReason).length <= 9 && many.total === 30, `${Object.keys(many.byReason).length} reasons, total ${many.total}`);
  check('the overflow is counted under other', many.byReason.other === 22, JSON.stringify(many.byReason));
}

header('the console sentence, the log fields, the de-dup key');
{
  const one = thinkingDropsFrom({ input_transformations: [dropped('organization_binding_mismatch')] });
  const three = thinkingDropsFrom({ input_transformations: [dropped('organization_binding_mismatch'), dropped('organization_binding_mismatch'), dropped('model_binding_mismatch')] });
  const zero = thinkingDropsFrom({ input_transformations: [] });

  check('nothing left out says nothing', describeThinkingDrops(zero, 'work') === '' && describeThinkingDrops(null, 'work') === '');
  check('one block is singular and names the seat and the reason',
    describeThinkingDrops(one, 'work') === 'upstream left 1 thinking block out of this request on seat work (organization_binding_mismatch 1); the request was served without them',
    describeThinkingDrops(one, 'work'));
  check('several blocks list each reason with its count',
    describeThinkingDrops(three, undefined) === 'upstream left 3 thinking blocks out of this request (model_binding_mismatch 1, organization_binding_mismatch 2); the request was served without them',
    describeThinkingDrops(three, undefined));

  check('no log fields when nothing was left out', Object.keys(thinkingDropLogFields(zero)).length === 0 && Object.keys(thinkingDropLogFields(null)).length === 0);
  check('log fields carry the count and the reasons',
    JSON.stringify(thinkingDropLogFields(three)) === JSON.stringify({ thinking_dropped: 3, thinking_dropped_reasons: { model_binding_mismatch: 1, organization_binding_mismatch: 2 } }),
    JSON.stringify(thinkingDropLogFields(three)));

  const sameReasons = thinkingDropsFrom({ input_transformations: [dropped('model_binding_mismatch'), dropped('organization_binding_mismatch')] });
  check('the key ignores counts and entry order', thinkingDropsKey(three) === thinkingDropsKey(sameReasons), `${thinkingDropsKey(three)} vs ${thinkingDropsKey(sameReasons)}`);
  check('the key differs for a different set of reasons', thinkingDropsKey(three) !== thinkingDropsKey(one));
}

header('historyCarriesThinking');
{
  check('not a list', historyCarriesThinking(undefined) === false && historyCarriesThinking('x') === false);
  check('string content only', historyCarriesThinking([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]) === false);
  check('an assistant turn with a thinking block',
    historyCarriesThinking([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'hello' }] }]) === true);
  check('an assistant turn with a redacted_thinking block',
    historyCarriesThinking([{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'd' }] }]) === true);
  check('a user turn quoting a block of that type does not count',
    historyCarriesThinking([{ role: 'user', content: [{ type: 'thinking', thinking: 'pasted' }] }]) === false);
  check('malformed entries are skipped', historyCarriesThinking([null, 3, { role: 'assistant', content: [null, 'x', { type: 'text', text: 'a' }] }]) === false);
}

header('seatMoveNote');
{
  const move = { fromAlias: 'work', fromOrganization: 'org-a', toAlias: 'home', toOrganization: 'org-b', carriesThinking: true };
  const note = seatMoveNote(move);
  check('another organization, thinking forwarded: a line naming both seats',
    typeof note === 'string' && note.includes('from seat work to seat home') && note.includes('another organization'), String(note));
  check('the same seat is silent', seatMoveNote({ ...move, toAlias: 'work' }) === null);
  check('no thinking forwarded is silent', seatMoveNote({ ...move, carriesThinking: false }) === null);
  check('the same organization is silent', seatMoveNote({ ...move, toOrganization: 'org-a' }) === null);
  check('an organization not learned yet is not reported as a different one',
    seatMoveNote({ ...move, fromOrganization: undefined }) === null && seatMoveNote({ ...move, toOrganization: undefined }) === null);
}

header('OncePerKey');
{
  const once = new OncePerKey(3);
  check('first sighting says yes', once.first('a') === true);
  check('a repeat says no', once.first('a') === false);
  check('another key says yes', once.first('b') === true && once.first('c') === true);
  check('past the bound it starts over instead of growing', once.first('d') === true && once.first('a') === true);
}

header('history strip: a client whose thinking is not forwarded');
{
  const body = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'read the config' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'first', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'thinking', thinking: 'second', signature: 'sig-2' },
        { type: 'text', text: 'reading it' },
      ] },
      { role: 'user', content: 'go on' },
    ],
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'billing',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  const assistant = built.body.messages.find((m) => m.role === 'assistant');
  const types = assistant.content.map((b) => b.type);
  check('thinking blocks are gone', !types.includes('thinking'), types.join(','));
  check('redacted_thinking goes with them', !types.includes('redacted_thinking'), types.join(','));
  check('the text block stays', types.length === 1 && types[0] === 'text' && assistant.content[0].text === 'reading it', JSON.stringify(assistant.content));
  check('not treated as a genuine Claude Code body', built.genuineCC !== true);
}

header('history strip: a genuine Claude Code body keeps its thinking as sent');
{
  const thinkingTurn = [
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'reading it' },
  ];
  const body = {
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.177.abc; cc_entrypoint=cli;' },
      { type: 'text', text: 'You are Claude Code, a command line tool.' },
    ],
    tools: [],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read the config' }] },
      { role: 'assistant', content: thinkingTurn },
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
    ],
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
  };
  const built = buildCCRequest(
    JSON.parse(JSON.stringify(body)),
    'x-anthropic-billing-header: cc_version=2.1.177.abc; cc_entrypoint=cli;',
    { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    {},
  );
  check('recognised as a genuine Claude Code body', built.genuineCC === true);
  const assistant = built.body.messages.find((m) => m.role === 'assistant');
  check('every block of the thinking turn is forwarded unchanged', JSON.stringify(assistant.content) === JSON.stringify(thinkingTurn), JSON.stringify(assistant.content));
  check('the client thinking setting is forwarded unchanged', JSON.stringify(built.body.thinking) === JSON.stringify(body.thinking), JSON.stringify(built.body.thinking));
}

console.log(`\nthinking-binding: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

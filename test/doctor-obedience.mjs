#!/usr/bin/env node
// Client-system obedience probe — unit tests for the pure verdict helpers
// behind `dario doctor --obedience` (dario#509).
//
// The probe itself is live-only (it needs a running proxy and a real
// subscription); these tests pin the parts that decide PASS/FAIL so the
// 6-hourly doctor-watch never files a drift issue over a parsing quirk:
//   - isObedientReply: lenient on case + single trailing ./! (the drift
//     class is "client system prompt ignored entirely", not punctuation
//     sampling), strict on everything else.
//   - extractMessageText: text blocks only — thinking blocks excluded,
//     refusals (empty content) and malformed bodies yield ''.

import {
  isObedientReply,
  extractMessageText,
  OBEDIENCE_SYSTEM_PROMPT,
} from '../dist/doctor.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

header('1. isObedientReply — obedient shapes');
check('exact PONG', isObedientReply('PONG'));
check('lowercase pong', isObedientReply('pong'));
check('mixed case Pong', isObedientReply('Pong'));
check('surrounding whitespace', isObedientReply('  PONG\n'));
check('trailing period', isObedientReply('PONG.'));
check('trailing bang', isObedientReply('Pong!'));

header('2. isObedientReply — disobedient shapes');
check('empty string (refusal)', !isObedientReply(''));
check('whitespace only', !isObedientReply('   \n'));
check('PONG inside prose', !isObedientReply('The word is PONG'));
check('PONG with trailing prose', !isObedientReply('PONG — happy to help!'));
check('persona answer (the #509 failure mode)',
  !isObedientReply("I'm Claude Code, Anthropic's official CLI. How can I help?"));
check('doubled pongpong', !isObedientReply('pongpong'));
check('double punctuation', !isObedientReply('PONG!!'));
check('quoted "PONG"', !isObedientReply('"PONG"'));

header('3. extractMessageText — block extraction');
check('single text block', extractMessageText({
  content: [{ type: 'text', text: 'PONG' }],
}) === 'PONG');
check('joins multiple text blocks', extractMessageText({
  content: [{ type: 'text', text: 'PO' }, { type: 'text', text: 'NG' }],
}) === 'PONG');
check('thinking block excluded', extractMessageText({
  content: [
    { type: 'thinking', thinking: 'the user wants PONG only' },
    { type: 'text', text: 'PONG' },
  ],
}) === 'PONG');
check('tool_use block excluded', extractMessageText({
  content: [
    { type: 'tool_use', id: 'toolu_1', name: 'WebFetch', input: {} },
    { type: 'text', text: 'PONG' },
  ],
}) === 'PONG');
check('result is trimmed', extractMessageText({
  content: [{ type: 'text', text: '  PONG \n' }],
}) === 'PONG');

header('4. extractMessageText — degenerate bodies');
check('refusal (empty content) -> empty', extractMessageText({
  content: [], stop_reason: 'refusal',
}) === '');
check('missing content -> empty', extractMessageText({}) === '');
check('null body -> empty', extractMessageText(null) === '');
check('string body -> empty', extractMessageText('error page') === '');
check('content not an array -> empty', extractMessageText({ content: 'PONG' }) === '');
check('text block without string text -> empty', extractMessageText({
  content: [{ type: 'text', text: 42 }],
}) === '');

header('5. probe prompt invariants');
check('prompt names PONG exactly once',
  (OBEDIENCE_SYSTEM_PROMPT.match(/PONG/g) || []).length === 1);
check('prompt demands exclusivity', /ONLY/.test(OBEDIENCE_SYSTEM_PROMPT));
check('an obedient reply to the prompt passes the judge',
  isObedientReply('PONG'));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

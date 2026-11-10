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
  probeFamilies,
} from '../dist/doctor.js';
import { BAKED_BASE_MODELS, resolveAliasAgainst } from '../dist/model-catalog.js';

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

// The --usage and --obedience probes send to one model per family. The list
// was written out by hand and went stale: it probed Haiku 4.5, Sonnet 5 and
// Fable 5 while the family shorthands routed to Haiku 5.5, Sonnet 5.5 and
// Fable 5.2. It is now the newest model of each family in the bundled list.
header('6. probe models — the newest of each family in the bundled list');
{
  const bundled = probeFamilies(BAKED_BASE_MODELS);
  const modelOf = (list, family) => list.find((f) => f.family === family)?.model;
  check('the four families, in the order the rows print', bundled.map((f) => f.family).join(',') === 'haiku,sonnet,opus,fable', bundled.map((f) => f.family).join(','));
  for (const { family, model } of bundled) {
    check(`${family}: probes what the \`${family}\` shorthand routes to (${model})`, model === resolveAliasAgainst(family, BAKED_BASE_MODELS));
    check(`${family}: a base model, no context tag`, BAKED_BASE_MODELS.includes(model) && !model.includes('['));
  }
  check('with the list as bundled today: Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.2',
    modelOf(bundled, 'haiku') === 'claude-haiku-5-5' && modelOf(bundled, 'sonnet') === 'claude-sonnet-5-5'
    && modelOf(bundled, 'opus') === 'claude-opus-5-5' && modelOf(bundled, 'fable') === 'claude-fable-5-2',
    JSON.stringify(bundled));

  const next = probeFamilies(['claude-haiku-5-5', 'claude-haiku-6', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-10']);
  check('a newer model added to the list is probed with no edit here', modelOf(next, 'haiku') === 'claude-haiku-6');
  check('versions compare as numbers: 5.10 is newer than 5.2', modelOf(next, 'fable') === 'claude-fable-5-10');
  check('a [1m] id is never the probe model', modelOf(probeFamilies(['claude-opus-5-5', 'claude-opus-6[1m]']), 'opus') === 'claude-opus-5-5');

  const partial = probeFamilies(['claude-sonnet-5-5', 'claude-opus-5-5']);
  check('a family the list holds no model for is left out', partial.map((f) => f.family).join(',') === 'sonnet,opus', JSON.stringify(partial));
  check('an empty list probes nothing', probeFamilies([]).length === 0);

  // With no list given, suspended families are dropped (DARIO_SUSPENDED_MODELS).
  const saved = process.env.DARIO_SUSPENDED_MODELS;
  try {
    process.env.DARIO_SUSPENDED_MODELS = 'fable';
    check('a suspended family is not probed', probeFamilies().map((f) => f.family).join(',') === 'haiku,sonnet,opus', JSON.stringify(probeFamilies()));
    process.env.DARIO_SUSPENDED_MODELS = '';
    check('with none suspended, all four are', probeFamilies().length === 4);
  } finally {
    if (saved === undefined) delete process.env.DARIO_SUSPENDED_MODELS; else process.env.DARIO_SUSPENDED_MODELS = saved;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

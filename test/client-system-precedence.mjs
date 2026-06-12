#!/usr/bin/env node
// Client system-prompt precedence framing — regression test for the
// 2026-06-12 deepdive planner outage.
//
// dario merges the API client's `system` text into block 3 of the outbound
// CC-shaped system array, after CC's persona prompt. A bare `\n\n` append
// silently stopped steering claude-sonnet-4-6 (the model followed the CC
// persona and ignored the appended client instructions — deterministically,
// while haiku obeyed the identical merged body). The fix frames the client
// text with an explicit override preamble (CLIENT_SYSTEM_PREFACE), which
// restored sonnet obedience 0/6 → 6/6 in live probes.
//
// These tests pin the merge structure: preface present exactly when client
// system text exists, client text intact and AFTER the preface, base prompt
// untouched when no client system is supplied.

import { buildCCRequest, CLIENT_SYSTEM_PREFACE, CC_SYSTEM_PROMPT } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const IDENTITY = { deviceId: 'dev-test', accountUuid: 'acct-test', sessionId: 'sess-test' };
const CACHE = { type: 'ephemeral' };
const BILLING = 'x-anthropic-billing-header: test';

function build(clientBody) {
  return buildCCRequest(clientBody, BILLING, CACHE, IDENTITY, {}).body;
}

function block3(body) {
  return body.system?.[2]?.text ?? '';
}

const CLIENT_SYSTEM = 'You are a research planner. Output FORMAT (strict): one JSON object, no prose.';

header('1. string-form client system gets the precedence preface');
{
  const body = build({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    system: CLIENT_SYSTEM,
    messages: [{ role: 'user', content: 'q' }],
  });
  const text = block3(body);
  check('preface present', text.includes(CLIENT_SYSTEM_PREFACE));
  check('client text present and intact', text.includes(CLIENT_SYSTEM));
  check('client text comes AFTER the preface',
    text.indexOf(CLIENT_SYSTEM) > text.indexOf(CLIENT_SYSTEM_PREFACE));
  check('preface comes AFTER the base persona prompt',
    text.indexOf(CLIENT_SYSTEM_PREFACE) > 0);
  check('exactly one preface occurrence',
    text.split(CLIENT_SYSTEM_PREFACE).length === 2);
}

header('2. array-form client system merges the same way');
{
  const body = build({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    system: [
      { type: 'text', text: 'First client block.' },
      { type: 'text', text: 'Second client block.' },
    ],
    messages: [{ role: 'user', content: 'q' }],
  });
  const text = block3(body);
  check('preface present for array form', text.includes(CLIENT_SYSTEM_PREFACE));
  check('both client blocks present',
    text.includes('First client block.') && text.includes('Second client block.'));
}

header('3. no client system → no preface, base prompt byte-identical');
{
  const body = build({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'q' }],
  });
  const text = block3(body);
  check('no preface injected', !text.includes(CLIENT_SYSTEM_PREFACE));
  check('block 3 ends with the unmodified base prompt', text === CC_SYSTEM_PROMPT);
}

header('4. haiku path gets the same merge');
{
  const body = build({
    model: 'claude-haiku-4-5',
    max_tokens: 100,
    system: CLIENT_SYSTEM,
    messages: [{ role: 'user', content: 'q' }],
  });
  const text = block3(body);
  check('haiku: preface present', text.includes(CLIENT_SYSTEM_PREFACE));
  check('haiku: client text present', text.includes(CLIENT_SYSTEM));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

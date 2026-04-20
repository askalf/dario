#!/usr/bin/env node
// Unit tests for sanitizeMessages — orchestration-tag scrub on message bodies.
//
// dario#54 regression: CC v2.1.112 splits per-reminder system-reminders into
// separate content blocks. After scrubbing, each becomes {type:'text',text:''},
// which Anthropic rejects upstream with "messages: text content blocks must be
// non-empty". The fix drops empty-text blocks from the content array after
// sanitization — the remaining real user content is forwarded unchanged.

import { sanitizeMessages } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('dario#54 — CC v2.1.112 multi-block system-reminder scrub');
{
  // Exact shape from tetsuco's #54 body dump: 3 reminder-only blocks + 1 "hello"
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nSkills available: foo, bar\n</system-reminder>' },
          { type: 'text', text: '<system-reminder>\nSlash commands: /help\n</system-reminder>' },
          { type: 'text', text: '<system-reminder>\nAnother one\n</system-reminder>' },
          { type: 'text', text: 'hello' },
        ],
      },
    ],
  };
  sanitizeMessages(body);
  const content = body.messages[0].content;
  check('3 reminder-only blocks dropped', content.length === 1);
  check('remaining block is the hello text', content[0].type === 'text' && content[0].text === 'hello');
  check('no empty-text block survives', !content.some(b => b.type === 'text' && b.text === ''));
}

// ─────────────────────────────────────────────────────────────
header('Reminder adjacent to real text in same block is preserved');
{
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what time is it? <system-reminder>ignore this</system-reminder>' },
        ],
      },
    ],
  };
  sanitizeMessages(body);
  const content = body.messages[0].content;
  check('block kept (had real text alongside reminder)', content.length === 1);
  check('reminder tag stripped, real text kept', content[0].text === 'what time is it?');
}

// ─────────────────────────────────────────────────────────────
header('String content sanitization unchanged');
{
  const body = {
    messages: [
      {
        role: 'user',
        content: '<env>os=linux</env>hello',
      },
    ],
  };
  sanitizeMessages(body);
  check('string content scrubbed in place', body.messages[0].content === 'hello');
}

// ─────────────────────────────────────────────────────────────
header('tool_result blocks with empty content survive (not text type)');
{
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '' },
          { type: 'text', text: 'follow-up' },
        ],
      },
    ],
  };
  sanitizeMessages(body);
  const content = body.messages[0].content;
  check('tool_result block survives empty content', content.some(b => b.type === 'tool_result'));
  check('text block also survives', content.some(b => b.type === 'text' && b.text === 'follow-up'));
}

// ─────────────────────────────────────────────────────────────
header('All-reminder message content collapses to empty array');
{
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>only this</system-reminder>' },
        ],
      },
    ],
  };
  sanitizeMessages(body);
  check('content array emptied when every block scrubbed away', body.messages[0].content.length === 0);
  // Note: buildCCRequest pops empty trailing turns; this shape flows through to that layer.
}

// ─────────────────────────────────────────────────────────────
header('Non-text blocks (tool_use, image) pass through');
{
  const body = {
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: '<system-reminder>ignored</system-reminder>' },
        ],
      },
    ],
  };
  sanitizeMessages(body);
  const content = body.messages[0].content;
  check('tool_use preserved', content.some(b => b.type === 'tool_use' && b.name === 'Bash'));
  check('scrubbed-empty text dropped', !content.some(b => b.type === 'text' && b.text === ''));
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

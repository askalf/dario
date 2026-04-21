#!/usr/bin/env node
// Unit tests for sanitizeMessages — orchestration-tag scrub on message bodies.
//
// dario#54 regression: CC v2.1.112 splits per-reminder system-reminders into
// separate content blocks. After scrubbing, each becomes {type:'text',text:''},
// which Anthropic rejects upstream with "messages: text content blocks must be
// non-empty". The fix drops empty-text blocks from the content array after
// sanitization — the remaining real user content is forwarded unchanged.

import { sanitizeMessages, buildOrchestrationPatterns, ORCHESTRATION_TAG_NAMES } from '../dist/proxy.js';
import { resolvePreserveOrchestrationTags } from '../dist/cli.js';

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
header('dario#78 — preserveTags opt-out: preserve all (Set(["*"]))');
{
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>keep me</system-reminder>' },
        { type: 'text', text: '<thinking>and me</thinking>' },
        { type: 'text', text: 'ok' },
      ],
    }],
  };
  sanitizeMessages(body, new Set(['*']));
  const content = body.messages[0].content;
  check('preserve-all keeps all 3 blocks', content.length === 3);
  check('system-reminder tag survives', content[0].text.includes('<system-reminder>keep me</system-reminder>'));
  check('thinking tag survives', content[1].text.includes('<thinking>and me</thinking>'));
  check('plain text survives', content[2].text === 'ok');
}

header('dario#78 — preserveTags opt-out: preserve one tag (Set(["thinking"]))');
{
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>strip me</system-reminder><thinking>keep me</thinking>' },
        { type: 'text', text: 'ok' },
      ],
    }],
  };
  sanitizeMessages(body, new Set(['thinking']));
  const content = body.messages[0].content;
  check('2 blocks retained (partial scrub left content in the first)', content.length === 2);
  check('system-reminder still stripped', !content[0].text.includes('<system-reminder>'));
  check('thinking preserved', content[0].text.includes('<thinking>keep me</thinking>'));
  check('plain text untouched', content[1].text === 'ok');
}

header('dario#78 — preserveTags undefined behaves identically to default');
{
  const body1 = { messages: [{ role: 'user', content: [{ type: 'text', text: '<env>a</env>hi' }] }] };
  const body2 = { messages: [{ role: 'user', content: [{ type: 'text', text: '<env>a</env>hi' }] }] };
  sanitizeMessages(body1);
  sanitizeMessages(body2, undefined);
  check('undefined === default — same output', JSON.stringify(body1) === JSON.stringify(body2));
}

header('dario#78 — buildOrchestrationPatterns shape');
{
  const allPatterns = buildOrchestrationPatterns();
  check('default patterns = 2 per tag', allPatterns.length === ORCHESTRATION_TAG_NAMES.length * 2);
  const preserveAllPatterns = buildOrchestrationPatterns(new Set(['*']));
  check('preserve all → 0 patterns', preserveAllPatterns.length === 0);
  const preserveTwoPatterns = buildOrchestrationPatterns(new Set(['thinking', 'env']));
  check('preserve 2 → (total - 2) * 2 patterns', preserveTwoPatterns.length === (ORCHESTRATION_TAG_NAMES.length - 2) * 2);
}

header('dario#78 — resolvePreserveOrchestrationTags parses CLI + env');
{
  check('no flag, no env → undefined',
    resolvePreserveOrchestrationTags([], undefined) === undefined);
  const bare = resolvePreserveOrchestrationTags(['--preserve-orchestration-tags'], undefined);
  check('bare flag → Set(["*"])', bare instanceof Set && bare.has('*') && bare.size === 1);
  const valued = resolvePreserveOrchestrationTags(['--preserve-orchestration-tags=thinking,env'], undefined);
  check('flag=list → Set of listed tags', valued instanceof Set && valued.has('thinking') && valued.has('env') && valued.size === 2);
  const envAll = resolvePreserveOrchestrationTags([], '*');
  check('env "*" → Set(["*"])', envAll instanceof Set && envAll.has('*') && envAll.size === 1);
  const envList = resolvePreserveOrchestrationTags([], 'thinking,env');
  check('env list → Set of listed tags', envList instanceof Set && envList.has('thinking') && envList.size === 2);
  const flagWinsOverEnv = resolvePreserveOrchestrationTags(['--preserve-orchestration-tags=thinking'], 'env');
  check('explicit flag wins over env', flagWinsOverEnv instanceof Set && flagWinsOverEnv.has('thinking') && !flagWinsOverEnv.has('env'));
  const whitespaceTolerant = resolvePreserveOrchestrationTags(['--preserve-orchestration-tags= thinking , env '], undefined);
  check('value whitespace trimmed', whitespaceTolerant.has('thinking') && whitespaceTolerant.has('env') && whitespaceTolerant.size === 2);
  const emptyValue = resolvePreserveOrchestrationTags(['--preserve-orchestration-tags='], undefined);
  check('empty value treated as "*"', emptyValue instanceof Set && emptyValue.has('*'));
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

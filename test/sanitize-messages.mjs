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
  // Pre-#744 this asserted `content.length === 0` and relied on downstream
  // layers to cope — but a NON-trailing empty message reached the upstream as
  // content:[] and 400'd ("must contain at least one block"). The contract is
  // now: a message emptied entirely by the scrub is dropped here.
  check('message emptied by the scrub is dropped, not sent as content:[]', body.messages.length === 0);
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
// dario#744 - a message that is NOTHING but orchestration tags must be
// DROPPED, not left as content:[] (upstream 400 "must contain at least one
// block"). Trigger shape: mid-session /model switch injects a standalone
// role:"system" <system-reminder> turn (CC 2.1.209, mid-conversation-system).
{
  const body = { messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'system', content: [{ type: 'text', text: '<system-reminder>The user selected the model claude-sonnet-5.</system-reminder>' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>note</system-reminder>' }, { type: 'text', text: 'real question' }] },
  ] };
  sanitizeMessages(body);
  check('all-orchestration system message is dropped entirely (#744)',
    body.messages.length === 2 && body.messages.every(m => !Array.isArray(m.content) || m.content.length > 0));
  check('mixed message keeps its real block (#744)',
    Array.isArray(body.messages[1].content) && body.messages[1].content.length === 1 && body.messages[1].content[0].text === 'real question');
}
{
  const body = { messages: [
    { role: 'user', content: '<system-reminder>only tags</system-reminder>' },
    { role: 'user', content: [{ type: 'text', text: 'kept' }] },
  ] };
  sanitizeMessages(body);
  check('string content scrubbed to empty drops the message too (#744)',
    body.messages.length === 1 && body.messages[0].content[0].text === 'kept');
}
{
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ] };
  sanitizeMessages(body);
  check('tool_use/tool_result messages untouched by the drop (#744)', body.messages.length === 2);
}
{
  const body = { messages: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] },
  ] };
  sanitizeMessages(body, new Set(['system-reminder']));
  check('preserved tag -> message survives intact (#744)',
    body.messages.length === 1 && body.messages[0].content[0].text.includes('system-reminder'));
}

// ─────────────────────────────────────────────────────────────
header('no-`<` fast path — output identical to the full regex loop');
{
  // sanitizeContent skips the ~28 orchestration-tag passes when the text has
  // no `<` (every pattern is anchored on one). The skip must be a pure
  // optimization: re-derive the pre-guard behavior (loop always runs) and
  // assert byte-for-byte parity across tag-free AND tag-bearing inputs.
  const patterns = buildOrchestrationPatterns();
  const loopThenNormalize = (text) => {
    let r = text;
    for (const p of patterns) { p.lastIndex = 0; r = r.replace(p, ''); }
    return r.replace(/\n{3,}/g, '\n\n').trim();
  };
  const samples = [
    'plain prose with no angle brackets at all',
    '  leading and trailing whitespace, three\n\n\nblank lines collapse  ',
    'code with generics: Array<Item> and a comparison a < b > c',
    'line1\n\n\n\nline2\n\n\n\nline3',
    '<system-reminder>drop me</system-reminder>keep',
    'text before <env>x</env> and after',
    '', // empty string
  ];
  // Drive the real code path through sanitizeMessages (string content) so the
  // guard inside sanitizeContent is what actually runs.
  let allMatch = true;
  const mismatches = [];
  for (const s of samples) {
    const body = { messages: [{ role: 'user', content: s }] };
    sanitizeMessages(body);
    const viaGuarded = body.messages.length ? body.messages[0].content : '';
    const expected = loopThenNormalize(s);
    // sanitizeMessages drops a message whose string content emptied to '';
    // account for that when the expected result is empty.
    const got = expected === '' ? '' : viaGuarded;
    if (got !== expected) { allMatch = false; mismatches.push(`${JSON.stringify(s)} -> ${JSON.stringify(got)} != ${JSON.stringify(expected)}`); }
  }
  check('guarded fast path is byte-identical to the unconditional loop', allMatch);
  if (!allMatch) for (const m of mismatches) console.log(`     ${m}`);

  // A tag-free block with interior '<' from generics must still be preserved
  // verbatim (the guard runs the loop because a '<' is present, and no pattern
  // matches a bare comparison).
  const codeBody = { messages: [{ role: 'user', content: 'const x: Map<string, number> = new Map(); if (a < b) {}' }] };
  sanitizeMessages(codeBody);
  check('tag-free code with `<` is preserved verbatim',
    codeBody.messages[0].content === 'const x: Map<string, number> = new Map(); if (a < b) {}');
}

// -------------------------------------------------------------
header('dario#1033 - the scrub must not leave a trailing assistant turn (prefill 400)');
{
  // CC emits standalone <system-reminder> / <task_metadata> user turns, notably
  // right after a Task (sub-agent) result is folded back into the transcript.
  // Both tags are scrubbed, so the turn empties, the drop-empty-messages filter
  // removes it, and the request goes out ending on the ASSISTANT turn. Anthropic
  // reads that as a prefill and Opus 4.6 under adaptive thinking + the
  // claude-code beta rejects it:
  //   400 "This model does not support assistant message prefill.
  //        The conversation must end with a user message."
  const lastRole = (b) => b.messages[b.messages.length - 1]?.role;

  {
    const body = { messages: [
      { role: 'user', content: [{ type: 'text', text: 'run the audit sub-agent' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Audit complete: 3 findings.' }] },
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>The Task tool has returned.</system-reminder>' }] },
    ]};
    sanitizeMessages(body);
    check('array content: trailing user turn survives the scrub', body.messages.length === 3);
    check('array content: request still ends on a user turn', lastRole(body) === 'user');
  }

  {
    const body = { messages: [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: '<system-reminder>note</system-reminder>' },
    ]};
    sanitizeMessages(body);
    check('string content: trailing user turn survives the scrub', body.messages.length === 3);
    check('string content: request still ends on a user turn', lastRole(body) === 'user');
  }

  {
    // task_metadata is the other tag CC wraps sub-agent bookkeeping in.
    const body = { messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: '<task_metadata>subagent=explore</task_metadata>' }] },
    ]};
    sanitizeMessages(body);
    check('task_metadata-only trailing turn survives', lastRole(body) === 'user');
  }

  {
    // The guard is positional: an emptied user turn in the MIDDLE is still
    // dropped exactly as before - only the tail is protected.
    const body = { messages: [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>mid</system-reminder>' }] },
      { role: 'user', content: [{ type: 'text', text: 'the real prompt' }] },
    ]};
    sanitizeMessages(body);
    check('interior emptied turn is still dropped', body.messages.length === 1);
    check('interior drop keeps the real prompt', body.messages[0].content[0].text === 'the real prompt');
  }

  {
    // Unaffected control: a trailing user turn carrying real text alongside the
    // reminder scrubs normally and keeps only the real text.
    const body = { messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>keep going' }] },
    ]};
    sanitizeMessages(body);
    check('control: reminder stripped from a turn with real text',
      body.messages[2].content[0].text === 'keep going');
    check('control: still ends on a user turn', lastRole(body) === 'user');
  }

  {
    // A trailing ASSISTANT turn that empties is NOT resurrected - the guard
    // only protects user turns, so #36's behaviour is untouched.
    const body = { messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: '<thinking>hmm</thinking>' }] },
    ]};
    sanitizeMessages(body);
    check('emptied trailing assistant turn is still dropped', body.messages.length === 1);
    check('and the request ends on the user turn', lastRole(body) === 'user');
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

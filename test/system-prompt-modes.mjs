// Unit tests for resolveSystemPrompt and the constraint strip behind it
// (cc-template.ts). Pure over the shipped template: no I/O, no upstream
// calls.
//
// CC sends a different system prompt per model family and each words its
// behavioral constraints differently. PROMPTS records which constraint
// phrasings each bundled prompt carries, and the checks assert that:
//   - the record matches the bundle, so a rebake that adds, drops or
//     rewords a constraint fails here instead of turning partial into a
//     silent no-op (the v4.8.x rebake bug; the 2.1.316 rebake dropped the
//     base prompt's comment line the same way)
//   - partial removes every carried constraint and keeps the refusal
//     reminder, the caution guidance and the neutral lines around it
//   - a prompt that carries none comes back from partial unchanged
//   - after partial, no line of any bundled prompt mentions comments, which
//     catches a new comment rule in a wording this record does not know
//   - aggressive also removes the refusal reminder and caution guidance
//   - any other string is used as the literal system prompt (the file-path
//     escape hatch: the CLI resolves the path, this layer gets the text)
//
// When the record check fails after a rebake, teach the strip in
// src/cc-template.ts the new wording first, then update PROMPTS.

import {
  resolveSystemPrompt, CC_SYSTEM_PROMPT,
  CC_SYSTEM_PROMPT_FABLE, CC_SYSTEM_PROMPT_OPUS5, CC_SYSTEM_PROMPT_SONNET5,
} from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// Every constraint phrasing the partial strip targets.
const CONSTRAINTS = {
  'compact comment line': 'Write code that reads like the surrounding code',
  'fable comment line': 'Only write a code comment to state a constraint',
  'Tone and style section': '# Tone and style',
  'Text output section': '# Text output',
  'scope bullet': " - Don't add features, refactor, or introduce abstractions",
  'error-handling bullet': " - Don't add error handling, fallbacks, or validation",
  'no-comments bullet': ' - Default to writing no comments.',
  'explain-what bullet': " - Don't explain WHAT the code does",
  'exploratory bullet': ' - For exploratory questions',
  'back-compat bullet': ' - Avoid backwards-compatibility hacks',
};
const POSITIVE = 'Be thorough. Show your reasoning.';
const ALIGNMENT = [
  'IMPORTANT: Assist with authorized security testing',
  'IMPORTANT: You must NEVER generate or guess URLs',
  '# Executing actions with care',
  'For actions that are hard to reverse or outward-facing',
];
const SECTIONS = ['# Tone and style', '# Text output'];

// `keeps` are neutral lines next to a stripped constraint; partial must not
// take them with it.
const PROMPTS = [
  { name: 'base', model: undefined, text: CC_SYSTEM_PROMPT, carries: [], keeps: ['# Harness'] },
  { name: 'fable', model: 'claude-fable-5', text: CC_SYSTEM_PROMPT_FABLE,
    carries: ['fable comment line'],
    keeps: ['# Communicating with the user', 'Match the response to the question:'] },
  { name: 'opus-5', model: 'claude-opus-5', text: CC_SYSTEM_PROMPT_OPUS5, carries: [], keeps: ['# Delivering work'] },
  { name: 'sonnet-5', model: 'claude-sonnet-5', text: CC_SYSTEM_PROMPT_SONNET5,
    carries: [
      'Tone and style section', 'Text output section',
      'scope bullet', 'error-handling bullet', 'no-comments bullet',
      'explain-what bullet', 'exploratory bullet', 'back-compat bullet',
    ],
    keeps: [
      ' - Prefer editing existing files to creating new ones.',
      ' - For UI or frontend changes',
      ' - If the user asks for help or wants to give feedback',
      '  - /help: Get help with using Claude Code',
      '# Using your tools',
      '# Session-specific guidance',
    ] },
];

/** The non-empty body lines of the `# heading` section in `text`. */
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return [];
  const body = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('# '); i++) {
    if (lines[i].trim()) body.push(lines[i]);
  }
  return body;
}

// ======================================================================
//  default / verbatim: return CC unchanged
// ======================================================================
header('verbatim mode');
{
  check('undefined returns CC verbatim', resolveSystemPrompt(undefined) === CC_SYSTEM_PROMPT);
  check("'' returns CC verbatim", resolveSystemPrompt('') === CC_SYSTEM_PROMPT);
  check("'verbatim' returns CC verbatim", resolveSystemPrompt('verbatim') === CC_SYSTEM_PROMPT);
  for (const p of PROMPTS) {
    check(`${p.name}: 'verbatim' returns the prompt CC sends that model`, resolveSystemPrompt('verbatim', p.model) === p.text);
  }
  const texts = new Set(PROMPTS.map((p) => p.text));
  check('the bundle carries a distinct prompt for every family checked here', texts.size === PROMPTS.length);
}

// ======================================================================
//  record: which bundled prompt carries which constraint
// ======================================================================
header('constraint record matches the bundle');
{
  for (const p of PROMPTS) {
    const found = Object.keys(CONSTRAINTS).filter((k) => p.text.includes(CONSTRAINTS[k]));
    const want = [...p.carries].sort().join(', ') || 'none';
    const got = [...found].sort().join(', ') || 'none';
    check(`${p.name}: carries [${want}] (bundle has [${got}])`, want === got);
  }
  check('at least one bundled prompt carries a constraint (partial is not a no-op everywhere)',
    PROMPTS.some((p) => p.carries.length > 0));
}

// ======================================================================
//  partial: strip the behavioral constraints, keep alignment and tools
// ======================================================================
header('partial mode');
for (const p of PROMPTS) {
  const partial = resolveSystemPrompt('partial', p.model);
  if (p.carries.length === 0) {
    check(`${p.name}: carries no constraint, so partial sends it unchanged`, partial === p.text);
    continue;
  }
  check(`${p.name}: partial differs from verbatim (strip actually fired)`, partial !== p.text);
  for (const k of p.carries) {
    check(`${p.name}: partial removes the ${k}`, !partial.includes(CONSTRAINTS[k]));
  }
  for (const h of SECTIONS.filter((h) => p.text.includes(h))) {
    const left = sectionBody(p.text, h).filter((l) => partial.split('\n').includes(l));
    check(`${p.name}: partial removes the body of ${h}, not just the heading (${left.length} lines left)`, left.length === 0);
  }
  check(`${p.name}: partial inserts the positive replacement instruction`, partial.includes(POSITIVE));
  for (const a of ALIGNMENT.filter((a) => p.text.includes(a))) {
    check(`${p.name}: partial keeps "${a}"`, partial.includes(a));
  }
  for (const k of p.keeps) {
    check(`${p.name}: partial keeps "${k.trim()}"`, partial.includes(k));
  }
}
{
  // A comment rule the record does not know yet. Fails on any surviving
  // line that mentions comments, so the next rewording is a loud failure.
  for (const p of PROMPTS) {
    const left = resolveSystemPrompt('partial', p.model).split('\n').filter((l) => /\bcomments?\b/i.test(l));
    check(`${p.name}: no line mentions comments after partial${left.length ? `: ${left[0].slice(0, 80)}` : ''}`, left.length === 0);
  }
}

// ======================================================================
//  aggressive: partial + strip prompt-level RLHF restatement + caution
// ======================================================================
header('aggressive mode');
for (const p of PROMPTS) {
  const partial = resolveSystemPrompt('partial', p.model);
  const aggressive = resolveSystemPrompt('aggressive', p.model);
  const targets = ALIGNMENT.filter((a) => p.text.includes(a));

  check(`${p.name}: carries at least one aggressive target`, targets.length > 0);
  check(`${p.name}: aggressive is shorter than partial`, aggressive.length < partial.length);
  for (const a of targets) {
    check(`${p.name}: aggressive removes "${a}"`, !aggressive.includes(a));
  }
  if (p.text.includes('# Executing actions with care')) {
    const left = sectionBody(p.text, '# Executing actions with care').filter((l) => aggressive.split('\n').includes(l));
    check(`${p.name}: aggressive removes the body of # Executing actions with care (${left.length} lines left)`, left.length === 0);
  }
  for (const k of p.carries) {
    check(`${p.name}: aggressive also removes the ${k}`, !aggressive.includes(CONSTRAINTS[k]));
  }
  for (const k of p.keeps) {
    check(`${p.name}: aggressive keeps "${k.trim()}"`, aggressive.includes(k));
  }
}

// ======================================================================
//  custom text: file-path mode passes literal string
// ======================================================================
header('custom literal text');
{
  const literal = 'You are a terse assistant. Be direct.';
  check('returns the literal string when given non-keyword input',
    resolveSystemPrompt(literal) === literal);

  const longText = 'x'.repeat(50000);
  check('handles long literal text', resolveSystemPrompt(longText) === longText);

  // Only the exact keyword strings ('verbatim', 'partial', 'aggressive')
  // take the special path. Anything else is literal.
  check("'verbatim ' (trailing space) is treated as literal text",
    resolveSystemPrompt('verbatim ') === 'verbatim ');
  check("'PARTIAL' (uppercase) is treated as literal text",
    resolveSystemPrompt('PARTIAL') === 'PARTIAL');
  check('a literal prompt wins over the model variant',
    resolveSystemPrompt(literal, 'claude-sonnet-5') === literal);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`======================================================================`);
process.exit(fail === 0 ? 0 : 1);

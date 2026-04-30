// Unit tests for resolveSystemPrompt + the constraint-stripping helper
// behind it (cc-template.ts, v3.34.0).
//
// Pure decision function over its input — no I/O, no upstream calls. We
// import the real CC system prompt from the shipped template and assert
// that:
//   - undefined / 'verbatim' returns CC unchanged
//   - 'partial' removes "# Tone and style" + "# Text output" sections
//     and the scope/verbosity/comment bullets in "# Doing tasks", AND
//     leaves IMPORTANT: refusal lines + tool descriptions intact
//   - 'aggressive' additionally removes the prompt-level RLHF
//     restatements + the "# Executing actions with care" section
//   - any other string is used verbatim as the literal system prompt
//     (the file-path escape hatch — CLI resolves the path; this layer
//     just gets the loaded text)
//
// These regressions catch the case where a future CC bump renames
// section headers and the strip silently degrades to verbatim.

import { resolveSystemPrompt, CC_SYSTEM_PROMPT } from '../dist/cc-template.js';

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

// ======================================================================
//  default / verbatim — return CC unchanged
// ======================================================================
header('verbatim mode');
{
  check('undefined returns CC verbatim', resolveSystemPrompt(undefined) === CC_SYSTEM_PROMPT);
  check("'' returns CC verbatim", resolveSystemPrompt('') === CC_SYSTEM_PROMPT);
  check("'verbatim' returns CC verbatim", resolveSystemPrompt('verbatim') === CC_SYSTEM_PROMPT);
}

// ======================================================================
//  partial — strip behavioral constraints, keep alignment & tools
// ======================================================================
header('partial mode');
{
  const partial = resolveSystemPrompt('partial');

  check('partial differs from CC', partial !== CC_SYSTEM_PROMPT);
  check('partial is shorter than CC', partial.length < CC_SYSTEM_PROMPT.length);
  check('partial removes "# Tone and style" section header',
    !partial.includes('# Tone and style'));
  check('partial removes "# Text output" section header',
    !partial.includes('# Text output'));
  check('partial replaces "Default to writing no comments." line',
    !partial.includes('Default to writing no comments.'));
  check('partial keeps "# Doing tasks" header',
    partial.includes('# Doing tasks'));
  check('partial keeps the IMPORTANT: refusal reminders intact (alignment-shaped lines)',
    partial.includes('IMPORTANT: Assist with authorized security testing')
      && partial.includes('IMPORTANT: You must NEVER generate or guess URLs'));
  check('partial keeps "# Executing actions with care" intact',
    partial.includes('# Executing actions with care'));
  check('partial inserts the positive replacement instruction',
    partial.includes('Be thorough. Show your reasoning.'));

  // Sanity: partial output isn't a regex-misfire collapsed string. Any
  // CC bump that loses these section headers should fail this loud
  // rather than silently produce a verbatim-shaped output.
  check('partial removed at least 500 chars vs CC',
    CC_SYSTEM_PROMPT.length - partial.length >= 500);
}

// ======================================================================
//  aggressive — partial + strip prompt-level RLHF restatements
// ======================================================================
header('aggressive mode');
{
  const partial = resolveSystemPrompt('partial');
  const aggressive = resolveSystemPrompt('aggressive');

  check('aggressive differs from CC', aggressive !== CC_SYSTEM_PROMPT);
  check('aggressive is shorter than partial', aggressive.length < partial.length);
  check('aggressive removes "IMPORTANT: Assist with authorized security testing"',
    !aggressive.includes('IMPORTANT: Assist with authorized security testing'));
  check('aggressive removes "IMPORTANT: You must NEVER generate or guess URLs"',
    !aggressive.includes('IMPORTANT: You must NEVER generate or guess URLs'));
  check('aggressive removes "# Executing actions with care" section',
    !aggressive.includes('# Executing actions with care'));
  check('aggressive still keeps "# Doing tasks" header',
    aggressive.includes('# Doing tasks'));
}

// ======================================================================
//  custom text — file-path mode passes literal string
// ======================================================================
header('custom literal text');
{
  const literal = 'You are a terse assistant. Be direct.';
  check('returns the literal string when given non-keyword input',
    resolveSystemPrompt(literal) === literal);

  const longText = 'x'.repeat(50000);
  check('handles long literal text', resolveSystemPrompt(longText) === longText);

  // Edge: a literal that looks like a keyword but isn't — only the
  // exact keyword strings ('verbatim', 'partial', 'aggressive') trigger
  // the special path. Anything else is literal.
  check("'verbatim ' (trailing space) is treated as literal text",
    resolveSystemPrompt('verbatim ') === 'verbatim ');
  check("'PARTIAL' (uppercase) is treated as literal text",
    resolveSystemPrompt('PARTIAL') === 'PARTIAL');
}

// ======================================================================
//  invariant: 'aggressive' adds <3% practical reduction over 'partial'
// ======================================================================
//  This is the load-bearing claim from docs/research/system-prompt.md —
//  the aggressive strip's RLHF-restatement removal is decorative because
//  alignment is RLHF-trained, not prompt-trained. The size delta
//  partial → aggressive should be small relative to verbatim → partial.
header('partial → aggressive delta is small (alignment is in the weights)');
{
  const partial = resolveSystemPrompt('partial');
  const aggressive = resolveSystemPrompt('aggressive');
  const verbatim = CC_SYSTEM_PROMPT;
  const partialDrop = verbatim.length - partial.length;
  const aggressiveDelta = partial.length - aggressive.length;
  // Aggressive's delta over partial should be smaller than partial's
  // delta over verbatim — the IMPORTANT: lines + Executing-actions
  // section together are smaller than Tone + Text-output + bullets.
  check('aggressive→partial delta < partial→verbatim drop',
    aggressiveDelta < partialDrop);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`======================================================================`);
process.exit(fail === 0 ? 0 : 1);

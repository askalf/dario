// Unit tests for resolveSystemPrompt + the constraint-stripping helper
// behind it (cc-template.ts).
//
// Pure decision function over its input — no I/O, no upstream calls. We
// import the real CC system prompt from the shipped template and assert
// that, against the current compact CC prompt (2.1.x+):
//   - undefined / 'verbatim' returns CC unchanged
//   - 'partial' swaps the comment-density / match-surrounding-style
//     constraint for a positive "be thorough" instruction, leaving the
//     IMPORTANT: refusal line + the caution paragraph + tools intact
//   - 'aggressive' additionally removes the IMPORTANT: RLHF restatement
//     and the hard-to-reverse / outward-facing caution paragraph
//   - any other string is used verbatim as the literal system prompt
//     (the file-path escape hatch — CLI resolves the path; this layer
//     just gets the loaded text)
//
// These regressions catch the case the v4.8.x rebake hit: a CC prompt
// rewrite the strip no longer matches, silently degrading to verbatim.
// `partial !== CC` plus the explicit removal/insertion checks fail loud
// rather than passing a no-op.

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
//  partial — swap the behavioral constraint, keep alignment & tools
// ======================================================================
header('partial mode');
{
  const partial = resolveSystemPrompt('partial');

  // partial !== CC is the load-bearing anti-degradation check: if a CC
  // prompt rewrite stops matching the strip, partial collapses to
  // verbatim and this fails loud rather than passing a silent no-op.
  check('partial differs from CC (strip actually fired)', partial !== CC_SYSTEM_PROMPT);
  check('partial removes the comment-density / match-style constraint',
    !partial.includes('Write code that reads like the surrounding code'));
  check('partial inserts the positive replacement instruction',
    partial.includes('Be thorough. Show your reasoning.'));
  check('partial keeps the IMPORTANT: refusal reminder intact (alignment-shaped line)',
    partial.includes('IMPORTANT: Assist with authorized security testing'));
  check('partial keeps the hard-to-reverse caution paragraph intact',
    partial.includes('For actions that are hard to reverse or outward-facing'));
  check('partial keeps the "# Harness" tool-usage section',
    partial.includes('# Harness'));
}

// ======================================================================
//  aggressive — partial + strip prompt-level RLHF restatement + caution
// ======================================================================
header('aggressive mode');
{
  const partial = resolveSystemPrompt('partial');
  const aggressive = resolveSystemPrompt('aggressive');

  check('aggressive differs from CC', aggressive !== CC_SYSTEM_PROMPT);
  check('aggressive is shorter than partial (removes alignment + caution paragraphs)',
    aggressive.length < partial.length);
  check('aggressive removes the IMPORTANT: alignment line',
    !aggressive.includes('IMPORTANT: Assist with authorized security testing'));
  check('aggressive removes the hard-to-reverse caution paragraph',
    !aggressive.includes('For actions that are hard to reverse or outward-facing'));
  check('aggressive also applies the partial swap (no comment-density constraint)',
    !aggressive.includes('Write code that reads like the surrounding code'));
  check('aggressive still keeps the "# Harness" tool-usage section',
    aggressive.includes('# Harness'));
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
//  invariant: on the compact prompt, partial barely moves the needle
//  and aggressive removes the bulk
// ======================================================================
//  The compact CC prompt (2.1.x+) carries a single behavioral-style line
//  that partial swaps for a slightly longer positive instruction, so
//  partial ≈ verbatim in length. Aggressive removes the IMPORTANT:
//  alignment paragraph + the caution paragraph — most of the strippable
//  surface. This matches docs/research/system-prompt-classifier-study.md:
//  there is very little prompt-level alignment to strip; it lives in the
//  weights, not the prompt. (On the older verbose prompt the ratio was
//  the reverse — partial did the bulk — which is why the size delta is no
//  longer the invariant; the content checks above are.)
header('partial ≈ verbatim length; aggressive removes the bulk');
{
  const partial = resolveSystemPrompt('partial');
  const aggressive = resolveSystemPrompt('aggressive');
  const verbatim = CC_SYSTEM_PROMPT;
  check('partial stays within ~200 chars of verbatim (single-line swap)',
    Math.abs(verbatim.length - partial.length) < 200);
  check('aggressive removes more from verbatim than partial does',
    (verbatim.length - aggressive.length) > Math.abs(verbatim.length - partial.length));
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`======================================================================`);
process.exit(fail === 0 ? 0 : 1);

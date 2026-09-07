#!/usr/bin/env node
// claude-model.ts: a dated id is servable when the catalog knows its short
// form, and vice versa. The catalog keeps one spelling per model (the short id
// when upstream lists both — normalizeUpstreamIds), while clients send either;
// before dario#1236 the servability test compared spellings literally, so a
// failover chain entry like `claude-opus-4-8-20260101` was silently skipped and
// the new local model-unroutable refusal would have refused a valid request.

import { isClaudeServableModel, resolveClaudeServable, resolveClaudeTarget } from '../dist/claude-model.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};

const bases = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5'];

console.log('\n=== dated request against a short-id catalog ===');
check('claude-opus-4-8-20260101 is servable', isClaudeServableModel('claude-opus-4-8-20260101', bases));
check('…and is forwarded as written (Anthropic accepts the dated form)',
  resolveClaudeServable('claude-opus-4-8-20260101', bases) === 'claude-opus-4-8-20260101',
  resolveClaudeServable('claude-opus-4-8-20260101', bases));
check('dated + [1m]', resolveClaudeServable('claude-opus-4-8-20260101[1m]', bases) === 'claude-opus-4-8-20260101[1m]');
check('dated behind a claude: prefix', resolveClaudeServable('claude:claude-opus-4-8-20260101', bases) === 'claude-opus-4-8-20260101');
// The bare `-high` spelling (what Cursor sends) and the prefixed `claude:…:high`
// form are the two effort spellings resolveClaudeTarget accepts; a bare
// `name:high` reads its colon as a provider prefix and always did.
check('dated with an effort suffix keeps the effort',
  JSON.stringify(resolveClaudeTarget('claude-opus-4-8-20260101-high', bases)) === JSON.stringify({ model: 'claude-opus-4-8-20260101', effort: 'high' }),
  JSON.stringify(resolveClaudeTarget('claude-opus-4-8-20260101-high', bases)));
check('…and behind a claude: prefix with the colon form',
  JSON.stringify(resolveClaudeTarget('claude:claude-opus-4-8-20260101:high', bases)) === JSON.stringify({ model: 'claude-opus-4-8-20260101', effort: 'high' }),
  JSON.stringify(resolveClaudeTarget('claude:claude-opus-4-8-20260101:high', bases)));

console.log('\n=== short request against a dated-only catalog (upstream listed only the dated form) ===');
const datedOnly = ['claude-opus-5', 'claude-sonnet-4-6-20260115'];
check('claude-sonnet-4-6 is servable', isClaudeServableModel('claude-sonnet-4-6', datedOnly));
check('…forwarded as written', resolveClaudeServable('claude-sonnet-4-6', datedOnly) === 'claude-sonnet-4-6');

console.log('\n=== the date rule does not widen anything else ===');
check('a typo stays unservable', !isClaudeServableModel('claude-sonnet-6', bases));
check('a date on an unknown base stays unservable', !isClaudeServableModel('claude-sonnet-6-20260101', bases));
check('a non-8-digit suffix is not a date', !isClaudeServableModel('claude-opus-4-8-2026', bases));
check('a gpt slug stays unservable', !isClaudeServableModel('gpt-5.6-sol', bases));
check('short id against a short-id catalog still resolves', resolveClaudeServable('claude-opus-4-8', bases) === 'claude-opus-4-8');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

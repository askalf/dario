// scripts/wire-drift-fix.mjs: the plan it makes from a wire-drift report, and the drops block it
// rewrites. The case below is the CC 2.1.292 drift: the base gained inline-tools, which Claude Code
// sends on opus and fable only. From the lists as they stood before that fix, the script must
// produce the lists that fixed it, and betaForModel must then reproduce the capture.

import { readFileSync } from 'node:fs';
import {
  planWireDriftFix, applyAdditions, parseDrops, renderDrops, replaceDrops, familyKey, parseReport, changelogBullet, DROPS_PATH,
} from '../scripts/wire-drift-fix.mjs';
import { betaForModel } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}

const OPUS = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,effort-2025-11-24';
const SONNET = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24';
const HAIKU = 'interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01';
const INLINE = 'inline-tools-2026-09-15';
const finding = (model, expected, got) => ({ severity: 'high', category: 'beta.transform', model, expected, got });
const withInline = (s, after) => s.split(',').flatMap((f) => (f === after ? [f, INLINE] : [f])).join(',');
const REPORT = {
  ccVersion: '2.1.292',
  findings: [
    finding('claude-sonnet-5', SONNET, withInline(SONNET, 'mid-conversation-system-2026-04-07')),
    finding('claude-haiku-4-5', HAIKU, withInline(HAIKU, 'prompt-caching-scope-2026-01-05')),
    { severity: 'low', category: 'emit.probe', message: 'low findings do not block a fix' },
  ],
};
const BEFORE = {
  haiku: ['mid-conversation-system-2026-04-07', 'mid-conversation-tool-changes-2026-07-01', 'effort-2025-11-24', 'afk-mode-2026-01-31'],
  sonnet: ['mid-conversation-tool-changes-2026-07-01'],
  'sonnet-4': ['mid-conversation-system-2026-04-07'],
};

console.log('\n=== the CC 2.1.292 inline-tools drift ===');
const plan = planWireDriftFix(REPORT, BEFORE);
check('it is fixable', plan.fixable === true);
check('sonnet-5 drops inline-tools under the sonnet key', plan.additions.some((a) => a.key === 'sonnet' && a.flags.join() === INLINE));
check('haiku-4-5 drops inline-tools under the haiku key', plan.additions.some((a) => a.key === 'haiku' && a.flags.join() === INLINE));
// The lists that fixed it, fixed here rather than read from the repository: the watcher keeps
// adding to the repository's table, and a later addition must not fail this replay.
const AFTER_292 = {
  haiku: [...BEFORE.haiku, INLINE],
  sonnet: [...BEFORE.sonnet, INLINE],
  'sonnet-4': [...BEFORE['sonnet-4']],
};
const after = applyAdditions(BEFORE, plan.additions);
const sameLists = (a, b) => Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every((k) => [...a[k]].sort().join() === [...(b[k] ?? [])].sort().join());
check('the result is exactly the lists that fixed the CC 2.1.292 drift', sameLists(after, AFTER_292));
const current = parseDrops(readFileSync(DROPS_PATH, 'utf8'));
check('the repository table still holds every one of those removals',
  Object.entries(AFTER_292).every(([k, flags]) => flags.every((f) => (current[k] ?? []).includes(f))));
const later = applyAdditions(after, [{ key: 'sonnet', model: 'claude-sonnet-5', flags: ['some-later-beta-2027-01-01'] }]);
check('a later addition extends the table without touching this replay',
  later.sonnet.includes('some-later-beta-2027-01-01') && sameLists(after, AFTER_292));
check('the input is not mutated', BEFORE.sonnet.length === 1 && BEFORE.haiku.length === 4);
check('betaForModel reproduces the sonnet-5 capture', betaForModel(OPUS, 'claude-sonnet-5') === SONNET);
check('betaForModel reproduces the haiku-4-5 capture', betaForModel(OPUS, 'claude-haiku-4-5') === HAIKU);
check('opus and fable keep the flag', betaForModel(OPUS, 'claude-opus-5') === OPUS && betaForModel(OPUS, 'claude-fable-5') === OPUS);
check('the changelog bullet names the version and the flag',
  changelogBullet(plan.additions, '2.1.292').includes('Claude Code 2.1.292') && changelogBullet(plan.additions, '2.1.292').includes(INLINE));

console.log('\n=== no mechanical fix ===');
const only = (...findings) => planWireDriftFix({ findings }, BEFORE);
check('a clean report', only().fixable === false);
check('a cch finding', only({ severity: 'high', category: 'cch.gate', model: 'claude-opus-5' }).fixable === false);
check('a fixable finding beside an unfixable one', only(REPORT.findings[0], { severity: 'high', category: 'header.set' }).fixable === false);
check('a flag Claude Code sends and dario does not',
  only(finding('claude-sonnet-5', withInline(SONNET, 'mid-conversation-system-2026-04-07'), SONNET)).fixable === false);
check('an order change',
  only(finding('claude-haiku-4-5', HAIKU, 'claude-code-20250219,' + HAIKU.split(',').filter((f) => f !== 'claude-code-20250219').join(','))).fixable === false);
check('an extra flag already listed for the family (the list does not reach the model)',
  planWireDriftFix(REPORT, after).fixable === false);

console.log('\n=== family keys ===');
check('haiku', familyKey('claude-haiku-4-5') === 'haiku');
check('a Sonnet finding covers the line', familyKey('claude-sonnet-5') === 'sonnet' && familyKey('claude-sonnet-5[1m]') === 'sonnet');
check('opus-5 and fable-5 get their own key', familyKey('claude-opus-5') === 'opus-5' && familyKey('claude-fable-5') === 'fable-5');

console.log('\n=== the drops block ===');
const file = readFileSync(DROPS_PATH, 'utf8');
check('the repository block reads back', current !== null && Array.isArray(current.haiku));
check('it renders back byte for byte', replaceDrops(file, current) === file);
check('a hand-formatted block is refused', parseDrops(file.replace(renderDrops(current), renderDrops(current).replace(/\n  /g, '\n    '))) === null);
check('a file without markers is refused', parseDrops('export const X = 1;\n') === null);
check('the report parser skips the proxy banner', parseReport('[dario] banner\n  more\n{\n  "drift": true\n}\n').drift === true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

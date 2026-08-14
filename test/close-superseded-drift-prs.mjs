// Unit tests for scripts/close-superseded-drift-prs.mjs.
//
// THE INCIDENT THIS PINS. cc-drift-watch skipped re-drafting when a PR for its
// OWN branch existed, but never looked at older sibling branches. #966
// (maxTested 2.1.231, v5.5.14) stayed open while #970 (2.1.232) and #973
// (v5.5.15) landed on master. Because a drift PR carries a LOWER maxTested and
// an OLDER package version, merging the stale one walks master backwards — so
// it went conflicted, still collected an approving review, and had to be closed
// by hand a day later.
//
// The dangerous direction is closing too much: a superseded PR left open costs
// a manual close, but closing a NEWER PR silently discards the fix that should
// ship. Every "not superseded" case below is guarding that direction.

import {
  selectSupersededPrs,
  versionFromBranch,
  DRIFT_BRANCH_PREFIX,
} from '../scripts/close-superseded-drift-prs.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}
const nums = (rows) => rows.map((r) => r.number);

console.log('\n  versionFromBranch');
check('parses a drift branch', versionFromBranch('bot/cc-drift-v2.1.231') === '2.1.231');
check('prefix constant matches', DRIFT_BRANCH_PREFIX === 'bot/cc-drift-v');
check('rejects a non-drift branch', versionFromBranch('bot/template-rebake-v2.1.231') === null);
check('rejects a feature branch', versionFromBranch('fix/whatever') === null);
check('rejects a non-numeric version', versionFromBranch('bot/cc-drift-vfoo') === null);
// parseInt('231-rc1') === 231, so a suffix would rank as a plain 231 and could
// close a PR it does not actually supersede. Reject rather than mis-rank.
check('rejects a suffixed version', versionFromBranch('bot/cc-drift-v2.1.231-rc1') === null);
check('rejects null / undefined', versionFromBranch(null) === null && versionFromBranch(undefined) === null);

console.log('\n  selectSupersededPrs — the #966 case');
{
  const open = [
    { number: 966, headRefName: 'bot/cc-drift-v2.1.231' },
    { number: 970, headRefName: 'bot/cc-drift-v2.1.232' },
  ];
  check('the newer PR supersedes the older', nums(selectSupersededPrs(open, 'bot/cc-drift-v2.1.232')).join() === '966');
}

console.log('\n  selectSupersededPrs — never closes what it must not');
{
  const open = [
    { number: 966, headRefName: 'bot/cc-drift-v2.1.231' },
    { number: 980, headRefName: 'bot/cc-drift-v2.1.240' },
  ];
  check('a NEWER open PR is never closed', nums(selectSupersededPrs(open, 'bot/cc-drift-v2.1.232')).join() === '966');
}
check('never closes its own branch',
  selectSupersededPrs([{ number: 970, headRefName: 'bot/cc-drift-v2.1.232' }], 'bot/cc-drift-v2.1.232').length === 0);
check('equal version on a different number is left alone',
  selectSupersededPrs([{ number: 969, headRefName: 'bot/cc-drift-v2.1.232' }], 'bot/cc-drift-v2.1.232').length === 0);
check('ignores unrelated bot branches',
  selectSupersededPrs([{ number: 900, headRefName: 'bot/template-rebake-v2.1.100' }], 'bot/cc-drift-v2.1.232').length === 0);
check('ignores human branches',
  selectSupersededPrs([{ number: 901, headRefName: 'fix/approval-identity' }], 'bot/cc-drift-v2.1.232').length === 0);

console.log('\n  selectSupersededPrs — degenerate input never throws');
check('empty list', selectSupersededPrs([], 'bot/cc-drift-v2.1.232').length === 0);
check('non-array', selectSupersededPrs(null, 'bot/cc-drift-v2.1.232').length === 0);
check('rows missing a number', selectSupersededPrs([{ headRefName: 'bot/cc-drift-v2.1.1' }], 'bot/cc-drift-v2.1.232').length === 0);
check('null rows', selectSupersededPrs([null, undefined], 'bot/cc-drift-v2.1.232').length === 0);
check('unparseable new branch closes nothing',
  selectSupersededPrs([{ number: 966, headRefName: 'bot/cc-drift-v2.1.231' }], 'bot/cc-drift-vfoo').length === 0);
check('empty new branch closes nothing',
  selectSupersededPrs([{ number: 966, headRefName: 'bot/cc-drift-v2.1.231' }], '').length === 0);

console.log('\n  selectSupersededPrs — multiple stragglers, oldest first');
{
  const open = [
    { number: 3, headRefName: 'bot/cc-drift-v2.1.230' },
    { number: 1, headRefName: 'bot/cc-drift-v2.1.9' },
    { number: 2, headRefName: 'bot/cc-drift-v2.1.229' },
  ];
  // 2.1.9 < 2.1.229 numerically, though it sorts after as a string — the
  // comparison must be component-wise, not lexicographic.
  check('all three, ordered oldest first', nums(selectSupersededPrs(open, 'bot/cc-drift-v2.1.232')).join() === '1,2,3');
}
check('major/minor differences compare correctly',
  nums(selectSupersededPrs([{ number: 5, headRefName: 'bot/cc-drift-v1.9.99' }], 'bot/cc-drift-v2.0.0')).join() === '5');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

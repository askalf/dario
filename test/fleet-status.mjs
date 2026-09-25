// Unit tests for scripts/fleet-status.mjs. Run: node test/fleet-status.mjs

import {
  laneStatuses,
  isCodePath,
  isBotPr,
  latestByContext,
  statusesToPost,
  verifiedAtHead,
  secondReadAtHead,
  CONTEXTS,
  requiredCiState,
  REDLINE_LOGIN,
  SECOND_READ_LOGIN,
  VERIFIER_LOGIN,
} from '../scripts/fleet-status.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const HEAD = '47536435fb5c9540d8cb36fd26d81e101955b364';
const OLD = '34b7875f46525f7899a4e6601fbca4be75443903';
const base = (over = {}) => ({
  head: HEAD, headRef: 'feat/opus-alias-5-5', author: 'askalf',
  files: ['src/proxy.ts', 'test/opus-alias-fallback.mjs', 'CHANGELOG.md'],
  labels: [], reviews: [], comments: [], ...over,
});
const verification = (sha, login = VERIFIER_LOGIN) => ({ login, body: `## Verification at ${sha}\n\nbody` });
const review = (login, state, commitId, body = '') => ({ login, state, commitId, body });
const by = (rows) => Object.fromEntries(rows.map((s) => [s.context, s]));

console.log('\n  isCodePath / isBotPr');
check('src is code', isCodePath('src/proxy.ts'));
check('markdown and images are not', !isCodePath('README.md') && !isCodePath('docs/art/x.PNG') && !isCodePath('docs/notes.txt'));
check('.github config is not', !isCodePath('.github/workflows/ci.yml') && !isCodePath('.github/labeler.yml'));
check('.github scripts are', isCodePath('.github/scripts/a.sh') && isCodePath('.github/workflows/helper.mjs'));
check('.gitattributes is not', !isCodePath('.gitattributes'));
check('askalf on bot/ is a bot PR', isBotPr('askalf', 'bot/cc-drift-v2.1.281'));
check('askalf on a feature branch is not', !isBotPr('askalf', 'feat/opus-alias-5-5'));
check('a person on bot/ is not', !isBotPr('someone', 'bot/cc-drift-v2.1.281'));
check('dependabot always is', isBotPr('dependabot[bot]', 'dependabot/npm/x'));

console.log('\n  verifiedAtHead');
check('label + comment at head', verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD)] })));
check('a 7-char prefix counts', verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD.slice(0, 7))] })));
check('the label alone does not', !verifiedAtHead(base({ labels: ['verified'] })));
check('a comment at an older head does not', !verifiedAtHead(base({ labels: ['verified'], comments: [verification(OLD)] })));
check('the latest comment wins', !verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD), verification(OLD)] })));
check('another login does not count', !verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD, 'someone')] })));
check('findings heading does not count', !verifiedAtHead(base({ labels: ['verified'], comments: [{ login: VERIFIER_LOGIN, body: `## Verification findings at ${HEAD}` }] })));

console.log('\n  code PR, not verified: everything waits on the Breaker');
{
  const s = by(laneStatuses(base({ reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] })));
  check('verify pending', s[CONTEXTS.verify].state === 'pending' && s[CONTEXTS.verify].description.includes('4753643'));
  check('review pending even with an approval at head', s[CONTEXTS.review].state === 'pending');
  check('second read pending', s[CONTEXTS.secondRead].state === 'pending');
}

console.log('\n  verdicts on an older head');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD),
      review(SECOND_READ_LOGIN, 'COMMENTED', OLD, 'text\nSECOND READ: NOT READY \u2014 stale stack'),
    ],
  })));
  check('verify green', s[CONTEXTS.verify].state === 'success');
  check('an old CHANGES_REQUESTED is not a red at this head', s[CONTEXTS.review].state === 'pending' && s[CONTEXTS.review].description.includes('34b7875'));
  check('an old NOT READY is not a red at this head', s[CONTEXTS.secondRead].state === 'pending');
}

console.log('\n  verdicts at the head');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD),
      review(REDLINE_LOGIN, 'APPROVED', HEAD),
      review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'body\n\nSECOND READ: READY\n'),
    ],
  })));
  check('Redline approved', s[CONTEXTS.review].state === 'success');
  check('Second Read READY', s[CONTEXTS.secondRead].state === 'success');
}
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD),
      review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: NOT READY \u2014 commit subject has an em dash'),
    ],
  })));
  check('Redline changes requested is red', s[CONTEXTS.review].state === 'failure');
  check('NOT READY is red with its reason', s[CONTEXTS.secondRead].state === 'failure' && s[CONTEXTS.secondRead].description.endsWith('commit subject has an em dash'));
}
check('a Second Read without a verdict line is not READY',
  secondReadAtHead(base({ reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'no verdict here')] })).state === 'none');
check('READY followed by text is not READY',
  secondReadAtHead(base({ reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: READY, mostly')] })).state === 'none');
check('the last verdict line in a body wins',
  secondReadAtHead(base({ reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: READY\nSECOND READ: NOT READY - x')] })).state === 'NOT READY');

console.log('\n  deterministic approvals');
{
  const det = review(REDLINE_LOGIN, 'APPROVED', HEAD, '**Deterministic approval** low-risk');
  const code = by(laneStatuses(base({ labels: ['verified'], comments: [verification(HEAD)], reviews: [det] })));
  check('on code it is not Redline\'s verdict', code[CONTEXTS.review].state === 'pending');
  const docs = by(laneStatuses(base({ files: ['README.md'], reviews: [det] })));
  check('on docs it is', docs[CONTEXTS.review].state === 'success');
}

console.log('\n  exempt PRs');
{
  const docs = by(laneStatuses(base({ files: ['README.md', 'docs/routing.md'] })));
  check('docs: verify not required', docs[CONTEXTS.verify].state === 'success' && docs[CONTEXTS.verify].description.startsWith('Not required'));
  check('docs: second read not gating', docs[CONTEXTS.secondRead].state === 'success');
  check('docs: review still waits on Redline', docs[CONTEXTS.review].state === 'pending');
  const bot = by(laneStatuses(base({ headRef: 'bot/cc-drift-v2.1.281', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] })));
  check('bot branch: verify not required, approval counts', bot[CONTEXTS.verify].state === 'success' && bot[CONTEXTS.review].state === 'success');
  const many = Array.from({ length: 101 }, (_, i) => `docs/p${i}.md`);
  check('more than 100 files is code whatever they are', by(laneStatuses(base({ files: many })))[CONTEXTS.verify].state === 'pending');
  const hundred = Array.from({ length: 100 }, (_, i) => `docs/p${i}.md`);
  check('exactly 100 docs files is not code', by(laneStatuses(base({ files: hundred })))[CONTEXTS.verify].state === 'success');
  check('more than 100 docs files still verifies once required CI passes',
    by(laneStatuses(base({ files: many, requiredCi: 'passed' })))[CONTEXTS.verify].state === 'success');
}

console.log('\n  descriptions');
{
  const long = 'x'.repeat(300);
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, `SECOND READ: NOT READY - ${long}`)],
  })));
  check('capped at 140 characters', laneStatuses(base()).every((r) => r.description.length <= 140) && s[CONTEXTS.secondRead].description.length === 140);
}

console.log('\n  verifiedAtHead: the label and the comment are each required');
check('a comment at head without the label does not count', !verifiedAtHead(base({ comments: [verification(HEAD)] })));
check('an older comment followed by one at head counts', verifiedAtHead(base({ labels: ['verified'], comments: [verification(OLD), verification(HEAD)] })));
check('a blocked heading does not count', !verifiedAtHead(base({ labels: ['verified'], comments: [{ login: VERIFIER_LOGIN, body: `## Verification blocked at ${HEAD}` }] })));

console.log('\n  Redline reviews that are not verdicts, and verdicts in order');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(REDLINE_LOGIN, 'APPROVED', OLD), review(REDLINE_LOGIN, 'DISMISSED', HEAD), review(REDLINE_LOGIN, 'COMMENTED', HEAD, 'notes')],
  })));
  check('a dismissal and a comment at head leave the older approval as the last verdict', s[CONTEXTS.review].state === 'pending' && s[CONTEXTS.review].description.includes('34b7875'));
}
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD), review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)],
  })));
  check('changes requested after an approval at the same head is red', s[CONTEXTS.review].state === 'failure');
}
{
  const s = by(laneStatuses(base({ reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] })));
  check('changes requested at an unverified head still waits on the Breaker', s[CONTEXTS.verify].state === 'pending' && s[CONTEXTS.review].state === 'pending' && s[CONTEXTS.secondRead].state === 'pending');
}

console.log('\n  the Second Read, review by review');
check('a Redline review carrying the line is not the Second Read',
  secondReadAtHead(base({ reviews: [review(REDLINE_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: READY')] })).state === 'none');
check('the latest review at head wins',
  secondReadAtHead(base({ reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: NOT READY - x'), review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: READY')] })).state === 'READY');
check('a later review without the line keeps the verdict',
  secondReadAtHead(base({ reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: NOT READY - x'), review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'follow-up')] })).state === 'NOT READY');
check('a verdict at an older head plus a lineless review at this head is none',
  secondReadAtHead(base({ reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', OLD, 'SECOND READ: READY'), review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'read again')] })).state === 'none');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: NOT READY')],
  })));
  check('NOT READY with no reason is red without a trailing colon', s[CONTEXTS.secondRead].state === 'failure' && s[CONTEXTS.secondRead].description === 'NOT READY at 4753643');
}

console.log('\n  what counts as code');
check('.github actions are', isCodePath('.github/actions/retry/action.yml'));
check('a .txt outside docs is', isCodePath('notes.txt') && isCodePath('src/fixtures/a.txt'));
check('a .github script keeps its case', isCodePath('.github/workflows/helper.MJS'));

console.log('\n  bot PRs');
check('github-actions on bot/ is', isBotPr('github-actions[bot]', 'bot/x') && isBotPr('app/github-actions', 'bot/x'));
check('askalf on a release, receipts or dependabot branch is',
  isBotPr('askalf', 'release-v6.12.0') && isBotPr('askalf', 'release/6.12') && isBotPr('askalf', 'chore/release-v6.12.0') && isBotPr('askalf', 'receipts-2026-09-24') && isBotPr('askalf', 'dependabot/npm/x'));
{
  const docs = (n) => Array.from({ length: n }, (_, i) => `docs/p${i}.md`);
  // The bot rule is read before the file count: a bot PR over 100 files is still exempt, a person's is code.
  check('a bot PR with more than 100 files is still not code', by(laneStatuses(base({ headRef: 'bot/cc-drift-v2.1.281', files: docs(101) })))[CONTEXTS.verify].state === 'success');
  check('a person with more than 100 docs files is code', by(laneStatuses(base({ files: docs(101) })))[CONTEXTS.verify].state === 'pending');
  check('99 docs files are not code', by(laneStatuses(base({ files: docs(99) })))[CONTEXTS.verify].state === 'success');
}

console.log('\n  docs PRs still show Redline\'s verdict');
{
  const s = by(laneStatuses(base({ files: ['README.md'], reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] })));
  check('changes requested on docs is red', s[CONTEXTS.review].state === 'failure' && s[CONTEXTS.secondRead].state === 'success');
  const old = by(laneStatuses(base({ files: ['README.md'], reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD)] })));
  check('changes requested on an older docs head is pending and says where', old[CONTEXTS.review].state === 'pending' && old[CONTEXTS.review].description.endsWith('(its last verdict was on 34b7875)'));
}

console.log('\n  the 140-character edge');
{
  const at = (reason) => by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, `SECOND READ: NOT READY - ${reason}`)],
  })))[CONTEXTS.secondRead].description;
  check('exactly 140 characters is kept whole', at('y'.repeat(118)) === `NOT READY at 4753643: ${'y'.repeat(118)}`);
  check('141 characters is cut to 137 and an ellipsis', at('y'.repeat(119)) === `NOT READY at 4753643: ${'y'.repeat(115)}...`);
}

console.log('\n  required CI is the verification where the base branch requires checks');
{
  const REQ = ['test', 'build (22)', 'live-test'];
  const ok = (name) => ({ name, state: 'success' });
  check('no required checks -> none', requiredCiState([], [ok('test')]) === 'none');
  check('all required passed -> passed', requiredCiState(REQ, REQ.map(ok)) === 'passed');
  check('a required check not reported yet -> pending', requiredCiState(REQ, [ok('test'), ok('build (22)')]) === 'pending');
  check('a required check still running -> pending', requiredCiState(REQ, [ok('test'), ok('build (22)'), { name: 'live-test', state: 'in_progress' }]) === 'pending');
  check('a required check failed -> failed, even with another pending',
    requiredCiState(REQ, [{ name: 'test', state: 'failure' }, ok('build (22)')]) === 'failed');
  check('the last result per check counts (a rerun that passed)',
    requiredCiState(['test'], [{ name: 'test', state: 'failure' }, ok('test')]) === 'passed');
  check('skipped and neutral pass', requiredCiState(['a', 'b'], [{ name: 'a', state: 'skipped' }, { name: 'b', state: 'neutral' }]) === 'passed');
  check('checks nobody requires do not hold it', requiredCiState(['test'], [ok('test'), { name: 'fleet/verify', state: 'pending' }]) === 'passed');

  const lanes = (over) => by(laneStatuses(base(over)));
  const passed = lanes({ requiredCi: 'passed' });
  check('CI passed: fleet/verify green with no label or comment', passed[CONTEXTS.verify].state === 'success'
    && passed[CONTEXTS.verify].description === 'Required CI passed at 4753643');
  check('CI passed: Redline and the Second Read are waited on, not held for a Breaker',
    passed[CONTEXTS.review].description === 'Waiting on Redline at 4753643'
      && passed[CONTEXTS.secondRead].description === 'Waiting on the Second Read at 4753643');
  check('CI pending: fleet/verify waits on CI, not the Breaker', lanes({ requiredCi: 'pending' })[CONTEXTS.verify].description === 'Waiting on required CI at 4753643');
  check('CI failed: fleet/verify red', lanes({ requiredCi: 'failed' })[CONTEXTS.verify].state === 'failure');
  check('CI pending: an old Breaker label and comment do not count',
    lanes({ requiredCi: 'pending', labels: ['verified'], comments: [verification(HEAD)] })[CONTEXTS.verify].state === 'pending');
  check('no required checks: the label and comment still verify',
    lanes({ requiredCi: 'none', labels: ['verified'], comments: [verification(HEAD)] })[CONTEXTS.verify].description === 'Verified at 4753643');
}

{
  // The dispatcher exempts a bot-shaped branch only when one of our identities opened it.
  check('a person on a bot-shaped branch is not a bot PR', !isBotPr('contributor', 'bot/maintenance'));
  check('a person on release/1.2 is not a bot PR', !isBotPr('someone', 'release/1.2'));
  check('askalf on bot/drift is a bot PR', isBotPr('askalf', 'bot/drift'));
  check('github-actions on receipts-2026 is a bot PR', isBotPr('github-actions[bot]', 'receipts-2026'));
  check('dependabot on any branch is a bot PR', isBotPr('dependabot[bot]', 'feature/x'));
}

{
  // With the fleet/* lanes listed as required checks, they must not wait on themselves.
  const ci = ['test', 'analyze'];
  const own = [CONTEXTS.verify, CONTEXTS.review, CONTEXTS.secondRead];
  const green = ci.map((name) => ({ name, state: 'SUCCESS' }));
  check('own lanes required, CI green: passed', requiredCiState([...ci, ...own], green) === 'passed');
  check('own lanes required and pending, CI green: still passed',
    requiredCiState([...ci, ...own], [...green, ...own.map((name) => ({ name, state: 'PENDING' }))]) === 'passed');
  check('only own lanes required: none (the Breaker rule applies)', requiredCiState(own, []) === 'none');
  check('own lanes required, a real check running: pending',
    requiredCiState([...ci, ...own], [{ name: 'test', state: 'SUCCESS' }, { name: 'analyze', state: 'IN_PROGRESS' }]) === 'pending');
  let posted = [];
  let states = [];
  for (let round = 0; round < 3; round++) {
    const requiredCi = requiredCiState([...ci, ...own], [...green, ...posted]);
    const out = laneStatuses(base({ requiredCi, reviews: [
      review(REDLINE_LOGIN, 'APPROVED', HEAD),
      review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: READY'),
    ] }));
    posted = out.map((x) => ({ name: x.context, state: x.state.toUpperCase() }));
    states = out.map((x) => x.state);
  }
  check('own lanes required, three rounds: all three green', states.join() === 'success,success,success');
}

{
  // Post-then-verify ordering: what differs from the head's newest status per context is posted.
  const have = latestByContext([
    { context: 'fleet/review', state: 'success', description: 'Redline approved abc1234' },
    { context: 'fleet/review', state: 'pending', description: 'older' },
    { context: 'fleet/verify', state: 'success', description: 'Required CI passed at abc1234' },
  ]);
  check('latestByContext keeps the newest per context', have.get('fleet/review').state === 'success' && have.size === 2);
  const want = [
    { context: 'fleet/verify', state: 'success', description: 'Required CI passed at abc1234' },
    { context: 'fleet/review', state: 'pending', description: 'Waiting on Redline at abc1234' },
    { context: 'fleet/second-read', state: 'pending', description: 'Waiting on the Second Read at abc1234' },
  ];
  const todo = statusesToPost(want, have).map((s) => s.context);
  check('an identical status is not posted again', !todo.includes('fleet/verify'));
  check('a differing state is posted', todo.includes('fleet/review'));
  check('a missing context is posted', todo.includes('fleet/second-read'));
  check('same state, new description is posted',
    statusesToPost([{ context: 'fleet/verify', state: 'success', description: 'Verified at abc1234' }], have).length === 1);
  // A stale run posted after a fresh one: the fresh run's verify pass sees the difference and corrects it.
  const stale = latestByContext([{ context: 'fleet/review', state: 'pending', description: 'Waiting on Redline at abc1234' }]);
  const fresh = [{ context: 'fleet/review', state: 'success', description: 'Redline approved abc1234' }];
  check('a stale overwrite is corrected on the next pass', statusesToPost(fresh, stale).length === 1);
  check('and then left alone', statusesToPost(fresh, latestByContext(fresh)).length === 0);
}

{
  // A dismissed Second Read review is not a verdict.
  const verified = { requiredCi: 'passed' };
  const dismissed = review(SECOND_READ_LOGIN, 'DISMISSED', HEAD, 'SECOND READ: NOT READY - old finding');
  check('dismissed NOT READY at head: waiting, not red',
    by(laneStatuses(base({ ...verified, reviews: [dismissed] })))[CONTEXTS.secondRead].state === 'pending');
  check('a later READY still counts after a dismissed NOT READY',
    by(laneStatuses(base({ ...verified, reviews: [dismissed, review(SECOND_READ_LOGIN, 'COMMENTED', HEAD, 'SECOND READ: READY')] })))[CONTEXTS.secondRead].state === 'success');
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

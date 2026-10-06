// Unit tests for scripts/fleet-status.mjs. Run: node test/fleet-status.mjs

import {
  laneStatuses,
  isCodePath,
  isBotPr,
  latestByContext,
  statusesToPost,
  verifiedAtHead,
  CONTEXTS,
  requiredCiState,
  REDLINE_LOGIN,
  VERIFIER_LOGIN,
  collectPages,
  prsFromHead,
} from '../scripts/fleet-status.mjs';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

// The workflow's on: block, comments dropped, so a trigger named in a comment does not count.
function onBlockOf(y) {
  const m = /^on:(.*)$/m.exec(y);
  if (!m) return '';
  const lines = [m[1]];
  for (const l of y.slice(m.index + m[0].length).split('\n').slice(1)) {
    if (/^[^\s#]/.test(l)) break;
    lines.push(l);
  }
  return lines.join('\n').replace(/#.*$/gm, '');
}
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

console.log('\n  verdicts on an older head');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD),
    ],
  })));
  check('verify green', s[CONTEXTS.verify].state === 'success');
  check('an old CHANGES_REQUESTED is not a red at this head', s[CONTEXTS.review].state === 'pending' && s[CONTEXTS.review].description.includes('34b7875'));
}

console.log('\n  verdicts at the head');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD),
      review(REDLINE_LOGIN, 'APPROVED', HEAD),
    ],
  })));
  check('Redline approved', s[CONTEXTS.review].state === 'success');
}
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD),
    ],
  })));
  check('Redline changes requested is red', s[CONTEXTS.review].state === 'failure');
}

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
check('capped at 140 characters', laneStatuses(base()).every((r) => r.description.length <= 140));

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
  check('changes requested at an unverified head still waits on the Breaker', s[CONTEXTS.verify].state === 'pending' && s[CONTEXTS.review].state === 'pending');
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
  check('changes requested on docs is red', s[CONTEXTS.review].state === 'failure');
  const old = by(laneStatuses(base({ files: ['README.md'], reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD)] })));
  check('changes requested on an older docs head is pending and says where', old[CONTEXTS.review].state === 'pending' && old[CONTEXTS.review].description.endsWith('(its last verdict was on 34b7875)'));
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
  check('CI passed: Redline is waited on, not held for a Breaker',
    passed[CONTEXTS.review].description === 'Waiting on Redline at 4753643');
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
  const own = [CONTEXTS.verify, CONTEXTS.review];
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
    ] }));
    posted = out.map((x) => ({ name: x.context, state: x.state.toUpperCase() }));
    states = out.map((x) => x.state);
  }
  check('own lanes required, three rounds: both green', states.join() === 'success,success');
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
  ];
  const todo = statusesToPost(want, have).map((s) => s.context);
  check('an identical status is not posted again', !todo.includes('fleet/verify'));
  check('a differing state is posted', todo.includes('fleet/review'));
  check('a missing context is posted', statusesToPost([{ context: 'fleet/new', state: 'pending', description: 'x' }], have).length === 1);
  check('same state, new description is posted',
    statusesToPost([{ context: 'fleet/verify', state: 'success', description: 'Verified at abc1234' }], have).length === 1);
  // A stale run posted after a fresh one: the fresh run's verify pass sees the difference and corrects it.
  const stale = latestByContext([{ context: 'fleet/review', state: 'pending', description: 'Waiting on Redline at abc1234' }]);
  const fresh = [{ context: 'fleet/review', state: 'success', description: 'Redline approved abc1234' }];
  check('a stale overwrite is corrected on the next pass', statusesToPost(fresh, stale).length === 1);
  check('and then left alone', statusesToPost(fresh, latestByContext(fresh)).length === 0);
}

{
  // fleet-status.yml's workflow_run list names every workflow that runs on pull_request or
  // pull_request_target, so a required check it produces refreshes the lanes when it finishes.
  // A pull_request_target run's checks land on the PR head too (its head_sha is the PR's), so the
  // status job accepts workflow_run events from both.
  const dir = join(fileURLToPath(new URL('..', import.meta.url)), '.github', 'workflows');
  const own = readFileSync(join(dir, 'fleet-status.yml'), 'utf8');
  const listed = (/^  workflow_run:\s*\n\s+workflows:\s*\[([^\]]*)\]/m.exec(own)?.[1] ?? '')
    .split(',').map((w) => w.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const onBlock = (y) => {
    const m = /^on:(.*)$/m.exec(y);
    if (!m) return '';
    const lines = [m[1]];
    for (const l of y.slice(m.index + m[0].length).split('\n').slice(1)) {
      if (/^[^\s#]/.test(l)) break;
      lines.push(l);
    }
    return lines.join('\n').replace(/#.*$/gm, '');
  };
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x) && x !== 'fleet-status.yml')) {
    const y = readFileSync(join(dir, f), 'utf8');
    if (!/\bpull_request(_target)?\b/.test(onBlock(y))) continue;
    const name = (/^name:\s*(.+)$/m.exec(y)?.[1] ?? f).trim().replace(/^['"]|['"]$/g, '');
    check(`workflow_run lists "${name}" (${f} runs on pull requests)`, listed.includes(name));
  }
  if (listed.length) {
    check('the status job accepts workflow_run events from pull_request and pull_request_target runs',
      /\["pull_request","pull_request_target"\]/.test(own));
  }
}

{
  // backfill pages past one page of open PRs and stops loudly at its cap.
  const wf = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), '.github', 'workflows', 'fleet-status-backfill.yml'), 'utf8');
  const limit = Number(/gh pr list --repo "\$REPO" --state open --limit (\d+)/.exec(wf)?.[1] ?? 0);
  check('backfill reads more than one page of open PRs', limit > 100);
  check('backfill fails at its cap instead of skipping PRs', new RegExp(`-ge ${limit}\\b`).test(wf) && /::error::/.test(wf));
}

{
  // Paging reads to the first short page, so a required check on page 2 still counts.
  const pager = (sizes) => async (n) => Array.from({ length: sizes[n - 1] ?? 0 }, (_, i) => ({ name: `check-${n}-${i}`, state: 'SUCCESS' }));
  const two = await collectPages(pager([100, 1]));
  check('101 rows over two pages are all read', two.length === 101);
  check('a full last page reads one more, empty, page', (await collectPages(pager([100, 100]))).length === 200);
  check('a short first page is the only page', (await collectPages(pager([5]))).length === 5);
  check('a required check on page 2 counts', requiredCiState(['check-2-0'], two) === 'passed');
}

console.log('\n  fork PRs: an outside contributor\'s PR');
{
  const FORK = "an outside contributor's PR: the operator verifies and merges";
  const fork = (over = {}) => by(laneStatuses(base({ fork: true, author: 'contributor', headRef: 'fix/typo', ...over })));
  const green = fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] });
  check('fork, Redline approved at head, required CI green: verify green',
    green[CONTEXTS.verify].state === 'success' && green[CONTEXTS.verify].description === 'Required CI passed at 4753643');
  check('fork, Redline approved at head, required CI green: review green',
    green[CONTEXTS.review].state === 'success' && green[CONTEXTS.review].description === 'Redline approved 4753643');
  const red = fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] });
  check('fork, Redline requested changes at head: review red', red[CONTEXTS.review].state === 'failure');
  check('fork, changes requested while required CI still runs: review red, not held',
    fork({ requiredCi: 'pending', reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] })[CONTEXTS.review].state === 'failure');
  const none = fork({ requiredCi: 'none', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] });
  check('fork, no required checks: verify pending for the operator',
    none[CONTEXTS.verify].state === 'pending' && none[CONTEXTS.verify].description === FORK);
  check('fork, no required checks: Redline\'s approval still shows', none[CONTEXTS.review].state === 'success');
  check('fork, no required checks: a label and verification comment do not verify it',
    fork({ requiredCi: 'none', labels: ['verified'], comments: [verification(HEAD)] })[CONTEXTS.verify].description === FORK);
  check('fork, no verdict: review waits on Redline at the head',
    fork({ requiredCi: 'passed' })[CONTEXTS.review].description === 'Waiting on Redline at 4753643');
  check('fork, approval on an older head: review pending',
    fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'APPROVED', OLD)] })[CONTEXTS.review].state === 'pending');
  check('fork, required CI failed: verify red', fork({ requiredCi: 'failed' })[CONTEXTS.verify].state === 'failure');
  check('fork, required CI running: verify waits on it', fork({ requiredCi: 'pending' })[CONTEXTS.verify].description === 'Waiting on required CI at 4753643');
  check('fork, docs only: verify not required', fork({ files: ['README.md'] })[CONTEXTS.verify].description.startsWith('Not required'));
  check('fork, deterministic approval on code is not a verdict',
    fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD, '**Deterministic approval** low-risk')] })[CONTEXTS.review].state === 'pending');
  check('fork, another login\'s approval is not Redline\'s',
    fork({ requiredCi: 'passed', reviews: [review('someone', 'APPROVED', HEAD)] })[CONTEXTS.review].state === 'pending');
  const same = by(laneStatuses(base({ fork: false, requiredCi: 'none', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] })));
  check('same-repo, unchanged: waits on the Breaker, review held',
    same[CONTEXTS.verify].description === 'Waiting on the Breaker to verify 4753643' && same[CONTEXTS.review].state === 'pending');

  const pull = (number, repo, state = 'open') => ({ number, state, head: { repo: repo === null ? null : { full_name: repo } } });
  check('a fork head resolves to its open PRs from that repository',
    prsFromHead([pull(7, 'someone/r'), pull(8, 'someone/other'), pull(9, 'someone/r', 'closed'), pull(10, null)], 'someone/r').join() === '7');
  check('no open PR from the fork head resolves to none', prsFromHead([], 'someone/r').length === 0);
}

console.log('\n  fork PRs through the CLI, against a stubbed GitHub');
{
  const script = fileURLToPath(new URL('../scripts/fleet-status.mjs', import.meta.url));
  const stub = `
    const fx = JSON.parse(process.env.FLEET_STATUS_FIXTURE);
    const posted = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const p = u.pathname;
      if (init.method === 'POST') { posted.push({ path: p, ...JSON.parse(init.body) }); return json({}, 201); }
      if (Number(u.searchParams.get('page') ?? 1) > 1) return p.endsWith('/check-runs') ? json({ check_runs: [] }) : json([]);
      if (p.endsWith('/pulls')) { fx.asked = u.searchParams.get('head'); return json(fx.pulls); }
      if (p.endsWith('/files')) return json(fx.files);
      if (p.endsWith('/reviews')) return json(fx.reviews);
      if (p.endsWith('/comments')) return json([]);
      if (p.includes('/rules/branches/')) return json(fx.rules);
      if (p.endsWith('/statuses')) return json([...posted].reverse());
      if (p.endsWith('/check-runs')) return json({ check_runs: fx.checkRuns });
      if (/[/]pulls[/]7$/.test(p)) return json(fx.pr);
      return json({ message: 'unexpected ' + p }, 404);
    };
    process.on('exit', () => process.stdout.write('ASKED ' + JSON.stringify(fx.asked ?? null) + '\\nPOSTED ' + JSON.stringify(posted) + '\\n'));
  `;
  const run = (fixture, env, ...args) => {
    const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`, script, ...args], {
      env: { ...process.env, GITHUB_TOKEN: 't', REPO: 'o/r', PR: '', HEAD_REPO: '', HEAD_BRANCH: '', FLEET_STATUS_FIXTURE: JSON.stringify(fixture), ...env },
      encoding: 'utf8',
    });
    return {
      status: r.status, out: r.stdout + r.stderr,
      asked: JSON.parse(/^ASKED (.*)$/m.exec(r.stdout)?.[1] ?? 'null'),
      posted: JSON.parse(/^POSTED (.*)$/m.exec(r.stdout)?.[1] ?? '[]'),
      lane: (c) => new RegExp(`^${c}\\s+(\\S+)\\s+(.*)$`, 'm').exec(r.stdout)?.slice(1) ?? [],
    };
  };
  const forkPr = { state: 'open', number: 7, html_url: 'https://x/pull/7', user: { login: 'contributor' }, labels: [],
    head: { sha: HEAD, ref: 'fix/typo', repo: { full_name: 'contributor/r' } }, base: { ref: 'main' } };
  const fixture = (over = {}) => ({
    pr: forkPr, pulls: [forkPr], files: [{ filename: 'src/a.ts' }],
    reviews: [{ user: { login: REDLINE_LOGIN }, state: 'APPROVED', commit_id: HEAD, body: 'ok' }],
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }, { context: CONTEXTS.verify }] } }],
    checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }], ...over,
  });
  const approved = run(fixture(), { PR: '7' }, '--dry-run');
  check('CLI: a fork PR, approved at head with required CI green, reads both lanes green',
    approved.status === 0 && approved.lane(CONTEXTS.verify)[0] === 'success' && approved.lane(CONTEXTS.review)[0] === 'success');
  const posting = run(fixture(), { PR: '7' });
  check('CLI: and posts both on the fork head',
    posting.status === 0 && posting.posted.length === 2 && posting.posted.every((s) => s.path === `/repos/o/r/statuses/${HEAD}` && s.state === 'success'));
  const noChecks = run(fixture({ rules: [] }), { PR: '7' }, '--dry-run');
  check('CLI: a fork PR where no checks are required leaves verify to the operator',
    noChecks.lane(CONTEXTS.verify).join(' ') === "pending an outside contributor's PR: the operator verifies and merges");
  const viaHead = run(fixture(), { HEAD_REPO: 'contributor/r', HEAD_BRANCH: 'fix/typo' }, '--dry-run');
  check('CLI: a fork head with no PR number finds its PR by owner and branch',
    viaHead.status === 0 && viaHead.asked === 'contributor:fix/typo' && viaHead.lane(CONTEXTS.review)[0] === 'success');
  const elsewhere = run(fixture({ pulls: [{ ...forkPr, head: { ...forkPr.head, repo: { full_name: 'contributor/other' } } }] }),
    { HEAD_REPO: 'contributor/r', HEAD_BRANCH: 'fix/typo' });
  check('CLI: a same-named branch in another of the owner\'s repos is not the PR',
    elsewhere.status === 0 && elsewhere.posted.length === 0 && /nothing to report/.test(elsewhere.out));
  check('CLI: no PR number and no fork head is a usage error', run(fixture(), {}).status === 2);
}

console.log('\n  fleet-status.yml: which events run the job for a fork');
{
  // A small evaluator for the Actions expression subset the job's if: uses: string and number
  // literals, null, property paths, !, ==, !=, &&, ||, contains() and fromJSON(). Strings compare
  // case-insensitively, as Actions does.
  const evalIf = (src, ctx) => {
    const toks = [];
    const re = /\s*(?:('(?:[^']|'')*')|(\d+)|(==|!=|&&|\|\||[!(),[\].])|([A-Za-z_][\w-]*))/y;
    for (let i = 0; !/^\s*$/.test(src.slice(i));) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m) throw new Error(`cannot read the expression at: ${src.slice(i, i + 30)}`);
      i = re.lastIndex;
      toks.push(m[1] ? { t: 'lit', v: m[1].slice(1, -1).replace(/''/g, "'") }
        : m[2] ? { t: 'lit', v: Number(m[2]) }
          : m[3] ? { t: m[3] } : { t: 'id', v: m[4] });
    }
    let p = 0;
    const peek = () => toks[p]?.t;
    const eat = (t) => { if (peek() !== t) throw new Error(`expected ${t} at token ${p}`); return toks[p++]; };
    const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');
    const eq = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null));
    const fns = {
      contains: (h, n) => (Array.isArray(h) ? h.some((x) => eq(x, n)) : String(h ?? '').toLowerCase().includes(String(n ?? '').toLowerCase())),
      fromJSON: (x) => JSON.parse(x),
    };
    const primary = () => {
      const k = toks[p++];
      if (k?.t === 'lit') return k.v;
      if (k?.t === '(') { const v = or(); eat(')'); return v; }
      if (k?.t === '!') return !truthy(primary());
      if (k?.t !== 'id') throw new Error(`unexpected token ${p - 1}`);
      if (k.v === 'null') return null;
      if (k.v === 'true' || k.v === 'false') return k.v === 'true';
      if (peek() === '(') {
        p++;
        const args = [];
        if (peek() !== ')') for (args.push(or()); peek() === ','; p++, args.push(or()));
        eat(')');
        return fns[k.v](...args);
      }
      let v = ctx[k.v] ?? null;
      for (;;) {
        if (peek() === '.') { p++; const key = eat('id').v; v = v?.[key] ?? null; } else if (peek() === '[') { p++; const at = or(); eat(']'); v = v?.[at] ?? null; } else return v;
      }
    };
    const cmp = () => { let v = primary(); while (peek() === '==' || peek() === '!=') { const op = toks[p++].t; const r = primary(); v = op === '==' ? eq(v, r) : !eq(v, r); } return v; };
    const and = () => { let v = cmp(); while (peek() === '&&') { p++; const r = cmp(); v = truthy(v) ? r : v; } return v; };
    const or = () => { let v = and(); while (peek() === '||') { p++; const r = and(); v = truthy(v) ? v : r; } return v; };
    const v = or();
    if (p !== toks.length) throw new Error(`trailing tokens from ${p}`);
    return truthy(v);
  };
  check('the evaluator reads literals, paths and functions',
    evalIf("contains(fromJSON('[\"a\",\"b\"]'), x.y[0]) && x.z == null && 'A' == 'a'", { x: { y: ['B'] } })
    && !evalIf("x.y != 'q' && x.y == 'q'", { x: { y: 'q' } }));

  const dir = join(fileURLToPath(new URL('..', import.meta.url)), '.github', 'workflows');
  const own = readFileSync(join(dir, 'fleet-status.yml'), 'utf8');
  const cond = (/^    if: >-\n((?: {6}.*\n)+)/m.exec(own)?.[1] ?? '').split('\n').map((l) => l.trim()).join(' ').trim();
  const REPO = 'askalf/example';
  const FORKED = 'contributor/example';
  const runs = (github) => evalIf(cond, { github: { repository: REPO, ...github } });
  const onPr = (event_name, headRepo) => runs({ event_name, event: { pull_request: { head: { repo: { full_name: headRepo } } } } });
  const onRun = (event, headRepo, prs) => runs({ event_name: 'workflow_run', event: { workflow_run: { event, head_repository: { full_name: headRepo }, pull_requests: prs } } });
  check('the job has an if: to read', cond.length > 0);
  check('a fork\'s pull_request event does not run the job', !onPr('pull_request', FORKED));
  check('a fork\'s pull_request_review event does not run the job', !onPr('pull_request_review', FORKED));
  check('a same-repo pull_request and review run it', onPr('pull_request', REPO) && onPr('pull_request_review', REPO));
  check('a comment on a PR runs it, fork or not; a comment on an issue does not',
    runs({ event_name: 'issue_comment', event: { issue: { pull_request: { url: 'x' } } } })
    && !runs({ event_name: 'issue_comment', event: { issue: {} } }));
  check('a fork\'s CI finishing runs it, though the event lists no PR', onRun('pull_request', FORKED, []));
  check('a fork\'s pull_request_target run finishing runs it', onRun('pull_request_target', FORKED, []));
  check('the review relay finishing on a fork runs it', onRun('pull_request_review', FORKED, []));
  check('the review relay finishing on a same-repo PR does not (its review event already ran)',
    !onRun('pull_request_review', REPO, [{ number: 7 }]));
  check('same-repo CI finishing runs it with a PR, not without',
    onRun('pull_request', REPO, [{ number: 7 }]) && !onRun('pull_request', REPO, []));
  check('a push or schedule run finishing does not', !onRun('push', REPO, []) && !onRun('schedule', FORKED, []));
  check('the fork path hands the script the head repo and branch',
    /HEAD_REPO: \$\{\{ github\.event\.workflow_run\.head_repository\.full_name \}\}/.test(own)
    && /HEAD_BRANCH: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/.test(own));
  // The invariant that lets a fork run here: the only checkout is the default branch's script.
  const checkouts = [...own.matchAll(/uses: \S*checkout\S*[^\n]*\n((?: {8,}.*\n)*)/g)];
  check('every checkout is the default branch, never the PR head', checkouts.length > 0
    && checkouts.every((m) => /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/.test(m[1])));
  check('no step reads the PR head ref or sha', !/(pull_request\.head\.(ref|sha)|workflow_run\.head_sha)/.test(own));

  // Our own code runs on dario-exec, our host's runners; code nobody here wrote never does. A
  // runs-on expression sends a fork's PR and a Dependabot PR to GitHub's runners and everything
  // else to ours. A literal dario-exec on a pull_request workflow needs a job if: that keeps forks
  // off it (live-test) or a job that never runs PR code (fleet-status, checked above).
  const OWN_RE = /^\s+runs-on: \$\{\{ (.+) \}\}$/;
  const exprs = [];
  const literal = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const y = readFileSync(join(dir, f), 'utf8');
    for (const line of y.split('\n')) {
      const m = OWN_RE.exec(line);
      if (m && m[1].includes('dario-exec')) exprs.push({ f, e: m[1] });
      else if (/^\s+runs-on: \[self-hosted, dario-exec\]/.test(line)) literal.push(f);
    }
  }
  check('the own-code runs-on expression is in use', exprs.length >= 8);
  const hosted = (e, github) => evalIf(`(${e}) == 'ubuntu-latest'`, { github: { repository: REPO, ...github } });
  const prFrom = (event_name, headRepo, login = 'askalf') =>
    ({ event_name, event: { pull_request: { head: { repo: { full_name: headRepo } }, user: { login } } } });
  for (const { f, e } of exprs) {
    check(`${f}: a fork's pull_request runs on GitHub's runners`, hosted(e, prFrom('pull_request', FORKED)));
    check(`${f}: a fork's pull_request_review runs on GitHub's runners`, hosted(e, prFrom('pull_request_review', FORKED)));
    check(`${f}: a Dependabot PR runs on GitHub's runners`, hosted(e, prFrom('pull_request', REPO, 'dependabot[bot]')));
    check(`${f}: a same-repo PR runs on ours`, !hosted(e, prFrom('pull_request', REPO)));
    check(`${f}: a push, schedule or dispatch runs on ours`,
      !hosted(e, { event_name: 'push', event: {} }) && !hosted(e, { event_name: 'schedule', event: {} })
      && !hosted(e, { event_name: 'workflow_dispatch', event: {} }));
    check(`${f}: the expression names exactly our label`, e.includes(`fromJSON('["self-hosted","dario-exec"]')`));
  }
  for (const f of literal) {
    const y = readFileSync(join(dir, f), 'utf8');
    const prTriggered = /\bpull_request(_target|_review)?\b/.test(onBlockOf(y));
    check(`${f}: a literal dario-exec is on a workflow no fork can run, or keeps forks off it`,
      !prTriggered || f === 'fleet-status.yml' || /head\.repo\.full_name == github\.repository/.test(y));
  }

  let relay = '';
  try { relay = readFileSync(join(dir, 'fleet-review-relay.yml'), 'utf8'); } catch { /* checked below */ }
  const listed = (/^  workflow_run:\s*\n\s+workflows:\s*\[([^\]]*)\]/m.exec(own)?.[1] ?? '')
    .split(',').map((w) => w.trim().replace(/^['"]|['"]$/g, ''));
  check('the review relay is listed in workflow_run', /^name: Fleet review relay$/m.test(relay) && listed.includes('Fleet review relay'));
  check('the review relay fires on pull_request_review alone', /^on:\n {2}pull_request_review:\n {4}types: \[[^\]]+\]\n\n/m.test(relay));
  check('the review relay has no token and runs no action or checkout', /^permissions: \{\}$/m.test(relay) && !/\buses:/.test(relay));
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

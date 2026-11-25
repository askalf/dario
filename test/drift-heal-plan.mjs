// scripts/drift-heal-plan.mjs: how drift-pr-heal.yml reads Redline's runs and when it leaves a PR
// alone because Redline is at work on its head, the floor that keeps a renumbered version clear of
// every version another open drift PR holds, and when the open drift PRs changed under the plan.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_STATUSES, busyReason, compareVersions, FIX_RESULT_WAIT_MS, main, MAX_PAGES, pickFloor, planChange,
  readRunList, readTwice, REDLINE_WORKFLOWS, redlineRuns, scanActive,
} from '../scripts/drift-heal-plan.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}

const REPO = 'askalf/dario';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const NOW = Date.parse('2026-11-25T22:00:00Z');
const run = (over) => ({ workflow: 'redline.yml', id: 1, event: 'workflow_dispatch', status: 'in_progress', conclusion: null, display_title: '', head_sha: 'c'.repeat(40), updated_at: '2026-11-25T21:50:00Z', ...over });
const busy = (runs, pr = 1936, head = HEAD, repo = REPO) => busyReason(repo, pr, head, runs, NOW);

// A fake GitHub API: `lists` maps a workflow and query to the runs it holds; `onGet` may change
// them between calls. Runs are answered 100 a page with the list's total.
function fakeApi(lists, onGet = () => {}) {
  const calls = [];
  const get = (path) => {
    calls.push(path);
    onGet(path, calls.length);
    const m = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs\?(.*)&per_page=100&page=(\d+)$/.exec(path);
    if (!m) throw new Error(`unexpected path ${path}`);
    const rows = lists[`${m[1]}?${m[2]}`] ?? [];
    if (rows === 'fail') throw new Error('HTTP 502');
    const page = Number(m[3]);
    return { total_count: rows.length, workflow_runs: rows.slice((page - 1) * 100, page * 100) };
  };
  return { get, calls };
}
const queued = (id, over = {}) => ({ id, event: 'pull_request', status: 'queued', display_title: 'x', head_sha: 'e'.repeat(40), updated_at: '2026-11-25T21:00:00Z', ...over });

console.log('\n=== reading the run lists ===');
check('the workflows and statuses read: the review, the fix and the verdict post, every unfinished status in the order a run passes them',
  JSON.stringify(REDLINE_WORKFLOWS) === JSON.stringify(['redline.yml', 'redline-fix.yml', 'redline-post.yml'])
  && JSON.stringify(ACTIVE_STATUSES) === JSON.stringify(['requested', 'pending', 'waiting', 'queued', 'in_progress']));
{
  const many = Array.from({ length: 250 }, (_, i) => queued(i + 1, { display_title: 'y'.repeat(600) }));
  const { get, calls } = fakeApi({ 'redline.yml?status=queued': many });
  const rows = readRunList(get, REPO, 'redline.yml', 'status=queued');
  check('a list of three pages, over 128 KiB as JSON, is read whole', rows !== null && rows.length === 250 && calls.length === 3 && JSON.stringify(rows).length > 131072);
  check('a list that does not add up to its first page\'s total is unread', readRunList((p) => ({ total_count: 101, workflow_runs: /page=1$/.test(p) ? many.slice(0, 100) : [] }), REPO, 'redline.yml', 'status=queued') === null);
  check('a run id twice is unread', readRunList(() => ({ total_count: 2, workflow_runs: [queued(1), queued(1)] }), REPO, 'redline.yml', 'status=queued') === null);
  check('a page that fails, or is no run list, is unread',
    readRunList(() => { throw new Error('x'); }, REPO, 'redline.yml', 'status=queued') === null && readRunList(() => ({ total_count: 0 }), REPO, 'redline.yml', 'status=queued') === null
    && readRunList(() => ({ workflow_runs: [] }), REPO, 'redline.yml', 'status=queued') === null);
  const full = Array.from({ length: MAX_PAGES * 100 }, (_, i) => queued(i + 1));
  check(`a list that does not end within ${MAX_PAGES} pages is unread`, readRunList(fakeApi({ 'redline.yml?status=queued': full }).get, REPO, 'redline.yml', 'status=queued') === null);
}
{
  const { get } = fakeApi({ 'redline.yml?status=queued': [queued(1)] });
  check('a scan reads every status of every workflow', scanActive(get, REPO)?.length === 1);
  // A queued run moves to waiting between the waiting and queued queries of the first scan: the
  // first scan misses it, the second sees it, so the two do not match.
  const moving = { 'redline.yml?status=queued': [queued(7)] };
  const api = fakeApi(moving, (path) => {
    if (path.includes('redline.yml/runs?status=queued') && !moving.moved) {
      moving.moved = true;
      moving['redline.yml?status=waiting'] = [queued(7, { status: 'waiting' })];
      moving['redline.yml?status=queued'] = [];
    }
  });
  check('a run that moves from queued to waiting between two queries: the two scans differ, unread', readTwice(() => scanActive(api.get, REPO)) === null);
  const steady = fakeApi({ 'redline.yml?status=queued': [queued(1)] });
  check('two scans that hold the same runs: read', readTwice(() => scanActive(steady.get, REPO))?.length === 1);
  check('the per-head fix list is read with the dispatcher\'s own query, and combined with the active runs',
    redlineRuns(fakeApi({ 'redline.yml?status=queued': [queued(1)], [`redline-fix.yml?event=workflow_dispatch&head_sha=${HEAD}`]: [queued(2, { status: 'completed' })] }).get, REPO, HEAD)?.length === 2);
  const finishes = { [`redline-fix.yml?event=workflow_dispatch&head_sha=${HEAD}`]: [queued(3, { status: 'completed', updated_at: '2026-11-25T21:00:00Z' })] };
  let headReads = 0;
  const rerun = fakeApi(finishes, (path) => {
    if (path.includes('head_sha=') && ++headReads === 2) finishes[`redline-fix.yml?event=workflow_dispatch&head_sha=${HEAD}`] = [queued(3, { status: 'completed', updated_at: '2026-11-25T21:30:00Z' })];
  });
  check('a finished run whose finish changes between the two reads (a re-run): unread', redlineRuns(rerun.get, REPO, HEAD) === null);
  check('a list that fails: unread', redlineRuns(fakeApi({ 'redline-post.yml?status=pending': 'fail' }).get, REPO, HEAD) === null);
}

console.log('\n=== busyReason: runs not finished ===');
check('runs that could not be listed: busy', /could not be listed/.test(busy(null)));
check('nothing running: free', busy([]) === '');
check('a dispatched review of this PR at this head: busy', /reviewing this head/.test(busy([run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })])));
check('a dispatched re-read of this PR at this head: busy', /reviewing this head/.test(busy([run({ status: 'queued', display_title: `Redline review ${REPO}#1936 @ ${HEAD} (re-read)` })])));
check('a dispatched review that names the head by a short prefix: busy', busy([run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD.slice(0, 7)}` })]) !== '');
check('a dispatched fix of this PR at this head: busy', /fixing this head/.test(busy([run({ workflow: 'redline-fix.yml', display_title: `Redline fix ${REPO}#1936 @ ${HEAD}` })])));
check('a dispatched review of an older head of this PR: free (Redline drops that review either way)', busy([run({ display_title: `Redline review ${REPO}#1936 @ ${OTHER}` })]) === '');
check('another PR whose number starts with this one: free', busy([run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })], 193) === '');
check('another repository with the same PR number: free', busy([run({ display_title: `Redline review askalf/dario-fork#1936 @ ${HEAD}` })]) === '');
check('a review title on the fix workflow, or a fix title on the review workflow: free',
  busy([run({ workflow: 'redline-fix.yml', display_title: `Redline review ${REPO}#1936 @ ${HEAD}` }), run({ display_title: `Redline fix ${REPO}#1936 @ ${HEAD}` })]) === '');
check('a review on pull_request at this head: busy, whatever its title', /reviewing this head/.test(busy([run({ event: 'pull_request', display_title: 'chore(drift): maxTested 2.1.333', head_sha: HEAD })])));
check('a pull_request run of another PR whose title names this PR and head: free (any author writes that title)',
  busy([run({ event: 'pull_request', display_title: `Redline review ${REPO}#1936 @ ${HEAD}`, head_sha: OTHER })]) === '');
check('a verdict post not finished: busy for every PR', /posting a verdict/.test(busy([run({ workflow: 'redline-post.yml', event: 'workflow_run', status: 'waiting', head_sha: OTHER })], 7)));
check('a repository name with regex characters is matched literally',
  busy([run({ display_title: `Redline review askalf/dario#1936 @ ${HEAD}` })], 1936, HEAD, 'askalf/da.io') === ''
  && busy([run({ display_title: `Redline review askalf/da.io#1936 @ ${HEAD}` })], 1936, HEAD, 'askalf/da.io') !== '');
check('a head that is not a commit id: busy (nothing is pushed on a guess)', busy([], 1936, 'main') !== '');

console.log('\n=== busyReason: a fix run that finished holds its head for the wait ===');
const done = (over) => run({ workflow: 'redline-fix.yml', status: 'completed', conclusion: 'success', display_title: `Redline fix ${REPO}#1936 @ ${HEAD}`, head_sha: HEAD, updated_at: '2026-11-25T21:40:00Z', ...over });
check('a fix run finished at this head lately: busy, and the reason says until when', /waited for until 2026-11-26T03:40:00\.000Z/.test(busy([done({})])), busy([done({})]));
check('a fix run that failed holds it too (the dispatcher refuses it after the run)', busy([done({ conclusion: 'failure' })]) !== '');
check('finished longer ago than the wait: free', busy([done({ updated_at: new Date(NOW - FIX_RESULT_WAIT_MS - 60_000).toISOString() })]) === '');
check('a re-run whose latest attempt finished lately holds the head, however old the run', busy([done({ updated_at: new Date(NOW - 5 * 60_000).toISOString() })]) !== '');
check('a finish time that cannot be read: busy', /cannot be read/.test(busy([done({ updated_at: null })])));
check('cancelled or skipped: nothing to apply, free', busy([done({ conclusion: 'cancelled' }), done({ conclusion: 'skipped' })]) === '');
check('a finished fix run of an older head: free (an applied fix moved the head)', busy([done({ display_title: `Redline fix ${REPO}#1936 @ ${OTHER}` })]) === '');
check('a finished fix run dispatched from another ref (its head commit is not this head): free, the dispatcher never applies it here', busy([done({ head_sha: OTHER })]) === '');
check('a finished review: free', busy([run({ status: 'completed', conclusion: 'success', display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })]) === '');

console.log('\n=== pickFloor ===');
check('versions compare by number', compareVersions('1.0.10', '1.0.9') === 1 && compareVersions('2.0.0', '10.0.0') === -1 && compareVersions('1.2.3', '1.2.3') === 0);
check('a version above the floor that no other PR holds keeps the floor', pickFloor('1.0.5', '1.0.7', ['1.0.6']) === '1.0.5');
check('a version at the floor: the floor as it is when the next version is free', pickFloor('1.0.5', '1.0.5', []) === '1.0.5');
check('the next version held by an up-to-date PR: the floor steps over it', pickFloor('1.0.5', '1.0.5', ['1.0.6']) === '1.0.6');
check('a run of held versions: the floor steps over every one', pickFloor('1.0.5', '1.0.4', ['1.0.6', '1.0.7', '1.0.9']) === '1.0.7');
check('a version above the floor but held by another PR: renumbered above it', pickFloor('1.0.5', '1.0.7', ['1.0.7']) === '1.0.7' && pickFloor('1.0.5', '1.0.7', ['1.0.7', '1.0.8']) === '1.0.8');
let threw = false;
try { pickFloor('1.0.5', 'x', []); } catch { threw = true; }
check('a version that is not x.y.z: refused', threw);

console.log('\n=== planChange ===');
const plan = { 11: [HEAD], 12: ['d'.repeat(40), 'e'.repeat(40)] };
check('the same PRs at the planned heads: no change', planChange(plan, [{ number: 11, headRefOid: HEAD }, { number: 12, headRefOid: 'e'.repeat(40) }]) === '');
check('a PR this run pushed may show either its old or its new head', planChange(plan, [{ number: 11, headRefOid: HEAD }, { number: 12, headRefOid: 'd'.repeat(40) }]) === '');
check('a head that moved otherwise: a change', /#11 moved/.test(planChange(plan, [{ number: 11, headRefOid: OTHER }, { number: 12, headRefOid: 'd'.repeat(40) }])));
check('a drift PR opened since: a change', /#13 was opened/.test(planChange(plan, [{ number: 11, headRefOid: HEAD }, { number: 12, headRefOid: 'd'.repeat(40) }, { number: 13, headRefOid: OTHER }])));
check('a drift PR closed since: a change', /#12 is no longer open/.test(planChange(plan, [{ number: 11, headRefOid: HEAD }])));
{
  const listed = (over) => [{ number: 11, headRefOid: HEAD, isDraft: false, baseRefName: 'master', ...over }, { number: 12, headRefOid: 'd'.repeat(40), isDraft: false, baseRefName: 'master' }];
  check('the PR about to be pushed, unchanged: no change', planChange(plan, listed({}), { number: 11, base: 'master' }) === '');
  check('the PR about to be pushed is now a draft, its head unchanged: a change', /#11 is now a draft/.test(planChange(plan, listed({ isDraft: true }), { number: 11, base: 'master' })));
  check('the PR about to be pushed now targets another base, its head unchanged: a change', /#11 now targets release/.test(planChange(plan, listed({ baseRefName: 'release' }), { number: 11, base: 'master' })));
}

console.log('\n=== the command line ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-heal-plan-'));
  try {
    const runs = join(dir, 'runs.json');
    const held = join(dir, 'held.json');
    const expected = join(dir, 'expected.json');
    const drift = join(dir, 'drift.json');
    writeFileSync(runs, JSON.stringify([run({ event: 'pull_request', head_sha: HEAD })]));
    writeFileSync(held, JSON.stringify(['1.0.6']));
    let out = '';
    const say = (s) => { out += s; };
    check('busy prints the reason', main(['busy', REPO, '1936', HEAD, runs], say, NOW) === 0 && /reviewing this head\n$/.test(out), out);
    out = '';
    const api = fakeApi({ 'redline.yml?status=in_progress': [queued(9, { status: 'in_progress', head_sha: HEAD })] });
    check('check reads the runs itself and prints the reason', main(['check', REPO, '1936', HEAD], say, NOW, api.get) === 0 && /reviewing this head\n$/.test(out) && api.calls.length > 15, out);
    out = '';
    check('check on runs that cannot be read prints a reason', main(['check', REPO, '1936', HEAD], say, NOW, () => { throw new Error('down'); }) === 0 && /could not be listed/.test(out), out);
    out = '';
    check('check on nothing running prints nothing', main(['check', REPO, '1936', HEAD], say, NOW, fakeApi({}).get) === 0 && out === '');
    out = '';
    check('floor prints the floor', main(['floor', '1.0.5', '1.0.5', held], say) === 0 && out === '1.0.6\n', out);
    out = '';
    writeFileSync(expected, JSON.stringify({ 11: [HEAD] }));
    writeFileSync(drift, JSON.stringify([{ number: 11, headRefOid: OTHER }]));
    check('changed prints the change', main(['changed', expected, drift], say) === 0 && /#11 moved/.test(out), out);
    out = '';
    writeFileSync(drift, JSON.stringify([{ number: 11, headRefOid: HEAD }]));
    check('changed on no change prints nothing', main(['changed', expected, drift], say) === 0 && out === '');
    check('bad arguments: exit 2',
      main(['busy', REPO, 'x', HEAD, runs], say) === 2 && main(['check', REPO, 'x', HEAD], say) === 2 && main(['check', 'not a repo', '1', HEAD], say) === 2
      && main(['floor', '1.0.5'], say) === 2 && main(['floor', '1.0.5', 'nope', held], say) === 2 && main(['changed', drift, drift], say) === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

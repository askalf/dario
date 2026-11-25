// scripts/drift-heal-plan.mjs: when drift-pr-heal.yml leaves a PR alone because Redline is at work
// on its head, the floor that keeps a renumbered version clear of every version another open drift
// PR holds, and when the open drift PRs changed under the plan.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_STATUSES, busyReason, compareVersions, FIX_RESULT_WAIT_MS, main, pickFloor, planChange, REDLINE_WORKFLOWS } from '../scripts/drift-heal-plan.mjs';

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
const busy = (runs, comments = [], pr = 1936, head = HEAD, repo = REPO) => busyReason(repo, pr, head, runs, comments, NOW);

console.log('\n=== busyReason: runs not finished ===');
check('the workflows it reads are the review, the fix and the verdict post, and the statuses are the unfinished ones',
  JSON.stringify(REDLINE_WORKFLOWS) === JSON.stringify(['redline.yml', 'redline-fix.yml', 'redline-post.yml'])
  && JSON.stringify(ACTIVE_STATUSES) === JSON.stringify(['queued', 'in_progress', 'waiting', 'requested', 'pending']));
check('runs that could not be listed: busy', /could not be listed/.test(busy(null)));
check('nothing running: free', busy([]) === '');
check('a dispatched review of this PR at this head: busy', /reviewing this head/.test(busy([run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })])));
check('a dispatched re-read of this PR at this head: busy', /reviewing this head/.test(busy([run({ status: 'queued', display_title: `Redline review ${REPO}#1936 @ ${HEAD} (re-read)` })])));
check('a dispatched review that names the head by a short prefix: busy', busy([run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD.slice(0, 7)}` })]) !== '');
check('a dispatched fix of this PR at this head: busy', /fixing this head/.test(busy([run({ workflow: 'redline-fix.yml', display_title: `Redline fix ${REPO}#1936 @ ${HEAD}` })])));
check('a dispatched review of an older head of this PR: free (Redline drops that review either way)', busy([run({ display_title: `Redline review ${REPO}#1936 @ ${OTHER}` })]) === '');
check('another PR whose number starts with this one: free', busy([run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })], [], 193) === '');
check('another repository with the same PR number: free', busy([run({ display_title: `Redline review askalf/dario-fork#1936 @ ${HEAD}` })]) === '');
check('a review title on the fix workflow, or a fix title on the review workflow: free',
  busy([run({ workflow: 'redline-fix.yml', display_title: `Redline review ${REPO}#1936 @ ${HEAD}` }), run({ display_title: `Redline fix ${REPO}#1936 @ ${HEAD}` })]) === '');
check('a review on pull_request at this head: busy, whatever its title', /reviewing this head/.test(busy([run({ event: 'pull_request', display_title: 'chore(drift): maxTested 2.1.333', head_sha: HEAD })])));
check('a pull_request run of another PR whose title names this PR and head: free (any author writes that title)',
  busy([run({ event: 'pull_request', display_title: `Redline review ${REPO}#1936 @ ${HEAD}`, head_sha: OTHER })]) === '');
check('a verdict post not finished: busy for every PR', /posting a verdict/.test(busy([run({ workflow: 'redline-post.yml', event: 'workflow_run', status: 'waiting', head_sha: OTHER })], [], 7)));
check('a repository name with regex characters is matched literally',
  busy([run({ display_title: `Redline review askalf/dario#1936 @ ${HEAD}` })], [], 1936, HEAD, 'askalf/da.io') === ''
  && busy([run({ display_title: `Redline review askalf/da.io#1936 @ ${HEAD}` })], [], 1936, HEAD, 'askalf/da.io') !== '');
check('a head that is not a commit id: busy (nothing is pushed on a guess)', busy([], [], 1936, 'main') !== '');

console.log('\n=== busyReason: a fix run that finished, until the platform answers it ===');
const done = (over) => run({ workflow: 'redline-fix.yml', status: 'completed', conclusion: 'success', display_title: `Redline fix ${REPO}#1936 @ ${HEAD}`, updated_at: '2026-11-25T21:40:00Z', ...over });
check('a fix run finished at this head, not answered yet: busy', /not yet applied or refused at this head/.test(busy([done({})])));
check('a fix run that failed is answered too before the head is free (the dispatcher refuses it with a comment)', busy([done({ conclusion: 'failure' })]) !== '');
check('answered "Fix not applied at" this head: free', busy([done({})], [`## Fix not applied at ${HEAD}: refused`]) === '');
check('answered "Fix refused at" this head: free', busy([done({})], [`## Fix refused at ${HEAD}: run 1 uploaded no fix artifact`]) === '');
check('answered "Description updated at" this head: free', busy([done({})], [`## Description updated at ${HEAD}`]) === '');
check('an answer for another head does not count: busy', busy([done({})], [`## Fix not applied at ${OTHER}: refused`]) !== '');
check('the comments could not be read: busy', /comments could not be read/.test(busy([done({})], null)));
check('finished longer ago than the wait: free', busy([done({ updated_at: new Date(NOW - FIX_RESULT_WAIT_MS - 60_000).toISOString() })]) === '');
check('a finish time that cannot be read: busy (the wait is not assumed over)', busy([done({ updated_at: null })]) !== '');
check('cancelled or skipped: nothing to apply, free', busy([done({ conclusion: 'cancelled' }), done({ conclusion: 'skipped' })]) === '');
check('a finished fix run of an older head: free (an applied fix moved the head)', busy([done({ display_title: `Redline fix ${REPO}#1936 @ ${OTHER}` })]) === '');
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

console.log('\n=== the command line ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-heal-plan-'));
  try {
    const runs = join(dir, 'runs.json');
    const comments = join(dir, 'comments.json');
    const held = join(dir, 'held.json');
    const expected = join(dir, 'expected.json');
    const drift = join(dir, 'drift.json');
    writeFileSync(runs, JSON.stringify([run({ event: 'pull_request', head_sha: HEAD })]));
    writeFileSync(comments, '[]');
    writeFileSync(held, JSON.stringify(['1.0.6']));
    let out = '';
    const say = (s) => { out += s; };
    check('busy prints the reason', main(['busy', REPO, '1936', HEAD, runs, comments], say, NOW) === 0 && /reviewing this head\n$/.test(out), out);
    out = '';
    writeFileSync(runs, 'null');
    check('busy on runs that could not be listed prints a reason', main(['busy', REPO, '1936', HEAD, runs, comments], say, NOW) === 0 && out !== '', out);
    out = '';
    writeFileSync(runs, '[]');
    check('busy on nothing running prints nothing', main(['busy', REPO, '1936', HEAD, runs, comments], say, NOW) === 0 && out === '');
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
      main(['busy', REPO, 'x', HEAD, runs, comments], say) === 2 && main(['busy', REPO, '1936', HEAD, runs], say) === 2
      && main(['floor', '1.0.5'], say) === 2 && main(['floor', '1.0.5', 'nope', held], say) === 2 && main(['changed', drift, drift], say) === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// scripts/drift-heal-plan.mjs: when drift-pr-heal.yml leaves a PR alone because Redline is at work
// on its head, and the floor that keeps a renumbered version clear of every version another open
// drift PR holds.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busyReason, compareVersions, main, pickFloor, REDLINE_WORKFLOWS } from '../scripts/drift-heal-plan.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}

const REPO = 'askalf/dario';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (over) => ({ workflow: 'redline.yml', id: 1, event: 'workflow_dispatch', status: 'in_progress', display_title: '', head_sha: 'c'.repeat(40), ...over });

console.log('\n=== busyReason ===');
check('the workflows it reads are the review, the fix and the verdict post', JSON.stringify(REDLINE_WORKFLOWS) === JSON.stringify(['redline.yml', 'redline-fix.yml', 'redline-post.yml']));
check('runs that could not be listed: busy', /could not be listed/.test(busyReason(REPO, 1936, HEAD, null)));
check('nothing running: free', busyReason(REPO, 1936, HEAD, []) === '');
check('a dispatched review of this PR at this head: busy',
  /reviewing this head/.test(busyReason(REPO, 1936, HEAD, [run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })])));
check('a dispatched re-read of this PR at this head: busy',
  /reviewing this head/.test(busyReason(REPO, 1936, HEAD, [run({ status: 'queued', display_title: `Redline review ${REPO}#1936 @ ${HEAD} (re-read)` })])));
check('a dispatched review that names the head by a short prefix: busy',
  busyReason(REPO, 1936, HEAD, [run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD.slice(0, 7)}` })]) !== '');
check('a dispatched fix of this PR at this head: busy',
  /fixing this head/.test(busyReason(REPO, 1936, HEAD, [run({ workflow: 'redline-fix.yml', display_title: `Redline fix ${REPO}#1936 @ ${HEAD}` })])));
check('a dispatched review of an older head of this PR: free (Redline drops that review either way)',
  busyReason(REPO, 1936, HEAD, [run({ display_title: `Redline review ${REPO}#1936 @ ${OTHER}` })]) === '');
check('another PR whose number starts with this one: free',
  busyReason(REPO, 193, HEAD, [run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })]) === '');
check('another repository with the same PR number: free',
  busyReason(REPO, 1936, HEAD, [run({ display_title: `Redline review askalf/dario-fork#1936 @ ${HEAD}` })]) === '');
check('a review title on the fix workflow, or a fix title on the review workflow: free',
  busyReason(REPO, 1936, HEAD, [run({ workflow: 'redline-fix.yml', display_title: `Redline review ${REPO}#1936 @ ${HEAD}` }), run({ display_title: `Redline fix ${REPO}#1936 @ ${HEAD}` })]) === '');
check('a review on pull_request at this head: busy, whatever its title',
  /reviewing this head/.test(busyReason(REPO, 1936, HEAD, [run({ event: 'pull_request', display_title: 'chore(drift): maxTested 2.1.333', head_sha: HEAD })])));
check('a pull_request run of another PR whose title names this PR and head: free (any author writes that title)',
  busyReason(REPO, 1936, HEAD, [run({ event: 'pull_request', display_title: `Redline review ${REPO}#1936 @ ${HEAD}`, head_sha: OTHER })]) === '');
check('a verdict post running: busy for every PR',
  /posting a verdict/.test(busyReason(REPO, 7, HEAD, [run({ workflow: 'redline-post.yml', event: 'workflow_run', head_sha: OTHER })])));
check('a completed run: free', busyReason(REPO, 1936, HEAD, [run({ status: 'completed', display_title: `Redline review ${REPO}#1936 @ ${HEAD}` })]) === '');
check('a repository name with regex characters is matched literally',
  busyReason('askalf/da.io', 1936, HEAD, [run({ display_title: `Redline review askalf/dario#1936 @ ${HEAD}` })]) === ''
  && busyReason('askalf/da.io', 1936, HEAD, [run({ display_title: `Redline review askalf/da.io#1936 @ ${HEAD}` })]) !== '');
check('a head that is not a commit id: busy (nothing is pushed on a guess)', busyReason(REPO, 1936, 'main', []) !== '');

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

console.log('\n=== the command line ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-heal-plan-'));
  const runs = join(dir, 'runs.json');
  const held = join(dir, 'held.json');
  writeFileSync(runs, JSON.stringify([run({ event: 'pull_request', head_sha: HEAD })]));
  writeFileSync(held, JSON.stringify(['1.0.6']));
  let out = '';
  const say = (s) => { out += s; };
  check('busy prints the reason', main(['busy', REPO, '1936', HEAD, runs], say) === 0 && /reviewing this head\n$/.test(out), out);
  out = '';
  writeFileSync(runs, 'null');
  check('busy on runs that could not be listed prints a reason', main(['busy', REPO, '1936', HEAD, runs], say) === 0 && out !== '', out);
  out = '';
  writeFileSync(runs, '[]');
  check('busy on nothing running prints nothing', main(['busy', REPO, '1936', HEAD, runs], say) === 0 && out === '');
  out = '';
  check('floor prints the floor', main(['floor', '1.0.5', '1.0.5', held], say) === 0 && out === '1.0.6\n', out);
  check('bad arguments: exit 2', main(['busy', REPO, 'x', HEAD, runs], say) === 2 && main(['floor', '1.0.5'], say) === 2 && main(['floor', '1.0.5', 'nope', held], say) === 2);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

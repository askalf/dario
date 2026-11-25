// scripts/drift-heal-busy.mjs: which drift PRs drift-pr-heal.yml leaves alone because Redline is at
// work on their head, and the version a busy PR keeps reserved. Run records here carry the commit
// they execute, which for a dispatched review or fix is the default branch, not the PR's head.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { busyReason, plan, REDLINE_WORKFLOWS } from '../scripts/drift-heal-busy.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}

const REPO = 'askalf/dario';
const HEAD = 'd6e03a7070d3c76f16916389c0aa53f56abd81f1';
const MASTER = '978ded3a1d9d4c2b8f0e1a2b3c4d5e6f7a8b9c0d';
const run = (patch) => ({ id: 1, path: '.github/workflows/redline.yml', display_title: 'x', head_sha: MASTER, event: 'workflow_dispatch', status: 'in_progress', ...patch });

console.log('\n=== busyReason ===');
check('a re-read dispatched on master for this PR, whatever commit it executes', /re-read.*is in_progress/.test(busyReason(REPO, 1936, HEAD,
  [run({ display_title: `Redline review ${REPO}#1936 @ ${HEAD} (re-read)` })])));
check('a fix dispatched for this PR, named by its run-name', /Redline fix/.test(busyReason(REPO, 1936, HEAD,
  [run({ path: '.github/workflows/redline-fix.yml', display_title: `Redline fix ${REPO}#1936 @ ${HEAD}`, head_sha: HEAD, status: 'queued' })])));
check('the review the PR\'s own push started, matched by its head', /review of d6e03a7/.test(busyReason(REPO, 1936, HEAD,
  [run({ display_title: 'auto-rebake: template drift detected', event: 'pull_request', head_sha: HEAD })])));
check('a verdict post running on master counts, its PR not being known', /verdict post/.test(busyReason(REPO, 1936, HEAD,
  [run({ path: '.github/workflows/redline-post.yml', display_title: 'Redline post', event: 'workflow_run' })])));
check('another PR\'s review is not this PR\'s, also one whose number starts the same', busyReason(REPO, 1936, HEAD, [
  run({ display_title: `Redline review ${REPO}#19360 @ ${HEAD}` }),
  run({ display_title: `Redline review ${REPO}#21936 @ ${HEAD}` }),
  run({ display_title: 'some other PR', event: 'pull_request', head_sha: 'f'.repeat(40) }),
]) === '');
check('a run of another workflow does not count', busyReason(REPO, 1936, HEAD, [run({ path: '.github/workflows/ci.yml', display_title: `${REPO}#1936 @ ${HEAD}` })]) === '');
check('no runs: not busy', busyReason(REPO, 1936, HEAD, []) === '');
check('runs that could not be listed: busy', /could not be listed/.test(busyReason(REPO, 1936, HEAD, null)));
check('the three workflows are the ones the heal lists', REDLINE_WORKFLOWS.join() === '.github/workflows/redline.yml,.github/workflows/redline-fix.yml,.github/workflows/redline-post.yml');

console.log('\n=== plan: busy PRs keep their versions reserved, in either order ===');
const runs = [run({ display_title: `Redline review ${REPO}#7 @ ${'a'.repeat(40)}` })];
const busyFirst = [{ number: 7, head_sha: 'a'.repeat(40), version: '1.0.5' }, { number: 8, head_sha: 'b'.repeat(40), version: '1.0.4' }];
const p1 = plan(REPO, busyFirst, runs);
const p2 = plan(REPO, [...busyFirst].reverse(), runs);
check('the busy PR is named, the other is not', Object.keys(p1.busy).join() === '7' && Object.keys(p2.busy).join() === '7', JSON.stringify(p1));
check('its version is the floor, whichever comes first', p1.floor === '1.0.5' && p2.floor === '1.0.5', `${p1.floor} ${p2.floor}`);
const two = [{ number: 7, head_sha: 'a'.repeat(40), version: '1.0.9' }, { number: 9, head_sha: 'c'.repeat(40), version: '1.0.10' }];
const p3 = plan(REPO, two, [...runs, run({ display_title: `Redline fix ${REPO}#9 @ ${'c'.repeat(40)}` })]);
check('two busy PRs: the higher version by number, not by text (1.0.10 over 1.0.9)', p3.floor === '1.0.10' && Object.keys(p3.busy).length === 2, JSON.stringify(p3));
check('nothing busy: no floor', plan(REPO, busyFirst, []).floor === '' && Object.keys(plan(REPO, busyFirst, []).busy).length === 0);
const pNull = plan(REPO, busyFirst, null);
check('runs not listed: every PR busy, and the highest version reserved', Object.keys(pNull.busy).length === 2 && pNull.floor === '1.0.5');

console.log('\n=== the command line the workflow calls ===');
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'drift-heal-busy.mjs');
const dir = mkdtempSync(join(tmpdir(), 'dario-heal-busy-'));
writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
writeFileSync(join(dir, 'null.json'), 'null');
writeFileSync(join(dir, 'candidates.json'), JSON.stringify(busyFirst));
const cli = (...a) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8' });
check('plan prints the busy PRs and the floor as JSON', JSON.parse(cli('plan', REPO, join(dir, 'candidates.json'), join(dir, 'runs.json'))).floor === '1.0.5');
check('check prints why a busy PR is busy', /Redline review/.test(cli('check', REPO, '7', 'a'.repeat(40), join(dir, 'runs.json'))));
check('and nothing for one that is not', cli('check', REPO, '8', 'b'.repeat(40), join(dir, 'runs.json')) === '');
check('runs not listed (null): check says so', /could not be listed/.test(cli('check', REPO, '8', 'b'.repeat(40), join(dir, 'null.json'))));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Tests for the "Check the open rebake PR against live" step of
// cc-drift-template-watch.yml, run as the shell it is.
//
// rebakePrAction is tested on its own in bake-drift-report.mjs. What it cannot
// see is the shell around it: which bundle the captures run against, whether
// master's bundle and drift summary are put back, what the step outputs, and
// whether `gh pr close` is reached. The step only runs on the self-hosted
// runner, so nothing else in CI exercises it.
//
// The run block is read out of the workflow and executed in a staged clone,
// with capture-and-bake.mjs and gh replaced by stubs that follow a plan and
// record what they were asked.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'cc-drift-template-watch.yml'), 'utf8');
const PR_BRANCH = 'bot/template-rebake-20260101-000000';
const MASTER_BUNDLE = JSON.stringify({ _bundle: 'master' }, null, 2) + '\n';
const PR_BUNDLE = JSON.stringify({ _bundle: 'pr' }, null, 2) + '\n';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

if (process.platform === 'win32') {
  console.log('  SKIP: the step is bash with GNU date, run on Linux');
  process.exit(0);
}

/** The step's `run: |` block, dedented. */
function stepScript(name) {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at === -1) return null;
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  if (runAt === -1) return null;
  const runIndent = lines[runAt].search(/\S/);
  const body = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== '' && l.search(/\S/) <= runIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n') + '\n';
}

const SCRIPT = stepScript('Check the open rebake PR against live');
const STALE_AFTER_HOURS = /STALE_AFTER_HOURS: '(\d+)'/.exec(WORKFLOW)?.[1];

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

// Follows capture-plan.json one entry per call, the way --check would: it
// removes and rewrites the tripwire and the summary, writes label-target.txt on
// exit 3, and records which bundle it read.
const CAPTURE_STUB = `import { readFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync('capture-plan.json', 'utf8'));
const n = existsSync('capture-count') ? Number(readFileSync('capture-count', 'utf8')) : 0;
writeFileSync('capture-count', String(n + 1));
appendFileSync('capture-seen.txt', JSON.parse(readFileSync('src/cc-template-data.json', 'utf8'))._bundle + '\\n');
const step = plan[n] ?? { code: 1 };
rmSync('issue-881-tripwire.txt', { force: true });
if (step.residue) writeFileSync('issue-881-tripwire.txt', 'hit\\n');
rmSync('drift-summary.md', { force: true });
if (step.code === 2 && !step.noSummary) writeFileSync('drift-summary.md', 'pr drift summary ' + (n + 1) + '\\n');
if (step.code === 3) writeFileSync('label-target.txt', '2.1.999\\n');
console.error('[bake] check: stub capture ' + (n + 1) + ' exit ' + step.code);
process.exit(step.code);
`;

const GH_STUB = `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1" = pr ] && [ "$2" = list ]; then printf '%s\\n' "$GH_PR_LIST"; fi
if [ "$1" = pr ] && [ "$2" = comment ]; then cat "$5" > "$GH_COMMENT"; fi
exit 0
`;

function runStep({ ageHours = 5, masterCheck = '2', plan = [], absent = false, labelTarget = null }) {
  const root = mkdtempSync(join(tmpdir(), 'dario-rebake-pr-step-'));
  const origin = join(root, 'origin');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(join(origin, 'src'), { recursive: true });
  mkdirSync(bin);

  git(origin, 'init', '-q');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/master');
  writeFileSync(join(origin, 'src', 'cc-template-data.json'), MASTER_BUNDLE);
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'master');
  git(origin, 'checkout', '-q', '-b', PR_BRANCH);
  writeFileSync(join(origin, 'src', 'cc-template-data.json'), PR_BUNDLE);
  git(origin, 'commit', '-q', '-am', 'rebake');
  git(origin, 'checkout', '-q', 'master');
  git(root, 'clone', '-q', `file://${origin}`, 'work');

  mkdirSync(join(work, 'scripts'));
  for (const f of ['drift-report.mjs', 'rebake-pr-action.mjs']) copyFileSync(join(ROOT, 'scripts', f), join(work, 'scripts', f));
  writeFileSync(join(work, 'scripts', 'capture-and-bake.mjs'), CAPTURE_STUB);
  writeFileSync(join(work, 'capture-plan.json'), JSON.stringify(plan));
  // The check against master ran first and left its summary for the drift issue.
  writeFileSync(join(work, 'drift-summary.md'), 'master summary\n');
  if (labelTarget) writeFileSync(join(work, 'label-target.txt'), labelTarget);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);

  const created = new Date(Date.now() - ageHours * 3600e3 - 5 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prList = absent ? 'null' : JSON.stringify({ number: 41, headRefName: PR_BRANCH, url: 'https://github.com/askalf/dario/pull/41', createdAt: created, isCrossRepository: false });
  const scriptPath = join(root, 'step.sh');
  writeFileSync(scriptPath, SCRIPT);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
      GITHUB_OUTPUT: join(root, 'output'),
      GH_LOG: join(root, 'gh.log'),
      GH_COMMENT: join(root, 'comment.md'),
      GH_PR_LIST: prList,
      GH_TOKEN: 'stub',
      STALE_AFTER_HOURS,
      MASTER_CHECK: masterCheck,
      RUN_URL: 'https://example.invalid/run',
    },
  });
  if (r.error) {
    console.log(`  SKIP: no bash available: ${r.error.message}`);
    process.exit(0);
  }
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const outputs = Object.fromEntries((read(join(root, 'output')) ?? '').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return {
    status: r.status,
    log: r.stdout + r.stderr,
    outputs,
    gh: (read(join(root, 'gh.log')) ?? '').split('\n').filter(Boolean),
    comment: read(join(root, 'comment.md')),
    seen: (read(join(work, 'capture-seen.txt')) ?? '').split('\n').filter(Boolean),
    bundle: read(join(work, 'src', 'cc-template-data.json')),
    treeClean: git(work, 'status', '--porcelain', '--', 'src').stdout === '',
    driftSummary: read(join(work, 'drift-summary.md')),
    labelTarget: read(join(work, 'label-target.txt')),
    leftovers: ['pr-bundle.json', 'drift-summary.keep'].filter((f) => existsSync(join(work, f))),
  };
}

const closed = (r) => r.gh.some((l) => l === 'pr close 41 --delete-branch');
const restored = (r) => r.bundle === MASTER_BUNDLE && r.treeClean && r.driftSummary === 'master summary\n' && r.leftovers.length === 0;

header('the step is in the workflow');
{
  check('found the run block', SCRIPT !== null && SCRIPT.includes('rebake-pr-action.mjs'));
  check('found STALE_AFTER_HOURS', STALE_AFTER_HOURS !== undefined);
  if (SCRIPT === null || STALE_AFTER_HOURS === undefined) {
    console.log(`\n${pass} pass, ${fail} fail`);
    process.exit(1);
  }
}

header('no open rebake PR');
{
  const r = runStep({ absent: true, plan: [{ code: 2 }, { code: 2 }] });
  check('exits 0', r.status === 0, r.log);
  check('state=none', r.outputs.state === 'none', JSON.stringify(r.outputs));
  check('no capture is made', r.seen.length === 0, r.seen.join(','));
  check('nothing is closed', !closed(r), r.gh.join(' | '));
  check('master summary untouched', r.driftSummary === 'master summary\n');
}

header('a PR younger than the threshold');
{
  const r = runStep({ ageHours: 1, plan: [{ code: 2 }, { code: 2 }] });
  check('exits 0', r.status === 0, r.log);
  check('no capture is made', r.seen.length === 0, r.seen.join(','));
  check('state=open with the PR named', r.outputs.state === 'open' && r.outputs.pr_number === '41' && r.outputs.pr_url === 'https://github.com/askalf/dario/pull/41', JSON.stringify(r.outputs));
  check('nothing is closed', !closed(r), r.gh.join(' | '));
  check('master bundle and summary in place', restored(r), JSON.stringify(r));
}

header('two captures report drift, master has drifted too: replace');
{
  const r = runStep({ masterCheck: '2', plan: [{ code: 2 }, { code: 2 }] });
  check('exits 0', r.status === 0, r.log);
  check('both captures read the PR bundle, not master', r.seen.join(',') === 'pr,pr', r.seen.join(','));
  check('master bundle and summary are put back', restored(r), JSON.stringify(r));
  check('state=closed', r.outputs.state === 'closed', JSON.stringify(r.outputs));
  check('the PR is closed and its branch deleted', closed(r), r.gh.join(' | '));
  check('the comment says a fresh bake follows', (r.comment ?? '').includes('this run bakes again'), r.comment);
  check('the comment carries the PR check summary, not master', (r.comment ?? '').includes('pr drift summary 2') && !(r.comment ?? '').includes('master summary'), r.comment);
}

header('two captures report drift, live matches master: close');
{
  const r = runStep({ masterCheck: '0', plan: [{ code: 2 }, { code: 2 }] });
  check('exits 0', r.status === 0, r.log);
  check('both captures read the PR bundle', r.seen.join(',') === 'pr,pr', r.seen.join(','));
  check('master bundle and summary are put back', restored(r), JSON.stringify(r));
  check('state=closed', r.outputs.state === 'closed', JSON.stringify(r.outputs));
  check('the PR is closed', closed(r), r.gh.join(' | '));
  check('the comment says there is nothing to re-bake', (r.comment ?? '').includes('nothing to re-bake'), r.comment);
}

header('without a summary the comment quotes the check lines');
{
  const r = runStep({ masterCheck: '2', plan: [{ code: 2, noSummary: true }, { code: 2, noSummary: true }] });
  check('the PR is closed', closed(r), r.gh.join(' | '));
  check('the comment carries both [bake] check lines', (r.comment ?? '').includes('[bake] check: stub capture 1 exit 2') && (r.comment ?? '').includes('[bake] check: stub capture 2 exit 2'), r.comment);
}

header('drift the second capture does not confirm');
for (const [label, second] of [['clean', 0], ['label only', 3], ['failed', 1]]) {
  const r = runStep({ masterCheck: '2', plan: [{ code: 2 }, { code: second }] });
  check(`${label} second capture: exits 0`, r.status === 0, r.log);
  check(`${label} second capture: two captures of the PR bundle`, r.seen.join(',') === 'pr,pr', r.seen.join(','));
  check(`${label} second capture: the PR is kept`, r.outputs.state === 'open' && r.outputs.pr_number === '41' && !closed(r), `${JSON.stringify(r.outputs)} ${r.gh.join(' | ')}`);
  check(`${label} second capture: master bundle and summary are put back`, restored(r), JSON.stringify(r));
}

header('a first capture that matches or fails is not repeated');
for (const [label, code] of [['clean', 0], ['failed', 1]]) {
  const r = runStep({ masterCheck: '2', plan: [{ code }, { code: 2 }] });
  check(`${label}: one capture`, r.seen.join(',') === 'pr', r.seen.join(','));
  check(`${label}: the PR is kept`, r.outputs.state === 'open' && !closed(r), `${JSON.stringify(r.outputs)} ${r.gh.join(' | ')}`);
  check(`${label}: master bundle and summary are put back`, restored(r), JSON.stringify(r));
}

header('the #881 residue never closes a PR');
for (const [label, plan] of [['on the first capture', [{ code: 2, residue: true }, { code: 2 }]], ['on the second capture', [{ code: 2 }, { code: 2, residue: true }]]]) {
  const r = runStep({ masterCheck: '2', plan });
  check(`${label}: the PR is kept`, r.outputs.state === 'open' && !closed(r), `${JSON.stringify(r.outputs)} ${r.gh.join(' | ')}`);
  check(`${label}: master bundle and summary are put back`, restored(r), JSON.stringify(r));
}

header('label-target.txt describes the check against master');
{
  const pr = runStep({ masterCheck: '2', plan: [{ code: 3 }] });
  check('a PR check exiting 3 leaves no label target when master drifted', pr.labelTarget === null, pr.labelTarget);
  const master = runStep({ masterCheck: '3', labelTarget: '2.1.300\n', plan: [{ code: 0 }] });
  check("master's label target survives the PR check", master.labelTarget === '2.1.300\n', master.labelTarget);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// The "Check the open rebake PR against live" step of cc-drift-template-watch.yml,
// run as it ships. Its `run:` block is read out of the workflow and executed with
// bash in a scratch repository whose origin holds master and a rebake branch, with
// `gh` and scripts/capture-and-bake.mjs stubbed. The decision helper is the real
// one (scripts/rebake-pr-action.mjs, tested in bake-drift-report.mjs); this file
// checks the wiring around it: which PR is looked at, which bundle the captures
// see, what is put back afterwards, and which PR, if any, is closed.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

if (process.platform === 'win32') {
  // The step runs under bash with GNU date on a Linux runner.
  console.log('skipped on win32');
  console.log('\n0 pass, 0 fail');
  process.exit(0);
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// The step, from the workflow file: its `run:` block, dedented, and its threshold.
const lines = readFileSync(join(REPO, '.github', 'workflows', 'cc-drift-template-watch.yml'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === '- name: Check the open rebake PR against live');
if (start < 0) {
  console.log('  FAIL the workflow has no "Check the open rebake PR against live" step');
  process.exit(1);
}
const stepIndent = lines[start].indexOf('-');
const next = lines.findIndex((l, i) => i > start && l.indexOf('- ') === stepIndent && l.trimStart().startsWith('- '));
const step = lines.slice(start, next < 0 ? lines.length : next);
const body = step.slice(step.findIndex((l) => l.trim() === 'run: |') + 1);
const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
const SCRIPT = body.map((l) => l.slice(indent)).join('\n');
const STALE_AFTER_HOURS = step.join('\n').match(/STALE_AFTER_HOURS: '(\d+)'/)?.[1];

const root = mkdtempSync(join(tmpdir(), 'rebake-open-pr-'));
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// origin: master with master's bundle, and the rebake branch with the PR's.
const MASTER_BUNDLE = '{"bundle":"master"}\n';
const PR_BUNDLE = '{"bundle":"pr"}\n';
const PR_BRANCH = 'bot/template-rebake-20260101-000000';
const ORIGIN = `file://${join(root, 'origin.git')}`;
{
  git(root, 'init', '-q', '--bare', 'origin.git');
  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  git(seed, '-c', 'init.defaultBranch=master', 'init', '-q');
  writeFileSync(join(seed, 'src', 'cc-template-data.json'), MASTER_BUNDLE);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'master');
  git(seed, 'push', '-q', ORIGIN, 'HEAD:refs/heads/master');
  git(seed, 'checkout', '-q', '-b', PR_BRANCH);
  writeFileSync(join(seed, 'src', 'cc-template-data.json'), PR_BUNDLE);
  git(seed, 'commit', '-q', '-am', 'rebake');
  git(seed, 'push', '-q', ORIGIN, `HEAD:refs/heads/${PR_BRANCH}`);
}

// gh: answers `pr list` from GH_STUB_PRS with the fields asked for, and records
// every call and the body of a comment. Any other command is refused.
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_DIR + '/gh.jsonl', JSON.stringify(args) + '\\n');
const opt = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'pr' && args[1] === 'list') {
  if (process.env.GH_STUB_LIST_FAILS) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
  const fields = opt('--json').split(',');
  const prs = JSON.parse(process.env.GH_STUB_PRS || '[]').map((p) => Object.fromEntries(fields.map((f) => [f, p[f]])));
  if (opt('--jq') !== 'map(select(.isCrossRepository | not)) | .[0]') { console.error('gh stub: unknown --jq ' + opt('--jq')); process.exit(99); }
  const pr = prs.filter((p) => !p.isCrossRepository)[0];
  console.log(pr === undefined ? 'null' : JSON.stringify(pr));
} else if (args[0] === 'pr' && args[1] === 'comment') {
  fs.writeFileSync(process.env.STUB_DIR + '/comment.md', fs.readFileSync(opt('--body-file')));
} else if (!(args[0] === 'pr' && args[1] === 'close')) {
  console.error('gh stub: unexpected ' + args.join(' '));
  process.exit(98);
}
`);
chmodSync(join(bin, 'gh'), 0o755);

// capture-and-bake.mjs --check: records the bundle it sees, exits with the next
// code of STUB_CODES, writes a drift summary on 2, a label target on 3 and the
// #881 tripwire file on the attempts in STUB_RESIDUE, and on attempt STUB_SIGNAL
// sends the step SIGTERM, as a cancelled job does.
const CAPTURE = `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const log = process.env.STUB_DIR + '/captures.jsonl';
const attempt = (existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0) + 1;
appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), bundle: readFileSync('src/cc-template-data.json', 'utf8') }) + '\\n');
if ((process.env.STUB_RESIDUE ?? '').split(',').includes(String(attempt))) writeFileSync('issue-881-tripwire.txt', 'hit\\n');
else rmSync('issue-881-tripwire.txt', { force: true });
const code = Number((process.env.STUB_CODES ?? '').split(',')[attempt - 1] || 1);
if (code === 2) writeFileSync('drift-summary.md', 'PR SUMMARY ' + attempt + '\\n');
if (code === 3) writeFileSync('label-target.txt', '2.1.30' + attempt + '\\n');
process.stderr.write('[bake] check: stub capture ' + attempt + ' exit ' + code + '\\n');
if (process.env.STUB_SIGNAL === String(attempt)) process.kill(process.ppid, 'SIGTERM');
process.exit(code);
`;

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3 - 60e3).toISOString();
const ours = (hoursAgo) => ({ number: 41, headRefName: PR_BRANCH, url: 'https://github.com/askalf/dario/pull/41', createdAt: iso(hoursAgo), isCrossRepository: false });
const forks = (hoursAgo) => ({ number: 40, headRefName: PR_BRANCH, url: 'https://github.com/askalf/dario/pull/40', createdAt: iso(hoursAgo), isCrossRepository: true });

let n = 0;
const MASTER_LABEL = '2.1.300\n';
/**
 * Run the step in a fresh clone of origin, with what the check against master
 * left behind: its drift summary, and its label target when it exited 3, which
 * is the one exit code capture-and-bake.mjs writes a label target on.
 */
function runStep({ prs = [], codes = '', residue = '', signal = '', masterCheck = '2', listFails = false } = {}) {
  n += 1;
  const work = join(root, `work-${n}`);
  const stub = join(root, `stub-${n}`);
  mkdirSync(stub);
  git(root, 'clone', '-q', ORIGIN, work);
  mkdirSync(join(work, 'scripts'));
  writeFileSync(join(work, 'scripts', 'capture-and-bake.mjs'), CAPTURE);
  for (const f of ['rebake-pr-action.mjs', 'drift-report.mjs']) copyFileSync(join(REPO, 'scripts', f), join(work, 'scripts', f));
  writeFileSync(join(work, 'drift-summary.md'), 'MASTER SUMMARY\n');
  if (masterCheck === '3') writeFileSync(join(work, 'label-target.txt'), MASTER_LABEL);
  writeFileSync(join(stub, 'step.sh'), SCRIPT);
  const output = join(stub, 'output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(stub, 'step.sh')], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_DIR: stub,
      GH_STUB_PRS: JSON.stringify(prs),
      ...(listFails ? { GH_STUB_LIST_FAILS: '1' } : {}),
      STUB_CODES: codes,
      STUB_RESIDUE: residue,
      STUB_SIGNAL: signal,
      STALE_AFTER_HOURS,
      MASTER_CHECK: masterCheck,
      RUN_URL: 'https://example.invalid/run',
      GITHUB_OUTPUT: output,
    },
  });
  const jsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const read = (f) => (existsSync(join(work, f)) ? readFileSync(join(work, f), 'utf8') : null);
  const gh = jsonl(join(stub, 'gh.jsonl'));
  return {
    status: r.status,
    signal: r.signal,
    log: r.stdout + r.stderr,
    outputs: Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
    closes: gh.filter((a) => a[0] === 'pr' && a[1] === 'close'),
    comments: gh.filter((a) => a[0] === 'pr' && a[1] === 'comment'),
    comment: existsSync(join(stub, 'comment.md')) ? readFileSync(join(stub, 'comment.md'), 'utf8') : '',
    captures: jsonl(join(stub, 'captures.jsonl')),
    bundle: read('src/cc-template-data.json'),
    summary: read('drift-summary.md'),
    label: read('label-target.txt'),
    left: ['pr-bundle.json', 'drift-summary.keep', 'label-target.keep'].filter((f) => existsSync(join(work, f))),
    clean: git(work, 'status', '--porcelain', '--', 'src').trim() === '',
  };
}

const closedOurs = (r) => JSON.stringify(r.closes) === JSON.stringify([['pr', 'close', '41', '--delete-branch']]);
const restored = (r) => r.bundle === MASTER_BUNDLE && r.clean && r.summary === 'MASTER SUMMARY\n' && r.left.length === 0;
const sawPrBundle = (r, times) => r.captures.length === times && r.captures.every((c) => c.bundle === PR_BUNDLE && c.args.join(' ') === '--check');

header('the step as the workflow has it');
{
  check('the run block was found', SCRIPT.includes('gh pr close') && SCRIPT.includes('rebake-pr-action.mjs'), SCRIPT.slice(0, 200));
  check('its threshold was found', /^\d+$/.test(STALE_AFTER_HOURS ?? ''), String(STALE_AFTER_HOURS));
  check('it reads its inputs from env, not from expressions', !SCRIPT.includes('${{'));
}

header('no open rebake PR');
{
  const r = runStep({ masterCheck: '3' });
  check('exits 0 with state=none', r.status === 0 && r.outputs.state === 'none', r.log);
  check('closes nothing and captures nothing', r.closes.length === 0 && r.captures.length === 0);
  check('master\'s bundle, summary and label target are untouched', restored(r) && r.label === MASTER_LABEL);
}

header('a PR lookup that fails');
{
  const r = runStep({ prs: [ours(5)], codes: '2,2', listFails: true });
  check('closes nothing, comments nothing and captures nothing', r.closes.length === 0 && r.comments.length === 0 && r.captures.length === 0, r.log);
  check('does not report an open PR to the rebake step', r.outputs.state !== 'open' && r.outputs.state !== 'closed', JSON.stringify(r.outputs));
  check('master\'s bundle and summary are untouched', restored(r));
}

header('a PR younger than the threshold');
{
  const r = runStep({ prs: [ours(Number(STALE_AFTER_HOURS) - 1)], codes: '2,2' });
  check('exits 0 and is reported open', r.status === 0 && r.outputs.state === 'open' && r.outputs.pr_number === '41' && r.outputs.pr_url === 'https://github.com/askalf/dario/pull/41', r.log);
  check('is not checked and not closed', r.captures.length === 0 && r.closes.length === 0 && r.comments.length === 0);
  check('master\'s bundle and summary are untouched', restored(r));
}

header('a cross-repository PR on the same branch name');
{
  const only = runStep({ prs: [forks(5)], codes: '2,2' });
  check('alone, it is not ours: state=none, nothing checked or closed', only.status === 0 && only.outputs.state === 'none' && only.captures.length === 0 && only.closes.length === 0, only.log);
  const both = runStep({ prs: [forks(5), ours(5)], codes: '2,2', masterCheck: '2' });
  check('listed before ours, ours is the one checked and closed', closedOurs(both) && both.comments.length === 1 && both.comments[0][2] === '41', JSON.stringify(both.closes));
}

header('two captures in a row report drift, and master has drifted too');
{
  const r = runStep({ prs: [ours(5)], codes: '2,2', masterCheck: '2' });
  check('exits 0 with state=closed', r.status === 0 && r.outputs.state === 'closed', r.log);
  check('both captures ran against the PR\'s bundle', sawPrBundle(r, 2), JSON.stringify(r.captures));
  check('only PR 41 is closed, and its branch deleted', closedOurs(r), JSON.stringify(r.closes));
  check('the comment says this run bakes again and carries the PR check\'s summary', r.comment.includes('this run bakes again') && r.comment.includes('PR SUMMARY 2') && r.comment.includes('https://example.invalid/run'), r.comment);
  check('master\'s bundle and summary are back, and nothing of the PR is left', restored(r), JSON.stringify({ bundle: r.bundle, summary: r.summary, left: r.left }));
  check('the check against master wrote no label target, and none is left', r.label === null);
}

header('two captures in a row report drift, and live matches master again');
{
  const r = runStep({ prs: [ours(5)], codes: '2,2', masterCheck: '0' });
  check('only PR 41 is closed', r.outputs.state === 'closed' && closedOurs(r), r.log);
  check('the comment says there is nothing to re-bake', r.comment.includes('nothing to re-bake'), r.comment);
  check('master\'s bundle and summary are back', restored(r));
  const label = runStep({ prs: [ours(5)], codes: '2,2', masterCheck: '3' });
  check('with master behind only on its label, the PR is closed and the label target kept', closedOurs(label) && label.label === MASTER_LABEL && restored(label), label.log);
}

header('evidence that is not enough to close on');
{
  const once = runStep({ prs: [ours(5)], codes: '2,0' });
  check('drift the second capture does not confirm: kept, after two captures of the PR\'s bundle', once.outputs.state === 'open' && once.closes.length === 0 && sawPrBundle(once, 2), once.log);
  check('and master\'s bundle and summary are back', restored(once));
  const match = runStep({ prs: [ours(5)], codes: '0' });
  check('a PR that matches live: kept after one capture', match.outputs.state === 'open' && match.closes.length === 0 && sawPrBundle(match, 1), match.log);
  const residue = runStep({ prs: [ours(5)], codes: '2,2', residue: '2' });
  check('the #881 tripwire on a capture: kept', residue.outputs.state === 'open' && residue.closes.length === 0 && residue.comments.length === 0 && sawPrBundle(residue, 2), residue.log);
  const broken = runStep({ prs: [ours(5)], codes: '1' });
  check('a capture that could not run: kept, and no second capture', broken.status === 0 && broken.outputs.state === 'open' && broken.closes.length === 0 && sawPrBundle(broken, 1), broken.log);
  check('and master\'s bundle and summary are back', restored(broken));
}

// label-target.txt is the label-sync step's input. It has to name the version
// seen by the check against master, whatever a check of the PR's bundle wrote.
header('the label target of the check against master');
{
  const both = runStep({ prs: [ours(5)], codes: '3', masterCheck: '3' });
  check('a check of the PR\'s bundle that exits 3 ran, and the PR is kept', sawPrBundle(both, 1) && both.outputs.state === 'open' && both.closes.length === 0, both.log);
  check('the target left is master\'s, not the one that check wrote', both.label === MASTER_LABEL && both.left.length === 0, JSON.stringify({ label: both.label, left: both.left }));
  const prOnly = runStep({ prs: [ours(5)], codes: '3', masterCheck: '2' });
  check('with no target from the check against master, the one a PR check wrote is not left', sawPrBundle(prOnly, 1) && prOnly.label === null && prOnly.left.length === 0, JSON.stringify({ label: prOnly.label, left: prOnly.left }));
  const clean = runStep({ prs: [ours(5)], codes: '3', masterCheck: '0' });
  check('the same when live matched master', clean.label === null && restored(clean), JSON.stringify({ label: clean.label, left: clean.left }));
  const cancelled = runStep({ prs: [ours(5)], codes: '3', signal: '1', masterCheck: '3' });
  check('master\'s target is back when the step is ended during that check', cancelled.status !== 0 && cancelled.label === MASTER_LABEL && restored(cancelled), `${cancelled.status} ${JSON.stringify({ label: cancelled.label, left: cancelled.left })}`);
}

header('the step ended by a signal while it checks the PR');
{
  const r = runStep({ prs: [ours(5)], codes: '2,2', signal: '1' });
  check('the step does not finish', r.status !== 0 && r.outputs.state === undefined, `${r.status} ${r.signal} ${r.log}`);
  check('nothing is closed', r.closes.length === 0 && r.comments.length === 0);
  check('master\'s bundle and summary are back, and nothing of the PR is left', restored(r), JSON.stringify({ bundle: r.bundle, summary: r.summary, left: r.left }));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// drift-pr-heal.yml's Heal step, run as it stands against throwaway repositories: a bare origin that
// holds master and the drift branches, a fresh clone of it as the job's checkout (on master, with
// no other local branch, as the runner's), and a stand-in for gh (test/fixtures/drift-heal-gh.mjs)
// that answers the PR list and Redline's runs from a fixture. bash, git, jq, node,
// sort and the repository's own release scripts are the real ones. Without what the step needs
// (bash 4 associative arrays, sort -V, jq, git) it is skipped, except in CI, where it fails. The
// fixtures are removed when the test ends.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}

const PROBE = [
  'declare -A m=([k]=v)',
  '[ "${m[k]}" = v ]',
  '[[ 1.2.3 =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
  '[ "$(printf "1.0.10\\n1.0.9\\n" | sort -V | tail -1)" = 1.0.10 ]',
  'jq -n 1 >/dev/null',
  'git --version >/dev/null',
].join(' && ');
const usable = process.platform !== 'win32' && spawnSync('bash', ['--noprofile', '--norc', '-c', PROBE]).status === 0;
if (!usable) {
  if (process.env.CI) {
    console.log('  FAIL the heal step needs bash 4, sort -V, jq and git, and this runner lacks one');
    process.exit(1);
  }
  console.log('  SKIP drift-heal-e2e: needs bash 4, sort -V, jq and git (CI runs it)');
  process.exit(0);
}

// The Heal step's script, cut from the workflow as the runner gets it.
function healScript() {
  const lines = readFileSync(join(ROOT, '.github', 'workflows', 'drift-pr-heal.yml'), 'utf8').split('\n');
  const at = lines.indexOf('      - name: Heal');
  const run = at === -1 ? -1 : lines.indexOf('        run: |', at);
  if (run === -1) throw new Error('the Heal step is not where this test reads it');
  const out = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(''); continue; }
    if (!l.startsWith('          ')) break;
    out.push(l.slice(10));
  }
  return out.join('\n');
}
const SCRIPT = healScript();
check('the Heal step reads Redline\'s runs, steps over held versions and checks the plan before a push',
  SCRIPT.includes('redline_busy') && SCRIPT.includes('held_by_others') && SCRIPT.includes('plan_changed'));

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...a],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// The release scripts the step runs from each branch, and the plan it copies out of master.
const SCRIPTS = ['renumber-release-version.mjs', 'resolve-release-conflicts.mjs', 'fold-unreleased.mjs', 'version-advances.sh', '_drift-patch-helpers.mjs', 'drift-heal-plan.mjs'];
const fixtures = [];
process.on('exit', () => { for (const d of fixtures) rmSync(d, { recursive: true, force: true }); });

function setVersion(dir, version, note, date) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'fx', version, private: true }, null, 2)}\n`);
  writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify({ name: 'fx', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'fx', version } } }, null, 2)}\n`);
  const cl = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  writeFileSync(join(dir, 'CHANGELOG.md'), cl.replace('## [Unreleased]\n\n', `## [Unreleased]\n\n## [${version}] - ${date}\n\n- ${note}\n\n`));
}

// master at 1.0.4, pushed to a bare origin from a work repository; `old` is that commit.
function fixture() {
  const top = mkdtempSync(join(tmpdir(), 'dario-heal-e2e-'));
  fixtures.push(top);
  const origin = join(top, 'origin.git');
  const work = join(top, 'work');
  mkdirSync(work);
  git(top, 'init', '-q', '--bare', origin);
  git(work, 'init', '-q');
  git(work, 'remote', 'add', 'origin', origin);
  mkdirSync(join(work, 'scripts'));
  for (const f of SCRIPTS) copyFileSync(join(ROOT, 'scripts', f), join(work, 'scripts', f));
  writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n');
  setVersion(work, '1.0.4', 'base', '2026-11-20');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base 1.0.4');
  git(work, 'push', '-q', 'origin', 'master');
  return { top, origin, work, old: git(work, 'rev-parse', 'HEAD') };
}

// A drift branch drafted on `from` at `version`, pushed; its tip.
function draft(fx, name, from, version, note) {
  git(fx.work, 'checkout', '-q', '-b', name, from);
  setVersion(fx.work, version, note, '2026-11-21');
  writeFileSync(join(fx.work, `${name.replace(/\//g, '-')}.txt`), `${note}\n`);
  git(fx.work, 'add', '-A');
  git(fx.work, 'commit', '-q', '-m', `chore(drift): ${note}`);
  git(fx.work, 'push', '-q', 'origin', name);
  const tip = git(fx.work, 'rev-parse', 'HEAD');
  git(fx.work, 'checkout', '-q', 'master');
  return tip;
}

function commitOnMaster(fx, message, change) {
  git(fx.work, 'checkout', '-q', 'master');
  change();
  git(fx.work, 'add', '-A');
  git(fx.work, 'commit', '-q', '-m', message);
  git(fx.work, 'push', '-q', 'origin', 'master');
}
const releaseMaster = (fx, version) => commitOnMaster(fx, `release ${version}`, () => setVersion(fx.work, version, 'master change', '2026-11-22'));

const pr = (number, headRefName, headRefOid, mergeStateStatus, over = {}) => ({
  number, isDraft: false, headRefName, headRefOid, baseRefName: 'master', headRepositoryOwner: { login: 'askalf' }, mergeStateStatus, ...over,
});
const recent = () => new Date(Date.now() - 5 * 60_000).toISOString();

// The Heal step, run in a fresh clone of origin with the gh stand-in first on PATH.
function heal(fx, spec) {
  const job = join(fx.top, `job-${fixtures.length}-${Date.now()}`);
  git(fx.top, 'clone', '-q', fx.origin, job);
  const stub = join(fx.top, 'stub');
  mkdirSync(stub, { recursive: true });
  copyFileSync(join(ROOT, 'test', 'fixtures', 'drift-heal-gh.mjs'), join(stub, 'gh.mjs'));
  writeFileSync(join(stub, 'gh'), `#!/bin/sh\nexec node "${join(stub, 'gh.mjs')}" "$@"\n`);
  chmodSync(join(stub, 'gh'), 0o755);
  const fixturePath = join(fx.top, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(spec));
  const runnerTemp = join(fx.top, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  const ghlog = join(fx.top, 'gh.log');
  writeFileSync(ghlog, '');
  const counts = join(fx.top, 'counts.json');
  rmSync(counts, { force: true });
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], {
    cwd: job,
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${stub}:${process.env.PATH}`, REPO: 'askalf/fx', GH_TOKEN: 'pat-token', RUNS_TOKEN: 'runs-token',
      RUNNER_TEMP: runnerTemp, HEAL_FIXTURE: fixturePath, HEAL_GHLOG: ghlog, HEAL_COUNTS: counts,
    },
  });
  const calls = readFileSync(ghlog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
}
const tipOf = (fx, b) => git(fx.top, '--git-dir', fx.origin, 'rev-parse', `refs/heads/${b}`);
const versionOf = (fx, b) => JSON.parse(git(fx.top, '--git-dir', fx.origin, 'show', `refs/heads/${b}:package.json`)).version;
const changelogOf = (fx, b) => git(fx.top, '--git-dir', fx.origin, 'show', `refs/heads/${b}:CHANGELOG.md`);
// The lines the step printed for one PR: its `=== #n (...) ===` header line and what follows, up to
// the next PR's header or the summary.
const section = (out, n) => (new RegExp(`=== #${n} [^\\n]*\\n[\\s\\S]*?(?=\\n=== #|\\nhealed=|$)`).exec(out) ?? [''])[0];

console.log('\n=== a review at a head holds that PR; every open drift PR holds its version ===');
{
  const fx = fixture();
  const a = draft(fx, 'bot/cc-drift-a', fx.old, '1.0.5', 'change a');
  const b = draft(fx, 'bot/cc-drift-b', fx.old, '1.0.5', 'change b');
  const c = draft(fx, 'bot/cc-drift-c', fx.old, '1.0.5', 'change c');
  releaseMaster(fx, '1.0.5');
  const d = draft(fx, 'bot/cc-drift-d', 'master', '1.0.6', 'change d');
  const x = draft(fx, 'bot/template-label-x', 'master', '1.0.7', 'label x');
  const r = heal(fx, {
    prs: [
      pr(11, 'bot/cc-drift-a', a, 'DIRTY'), pr(12, 'bot/cc-drift-b', b, 'DIRTY'), pr(13, 'bot/cc-drift-c', c, 'DIRTY'),
      pr(14, 'bot/cc-drift-d', d, 'CLEAN'), pr(15, 'bot/template-label-x', x, 'CLEAN', { isDraft: true }),
      pr(16, 'feature/by-hand', 'f'.repeat(40), 'DIRTY'),
    ],
    runs: [
      { workflow: 'redline.yml', id: 1, event: 'pull_request', status: 'in_progress', display_title: 'chore(drift): change c', head_sha: c },
      { workflow: 'redline.yml', id: 2, event: 'pull_request', status: 'queued', display_title: `Redline review askalf/fx#11 @ ${a}`, head_sha: 'e'.repeat(40) },
      { workflow: 'redline.yml', id: 3, event: 'pull_request', status: 'completed', conclusion: 'success', display_title: 'chore(drift): change b', head_sha: b },
    ],
  });
  check('the run ends cleanly and counts what it did', r.status === 0 && /healed=2 refused=0 skipped=1/.test(r.out), r.out);
  check('A, stale at the version master released, is renumbered over every version another open drift PR holds (B and C 1.0.5, D 1.0.6, the draft 1.0.7): 1.0.8',
    versionOf(fx, 'bot/cc-drift-a') === '1.0.8', versionOf(fx, 'bot/cc-drift-a'));
  check('A\'s changelog carries its section at 1.0.8 and master\'s 1.0.5', /## \[1\.0\.8\][^\n]*\n\n- change a/.test(changelogOf(fx, 'bot/cc-drift-a')) && changelogOf(fx, 'bot/cc-drift-a').includes('## [1.0.5]'));
  check('B, after it: 1.0.9', versionOf(fx, 'bot/cc-drift-b') === '1.0.9', versionOf(fx, 'bot/cc-drift-b'));
  check('C, with a review running at its head, is left as it was', tipOf(fx, 'bot/cc-drift-c') === c && /SKIPPED: Redline is at work on this head/.test(section(r.out, 13)), section(r.out, 13));
  check('A is not held by another PR\'s review whose title names A and its head', /HEALED/.test(section(r.out, 11)), section(r.out, 11));
  check('D and the draft, up to date, are untouched, and the branch someone else opened is never read',
    tipOf(fx, 'bot/cc-drift-d') === d && tipOf(fx, 'bot/template-label-x') === x && !r.out.includes('#16'));
  check('the five open drift PRs hold five different versions',
    new Set(['bot/cc-drift-a', 'bot/cc-drift-b', 'bot/cc-drift-c', 'bot/cc-drift-d', 'bot/template-label-x'].map((h) => versionOf(fx, h))).size === 5);
  check('Redline\'s runs are read with the job\'s token, the PR list with the drift-bot PAT, and no comment is read',
    r.calls.some((x2) => x2.args[0] === 'api') && r.calls.filter((x2) => x2.args[0] === 'api').every((x2) => x2.token === 'runs-token')
    && r.calls.filter((x2) => x2.args[0] === 'pr').every((x2) => x2.token === 'pat-token') && !r.calls.some((x2) => /\/comments/.test(String(x2.args[1]))));
  check('every unfinished status of every Redline workflow is read, and the fix runs at each checked head',
    ['redline.yml', 'redline-fix.yml', 'redline-post.yml'].every((wf) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].every((st) => r.calls.some((x2) => String(x2.args[1]).includes(`/${wf}/runs?status=${st}&`))))
    && r.calls.some((x2) => String(x2.args[1]).includes(`/redline-fix.yml/runs?event=workflow_dispatch&head_sha=${a}&`)));
}

console.log('\n=== an older queued review behind 100 newer ones is still found ===');
{
  const fx = fixture();
  const c = draft(fx, 'bot/cc-drift-c', fx.old, '1.0.5', 'change c');
  releaseMaster(fx, '1.0.5');
  const others = Array.from({ length: 120 }, (_, i) => ({ workflow: 'redline.yml', id: 1000 + i, event: 'pull_request', status: 'queued', display_title: 'other', head_sha: (i % 10).toString().repeat(40) }));
  const r = heal(fx, {
    prs: [pr(13, 'bot/cc-drift-c', c, 'DIRTY')],
    runs: [...others, { workflow: 'redline.yml', id: 1, event: 'pull_request', status: 'queued', display_title: 'chore(drift): change c', head_sha: c }],
  });
  check('C, whose review is on the second page of queued runs, is left as it was',
    r.status === 0 && tipOf(fx, 'bot/cc-drift-c') === c && /SKIPPED: Redline is at work on this head/.test(section(r.out, 13))
    && r.calls.some((x2) => String(x2.args[1]).includes('/redline.yml/runs?status=queued&per_page=100&page=2')), r.out);
}

console.log('\n=== a list that changes while it is read counts as unread ===');
{
  const fx = fixture();
  const c = draft(fx, 'bot/cc-drift-c', fx.old, '1.0.5', 'change c');
  releaseMaster(fx, '1.0.5');
  // 100 newer queued runs, the first of which starts once the first page is read (from the second
  // read of the queued list on), and C's queued
  // review last: page two comes back empty, though C's review was queued all along.
  const newer = Array.from({ length: 100 }, (_, i) => ({ workflow: 'redline.yml', id: 3000 + i, event: 'pull_request', status: 'queued', display_title: 'other', head_sha: (i % 10).toString().repeat(40),
    ...(i === 0 ? { changeAfter: { key: 'redline.yml|queued', calls: 2, status: 'in_progress' } } : {}) }));
  const r = heal(fx, { prs: [pr(13, 'bot/cc-drift-c', c, 'DIRTY')], runs: [...newer, { workflow: 'redline.yml', id: 1, event: 'pull_request', status: 'queued', display_title: 'chore(drift): change c', head_sha: c }] });
  check('a queued list that shrinks between its pages: held, as runs that could not be listed', r.status === 0 && tipOf(fx, 'bot/cc-drift-c') === c && /the Redline runs could not be listed/.test(section(r.out, 13)), r.out);
  const fx2 = fixture();
  const c2 = draft(fx2, 'bot/cc-drift-c', fx2.old, '1.0.5', 'change c');
  releaseMaster(fx2, '1.0.5');
  // A review of C that joins the queued list after it was read (a re-run), before the end of the scan.
  const r2 = heal(fx2, { prs: [pr(13, 'bot/cc-drift-c', c2, 'DIRTY')], runs: [{ workflow: 'redline.yml', id: 2, event: 'pull_request', status: 'queued', display_title: 'chore(drift): change c', head_sha: c2, appearAfter: 2 }] });
  check('a review that joins a list already read is caught when the list is read again', r2.status === 0 && tipOf(fx2, 'bot/cc-drift-c') === c2 && /could not be listed/.test(section(r2.out, 13)), r2.out);
  const fx3 = fixture();
  const c3 = draft(fx3, 'bot/cc-drift-c', fx3.old, '1.0.5', 'change c');
  releaseMaster(fx3, '1.0.5');
  // Between the two reads, an unrelated queued review leaves the list and one of C joins it: the
  // count stays at one, and the second read holds C's review.
  const r3 = heal(fx3, { prs: [pr(13, 'bot/cc-drift-c', c3, 'DIRTY')], runs: [
    { workflow: 'redline.yml', id: 4, event: 'pull_request', status: 'queued', display_title: 'other', head_sha: '7'.repeat(40), goneAfter: { key: 'redline.yml|queued', calls: 2 } },
    { workflow: 'redline.yml', id: 5, event: 'pull_request', status: 'queued', display_title: 'chore(drift): change c', head_sha: c3, appearAfter: 2 },
  ] });
  check('a review replaced by one of this head at a constant count is caught by the run ids', r3.status === 0 && tipOf(fx3, 'bot/cc-drift-c') === c3 && /could not be listed/.test(section(r3.out, 13)), r3.out);
  const fx4 = fixture();
  const c4 = draft(fx4, 'bot/cc-drift-c', fx4.old, '1.0.5', 'change c');
  releaseMaster(fx4, '1.0.5');
  // 101 fix runs at C's head, all answered long ago; the newest is deleted once the first page is
  // read, so the last one would shift onto page one and page two come back empty.
  const old = (i) => ({ workflow: 'redline-fix.yml', id: 5000 + i, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    display_title: `Redline fix askalf/fx#13 @ ${c4}`, head_sha: c4, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:10:00Z',
    ...(i === 0 ? { goneAfter: { key: 'redline-fix.yml|head', calls: 2 } } : {}) });
  const r4 = heal(fx4, { prs: [pr(13, 'bot/cc-drift-c', c4, 'DIRTY')], runs: Array.from({ length: 101 }, (_, i) => old(i)) });
  check('the per-head fix list that shifts across its page boundary is held as unread', r4.status === 0 && tipOf(fx4, 'bot/cc-drift-c') === c4 && /could not be listed/.test(section(r4.out, 13)), r4.out);
  const fx5 = fixture();
  const c5 = draft(fx5, 'bot/cc-drift-c', fx5.old, '1.0.5', 'change c');
  releaseMaster(fx5, '1.0.5');
  // C's review moves from queued to waiting between the waiting and queued queries of the first
  // scan, so that scan misses it; the second scan finds it waiting, and the two differ.
  const r5 = heal(fx5, { prs: [pr(13, 'bot/cc-drift-c', c5, 'DIRTY')], runs: [
    { workflow: 'redline.yml', id: 6, event: 'pull_request', status: 'queued', display_title: 'chore(drift): change c', head_sha: c5, changeAfter: { key: 'redline.yml|queued', calls: 1, status: 'waiting' } },
  ] });
  check('a review that moves from queued to waiting between two queries holds the PR', r5.status === 0 && tipOf(fx5, 'bot/cc-drift-c') === c5 && /could not be listed/.test(section(r5.out, 13)), r5.out);
}

console.log('\n=== a stable list larger than a shell argument is read whole ===');
{
  const fx = fixture();
  const c = draft(fx, 'bot/cc-drift-c', fx.old, '1.0.5', 'change c');
  releaseMaster(fx, '1.0.5');
  // 250 queued runs with long names (over 128 KiB as JSON), and C's review on the third page.
  const crowd = Array.from({ length: 250 }, (_, i) => ({ workflow: 'redline.yml', id: 7000 + i, event: 'pull_request', status: 'queued', display_title: 'z'.repeat(600), head_sha: (i % 10).toString().repeat(40) }));
  const r = heal(fx, { prs: [pr(13, 'bot/cc-drift-c', c, 'DIRTY')], runs: [...crowd, { workflow: 'redline.yml', id: 1, event: 'pull_request', status: 'queued', display_title: 'chore(drift): change c', head_sha: c }] });
  check('C, whose review is the 251st queued run, is left as it was', r.status === 0 && tipOf(fx, 'bot/cc-drift-c') === c && /reviewing this head/.test(section(r.out, 13)), r.out);
}

console.log('\n=== a review that starts while a PR is healed: left as it was, and its version still held ===');
{
  const fx = fixture();
  const f = draft(fx, 'bot/cc-drift-f', fx.old, '1.0.5', 'change f');
  releaseMaster(fx, '1.0.5');
  const e = draft(fx, 'bot/cc-drift-e', 'master', '1.0.6', 'change e');
  commitOnMaster(fx, 'docs: unrelated', () => writeFileSync(join(fx.work, 'notes.txt'), 'master moved\n'));
  const r = heal(fx, {
    prs: [pr(21, 'bot/cc-drift-e', e, 'BEHIND'), pr(22, 'bot/cc-drift-f', f, 'DIRTY')],
    // Each check reads every list twice. Shown from the third first-page read of redline.yml's
    // in-progress runs on: after E's first check, from its check before the push.
    runs: [{ workflow: 'redline.yml', id: 7, event: 'pull_request', status: 'in_progress', display_title: 'chore(drift): change e', head_sha: e, appearAfter: 3 }],
  });
  check('the run ends cleanly', r.status === 0 && /healed=1 refused=0 skipped=1/.test(r.out), r.out);
  check('E, whose review started while it was healed, is left as it was', tipOf(fx, 'bot/cc-drift-e') === e && /SKIPPED: Redline started on this head while it was healed/.test(section(r.out, 21)), section(r.out, 21));
  check('F steps over the 1.0.6 that E still holds: 1.0.7', versionOf(fx, 'bot/cc-drift-f') === '1.0.7', versionOf(fx, 'bot/cc-drift-f'));
}

console.log('\n=== a dispatched re-read holds its PR; a finished fix holds it for the wait ===');
{
  const fx = fixture();
  const k = draft(fx, 'bot/cc-drift-k', fx.old, '1.0.5', 'change k');
  const l = draft(fx, 'bot/cc-drift-l', fx.old, '1.0.5', 'change l');
  const m = draft(fx, 'bot/cc-drift-m', fx.old, '1.0.5', 'change m');
  const n2 = draft(fx, 'bot/cc-drift-n', fx.old, '1.0.5', 'change n');
  const q = draft(fx, 'bot/cc-drift-q', fx.old, '1.0.5', 'change q');
  releaseMaster(fx, '1.0.5');
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const finished = (id, n, head, over = {}) => ({ workflow: 'redline-fix.yml', id, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    display_title: `Redline fix askalf/fx#${n} @ ${head}`, head_sha: head, created_at: ago(10), updated_at: ago(5), ...over });
  const r = heal(fx, {
    prs: [pr(51, 'bot/cc-drift-k', k, 'DIRTY'), pr(52, 'bot/cc-drift-l', l, 'DIRTY'), pr(53, 'bot/cc-drift-m', m, 'DIRTY'),
      pr(54, 'bot/cc-drift-n', n2, 'DIRTY'), pr(55, 'bot/cc-drift-q', q, 'DIRTY')],
    runs: [
      { workflow: 'redline.yml', id: 9, event: 'workflow_dispatch', status: 'queued', display_title: `Redline review askalf/fx#51 @ ${k} (re-read)`, head_sha: 'd'.repeat(40) },
      // L: its fix run finished seven hours ago, past the wait.
      finished(10, 52, l, { created_at: ago(7 * 60 + 10), updated_at: ago(7 * 60) }),
      // L: a fix run dispatched from master that names L, lately: never applied by the dispatcher, so it holds nothing.
      finished(15, 52, l, { head_sha: 'b'.repeat(40) }),
      // M: a fix run finished five minutes ago.
      finished(11, 53, m),
      // N: a first fix run, then a retry at the same head that finished lately.
      finished(12, 54, n2, { created_at: ago(40), updated_at: ago(30) }), finished(13, 54, n2, { created_at: ago(20), updated_at: ago(5) }),
      // Q: created two days ago and re-run lately.
      finished(14, 55, q, { created_at: ago(2 * 24 * 60), updated_at: ago(5) }),
    ],
  });
  check('K, with a re-read queued for its head, is left as it was', r.status === 0 && tipOf(fx, 'bot/cc-drift-k') === k && /SKIPPED: Redline is at work on this head/.test(section(r.out, 51)), r.out);
  check('M, whose fix run finished five minutes ago, is left as it was, and the reason says until when', tipOf(fx, 'bot/cc-drift-m') === m && /its fix is waited for until/.test(section(r.out, 53)), section(r.out, 53));
  check('N, whose retry finished lately, is left as it was', tipOf(fx, 'bot/cc-drift-n') === n2 && /its fix is waited for until/.test(section(r.out, 54)), section(r.out, 54));
  check('Q, a fix run created two days ago and re-run lately, is left as it was', tipOf(fx, 'bot/cc-drift-q') === q && /its fix is waited for until/.test(section(r.out, 55)), section(r.out, 55));
  check('L, whose fix finished past the wait and whose other fix was dispatched from master, is healed clear of the 1.0.5 the others hold: 1.0.6', versionOf(fx, 'bot/cc-drift-l') === '1.0.6', versionOf(fx, 'bot/cc-drift-l'));
}

console.log('\n=== Redline\'s runs that cannot be listed hold every PR ===');
{
  const fx = fixture();
  const h = draft(fx, 'bot/cc-drift-h', fx.old, '1.0.5', 'change h');
  releaseMaster(fx, '1.0.5');
  const r = heal(fx, { prs: [pr(41, 'bot/cc-drift-h', h, 'DIRTY')], runs: [], failRuns: ['redline-fix.yml'] });
  check('the PR is left as it was, and the log says why', r.status === 0 && tipOf(fx, 'bot/cc-drift-h') === h && /the Redline runs could not be listed/.test(section(r.out, 41)), r.out);
}

console.log('\n=== a sibling that changes during the run: no push from the old plan ===');
{
  const fx = fixture();
  const a = draft(fx, 'bot/cc-drift-a', fx.old, '1.0.5', 'change a');
  releaseMaster(fx, '1.0.5');
  const x = draft(fx, 'bot/template-label-x', 'master', '1.0.6', 'label x');
  const prs = [pr(11, 'bot/cc-drift-a', a, 'DIRTY'), pr(15, 'bot/template-label-x', x, 'CLEAN', { isDraft: true })];
  // From the second list on, the draft shows another head, as when it is renumbered mid-run.
  const r = heal(fx, { prs, prsLater: [prs[0], { ...prs[1], headRefOid: '9'.repeat(40) }], runs: [] });
  check('nothing is pushed, the run ends cleanly and says what changed',
    r.status === 0 && tipOf(fx, 'bot/cc-drift-a') === a && /STOPPED: the open drift PRs changed during the run \(#15 moved/.test(r.out), r.out);
  const opened = fixture();
  const a2 = draft(opened, 'bot/cc-drift-a', opened.old, '1.0.5', 'change a');
  releaseMaster(opened, '1.0.5');
  const first = [pr(11, 'bot/cc-drift-a', a2, 'DIRTY')];
  const r2 = heal(opened, { prs: first, prsLater: [...first, pr(17, 'bot/cc-drift-new', '8'.repeat(40), 'CLEAN')], runs: [] });
  check('a drift PR opened during the run stops it too', r2.status === 0 && tipOf(opened, 'bot/cc-drift-a') === a2 && /#17 was opened/.test(r2.out), r2.out);
  const long = fixture();
  const a3 = draft(long, 'bot/cc-drift-a', long.old, '1.0.5', 'change a');
  releaseMaster(long, '1.0.5');
  const one = [pr(11, 'bot/cc-drift-a', a3, 'DIRTY')];
  const crowd = Array.from({ length: 999 }, (_, i) => pr(2000 + i, `feature/by-hand-${i}`, 'f'.repeat(40), 'CLEAN'));
  const r3 = heal(long, { prs: one, prsLater: [...one, ...crowd], runs: [] });
  check('a second list of 1000 or more open PRs, which may be cut short, stops it too', r3.status === 0 && tipOf(long, 'bot/cc-drift-a') === a3 && /may be cut short/.test(r3.out), r3.out);
  for (const [what, over, said] of [['converted to a draft', { isDraft: true }, /#11 is now a draft/], ['retargeted to another base', { baseRefName: 'release' }, /#11 now targets release/]]) {
    const fx = fixture();
    const a4 = draft(fx, 'bot/cc-drift-a', fx.old, '1.0.5', 'change a');
    releaseMaster(fx, '1.0.5');
    const first = [pr(11, 'bot/cc-drift-a', a4, 'DIRTY')];
    const r4 = heal(fx, { prs: first, prsLater: [{ ...first[0], ...over }], runs: [] });
    check(`the PR ${what} during the run, its head unchanged, is not pushed`, r4.status === 0 && tipOf(fx, 'bot/cc-drift-a') === a4 && said.test(r4.out), r4.out);
  }
}

console.log('\n=== a sibling branch that moves onto the chosen version while the PR list still shows its old head ===');
{
  const fx = fixture();
  const p1 = draft(fx, 'bot/cc-drift-p1', fx.old, '1.0.5', 'change p1');
  releaseMaster(fx, '1.0.5');
  const sib = draft(fx, 'bot/cc-drift-s', 'master', '1.0.8', 'change s');
  // The sibling renumbered to 1.0.6, the version p1 will choose, parked on origin until the run.
  git(fx.work, 'checkout', '-q', 'bot/cc-drift-s');
  setVersion(fx.work, '1.0.6', 'renumbered', '2026-11-23');
  git(fx.work, 'add', '-A');
  git(fx.work, 'commit', '-q', '-m', 'chore: renumber');
  const moved = git(fx.work, 'rev-parse', 'HEAD');
  git(fx.work, 'push', '-q', 'origin', `${moved}:refs/heads/parked-s`);
  git(fx.work, 'checkout', '-q', 'master');
  const r = heal(fx, {
    prs: [pr(71, 'bot/cc-drift-p1', p1, 'DIRTY'), pr(72, 'bot/cc-drift-s', sib, 'CLEAN')],
    runs: [],
    // The sibling moves during p1's last Redline check, after the PR list was read again.
    sideEffects: [{ key: 'redline.yml|queued', call: 3, git: ['--git-dir', fx.origin, 'update-ref', 'refs/heads/bot/cc-drift-s', moved] }],
  });
  check('p1 is not pushed, and the run ends cleanly and says which branch moved',
    r.status === 0 && tipOf(fx, 'bot/cc-drift-p1') === p1 && /STOPPED: a drift branch changed during the run \(bot\/cc-drift-s is at [0-9a-f]{7} on origin, not [0-9a-f]{7}\)/.test(r.out), r.out);
}

console.log('\n=== a new drift branch, and its PR, during the last Redline check ===');
for (const withPr of [false, true]) {
  const fx = fixture();
  const p1 = draft(fx, 'bot/cc-drift-p1', fx.old, '1.0.5', 'change p1');
  releaseMaster(fx, '1.0.5');
  // A new drift branch at 1.0.6, the version p1 will choose, parked on origin until the run.
  const z = draft(fx, 'bot/parked-z', 'master', '1.0.6', 'change z');
  const prs = [pr(81, 'bot/cc-drift-p1', p1, 'DIRTY')];
  const r = heal(fx, {
    prs,
    ...(withPr ? { prsLater: [...prs, pr(82, 'bot/cc-drift-z', z, 'CLEAN')], prsLaterOnEffect: true } : {}),
    runs: [],
    // The drafter pushes bot/cc-drift-z (and opens its PR) during p1's last Redline check.
    sideEffects: [{ key: 'redline.yml|queued', call: 3, git: ['--git-dir', fx.origin, 'update-ref', 'refs/heads/bot/cc-drift-z', z], showLater: withPr }],
  });
  check(withPr
    ? 'a drift PR opened on a new branch during the last Redline check: the PR list read after it stops the run, and p1 is not pushed'
    : 'a new drift branch pushed during the last Redline check, its PR not open yet: the read of every drift branch stops the run, and p1 is not pushed',
  r.status === 0 && tipOf(fx, 'bot/cc-drift-p1') === p1
    && (withPr ? /STOPPED: the open drift PRs changed during the run \(#82 was opened\)/ : /STOPPED: a drift branch changed during the run \(bot\/cc-drift-z appeared on origin/).test(r.out), r.out);
}

console.log('\n=== one branch, two open PRs ===');
{
  const fx = fixture();
  releaseMaster(fx, '1.0.5');
  const sh = draft(fx, 'bot/cc-drift-sh', fx.old, '1.0.5', 'change sh');
  const o = draft(fx, 'bot/cc-drift-o', fx.old, '1.0.5', 'change o');
  // A backport PR from the same branch onto release, besides the PR onto master.
  const r = heal(fx, { prs: [pr(61, 'bot/cc-drift-sh', sh, 'DIRTY'), pr(62, 'bot/cc-drift-sh', sh, 'DIRTY', { baseRefName: 'release' }), pr(63, 'bot/cc-drift-o', o, 'DIRTY')], runs: [] });
  check('both PRs of the shared branch are skipped and the branch is left as it was',
    r.status === 0 && tipOf(fx, 'bot/cc-drift-sh') === sh && /SKIPPED: its branch is also the head of #62 onto release; a push would move both/.test(section(r.out, 61))
    && /SKIPPED: its branch is also the head of #61 onto master/.test(section(r.out, 62)), r.out);
  check('the other PR is healed clear of the 1.0.5 the shared branch holds: 1.0.6', versionOf(fx, 'bot/cc-drift-o') === '1.0.6' && /HEALED/.test(section(r.out, 63)), r.out);
}

console.log('\n=== a candidate that moves during the run to a branch with no version: the run fails ===');
{
  const fx = fixture();
  const p1 = draft(fx, 'bot/cc-drift-p1', fx.old, '1.0.5', 'change p1');
  const p2 = draft(fx, 'bot/cc-drift-p2', fx.old, '1.0.5', 'change p2');
  git(fx.work, 'checkout', '-q', 'bot/cc-drift-p2');
  writeFileSync(join(fx.work, 'package.json'), '{ "name": "fx" }\n');
  git(fx.work, 'add', '-A');
  git(fx.work, 'commit', '-q', '-m', 'broken');
  const broken = git(fx.work, 'rev-parse', 'HEAD');
  git(fx.work, 'push', '-q', 'origin', `${broken}:refs/heads/parked-broken`);
  git(fx.work, 'checkout', '-q', 'master');
  releaseMaster(fx, '1.0.5');
  const r = heal(fx, {
    prs: [pr(31, 'bot/cc-drift-p1', p1, 'DIRTY'), pr(32, 'bot/cc-drift-p2', p2, 'DIRTY')],
    // P1 is busy, so it is skipped; P2 moves to the broken commit while P1 is checked.
    runs: [{ workflow: 'redline.yml', id: 5, event: 'pull_request', status: 'in_progress', display_title: 'chore(drift): change p1', head_sha: p1 }],
    sideEffects: [{ key: 'redline.yml|in_progress', call: 1, git: ['--git-dir', fx.origin, 'update-ref', 'refs/heads/bot/cc-drift-p2', broken] }],
  });
  check('P1 is skipped, then the run fails at P2 and says why', r.status === 1 && /SKIPPED/.test(section(r.out, 31)) && tipOf(fx, 'bot/cc-drift-p1') === p1
    && /STOPPED: moved since the list was read and holds no x\.y\.z version/.test(section(r.out, 32)) && tipOf(fx, 'bot/cc-drift-p2') === broken, r.out);
}

console.log('\n=== a branch that moved before the plan: no version is chosen from that plan ===');
{
  const fx = fixture();
  const g1 = draft(fx, 'bot/cc-drift-g', fx.old, '1.0.5', 'change g');
  git(fx.work, 'checkout', '-q', 'bot/cc-drift-g');
  writeFileSync(join(fx.work, 'g2.txt'), 'pushed after the list was read\n');
  git(fx.work, 'add', '-A');
  git(fx.work, 'commit', '-q', '-m', 'fix: g2');
  git(fx.work, 'push', '-q', 'origin', 'bot/cc-drift-g');
  const g2 = git(fx.work, 'rev-parse', 'HEAD');
  git(fx.work, 'checkout', '-q', 'master');
  const z = draft(fx, 'bot/cc-drift-z', fx.old, '1.0.5', 'change z');
  releaseMaster(fx, '1.0.5');
  const r = heal(fx, { prs: [pr(61, 'bot/cc-drift-z', z, 'DIRTY'), pr(62, 'bot/cc-drift-g', g1, 'DIRTY')], runs: [] });
  check('nothing is healed, the run ends cleanly and says why, and no runs are read',
    r.status === 0 && /Plan incomplete: bot\/cc-drift-g \(#62\) moved since the list was read/.test(r.out)
    && tipOf(fx, 'bot/cc-drift-g') === g2 && tipOf(fx, 'bot/cc-drift-z') === z && !r.calls.some((x2) => x2.args[0] === 'api'), r.out);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

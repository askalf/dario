// drift-pr-heal.yml's Heal step, run as it stands against throwaway repositories: a bare origin that
// holds master and the drift branches, a fresh clone of it as the job's checkout (on master, with
// no other local branch, as the runner's), and a stand-in for gh (test/fixtures/drift-heal-gh.mjs)
// that answers the PR list, Redline's runs and the PRs' comments from a fixture. bash, git, jq, node,
// GNU date and sort, and the repository's own release scripts are the real ones. Without what the
// step needs (bash 4 associative arrays, GNU date -d, sort -V, jq, git) it is skipped, except in
// CI, where it fails. The fixtures are removed when the test ends.

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
  'date -u -d "-24 hours" +%Y-%m-%dT%H:%M:%SZ >/dev/null',
  '[ "$(printf "1.0.10\\n1.0.9\\n" | sort -V | tail -1)" = 1.0.10 ]',
  'jq -n 1 >/dev/null',
  'git --version >/dev/null',
].join(' && ');
const usable = process.platform !== 'win32' && spawnSync('bash', ['--noprofile', '--norc', '-c', PROBE]).status === 0;
if (!usable) {
  if (process.env.CI) {
    console.log('  FAIL the heal step needs bash 4, GNU date and sort, jq and git, and this runner lacks one');
    process.exit(1);
  }
  console.log('  SKIP drift-heal-e2e: needs bash 4, GNU date and sort, jq and git (CI runs it)');
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
  check('Redline\'s runs and comments are read with the job\'s token, the PR list with the drift-bot PAT',
    r.calls.some((x2) => x2.args[0] === 'api') && r.calls.filter((x2) => x2.args[0] === 'api').every((x2) => x2.token === 'runs-token')
    && r.calls.filter((x2) => x2.args[0] === 'pr').every((x2) => x2.token === 'pat-token'));
  check('every unfinished status of every Redline workflow is read, and the fix runs at each checked head',
    ['redline.yml', 'redline-fix.yml', 'redline-post.yml'].every((wf) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].every((st) => r.calls.some((x2) => String(x2.args[1]).includes(`/${wf}/runs?status=${st}&`))))
    && r.calls.some((x2) => String(x2.args[1]).includes(`/redline-fix.yml/runs?head_sha=${a}&`)));
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

console.log('\n=== a review that starts while a PR is healed: left as it was, and its version still held ===');
{
  const fx = fixture();
  const f = draft(fx, 'bot/cc-drift-f', fx.old, '1.0.5', 'change f');
  releaseMaster(fx, '1.0.5');
  const e = draft(fx, 'bot/cc-drift-e', 'master', '1.0.6', 'change e');
  commitOnMaster(fx, 'docs: unrelated', () => writeFileSync(join(fx.work, 'notes.txt'), 'master moved\n'));
  const r = heal(fx, {
    prs: [pr(21, 'bot/cc-drift-e', e, 'BEHIND'), pr(22, 'bot/cc-drift-f', f, 'DIRTY')],
    // Shown from the second read of redline.yml's in-progress runs on: after E's first check, before its push.
    runs: [{ workflow: 'redline.yml', id: 7, event: 'pull_request', status: 'in_progress', display_title: 'chore(drift): change e', head_sha: e, appearAfter: 2 }],
  });
  check('the run ends cleanly', r.status === 0 && /healed=1 refused=0 skipped=1/.test(r.out), r.out);
  check('E, whose review started while it was healed, is left as it was', tipOf(fx, 'bot/cc-drift-e') === e && /SKIPPED: Redline started on this head while it was healed/.test(section(r.out, 21)), section(r.out, 21));
  check('F steps over the 1.0.6 that E still holds: 1.0.7', versionOf(fx, 'bot/cc-drift-f') === '1.0.7', versionOf(fx, 'bot/cc-drift-f'));
}

console.log('\n=== a dispatched re-read holds its PR; a finished fix holds it until the platform answers it ===');
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
  const refused = (head, at) => ({ user: { login: 'askalf' }, created_at: at, body: `## Fix not applied at ${head}: refused\n\nThe only finding is about an existing commit.` });
  const r = heal(fx, {
    prs: [pr(51, 'bot/cc-drift-k', k, 'DIRTY'), pr(52, 'bot/cc-drift-l', l, 'DIRTY'), pr(53, 'bot/cc-drift-m', m, 'DIRTY'),
      pr(54, 'bot/cc-drift-n', n2, 'DIRTY'), pr(55, 'bot/cc-drift-q', q, 'DIRTY')],
    runs: [
      { workflow: 'redline.yml', id: 9, event: 'workflow_dispatch', status: 'queued', display_title: `Redline review askalf/fx#51 @ ${k} (re-read)`, head_sha: 'd'.repeat(40) },
      finished(10, 52, l), finished(11, 53, m),
      // N: a first fix run refused, then a retry at the same head that finished after the refusal.
      finished(12, 54, n2, { created_at: ago(40), updated_at: ago(30) }), finished(13, 54, n2, { created_at: ago(20), updated_at: ago(5) }),
      // Q: created two days ago and re-run lately.
      finished(14, 55, q, { created_at: ago(2 * 24 * 60), updated_at: ago(5) }),
    ],
    comments: { 52: [refused(l, ago(1))], 54: [refused(n2, ago(25))] },
  });
  check('K, with a re-read queued for its head, is left as it was', r.status === 0 && tipOf(fx, 'bot/cc-drift-k') === k && /SKIPPED: Redline is at work on this head/.test(section(r.out, 51)), r.out);
  check('M, whose fix run finished and is not yet answered, is left as it was', tipOf(fx, 'bot/cc-drift-m') === m && /not yet applied or refused at this head/.test(section(r.out, 53)), section(r.out, 53));
  check('L, whose finished fix the platform answered, is healed clear of the 1.0.5 the others hold: 1.0.6', versionOf(fx, 'bot/cc-drift-l') === '1.0.6', versionOf(fx, 'bot/cc-drift-l'));
  check('N, whose retry finished after the first run\'s refusal, is left as it was', tipOf(fx, 'bot/cc-drift-n') === n2 && /not yet applied or refused at this head/.test(section(r.out, 54)), section(r.out, 54));
  check('Q, a fix run created two days ago and re-run lately, is left as it was', tipOf(fx, 'bot/cc-drift-q') === q && /not yet applied or refused at this head/.test(section(r.out, 55)), section(r.out, 55));
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
    sideEffects: [{ key: 'redline.yml|queued', call: 2, git: ['--git-dir', fx.origin, 'update-ref', 'refs/heads/bot/cc-drift-s', moved] }],
  });
  check('p1 is not pushed, and the run ends cleanly and says which branch moved',
    r.status === 0 && tipOf(fx, 'bot/cc-drift-p1') === p1 && /STOPPED: a drift branch changed during the run \(bot\/cc-drift-s \(#72\) is at/.test(r.out), r.out);
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

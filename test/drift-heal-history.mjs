// drift-pr-heal.yml leaves a healed drift PR that is still the drafter's one commit as one commit on
// top of its base, with that commit's subject, and keeps the commits of any other branch (a fix pushed
// on a draft, a template rebake's bake commit). It leaves a PR alone while a Redline review, fix or
// verdict post is queued or running at its head. The git commands below are the ones the workflow
// runs, replayed on throwaway repos.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}

const wf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'drift-pr-heal.yml'), 'utf8');

console.log('\n=== drift-pr-heal leaves one commit ===');
const push = wf.indexOf('git push --force-with-lease="$head:');
const reset = wf.indexOf('git reset -q --soft "origin/$base"');
check('the workflow flattens the branch before it pushes', reset !== -1 && push > reset);
check('the push is a lease on the branch tip it fetched, not a bare force', !/git push (-f|--force)(?!-)/.test(wf) && wf.includes('--force-with-lease="$head:$(git rev-parse "origin/$head")"'));
check('the one commit keeps the draft commit\'s subject', wf.includes('git log --reverse --no-merges --format=%s "origin/$base..origin/$head" | head -n 1'));
check('it flattens only a branch that is still one commit of its own, and never a template rebake',
  wf.includes('own=$(git rev-list --no-merges --count "origin/$base..origin/$head")')
  && wf.includes('if [ "$own" -eq 1 ] && [[ "$head" != bot/template-rebake-* ]]; then')
  && wf.indexOf('if [ "$own" -eq 1 ]') < reset);

console.log('\n=== drift-pr-heal leaves a PR alone while Redline is at work on its head ===');
const busyAt = wf.indexOf('for st in queued in_progress; do');
const renumberAt = wf.indexOf('node scripts/renumber-release-version.mjs');
check('before it changes anything, it reads the queued and running runs at the head', busyAt !== -1 && renumberAt > busyAt
  && wf.includes('gh api "repos/$REPO/actions/runs?head_sha=$head_sha&status=$st&per_page=100"'));
check('a review, fix or verdict post there leaves the PR for the next pass', wf.includes("grep -qxE '\\.github/workflows/redline(-fix|-post)?\\.yml'")
  && /if \[ -n "\$busy" \]; then\n\s+echo "  SKIPPED: \$busy; the next pass heals it"\n\s+continue/.test(wf));
check('runs that cannot be listed count as busy', wf.includes('busy="the runs at $head_sha could not be listed"'));
check('the job may read the runs', /permissions:\n\s+contents: write\n\s+pull-requests: read\n\s+actions: read\n/.test(wf));

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

// A branch drafted on master, then master moves, then the workflow's merge and fold: `commits` are
// the branch's own commits before the heal, the first of them the draft.
function stuckBranch(branch, commits) {
  const dir = mkdtempSync(join(tmpdir(), 'dario-heal-'));
  git(dir, 'init', '-q', '-b', 'master');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', branch);
  commits.forEach((subject, i) => {
    writeFileSync(join(dir, `b${i}.txt`), `${subject}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', subject);
  });
  const tip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'master');
  writeFileSync(join(dir, 'c.txt'), 'master moved\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'master change');
  git(dir, 'checkout', '-q', branch);
  git(dir, 'merge', '-q', '--no-edit', 'master');
  writeFileSync(join(dir, 'b0.txt'), `${commits[0]}\nnotes\n`);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: fold notes merged since drafting into this release');
  return { dir, tip, tree: git(dir, 'rev-parse', 'HEAD^{tree}') };
}

// The workflow's decision and lines, with the remote-tracking names replaced by local ones:
// origin/$head is the branch tip before the heal, origin/$base is master.
function heal(dir, branch, tip) {
  const own = Number(git(dir, 'rev-list', '--no-merges', '--count', `master..${tip}`));
  if (own === 1 && !branch.startsWith('bot/template-rebake-')) {
    const subject = git(dir, 'log', '--reverse', '--no-merges', '--format=%s', `master..${tip}`).split('\n')[0];
    git(dir, 'reset', '-q', '--soft', 'master');
    git(dir, 'commit', '-q', '-m', subject);
  }
}

{
  const { dir, tip, tree } = stuckBranch('bot/template-label-x', ['chore(template): label refresh']);
  heal(dir, 'bot/template-label-x', tip);
  const subjects = git(dir, 'log', '--format=%s', 'master..HEAD').split('\n');
  check('a draft of one commit: one commit on top of the base', subjects.length === 1, subjects.join(' | '));
  check('it carries the draft subject', subjects[0] === 'chore(template): label refresh', subjects[0]);
  check('the healed tree is unchanged', git(dir, 'rev-parse', 'HEAD^{tree}') === tree);
  check('its parent is the base tip', git(dir, 'rev-parse', 'HEAD^') === git(dir, 'rev-parse', 'master'));
}
{
  // A fix pushed on top of a draft: its commit is what the fix comment and the review name.
  const { dir, tip, tree } = stuckBranch('bot/cc-drift-x', ['chore(drift): maxTested 2.1.332', 'fix: keep the client-required fields']);
  heal(dir, 'bot/cc-drift-x', tip);
  check('a draft with a fix on top keeps its commits: the old tip is still in the branch', git(dir, 'merge-base', '--is-ancestor', tip, 'HEAD') === '' && git(dir, 'rev-parse', 'HEAD^{tree}') === tree);
  check('and the fix commit with it', git(dir, 'log', '--format=%s', 'master..HEAD').split('\n').includes('fix: keep the client-required fields'));
}
{
  // A rebake's bake commit carries the rebake/upstream status: one commit of its own, still kept.
  const { dir, tip, tree } = stuckBranch('bot/template-rebake-20261125-020228', ['auto-rebake: template drift detected']);
  heal(dir, 'bot/template-rebake-20261125-020228', tip);
  check('a template rebake keeps its bake commit, though it is the only one', git(dir, 'merge-base', '--is-ancestor', tip, 'HEAD') === '' && git(dir, 'rev-parse', 'HEAD^{tree}') === tree);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

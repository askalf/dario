// drift-pr-heal.yml leaves a healed drift PR that is still the drafter's one commit as one commit on
// top of its base, with that commit's subject, and keeps the commits of any other branch (a fix pushed
// on a draft, a template rebake's bake commit). The git commands below are the ones the workflow runs,
// replayed on throwaway repos.

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
// The workflow's history block: from its comment up to the push, run as it stands in the replays below.
const blockStart = wf.indexOf("# A branch that is still the drafter's one commit");
const block = blockStart === -1 ? '' : wf.slice(blockStart, push);
check('the history block decides before it flattens, and ends at the push',
  blockStart !== -1 && blockStart < reset && reset < push);

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// A branch drafted on master, then master moves, then the workflow's merge and fold: `commits` are
// the branch's own commits before the heal, the first of them the draft. With `mergedBefore`, master
// moves once and is merged into the branch before the heal, so the remote head is that merge.
function stuckBranch(branch, commits, { mergedBefore = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dario-heal-'));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', branch);
  commits.forEach((subject, i) => {
    writeFileSync(join(dir, `b${i}.txt`), `${subject}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', subject);
  });
  if (mergedBefore) {
    git(dir, 'checkout', '-q', 'master');
    writeFileSync(join(dir, 'm.txt'), 'master moved first\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'master change before the merge');
    git(dir, 'checkout', '-q', branch);
    git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'master');
  }
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

// Run the workflow's block with the shell the Actions runner uses. The fetched tips are local
// remote-tracking refs: origin/$head is the branch tip before the heal, origin/$base is master.
function heal(dir, branch, tip) {
  git(dir, 'update-ref', 'refs/remotes/origin/master', 'master');
  git(dir, 'update-ref', `refs/remotes/origin/${branch}`, tip);
  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', block], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, base: 'master', head: branch },
  });
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
{
  // A one-commit draft someone updated by merging master: the merge tip is what a review can name.
  const { dir, tip, tree } = stuckBranch('bot/template-label-y', ['chore(template): label refresh'], { mergedBefore: true });
  heal(dir, 'bot/template-label-y', tip);
  check('a draft with a merge already on its head keeps that merge tip', git(dir, 'merge-base', '--is-ancestor', tip, 'HEAD') === '' && git(dir, 'rev-parse', 'HEAD^{tree}') === tree);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

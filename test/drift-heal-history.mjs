// drift-pr-heal.yml leaves each healed drift PR as one commit on top of its base, with the subject of
// its first non-merge commit. The git commands below are the ones the workflow runs, replayed on a
// throwaway repo.

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

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
const dir = mkdtempSync(join(tmpdir(), 'dario-heal-'));
git(dir, 'init', '-q', '-b', 'master');
writeFileSync(join(dir, 'a.txt'), 'base\n');
git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
git(dir, 'checkout', '-q', '-b', 'bot/x');
writeFileSync(join(dir, 'b.txt'), 'draft\n');
git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore(template): label refresh');
git(dir, 'checkout', '-q', 'master');
writeFileSync(join(dir, 'c.txt'), 'master moved\n');
git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'master change');
git(dir, 'checkout', '-q', 'bot/x');
git(dir, 'merge', '-q', '--no-edit', 'master');
writeFileSync(join(dir, 'b.txt'), 'draft\nnotes\n');
git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: fold notes merged since drafting into this release');
const tree = git(dir, 'rev-parse', 'HEAD^{tree}');

// The workflow's lines, with the remote-tracking names replaced by the local ones.
const subject = git(dir, 'log', '--reverse', '--no-merges', '--format=%s', 'master..bot/x').split('\n')[0];
git(dir, 'reset', '-q', '--soft', 'master');
git(dir, 'commit', '-q', '-m', subject);

const subjects = git(dir, 'log', '--format=%s', 'master..HEAD').split('\n');
check('one commit on top of the base', subjects.length === 1, subjects.join(' | '));
check('it carries the draft subject', subjects[0] === 'chore(template): label refresh', subjects[0]);
check('the healed tree is unchanged', git(dir, 'rev-parse', 'HEAD^{tree}') === tree);
check('its parent is the base tip', git(dir, 'rev-parse', 'HEAD^') === git(dir, 'rev-parse', 'master'));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

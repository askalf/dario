// scripts/check-changelog.mjs — the CI gate that makes a src/ change carry a
// release note. Pure helpers are tested directly; the end-to-end cases build a
// throwaway git repo per scenario so `git diff`/`git show` see real commits.
// No network, no dist/ import.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const { sectionsOf, newReleaseNoteBullets, main } = await import('../scripts/check-changelog.mjs');

const BASE_LOG = [
  '# Changelog', '',
  '## [Unreleased]', '',
  '## [6.0.22] - 2026-09-05', '',
  '- **Old entry.** Shipped already.', '',
].join('\n');

header('sectionsOf');
{
  const s = sectionsOf(BASE_LOG);
  check('finds both headings', s.has('## [Unreleased]') && s.has('## [6.0.22] - 2026-09-05'));
  check('Unreleased is empty at base', s.get('## [Unreleased]').size === 0);
  check('old section holds its bullet', s.get('## [6.0.22] - 2026-09-05').has('- **Old entry.** Shipped already.'));
  check('CRLF input parses the same', sectionsOf(BASE_LOG.replace(/\n/g, '\r\n')).get('## [6.0.22] - 2026-09-05').size === 1);
}

header('newReleaseNoteBullets — what counts as a release note for THIS PR');
{
  const withNew = BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **New thing.** Added.\n');
  check('a bullet added under Unreleased counts', newReleaseNoteBullets(BASE_LOG, withNew).length === 1);

  const oldEdit = BASE_LOG.replace('Shipped already.', 'Shipped already (typo fixed).');
  check('editing an OLD entry does not count (the #1217 review bypass)', newReleaseNoteBullets(BASE_LOG, oldEdit).length === 0);

  const oldAdd = BASE_LOG.replace('- **Old entry.** Shipped already.\n', '- **Old entry.** Shipped already.\n- **Backfilled.** Into an old release.\n');
  check('adding a bullet to an OLD release section does not count', newReleaseNoteBullets(BASE_LOG, oldAdd).length === 0);

  const deletion = BASE_LOG.replace('- **Old entry.** Shipped already.\n', '');
  check('deleting text does not count', newReleaseNoteBullets(BASE_LOG, deletion).length === 0);

  check('unchanged file yields nothing', newReleaseNoteBullets(BASE_LOG, BASE_LOG).length === 0);

  // A version-bump PR: Unreleased had a bullet at base; head renames the
  // section to the new version and adds a fresh empty Unreleased above.
  const baseWithPending = BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **Pending.** Landed earlier.\n');
  const bumped = baseWithPending.replace('## [Unreleased]\n\n- **Pending.** Landed earlier.\n', '## [Unreleased]\n\n## [6.0.23] - 2026-09-06\n\n- **Pending.** Landed earlier.\n');
  check('a bump that only MOVES bullets adds no new note', newReleaseNoteBullets(baseWithPending, bumped).length === 0);
  const bumpedWithOwn = bumped.replace('- **Pending.** Landed earlier.\n', '- **Pending.** Landed earlier.\n- **Bump-carried fix.** New in this PR.\n');
  check('a bullet under a NEW release heading counts', newReleaseNoteBullets(baseWithPending, bumpedWithOwn).length === 1);

  // Second review on #1217: any new `## ` heading used to count as a release
  // section, so `## Notes` + a bullet passed the gate.
  const notesHeading = BASE_LOG + '## Notes\n\n- updated docs\n';
  check('a bullet under an arbitrary NEW non-release heading does NOT count', newReleaseNoteBullets(BASE_LOG, notesHeading).length === 0);
  const undatedRelease = BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [6.0.23]\n\n- **Undated release heading.** Still a release.\n');
  check('an undated `## [x.y.z]` heading still counts as a release section', newReleaseNoteBullets(BASE_LOG, undatedRelease).length === 1);

  // Third review on #1217: by text alone a REWORDED Unreleased bullet looks
  // new. The gate is a count.
  const reworded = baseWithPending.replace('- **Pending.** Landed earlier.', '- **Pending.** Landed earlier!');
  check('rewording an existing Unreleased bullet does NOT count', newReleaseNoteBullets(baseWithPending, reworded).length === 0);
  const rewordedPlusNew = reworded.replace('- **Pending.** Landed earlier!\n', '- **Pending.** Landed earlier!\n- **Really new.** This PR.\n');
  check('reword + a genuinely new bullet counts once', newReleaseNoteBullets(baseWithPending, rewordedPlusNew).length >= 1);
}

// ---------------------------------------------------------------- end-to-end
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'dario-changelog-gate-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@example.invalid']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'CHANGELOG.md'), BASE_LOG);
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'README.md'), 'readme\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  return { dir, base };
}
async function scenario(label, mutate, expectExit, labels = '') {
  const { dir } = await repo();
  await mutate(dir);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  // Judge against the commit just before HEAD: a scenario may lay down an
  // extra base commit inside mutate() (the reworded-bullet case does).
  const base = git(dir, ['rev-parse', 'HEAD~1']);
  const prev = process.cwd();
  process.chdir(dir);
  const origLog = console.log, origErr = console.error;
  console.log = () => {}; console.error = () => {};
  let code;
  try { code = main({ BASE_SHA: base, HEAD_SHA: head, PR_LABELS: labels }); }
  finally { console.log = origLog; console.error = origErr; process.chdir(prev); }
  check(`${label} → exit ${expectExit}`, code === expectExit);
  await rm(dir, { recursive: true, force: true });
}

header('end-to-end against real commits');
await scenario('src change + new Unreleased bullet', async (d) => {
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(d, 'CHANGELOG.md'), BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **Changed a.** Now 2.\n'));
}, 0);
await scenario('src change, CHANGELOG untouched', async (d) => {
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
}, 1);
await scenario('src change + only an OLD-entry typo fix (the bypass)', async (d) => {
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(d, 'CHANGELOG.md'), BASE_LOG.replace('Shipped already.', 'Shipped already (typo).'));
}, 1);
await scenario('src change + bullet added to an OLD release', async (d) => {
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(d, 'CHANGELOG.md'), BASE_LOG.replace('- **Old entry.** Shipped already.\n', '- **Old entry.** Shipped already.\n- **Sneaky.** Old section.\n'));
}, 1);
await scenario('src change + bullet under a new non-release `## Notes` heading (2nd bypass)', async (d) => {
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(d, 'CHANGELOG.md'), BASE_LOG + '## Notes\n\n- updated docs\n');
}, 1);
await scenario('src change + no-changelog label', async (d) => {
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
}, 0, 'ci,no-changelog');
await scenario('docs-only change, CHANGELOG untouched', async (d) => {
  await writeFile(join(d, 'README.md'), 'readme 2\n');
}, 0);
await scenario('src change + only a REWORDED existing Unreleased bullet', async (d) => {
  // base for this scenario has a pending bullet; write it first as a base commit
  await writeFile(join(d, 'CHANGELOG.md'), BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **Pending.** Landed earlier.\n'));
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'pending']);
  await writeFile(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(d, 'CHANGELOG.md'), BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **Pending.** Landed earlier!\n'));
}, 1);

header('base advanced after the fork — the PR must be judged on ITS changes');
{
  // master: base ─┬─ (PR) README-only
  //               └─ (master moved) src/b.ts + its own changelog bullet
  const { dir, base } = await repo();
  git(dir, ['checkout', '-q', '-b', 'pr']);
  await writeFile(join(dir, 'README.md'), 'readme from the PR\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'pr: docs only']);
  const prHead = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', 'master']);
  await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  await writeFile(join(dir, 'CHANGELOG.md'), BASE_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **b.** Someone else shipped this.\n'));
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'master: unrelated src change']);
  const movedBase = git(dir, ['rev-parse', 'HEAD']);
  // What Actions checks out on pull_request: base with the PR merged in.
  git(dir, ['checkout', '-q', '-b', 'merge', 'master']);
  git(dir, ['merge', '-q', '--no-edit', 'pr']);
  const mergeSha = git(dir, ['rev-parse', 'HEAD']);
  const prev = process.cwd(); process.chdir(dir);
  const origLog = console.log, origErr = console.error; console.log = () => {}; console.error = () => {};
  let viaMerge, viaHead;
  try {
    viaMerge = main({ BASE_SHA: movedBase, HEAD_SHA: mergeSha, PR_LABELS: '' });
    viaHead = main({ BASE_SHA: movedBase, HEAD_SHA: prHead, PR_LABELS: '' });
  } finally { console.log = origLog; console.error = origErr; process.chdir(prev); }
  check('docs-only PR passes when judged as the merge commit (CI shape) → exit 0', viaMerge === 0);
  check('docs-only PR passes when judged as its stale head via merge-base → exit 0', viaHead === 0);
  check('sanity: the naive two-dot diff WOULD have blamed src/b.ts on the PR',
    git(dir, ['diff', '--name-only', movedBase, prHead]).includes('src/b.ts'));
  await rm(dir, { recursive: true, force: true });
  void base;
}
{
  // No BASE_SHA = a push run; must be a no-op regardless of tree state.
  check('no BASE_SHA → exit 0', main({ HEAD_SHA: 'HEAD', PR_LABELS: '' }) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
void fileURLToPath;

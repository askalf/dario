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
  const { dir, base } = await repo();
  await mutate(dir);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);
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
{
  // No BASE_SHA = a push run; must be a no-op regardless of tree state.
  check('no BASE_SHA → exit 0', main({ HEAD_SHA: 'HEAD', PR_LABELS: '' }) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
void fileURLToPath;

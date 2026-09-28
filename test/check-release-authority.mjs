// scripts/check-release-authority.mjs — the CI gate that keeps an outside
// contributor's PR from cutting a release (dario#1450 bumped to 6.12.8 on its
// own and the merge published it). Pure helpers are tested directly; the
// end-to-end cases build a throwaway git repo per scenario so `git show` sees
// real commits. No network, no dist/ import.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

const { isOutsideContributor, newReleaseHeadings, releaseChanges, main } = await import('../scripts/check-release-authority.mjs');

const REPO = 'askalf/dario';
const FORK = 'someone/dario';

header('isOutsideContributor — who may cut a release');
{
  check('fork + CONTRIBUTOR is outside (the #1450 shape)', isOutsideContributor({ headRepo: FORK, baseRepo: REPO, association: 'CONTRIBUTOR' }));
  check('fork + FIRST_TIME_CONTRIBUTOR is outside', isOutsideContributor({ headRepo: FORK, baseRepo: REPO, association: 'FIRST_TIME_CONTRIBUTOR' }));
  check('fork + NONE is outside', isOutsideContributor({ headRepo: FORK, baseRepo: REPO, association: 'NONE' }));
  check('fork + missing association fails closed (outside)', isOutsideContributor({ headRepo: FORK, baseRepo: REPO }));
  check('fork + OWNER may release', !isOutsideContributor({ headRepo: FORK, baseRepo: REPO, association: 'OWNER' }));
  check('fork + MEMBER may release', !isOutsideContributor({ headRepo: FORK, baseRepo: REPO, association: 'MEMBER' }));
  check('fork + COLLABORATOR may release', !isOutsideContributor({ headRepo: FORK, baseRepo: REPO, association: 'COLLABORATOR' }));
  check('same-repo branch may release (drift bot PRs)', !isOutsideContributor({ headRepo: REPO, baseRepo: REPO, association: 'CONTRIBUTOR' }));
  check('deleted fork (no head repo) fails closed', isOutsideContributor({ headRepo: '', baseRepo: REPO, association: 'CONTRIBUTOR' }));
}

const LOG = [
  '# Changelog', '',
  '## [Unreleased]', '',
  '## [6.12.7] - 2026-09-26', '',
  '- **Old entry.** Shipped already.', '',
].join('\n');
const CUT = LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [6.12.8] - 2026-09-27\n\n- **Hard floor.** New.\n');
const NOTED = LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- **Hard floor.** New.\n');

header('newReleaseHeadings');
{
  check('a new dated release heading is found', newReleaseHeadings(LOG, CUT).join() === '## [6.12.8] - 2026-09-27');
  check('an undated release heading is found', newReleaseHeadings(LOG, LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [6.12.8]\n')).length === 1);
  check('a bullet under Unreleased is not a release', newReleaseHeadings(LOG, NOTED).length === 0);
  check('an existing release heading is not new', newReleaseHeadings(LOG, LOG).length === 0);
  check('a `## Notes` heading is not a release', newReleaseHeadings(LOG, LOG + '## Notes\n').length === 0);
}

const pkg = (v) => ({ name: '@askalf/dario', version: v });
const lock = (v, root = v) => ({ name: '@askalf/dario', version: v, packages: { '': { version: root } } });

header('releaseChanges — each release slot on its own');
{
  const same = { basePkg: pkg('6.12.7'), headPkg: pkg('6.12.7'), baseLock: lock('6.12.7'), headLock: lock('6.12.7'), baseLog: LOG, headLog: NOTED };
  check('no release-cutting change → empty', releaseChanges(same).length === 0);
  check('package.json bump alone is caught', releaseChanges({ ...same, headPkg: pkg('6.12.8') }).length === 1);
  check('lockfile .version alone is caught', releaseChanges({ ...same, headLock: lock('6.12.8', '6.12.7') }).length === 1);
  check('lockfile packages[""] alone is caught', releaseChanges({ ...same, headLock: lock('6.12.7', '6.12.8') }).length === 1);
  check('release heading alone is caught', releaseChanges({ ...same, headLog: CUT }).length === 1);
  check('the full #1450 bump reports all four', releaseChanges({ ...same, headPkg: pkg('6.12.8'), headLock: lock('6.12.8'), headLog: CUT }).length === 4);
}

// ---------------------------------------------------------------- end-to-end
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function writeState(dir, v, log) {
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg(v), null, 2) + '\n');
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock(v), null, 2) + '\n');
  await writeFile(join(dir, 'CHANGELOG.md'), log);
}
async function scenario(label, { version, log, headRepo = FORK, association = 'CONTRIBUTOR' }, expectExit) {
  const dir = await mkdtemp(join(tmpdir(), 'dario-release-authority-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@example.invalid']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeState(dir, '6.12.7', LOG);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  await writeState(dir, version, log);
  await writeFile(join(dir, 'pool.ts'), 'export const floor = 0.05;\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'head']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  const prev = process.cwd();
  process.chdir(dir);
  const origLog = console.log, origErr = console.error;
  console.log = () => {}; console.error = () => {};
  let code;
  try {
    code = main({ BASE_SHA: base, HEAD_SHA: head, HEAD_REPO: headRepo, GITHUB_REPOSITORY: REPO, AUTHOR_ASSOCIATION: association });
  } finally { console.log = origLog; console.error = origErr; process.chdir(prev); }
  check(`${label} → exit ${expectExit}`, code === expectExit);
  await rm(dir, { recursive: true, force: true });
}

header('end-to-end against real commits');
await scenario('fork contributor bumps and cuts a heading (#1450)', { version: '6.12.8', log: CUT }, 1);
await scenario('fork contributor bumps package.json only', { version: '6.12.8', log: NOTED }, 1);
await scenario('fork contributor cuts a heading only', { version: '6.12.7', log: CUT }, 1);
await scenario('fork contributor with notes under Unreleased', { version: '6.12.7', log: NOTED }, 0);
await scenario('owner bump from a same-repo branch', { version: '6.12.8', log: CUT, headRepo: REPO, association: 'OWNER' }, 0);
await scenario('collaborator bump from a fork', { version: '6.12.8', log: CUT, association: 'COLLABORATOR' }, 0);
check('no BASE_SHA → exit 0', main({ HEAD_SHA: 'HEAD', HEAD_REPO: FORK, GITHUB_REPOSITORY: REPO, AUTHOR_ASSOCIATION: 'NONE' }) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

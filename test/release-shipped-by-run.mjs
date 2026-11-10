#!/usr/bin/env node
/**
 * Tests for scripts/release-shipped-by-run.mjs and the workflow that calls it.
 *
 * homebrew-tap-notify.yml runs after every successful run of the release
 * workflow. Most of those runs release nothing, and the one mistake that
 * matters is announcing a release the run did not publish (the tap would be
 * poked on every merge) or missing the one it did. The steps run only in
 * Actions, so the conditions the two workflow files have to keep are read
 * from the files.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedBy, SKEW_MS } from '../scripts/release-shipped-by-run.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

header('the release a run published');
{
  const rel = (tag_name, published_at, extra = {}) => ({ tag_name, published_at, draft: false, prerelease: false, ...extra });
  // A real release run: started 16:45:36, release created 16:48:50, ended 16:49:13.
  const START = '2026-11-10T16:45:36Z';
  const END = '2026-11-10T16:49:13Z';
  const older = [rel('v6.23.7', '2026-11-10T03:08:02Z'), rel('v6.23.6', '2026-11-10T02:39:27Z')];

  check('the release published while the run was going', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z'), ...older], START, END) === '6.23.8');
  check('a run that published nothing: none', shippedBy(older, START, END) === null);
  check('the hourly run an hour after a release does not announce it again', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z'), ...older], '2026-11-10T17:45:26Z', '2026-11-10T17:45:39Z') === null);
  check('a push run seconds after the release run does not either', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z')], '2026-11-10T16:53:40Z', '2026-11-10T16:53:55Z') === null);
  check('a release from before the run started is not this run\'s', shippedBy([rel('v6.23.8', '2026-11-10T16:40:00Z')], START, END) === null);
  check('a release from after the run ended is not this run\'s', shippedBy([rel('v6.23.9', '2026-11-10T16:55:00Z')], START, END) === null);

  const ms = (iso, d) => new Date(Date.parse(iso) + d).toISOString();
  check('clock slack: a release stamped just before the start still counts', shippedBy([rel('v6.23.8', ms(START, -SKEW_MS + 1000))], START, END) === '6.23.8');
  check('and one stamped just after the end', shippedBy([rel('v6.23.8', ms(END, SKEW_MS - 1000))], START, END) === '6.23.8');
  check('but not beyond the slack on either side', shippedBy([rel('v6.23.8', ms(START, -SKEW_MS - 1000))], START, END) === null && shippedBy([rel('v6.23.8', ms(END, SKEW_MS + 1000))], START, END) === null);

  check('a draft is not announced', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z', { draft: true })], START, END) === null);
  check('a pre-release is not announced', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z', { prerelease: true })], START, END) === null);
  check('a tag that is not vX.Y.Z is not announced', ['6.23.8', 'v6.23.8-rc.1', 'v6.23', 'release-6.23.8', 'v6.23.8\n'].every((t) => shippedBy([rel(t, '2026-11-10T16:48:50Z')], START, END) === null));
  check('a release with no publish time is skipped', shippedBy([rel('v6.23.8', null), rel('v6.23.8', 'soon')], START, END) === null);
  check('two releases inside one window: the newest', shippedBy([rel('v6.23.8', '2026-11-10T16:46:00Z'), rel('v6.23.9', '2026-11-10T16:48:50Z')], START, END) === '6.23.9');
  check('the order of the listing does not matter', shippedBy([...older, rel('v6.23.8', '2026-11-10T16:48:50Z')], START, END) === '6.23.8');

  check('a run window that cannot be read: none', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z')], '', END) === null && shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z')], START, undefined) === null);
  check('an end before the start: none', shippedBy([rel('v6.23.8', '2026-11-10T16:48:50Z')], END, START) === null);
  check('a listing that is not a list: none', shippedBy(null, START, END) === null && shippedBy({ message: 'Not Found' }, START, END) === null);
}

header('the command line');
{
  const cli = (env) => spawnSync(process.execPath, [join(REPO, 'scripts', 'release-shipped-by-run.mjs')], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '', RUN_STARTED: '', RUN_ENDED: '', ...env } });
  check('no window: exits 1 and prints no version', cli({ GITHUB_REPOSITORY: 'o/r' }).status === 1 && cli({ GITHUB_REPOSITORY: 'o/r' }).stdout === '');
  check('no repository: exits 1', cli({ RUN_STARTED: '2026-11-10T16:45:36Z', RUN_ENDED: '2026-11-10T16:49:13Z' }).status === 1);
  check('an unreadable time: exits 1', cli({ GITHUB_REPOSITORY: 'o/r', RUN_STARTED: 'soon', RUN_ENDED: '2026-11-10T16:49:13Z' }).status === 1);
}

header('the two workflows');
{
  const wf = (name) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');
  const release = wf('cc-drift-auto-release.yml');
  const notify = wf('homebrew-tap-notify.yml');
  const jobOf = (text, name) => {
    const start = text.indexOf(`\n  ${name}:\n`);
    if (start < 0) return null;
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };

  // What holds the release run open is what delays the box: nothing may wait on npm in it.
  check('the release workflow has no homebrew job and no wait on npm', !release.includes('homebrew-tap:') && !release.includes('TAP_DISPATCH_TOKEN') && !/for _ in \$\(seq/.test(release));
  check('and is one job', (release.slice(release.indexOf('\njobs:')).match(/\n  [a-z][a-z0-9-]*:\n/g) ?? []).length === 1);

  const releaseName = /^name: (.+)$/m.exec(release)?.[1];
  check('the notify workflow follows the release workflow by its name', releaseName === 'Auto release on version bump' && notify.includes(`    workflows: ["${releaseName}"]\n    types: [completed]\n    branches: [master]\n`));
  check('it is triggered by nothing else', /^on:\n  workflow_run:\n(?:    .*\n)+\npermissions: \{\}\n/m.test(notify) && !/^\s+(push|pull_request|pull_request_target|schedule|workflow_dispatch):/m.test(notify));
  check('the workflow token has no scopes by default', /\npermissions: \{\}\n/.test(notify));

  const shipped = jobOf(notify, 'shipped');
  const send = jobOf(notify, 'notify');
  check('both jobs are there', shipped !== null && send !== null);
  check('only a release run that succeeded, and never from a fork', (shipped ?? '').includes("    if: github.repository == 'askalf/dario' && github.event.workflow_run.conclusion == 'success'\n"));
  check('the first job reads the repository and nothing more', /\n    permissions:\n      contents: read\n    outputs:/.test(shipped ?? '') && !(shipped ?? '').includes('secrets.'));
  check('the tap token is read in one place in the whole workflow', notify.split('secrets.').length - 1 === 1 && (send ?? '').includes('secrets.TAP_DISPATCH_TOKEN'));
  check('the run window comes from the event, through the environment', (shipped ?? '').includes('RUN_STARTED: ${{ github.event.workflow_run.run_started_at }}') && (shipped ?? '').includes('RUN_ENDED: ${{ github.event.workflow_run.updated_at }}') && !((shipped ?? '').split('run: |')[1] ?? '').includes('${{'));
  check('a failed listing announces nothing and does not fail the job', /version=\$\(node scripts\/release-shipped-by-run\.mjs\) \|\| \{\n[^\n]*::warning::[^\n]*\n\s+exit 0\n/.test(shipped ?? ''));
  check('no version found: no output, so the second job is skipped', /if \[ -z "\$version" \]; then\n[^\n]*\n\s+exit 0\n/.test(shipped ?? '') && (shipped ?? '').indexOf('exit 0\n          fi\n          echo "The release run published v$version') < (shipped ?? '').indexOf('echo "version=$version" >> "$GITHUB_OUTPUT"'));

  check('the second job runs only for a version', (send ?? '').includes("    needs: shipped\n    if: needs.shipped.outputs.version != ''\n"));
  check('it holds the tap token and no workflow-token scopes', (send ?? '').includes('    permissions: {}\n') && (send ?? '').includes('GH_TOKEN: ${{ secrets.TAP_DISPATCH_TOKEN }}'));
  check('no checkout and no action in the job that holds the tap token', !(send ?? '').includes('uses:'));
  const sendRun = (send ?? '').split('run: |')[1] ?? '';
  check('the version reaches the shell through the environment only', (send ?? '').includes('VERSION: ${{ needs.shipped.outputs.version }}') && !sendRun.includes('${{'));
  check('it is checked as x.y.z before it is used', sendRun.indexOf('if [[ ! "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then') > 0 && sendRun.indexOf('if [[ ! "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then') < sendRun.indexOf('npm view'));
  check('the event is sent only once npm reports the version', sendRun.indexOf('if [ "$latest" != "$VERSION" ]; then') > 0 && sendRun.indexOf('if [ "$latest" != "$VERSION" ]; then') < sendRun.indexOf('gh api --method POST repos/askalf/homebrew-tap/dispatches -f event_type=dario-release'));
  check('without the token it ends with a notice', /if \[ -z "\$GH_TOKEN" \]; then\n[^\n]*::notice::[^\n]*\n\s+exit 0\n/.test(sendRun));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

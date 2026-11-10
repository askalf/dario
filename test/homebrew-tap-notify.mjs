#!/usr/bin/env node
/**
 * The hand-off between cc-drift-auto-release.yml and homebrew-tap-notify.yml.
 *
 * The tap notification runs after the release run, not inside it, so that its
 * wait for npm does not hold the release run open (the hosted instance's
 * deploy starts when that run completes). A release run that shipped leaves an
 * artifact naming the version, and the notify workflow reads it by the id of
 * the run that triggered it.
 *
 * Neither workflow can run outside Actions. What can go wrong without a test
 * noticing is the two files drifting apart: the artifact renamed on one side,
 * the workflow renamed, the marker written by a run that shipped nothing, or
 * the wait for npm creeping back into the release run. Each of those is read
 * out of the files here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = (name) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');
const release = wf('cc-drift-auto-release.yml');
const notify = wf('homebrew-tap-notify.yml');

/** One step, from its `- name:` line to the next step at the same indent. */
const stepOf = (text, name) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) return null;
  const indent = lines[start].indexOf('-');
  const next = lines.findIndex((l, i) => i > start && l.indexOf('- ') === indent && l.trimStart().startsWith('- '));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
};
/** One job, from its key to the next job (the comment above the next job included). */
const jobOf = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const ifOf = (step) => (step ?? '').split('\n').find((l) => l.trim().startsWith('if:'))?.trim() ?? '';
const ARTIFACT = 'released-version';
const FILE = 'released-version.txt';

header('the release run ends when the release is out');
{
  const jobs = release.slice(release.indexOf('\njobs:')).match(/\n  [a-z][a-z0-9-]*:\n/g) ?? [];
  check('the release workflow is one job', jobs.length === 1 && jobs[0].trim() === 'release:', jobs.join(' '));
  check('nothing in it waits on npm to report a version', !/for _ in \$\(seq/.test(release) && !/sleep \d+/.test(release.slice(release.indexOf('\njobs:'))), 'a sleep or a poll loop is back in the release run');
  check('it does not hold the tap token', !release.includes('TAP_DISPATCH_TOKEN') && !release.includes('homebrew-tap/dispatches'));
}

header('a run that shipped leaves the marker, and only such a run');
{
  const write = stepOf(release, 'Write the version this run shipped');
  const upload = stepOf(release, 'Upload it for the Homebrew notification');
  check('both steps are there, in order, and last in the job', write !== null && upload !== null
    && release.indexOf('- name: Write the version this run shipped') < release.indexOf('- name: Upload it for the Homebrew notification')
    && release.trimEnd().endsWith((upload ?? '').trimEnd()));
  for (const [label, step] of [['write', write], ['upload', upload]]) {
    check(`${label}: only when the gate let the run ship`, ifOf(step) === "if: steps.gate.outputs.proceed == 'true'", ifOf(step));
    check(`${label}: not on a failed run (no always() or failure() in its condition)`, !/always\(\)|failure\(\)|cancelled\(\)/.test(ifOf(step)));
  }
  check('the version is the one the run released, passed through the environment', (write ?? '').includes('VERSION: ${{ steps.ver.outputs.version }}') && (write ?? '').includes(`run: printf '%s\\n' "$VERSION" > ${FILE}`));
  check('the upload names the artifact and the file', (upload ?? '').includes(`name: ${ARTIFACT}\n`) && (upload ?? '').includes(`path: ${FILE}\n`));
  check('a missing file is an error of the upload step, not an empty artifact', (upload ?? '').includes('if-no-files-found: error'));
  check('a failed upload does not fail a release that is already out', (upload ?? '').includes('continue-on-error: true') && !(write ?? '').includes('continue-on-error'));
  check('the upload action is pinned to a commit', /uses: actions\/upload-artifact@[0-9a-f]{40} # v/.test(upload ?? ''));
  // Positions of the steps themselves. The words "npm publish" also appear in the file's opening comment.
  const PUBLISH = '      - name: npm publish (OIDC trusted publishing)\n';
  const WRITE = '      - name: Write the version this run shipped\n';
  const UPLOAD = '      - name: Upload it for the Homebrew notification\n';
  const markerAfterPublish = (text) => {
    const at = (s) => (text.split(s).length - 1 === 1 ? text.indexOf(s) : -1);
    return at(PUBLISH) > 0 && at(WRITE) > at(PUBLISH) && at(UPLOAD) > at(WRITE);
  };
  check('the marker is written and uploaded after the npm publish step', markerAfterPublish(release));
  // The same file with the two marker steps moved ahead of the publish step: the check has to notice.
  const markerSteps = `${write}\n${upload}`.trimEnd() + '\n';
  const without = release.replace(`\n${markerSteps}`, '\n');
  const moved = without.replace(PUBLISH, `${markerSteps}\n${PUBLISH}`);
  const once = (text, s) => text.split(s).length - 1 === 1;
  check('the fixture holds the same three steps, each once, with the marker steps first', !without.includes(WRITE) && !without.includes(UPLOAD)
    && [PUBLISH, WRITE, UPLOAD].every((s) => once(moved, s))
    && moved.indexOf(WRITE) < moved.indexOf(UPLOAD) && moved.indexOf(UPLOAD) < moved.indexOf(PUBLISH));
  check('with the marker steps moved ahead of the publish step, the check fails', markerAfterPublish(moved) === false);
  check('with the publish step renamed, the check fails rather than passing on a comment', markerAfterPublish(release.replace(PUBLISH, '      - name: publish\n')) === false);
}

header('the notify workflow follows the release workflow');
{
  const releaseName = /^name: (.+)$/m.exec(release)?.[1];
  check('by its name, on master, when a run completes', releaseName === 'Auto release on version bump'
    && notify.includes(`on:\n  workflow_run:\n    workflows: ["${releaseName}"]\n    types: [completed]\n    branches: [master]\n`));
  check('and on nothing else', !/^\s+(push|pull_request|pull_request_target|schedule|workflow_dispatch):/m.test(notify));
  check('the workflow token has no scopes by default', /\npermissions: \{\}\n/.test(notify));
  // A group keeps one pending run: a later no-op run would replace a pending run that has a release to announce.
  check('no concurrency group', !/^\s*concurrency:/m.test(notify) && !/^\s*cancel-in-progress:/m.test(notify));
}

header('which run shipped is read from that run, not inferred');
{
  const shipped = jobOf(notify, 'shipped');
  // The step is the job's only one, so its script is read from the job: stepOf would run on into the next job.
  const find = shipped;
  const run = (shipped ?? '').split('run: |')[1] ?? '';
  check('the job has one step', ((shipped ?? '').match(/\n      - name: /g) ?? []).length === 1 && (shipped ?? '').includes('- name: Read the version that run shipped'));
  check('only a release run that succeeded, and never from a fork', (shipped ?? '').includes("    if: github.repository == 'askalf/dario' && github.event.workflow_run.conclusion == 'success'\n"));
  check('the job may read Actions artifacts and nothing else', /\n    permissions:\n      actions: read\n    outputs:/.test(shipped ?? ''));
  check('it holds no secret and runs no action or checkout', !(shipped ?? '').includes('secrets.') && !(shipped ?? '').includes('uses:'));
  check('the run is the one that triggered this workflow', (find ?? '').includes('RUN_ID: ${{ github.event.workflow_run.id }}') && !run.includes('${{'));
  check('the run id is checked as a number before it is used', run.indexOf('if [[ ! "$RUN_ID" =~ ^[0-9]+$ ]]; then') > 0 && run.indexOf('if [[ ! "$RUN_ID" =~ ^[0-9]+$ ]]; then') < run.indexOf('gh api'));
  check('the artifact is looked up by that run id and by name', run.includes('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/artifacts"') && run.includes(`select(.name == "${ARTIFACT}" and .expired == false)`));
  check('and downloaded from that run', run.includes(`gh run download "$RUN_ID" --repo "$GITHUB_REPOSITORY" --name ${ARTIFACT} --dir "$dir"`));
  check('the file read is the one the release run wrote', run.includes(`"$dir/${FILE}"`));
  check('no publish times, no release listing: nothing is inferred from a window', !/published_at|run_started_at|updated_at|releases\b/.test(shipped ?? ''));
  check('no marker means the run shipped nothing, said plainly and without a warning', /if \[ "\$marker" != "1" \]; then\n\s+echo "The release run shipped nothing[^\n]*\n\s+exit 0\n/.test(run));
  check('the artifact\'s content leaves the job only as a plain version', run.indexOf('if [[ ! "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then') > 0
    && run.indexOf('if [[ ! "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then') < run.indexOf('echo "version=$version" >> "$GITHUB_OUTPUT"')
    && run.split('>> "$GITHUB_OUTPUT"').length - 1 === 1);
  check('every way of not finding a version ends the job green', (run.match(/exit 0/g) ?? []).length === 5 && !/exit [1-9]/.test(run));
}

header('the job that holds the tap token');
{
  const send = jobOf(notify, 'notify');
  const run = (send ?? '').split('run: |')[1] ?? '';
  check('runs only for a version', (send ?? '').includes("    needs: shipped\n    if: needs.shipped.outputs.version != ''\n"));
  check('has no workflow-token scopes', (send ?? '').includes('    permissions: {}\n'));
  check('runs no action and no checkout', !(send ?? '').includes('uses:'));
  check('is the one place the tap token is read', notify.split('secrets.').length - 1 === 1 && (send ?? '').includes('GH_TOKEN: ${{ secrets.TAP_DISPATCH_TOKEN }}'));
  check('takes the version through the environment only', (send ?? '').includes('VERSION: ${{ needs.shipped.outputs.version }}') && !run.includes('${{'));
  check('checks it as x.y.z before using it', run.indexOf('if [[ ! "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then') > 0 && run.indexOf('if [[ ! "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then') < run.indexOf('npm view'));
  check('sends the event only once npm reports the version', run.indexOf('if [ "$latest" != "$VERSION" ]; then') > 0
    && run.indexOf('if [ "$latest" != "$VERSION" ]; then') < run.indexOf('gh api --method POST repos/askalf/homebrew-tap/dispatches -f event_type=dario-release'));
  check('ends with a notice when the token is not set', /if \[ -z "\$GH_TOKEN" \]; then\n[^\n]*::notice::[^\n]*\n\s+exit 0\n/.test(run));
}

header('the runner policy knows the new workflow');
{
  const selfTest = wf('fleet-status-self-test.yml');
  const repoOnly = /^\s+repo-only: (.+)$/m.exec(selfTest)?.[1].split(/\s+/) ?? [];
  check('homebrew-tap-notify.yml is listed among the workflows that never run PR code', repoOnly.includes('homebrew-tap-notify.yml'), repoOnly.join(' '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

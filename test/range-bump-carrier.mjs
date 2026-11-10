#!/usr/bin/env node
/**
 * Tests for scripts/range-bump-carrier.mjs and the wiring around it.
 *
 * A Claude Code version that changes the prompt or the tools ships as one dario
 * release: cc-drift-watch.yml dispatches the template watcher for the version
 * and drafts its own maxTested PR only when no rebake PR carries the bump. The
 * functions that decide "does a rebake PR carry it" and "which run is the one
 * we dispatched" are tested here with stand-ins for `gh`. The workflow steps
 * that call them cannot run outside Actions, so the conditions that hold the
 * design together are read out of the two workflow files and asserted.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPlainVersion, maxTestedOf, carriesRange, pickCarrier, runFor, awaitRun, runTitleFor, RANGE_FILE, TEMPLATE_WATCH,
  pickBinary, wireVersionOf, openWireIssueCount, mayCarry, WIRE_DRIFT_LABEL, WIRE_DRIFT_TITLE_PREFIX,
} from '../scripts/range-bump-carrier.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (v) => `export const SUPPORTED_CC_RANGE = {\n  min: '1.0.0',\n  maxTested: '${v}',\n};\n`;

header('maxTested as a branch claims it');
{
  check('read from the source text', maxTestedOf(source('2.1.323')) === '2.1.323');
  check('either quote style', maxTestedOf('maxTested: "2.1.9"') === '2.1.9');
  check('no maxTested line: null', maxTestedOf('export const X = 1;') === null);
  check('a value that is not x.y.z: null', maxTestedOf("maxTested: '2.1.323-beta.1'") === null && maxTestedOf("maxTested: 'latest'") === null);
  check('not a string: null', maxTestedOf(null) === null && maxTestedOf(undefined) === null);
  check('the file it is read from is the one that defines it', readFileSync(join(REPO, RANGE_FILE), 'utf8').includes('SUPPORTED_CC_RANGE') && maxTestedOf(readFileSync(join(REPO, RANGE_FILE), 'utf8')) !== null);

  check('the version itself is carried', carriesRange(source('2.1.323'), '2.1.323'));
  check('a newer claim carries it too', carriesRange(source('2.1.324'), '2.1.323') && carriesRange(source('2.2.0'), '2.1.323'));
  check('an older claim does not', !carriesRange(source('2.1.322'), '2.1.323'));
  check('numeric, not lexical: 2.1.99 is older than 2.1.100', !carriesRange(source('2.1.99'), '2.1.100') && carriesRange(source('2.1.100'), '2.1.99'));
  check('unreadable source carries nothing', !carriesRange(null, '2.1.323') && !carriesRange('', '2.1.323'));
  check('a version that is not x.y.z is never carried', !carriesRange(source('2.1.323'), 'unknown') && !carriesRange(source('2.1.323'), '2.1') && !carriesRange(source('2.1.323'), undefined));
  check('isPlainVersion', isPlainVersion('2.1.323') && !isPlainVersion('v2.1.323') && !isPlainVersion('2.1.323 ') && !isPlainVersion(2));
  check('a trailing newline, or a second line, is not a plain version', !isPlainVersion('2.1.323\n') && !isPlainVersion('2.1.323\r\n') && !isPlainVersion('2.1.323\n2.1.324') && !isPlainVersion('\n2.1.323'));
  check('and such a value carries nothing and picks nothing', !carriesRange(source('2.1.323'), '2.1.323\n') && pickBinary(['/usr/bin/claude'], () => '2.1.323\n', '2.1.323\n') === null);
}

header('the rebake PR that carries the bump');
{
  const pr = (number, headRefName, extra = {}) => ({ number, headRefName, headRefOid: `sha${number}`, isCrossRepository: false, ...extra });
  const texts = { sha10: source('2.1.322'), sha11: source('2.1.323'), sha12: source('2.1.323') };
  const read = [];
  const sourceAt = async (p) => { read.push(p.number); return texts[p.headRefOid] ?? null; };

  check('the one whose head claims the version', await pickCarrier([pr(10, 'bot/template-rebake-1'), pr(11, 'bot/template-rebake-2')], sourceAt, '2.1.323') === 11);
  check('the lowest-numbered when two do', await pickCarrier([pr(12, 'bot/template-rebake-3'), pr(11, 'bot/template-rebake-2')], sourceAt, '2.1.323') === 11);
  check('none when every open rebake claims an older version', await pickCarrier([pr(10, 'bot/template-rebake-1')], sourceAt, '2.1.323') === null);
  check('none when there is no open rebake PR', await pickCarrier([], sourceAt, '2.1.323') === null && await pickCarrier(null, sourceAt, '2.1.323') === null);

  read.length = 0;
  const others = [
    pr(11, 'bot/cc-drift-v2.1.323'),
    pr(11, 'bot/template-label-20261110'),
    pr(11, 'fix/bot/template-rebake-lookalike'),
    pr(11, 'bot/template-rebake-2', { isCrossRepository: true }),
    pr(11, 'bot/template-rebake-2', { isCrossRepository: undefined }),
  ];
  check('another branch, a fork, or a PR whose origin is unknown is never the carrier', await pickCarrier(others, sourceAt, '2.1.323') === null);
  check('and its source is not even read', read.length === 0, read.join(','));

  check('a source that cannot be read is not a carrier, and the next PR is still tried',
    await pickCarrier([pr(9, 'bot/template-rebake-0'), pr(11, 'bot/template-rebake-2')], async (p) => { if (p.number === 9) throw new Error('404'); return texts[p.headRefOid]; }, '2.1.323') === 11);
  check('an empty answer is not a carrier', await pickCarrier([pr(11, 'bot/template-rebake-2')], async () => null, '2.1.323') === null);
}

header('the run this job dispatched');
{
  const T0 = Date.parse('2026-11-10T12:00:00Z');
  const run = (databaseId, displayTitle, createdAt, status = 'completed', conclusion = 'success') => ({ databaseId, displayTitle, createdAt, status, conclusion });
  const ours = run(2, runTitleFor('2.1.323'), '2026-11-10T12:00:30Z');
  const runs = [
    run(1, 'CC template drift watch (self-hosted)', '2026-11-10T12:00:40Z'),
    ours,
    run(3, runTitleFor('2.1.323'), '2026-11-10T12:05:00Z'),
    run(4, runTitleFor('2.1.322'), '2026-11-10T12:00:35Z'),
    run(5, runTitleFor('2.1.323'), '2026-11-10T11:30:00Z'),
  ];
  check('named for the version and created since the dispatch', runFor(runs, '2.1.323', T0) === ours);
  check('the oldest of two such runs', runFor(runs, '2.1.323', T0).databaseId === 2);
  check('an hourly run is not it', runFor([runs[0]], '2.1.323', T0) === null);
  check('a run for another version is not it', runFor([runs[3]], '2.1.323', T0) === null);
  check('a run from before the dispatch is not it', runFor([runs[4]], '2.1.323', T0) === null);
  check('a run created in the same second as `since` is', runFor([run(6, runTitleFor('2.1.323'), '2026-11-10T12:00:00Z')], '2.1.323', T0)?.databaseId === 6);
  check('no runs: null', runFor([], '2.1.323', T0) === null && runFor(undefined, '2.1.323', T0) === null);

  // A clock the test moves: each sleep advances it.
  const clock = () => { let t = T0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
  const base = { ccVersion: '2.1.323', sinceMs: T0, timeoutMs: 100_000, intervalMs: 20_000 };

  {
    const c = clock(); let polls = 0;
    const r = await awaitRun({ ...base, ...c, listRuns: async () => { polls++; return polls < 3 ? [] : [ours]; } });
    check('a run that appears and completes: its conclusion', r.found && r.completed && r.conclusion === 'success' && r.run === 2 && polls === 3, JSON.stringify(r));
  }
  {
    const c = clock(); let polls = 0;
    const r = await awaitRun({ ...base, ...c, listRuns: async () => { polls++; return [run(2, runTitleFor('2.1.323'), '2026-11-10T12:00:30Z', polls < 4 ? 'in_progress' : 'completed', polls < 4 ? null : 'failure')]; } });
    check('a run that fails: completed, with that conclusion', r.completed && r.conclusion === 'failure', JSON.stringify(r));
  }
  {
    const c = clock(); let polls = 0;
    const r = await awaitRun({ ...base, ...c, listRuns: async () => { polls++; return []; } });
    check('no run by the deadline: not found, not completed', r.found === false && r.completed === false && r.run === null, JSON.stringify(r));
    check('it polled until the deadline and no further', polls === 6 && c.now() <= T0 + base.timeoutMs, `${polls} polls, ${c.now() - T0}ms`);
  }
  {
    const c = clock();
    const r = await awaitRun({ ...base, ...c, listRuns: async () => [run(2, runTitleFor('2.1.323'), '2026-11-10T12:00:30Z', 'in_progress', null)] });
    check('a run still going at the deadline: found, not completed', r.found === true && r.completed === false && r.conclusion === null && r.run === 2, JSON.stringify(r));
  }
  {
    const c = clock(); let polls = 0;
    const r = await awaitRun({ ...base, ...c, listRuns: async () => { polls++; if (polls % 2 === 1) throw new Error('gh: 502'); return polls < 4 ? [] : [ours]; } });
    check('a listing that fails is one missed poll', r.completed && r.conclusion === 'success', JSON.stringify(r));
  }
  {
    const c = clock(); let polls = 0;
    const r = await awaitRun({ ...base, ...c, listRuns: async () => { polls++; if (polls === 1) return [run(2, runTitleFor('2.1.323'), '2026-11-10T12:00:30Z', 'in_progress', null)]; throw new Error('gh: 502'); } });
    check('a run seen once stays found when later listings fail', r.found === true && r.completed === false && r.run === 2, JSON.stringify(r));
  }
}

header('the binary a dispatched run measures');
{
  // Two installs, as on the runner: the tool-cache copy first on PATH, the system one behind it.
  const TOOL = '/opt/hostedtoolcache/node/22/bin/claude';
  const SYS = '/usr/bin/claude';
  const versions = (map) => (p) => map[p] ?? null;

  check('the tool-cache copy is behind and the system one is at the version: the system one', pickBinary([TOOL, SYS], versions({ [TOOL]: '2.1.322', [SYS]: '2.1.323' }), '2.1.323') === SYS);
  check('the system one is behind and the tool-cache copy is at the version: the tool-cache copy', pickBinary([TOOL, SYS], versions({ [TOOL]: '2.1.323', [SYS]: '2.1.322' }), '2.1.323') === TOOL);
  check('both at the version: the first given', pickBinary([TOOL, SYS], versions({ [TOOL]: '2.1.323', [SYS]: '2.1.323' }), '2.1.323') === TOOL);
  check('neither at the version: none, so the step installs', pickBinary([TOOL, SYS], versions({ [TOOL]: '2.1.322', [SYS]: '2.1.321' }), '2.1.323') === null);
  check('a newer install is not the version either', pickBinary([TOOL], versions({ [TOOL]: '2.1.324' }), '2.1.323') === null);
  check('a path that is missing or does not run is skipped', pickBinary(['/nope', SYS], (p) => { if (p === '/nope') throw new Error('ENOENT'); return '2.1.323'; }, '2.1.323') === SYS);
  const probed = [];
  pickBinary(['', TOOL, TOOL, undefined, SYS], (p) => { probed.push(p); return null; }, '2.1.323');
  check('empty and repeated paths are not probed', JSON.stringify(probed) === JSON.stringify([TOOL, SYS]), probed.join(','));
  check('a version that is not x.y.z picks nothing', pickBinary([SYS], versions({ [SYS]: 'latest' }), 'latest') === null);
  check('no paths: none', pickBinary([], versions({}), '2.1.323') === null && pickBinary(undefined, versions({}), '2.1.323') === null);
}

header('what the wire-drift check measured, and what is open');
{
  check('the version from a report', wireVersionOf('{"ccVersion":"2.1.323","findings":[]}') === '2.1.323');
  check('a report that follows log lines', wireVersionOf('[wire] capturing...\nnote\n{"ccVersion":"2.1.323"}') === '2.1.323');
  check('no version, a null one, or one that is not x.y.z: null', wireVersionOf('{"findings":[]}') === null && wireVersionOf('{"ccVersion":null}') === null && wireVersionOf('{"ccVersion":"unknown"}') === null);
  check('no report, or text that is not one: null', wireVersionOf(null) === null && wireVersionOf('') === null && wireVersionOf('capture failed') === null);

  const issue = (title, extra = {}) => ({ title, ...extra });
  check('issues titled as wire-drift reports are counted', openWireIssueCount([issue('Wire drift detected: CC v2.1.322'), issue('CC drift detected: v2.1.323'), issue('Wire drift detected: CC v2.1.323')]) === 2);
  check('the other cc-drift issues are not', openWireIssueCount([issue('CC drift detected: v2.1.323'), issue('CC authorize-probe drift: v2.1.323')]) === 0);
  check('a pull request listed among issues is not', openWireIssueCount([issue('Wire drift detected: CC v2.1.323', { pull_request: {} })]) === 0);
  check('none open: zero', openWireIssueCount([]) === 0);
  check('a listing that is not a list: unknown', openWireIssueCount(null) === null && openWireIssueCount({}) === null);
  check('the label and title are the ones the watchers file under', WIRE_DRIFT_LABEL === 'cc-drift' && WIRE_DRIFT_TITLE_PREFIX === 'Wire drift detected'
    && readFileSync(join(REPO, '.github', 'workflows', 'wire-drift-self-hosted.yml'), 'utf8').includes(WIRE_DRIFT_TITLE_PREFIX)
    && readFileSync(join(REPO, '.github', 'workflows', 'cc-drift-template-watch.yml'), 'utf8').includes('wire_title="' + WIRE_DRIFT_TITLE_PREFIX + ': CC v${wire_cc}"'));
}

header('whether a rebake may carry the bump');
{
  const clean = { rangePrOpen: false, upstream: 'pass', wireExit: 0, wireVersion: '2.1.323', bakedVersion: '2.1.323', openWireIssues: 0 };
  const carry = (over) => mayCarry({ ...clean, ...over });
  check('everything clean, one version measured: carry', carry({}).carry === true && carry({}).reason.includes('2.1.323'));

  check('a CC version PR is open: no', carry({ rangePrOpen: true }).carry === false);
  check('the listing of CC version PRs was not read: no', carry({ rangePrOpen: null }).carry === false && carry({ rangePrOpen: undefined }).carry === false);
  check('the upstream check failed, or gave no verdict: no', carry({ upstream: 'fail' }).carry === false && carry({ upstream: 'incomplete' }).carry === false && carry({ upstream: '' }).carry === false);
  check('the wire-drift check failed: no', carry({ wireExit: 1 }).carry === false && carry({ wireExit: 2 }).carry === false);
  check('the wire-drift exit code was not read: no', carry({ wireExit: null }).carry === false && carry({ wireExit: '0' }).carry === false);

  // The two-install case: the bake captured from the new version, the wire check ran on the old binary.
  const twoInstalls = carry({ wireVersion: '2.1.322' });
  check('a clean wire check on another Claude Code version than the bake: no', twoInstalls.carry === false);
  check('and the reason names both versions', twoInstalls.reason.includes('2.1.322') && twoInstalls.reason.includes('2.1.323'), twoInstalls.reason);
  check('a wire check that reports no version: no', carry({ wireVersion: null }).carry === false);
  check('a bundle that names no plain version: no', carry({ bakedVersion: '' }).carry === false && carry({ bakedVersion: '2.1.323-beta.1', wireVersion: '2.1.323-beta.1' }).carry === false);

  // A clean check in this run, with a report from an earlier run still open.
  const stale = carry({ openWireIssues: 1 });
  check('a clean wire check with a wire-drift issue still open: no', stale.carry === false);
  check('and the reason says the merge gate holds the rebake', stale.reason.includes('1 wire-drift issue is open') && stale.reason.includes('merge gate'), stale.reason);
  check('several open: no', carry({ openWireIssues: 3 }).carry === false && carry({ openWireIssues: 3 }).reason.includes('3 wire-drift issues are open'));
  check('the open issues could not be read: no', carry({ openWireIssues: null }).carry === false && carry({ openWireIssues: undefined }).carry === false);
  check('every refusal gives a reason', [{ rangePrOpen: true }, { upstream: 'fail' }, { wireExit: 1 }, { wireVersion: null }, { bakedVersion: '' }, { openWireIssues: null }].every((o) => carry(o).reason.length > 20));
}

header('the command line');
{
  // may-carry reads its inputs from the environment. With no repository the open issues cannot be read.
  const decide = (env) => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'range-bump-carrier.mjs'), 'may-carry'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '', RANGE_PR_OPEN: '', UPSTREAM: 'pass', WIRE_EXIT: '0', WIRE_REPORT: '', BAKED_VERSION: '2.1.323', ...env } });
    try { return { status: r.status, ...JSON.parse(r.stdout) }; } catch { return { status: r.status, carry: null, reason: r.stdout + r.stderr }; }
  };
  check('may-carry with no wire report and no repository to ask: exits 0 with a no', decide({}).status === 0 && decide({}).carry === false);
  check('may-carry names the first thing that stands in the way', decide({ RANGE_PR_OPEN: 'true' }).reason.includes('CC version PR') && decide({ UPSTREAM: 'fail' }).reason.includes('upstream') && decide({ WIRE_EXIT: '1' }).reason.includes('exit 1'));
  check('a RANGE_PR_OPEN it does not know is not read as "none open"', decide({ RANGE_PR_OPEN: 'maybe' }).reason.includes('CC version PR'));
  check('a wire report that is not there is a version that was not measured', decide({ WIRE_REPORT: join(REPO, 'no-such-report.json') }).reason.includes('an unknown version'));
  check('pick-binary with no path that runs prints nothing and exits 0', (() => { const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'range-bump-carrier.mjs'), 'pick-binary', '2.1.323', join(REPO, 'no-such-claude'), ''], { encoding: 'utf8' }); return r.status === 0 && r.stdout === ''; })());
  check('pick-binary with a version that is not x.y.z exits 2', spawnSync(process.execPath, [join(REPO, 'scripts', 'range-bump-carrier.mjs'), 'pick-binary', 'latest', '/usr/bin/claude'], { encoding: 'utf8' }).status === 2);

  const cli = (args, env = {}) => spawnSync(process.execPath, [join(REPO, 'scripts', 'range-bump-carrier.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'o/r', ...env } });
  check('a version that is not x.y.z exits 2 before anything is asked of gh', cli(['find', 'unknown']).status === 2 && cli(['find', '2.1.323; echo x']).status === 2 && cli(['await', '2.1', '2026-11-10T12:00:00Z']).status === 2);
  check('an unknown command exits 2', cli(['bump', '2.1.323']).status === 2);
  check('await without a readable time, or with a bad duration, exits 2', cli(['await', '2.1.323', 'soon']).status === 2 && cli(['await', '2.1.323', '2026-11-10T12:00:00Z', '0']).status === 2 && cli(['await', '2.1.323', '2026-11-10T12:00:00Z', 'x']).status === 2);
  check('no repository in the environment exits 2', cli(['find', '2.1.323'], { GITHUB_REPOSITORY: '' }).status === 2);
}

// The steps themselves run only in Actions. What is asserted here is each condition
// the design leans on, so an edit that drops one fails a test and not a release.
header('the workflows hold the design together');
{
  const wf = (name) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');
  /** One step of a workflow, from its `- name:` line to the next step. */
  const stepOf = (text, name) => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    if (start < 0) return null;
    const indent = lines[start].indexOf('-');
    const next = lines.findIndex((l, i) => i > start && l.indexOf('- ') === indent && l.trimStart().startsWith('- '));
    return lines.slice(start, next < 0 ? lines.length : next).join('\n');
  };
  const ifOf = (step) => (step ?? '').split('\n').find((l) => l.trim().startsWith('if:'))?.trim() ?? '';

  const watch = wf('cc-drift-watch.yml');
  const ask = stepOf(watch, 'Ask the template watcher first');
  const draft = stepOf(watch, 'Auto-draft drift-fix PR');
  check('cc-drift-watch has the step, ahead of the draft', ask !== null && draft !== null && watch.indexOf('- name: Ask the template watcher first') < watch.indexOf('- name: Auto-draft drift-fix PR'));
  check('it runs only on drift', ifOf(ask) === "if: steps.drift.outputs.exit_code != '0'", ifOf(ask));
  check('it dispatches the template watcher on master with the version as an input', (ask ?? '').includes(`gh workflow run ${TEMPLATE_WATCH} --ref master -f "cc_version=$CC_VERSION"`));
  check('the version reaches the shell through the environment only', (ask ?? '').includes('CC_VERSION: ${{ steps.ver.outputs.cc_version }}') && !(ask ?? '').split('run: |')[1].includes('${{'));
  // A whole-string match: `grep` would pass a value whose first line is a version.
  const PLAIN = (name) => `if [[ ! "$${name}" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then`;
  check('the version is checked as x.y.z before the dispatch', (ask ?? '').indexOf(PLAIN('CC_VERSION')) > 0 && (ask ?? '').indexOf(PLAIN('CC_VERSION')) < (ask ?? '').indexOf('gh workflow run'));
  check('it looks for a carrier before dispatching and again after the run', (ask ?? '').split('read_carrier)"').length - 1 === 2 && (ask ?? '').indexOf('read_carrier)"') < (ask ?? '').indexOf('gh workflow run') && (ask ?? '').lastIndexOf('read_carrier)"') > (ask ?? '').indexOf('range-bump-carrier.mjs await'));
  check('a failed dispatch falls through to the draft', /if ! gh workflow run [^\n]+; then\n[^\n]*::warning::[^\n]*\n\s*finish/.test(ask ?? ''));
  check('the draft is skipped only when a rebake PR carries the bump', ifOf(draft) === "if: steps.drift.outputs.exit_code != '0' && steps.carrier.outputs.carried != 'true'", ifOf(draft));
  for (const name of ['Mark CC version as full-checked (write sentinel)', 'Save cache sentinel (keyed on CC version)']) {
    check(`"${name}" waits while a rebake PR carries the bump`, ifOf(stepOf(watch, name)) === "if: success() && steps.carrier.outputs.carried != 'true'", ifOf(stepOf(watch, name)));
  }
  const checkJob = watch.slice(watch.indexOf('\n  check:'));
  check('the job may dispatch a workflow and list pull requests', /\n      actions: write\n/.test(checkJob) && /\n      pull-requests: read\n/.test(checkJob));
  const minutes = Number(/timeout-minutes: (\d+)/.exec(checkJob)?.[1]);
  const waited = Number(/range-bump-carrier\.mjs await "\$CC_VERSION" "\$since" (\d+)/.exec(ask ?? '')?.[1]);
  check('the job outlasts the wait with room for the rest of its steps', waited === 600 && minutes * 60 >= waited + 20 * 60, `${minutes} min for a ${waited}s wait`);

  const template = wf('cc-drift-template-watch.yml');
  check('a dispatched run is named the way the poller looks for it',
    template.includes("run-name: ${{ inputs.cc_version && format('CC template drift watch for Claude Code {0}', inputs.cc_version) || 'CC template drift watch (self-hosted)' }}")
    && runTitleFor('2.1.323') === 'CC template drift watch for Claude Code 2.1.323');
  check('the dispatch takes a cc_version input that defaults to none', /workflow_dispatch:\n    inputs:\n      cc_version:\n(?:        [^\n]*\n)*?        default: ''\n/.test(template));

  const PIN = 'Pin this run to the dispatched Claude Code version';
  const pin = stepOf(template, PIN);
  const pinRun = (pin ?? '').split('run: |')[1] ?? '';
  check('the pin step runs only in a dispatched run', ifOf(pin) === "if: inputs.cc_version != ''", ifOf(pin));
  check('the input reaches the shell through the environment only', (pin ?? '').includes('WANTED: ${{ inputs.cc_version }}') && !pinRun.includes('${{'));
  const at = (needle) => pinRun.indexOf(needle);
  const INSTALL = 'npm i -g "@anthropic-ai/claude-code@${WANTED}"';
  const NONE_FOUND = 'if [ -z "$bin" ]; then\n            echo "::warning::$WANTED was installed but no binary reports it';
  check('x.y.z, then npm latest, then the install: in that order',
    at(PLAIN('WANTED')) > 0
    && at(PLAIN('WANTED')) < at('if [ "$WANTED" != "$latest" ]')
    && at('if [ "$WANTED" != "$latest" ]') < at(INSTALL));
  check('a binary already at the version is looked for before anything is installed', at('bin="$(pick)"') > 0 && at('bin="$(pick)"') < at(INSTALL));
  check('the candidates are the install prefix, the system binary and PATH, chosen by the version each reports',
    pinRun.includes('node scripts/range-bump-carrier.mjs pick-binary "$WANTED" "$prefix_bin" /usr/bin/claude "$(command -v claude 2>/dev/null || true)"'));
  check('an install already past the version is left alone', at('| sort -V | tail -1)" != "$WANTED" ]') > 0 && at('| sort -V | tail -1)" != "$WANTED" ]') < at(INSTALL));
  check('the binary is looked for again after the install', pinRun.split('bin="$(pick)"').length - 1 === 2 && pinRun.lastIndexOf('bin="$(pick)"') > at(INSTALL));
  check('the run is pinned only to a binary that was found',
    at(NONE_FOUND) > 0 && at('echo "DARIO_CLAUDE_BIN=$bin" >> "$GITHUB_ENV"') > at(NONE_FOUND) && pinRun.split('>> "$GITHUB_ENV"').length - 1 === 1);
  check('every refusal leaves the run going', (pinRun.match(/exit 0/g) ?? []).length === 5 && !/exit [1-9]/.test(pinRun) && !pinRun.includes('set -e'));
  check('it runs before the check that captures', template.indexOf(`- name: ${PIN}`) > 0 && template.indexOf(`- name: ${PIN}`) < template.indexOf('- name: Run drift check'));
  check('nothing is installed over the system binary', !pinRun.includes('--prefix') && !pinRun.includes('sudo'));

  const rangePr = stepOf(template, 'Find an open CC version PR');
  check('an open CC version PR is looked for on drift and on label drift', ifOf(rangePr) === "if: steps.check.outputs.exit_code == '2' || steps.check.outputs.exit_code == '3'", ifOf(rangePr));
  check('a listing that fails reads as open', /else\n[^\n]*::warning::[^\n]*\n\s*echo "open=true" >> "\$GITHUB_OUTPUT"/.test(rangePr ?? ''));

  const rebake = stepOf(template, 'Auto-rebake + open PR');
  const step = rebake ?? '';
  check('the wire-drift check measures the pinned binary, and the system one only when the run has none',
    step.includes('if [ -z "${DARIO_CLAUDE_BIN:-}" ] && [ -x /usr/bin/claude ]; then export DARIO_CLAUDE_BIN=/usr/bin/claude; fi')
    && !step.includes('\n          if [ -x /usr/bin/claude ]; then export DARIO_CLAUDE_BIN'));
  const decide = step.indexOf('node scripts/range-bump-carrier.mjs may-carry');
  check('the carry decision is mayCarry\'s, fed this run\'s results',
    decide > 0 && step.includes('carry_verdict=$(GH_TOKEN="$STATUS_TOKEN" RANGE_PR_OPEN="$RANGE_PR_OPEN" UPSTREAM="$upstream" WIRE_EXIT="$wire_exit" \\\n            WIRE_REPORT=wire-drift-report.json BAKED_VERSION="$cc_version" \\\n            node scripts/range-bump-carrier.mjs may-carry'));
  check('a decision that cannot be made is a no', step.includes('may-carry || echo \'{"carry":false,"reason":"the decision could not be made"}\')'));
  check('the flag is set from that decision and nowhere else', step.split('carry=(--carry-range)').length - 1 === 1
    && /\.carry === true' 2>\/dev\/null\)" = "true" \]; then\n\s+carry=\(--carry-range\)/.test(step));
  check('the flag is passed to the release prep', step.includes('new_version=$(node scripts/rebake-release-prep.mjs "${carry[@]}")'));
  const known = ['upstream=$(node -p', 'wire_exit=$?', 'cc_version=$(node -p "require(\'./src/cc-template-data.json\')._version")'];
  check('the upstream check, the wire-drift check and the baked version are all known by then', known.every((k) => step.indexOf(k) > 0 && step.indexOf(k) < decide), known.map((k) => step.indexOf(k)).join(','));
  check('the files the bump changes are staged', /git add src\/cc-template-data\.json package\.json package-lock\.json CHANGELOG\.md src\/live-fingerprint\.ts test\/compat-pinned\.json\n/.test(rebake ?? ''));
  check('the step is told whether a CC version PR is open', (rebake ?? '').includes('RANGE_PR_OPEN: ${{ steps.range_pr.outputs.open }}'));

  const label = stepOf(template, 'Label-sync + open PR');
  check('no label PR in a dispatched run or beside a CC version PR',
    ifOf(label) === "if: steps.check.outputs.exit_code == '3' && inputs.cc_version == '' && steps.range_pr.outputs.open != 'true'", ifOf(label));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

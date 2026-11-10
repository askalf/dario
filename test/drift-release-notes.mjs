// Each drift bot's release-prep script is run end to end against a staged repo and
// the CHANGELOG bullet it files (the release note users read) is read back.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const NARRATION = /\.yml\b|auto-drafted|auto-handled|auto-merged|cc-drift-template-watch|capture-and-bake|sdk-drift|early-warning|detected/i;

function runBot(script, args, stage) {
  const root = mkdtempSync(join(tmpdir(), 'dario-drift-notes-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  for (const f of ['_drift-patch-helpers.mjs', 'drift-report.mjs', script]) copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
  // The rebake prep reads the variant families from the build, as it does in the workflow.
  if (script === 'rebake-release-prep.mjs') cpSync(join(SCRIPTS, '..', 'dist'), join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@askalf/dario', version: '6.11.3' }, null, 2) + '\n');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '6.11.3', packages: { '': { version: '6.11.3' } } }, null, 2) + '\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [6.11.3] - 2026-09-20\n\n- older\n');
  writeFileSync(join(root, 'src', 'live-fingerprint.ts'), "export const SUPPORTED_CC_RANGE = {\n  maxTested: '2.1.280',\n};\n");
  writeFileSync(join(root, 'src', 'cc-template-data.json'), JSON.stringify({
    _version: '2.1.280',
    _captured: '2026-09-01T00:00:00.000Z',
    header_values: { 'user-agent': 'claude-cli/2.1.280 (external, sdk-cli)' },
    _supportedMaxTested: '2.1.280',
  }, null, 2) + '\n');
  writeFileSync(join(root, 'drift-report.json'), JSON.stringify({
    drift: true, ccVersion: '2.1.281', pinned: { maxTested: '2.1.280' },
    items: [{ category: 'compat.range', severity: 'medium', message: 'bump SUPPORTED_CC_RANGE.maxTested' }],
  }));
  if (stage) stage(root);
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' });
  const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('## [6.11.4]'));
  const bullet = at === -1 ? '' : lines.slice(at + 1).find((l) => l.startsWith('- ')) ?? '';
  const end = at === -1 ? -1 : lines.findIndex((l, i) => i > at && l.startsWith('## ['));
  const bullets = at === -1 ? [] : lines.slice(at + 1, end === -1 ? undefined : end).filter((l) => l.startsWith('- '));
  const summary = existsSync(join(root, 'rebake-summary.md')) ? readFileSync(join(root, 'rebake-summary.md'), 'utf8') : '';
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, bullet, bullets, summary, root };
}

for (const [script, args, expectVersions] of [
  ['auto-draft-drift-fix.mjs', ['drift-report.json'], ['2.1.280', '2.1.281']],
  ['label-sync.mjs', ['2.1.281'], ['2.1.281']],
  ['rebake-release-prep.mjs', [], []],
]) {
  header(`${script} release note`);
  const { status, stderr, bullet } = runBot(script, args);
  check('exits 0', status === 0, stderr);
  check('bullet filed under the promoted version', bullet.startsWith('- '), bullet);
  if (expectVersions.length) check('names the versions involved', expectVersions.every((v) => bullet.includes(v)), bullet);
  check('no em dash', !bullet.includes('\u2014'), bullet);
  check('no arrow between versions', !bullet.includes('\u2192'), bullet);
  const m = NARRATION.exec(bullet);
  check('no workflow or merge narration', m === null, m && m[0]);
  if (script === 'label-sync.mjs') {
    // The note names the old label, the new label and the user-agent value, with no capture or comparison claim.
    check('names the label it moved to and the one it held', bullet.includes('labelled Claude Code 2.1.281') && bullet.includes('It was labelled 2.1.280.'), bullet);
    check('names the user-agent value', bullet.includes('`claude-cli/2.1.281 (external, sdk-cli)`'), bullet);
    const claim = /captur|compar|matched|unchanged|no difference|identical|verified/i.exec(bullet);
    check('makes no claim about a capture or comparison', claim === null, claim && claim[0]);
  }
}

// A rebake's release note and its PR summary are written from the diff between the
// committed bundle and the baked one.
header('rebake-release-prep.mjs describes the bake');
{
  const git = (root, ...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  const { status, stderr, bullets, summary } = runBot('rebake-release-prep.mjs', [], (root) => {
    const path = join(root, 'src', 'cc-template-data.json');
    const tool = (description) => [{ name: 'Bash', description, input_schema: { type: 'object', properties: {} } }];
    const committed = { ...JSON.parse(readFileSync(path, 'utf8')), system_prompt: 'base', system_prompt_variants: { 'sonnet-5': 'S'.repeat(300) }, tools: tool('old text') };
    writeFileSync(path, JSON.stringify(committed, null, 2) + '\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    writeFileSync(path, JSON.stringify({ ...committed, _version: '2.1.281', system_prompt_variants: { 'sonnet-5': 's'.repeat(200) }, tools: tool('new text') }, null, 2) + '\n');
  });
  check('exits 0', status === 0, stderr);
  check('one bullet per thing the bake changed: the prompt, the tool, the label', bullets.length === 3, bullets.join(' | '));
  check('the note names the prompt that changed and its sizes', (bullets[0] ?? '').includes('Sonnet 5') && (bullets[0] ?? '').includes('200 characters') && (bullets[0] ?? '').includes('300-character'), bullets[0]);
  check('the note names the tool whose text changed', (bullets[1] ?? '').includes('`Bash`'), bullets[1]);
  check('the note names the label that moved', (bullets[2] ?? '').includes('labelled Claude Code 2.1.281') && (bullets[2] ?? '').includes('2.1.280'), bullets[2]);
  const narrated = bullets.map((x) => NARRATION.exec(x)).find(Boolean);
  check('no workflow or merge narration in the described notes', !narrated, narrated && narrated[0]);
  check('the note is not the generic sentence', !bullets.join(' ').includes('current request shape'), bullets.join(' | '));
  check('the PR summary is written beside it', summary.includes('- **Sonnet 5 system prompt:**') && summary.includes('- **`Bash` tool:** its description changed.'), summary);
  check('no em dash and no arrow in either', ![...bullets, summary].some((x) => x.includes('\u2014') || x.includes('\u2192')));
}

// A family within a wider one. With no variant of its own in the bundle its models get
// the wider family's prompt, so that is what the note says the new one replaces.
header('rebake-release-prep.mjs on a variant new to a family within another');
{
  const git = (root, ...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  const { status, stderr, bullets, summary } = runBot('rebake-release-prep.mjs', [], (root) => {
    const path = join(root, 'src', 'cc-template-data.json');
    const committed = { ...JSON.parse(readFileSync(path, 'utf8')), system_prompt: 'base', system_prompt_variants: { fable: 'F'.repeat(300) } };
    writeFileSync(path, JSON.stringify(committed, null, 2) + '\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    writeFileSync(path, JSON.stringify({ ...committed, system_prompt_variants: { fable: 'F'.repeat(300), 'fable-5-2': 'G'.repeat(320) } }, null, 2) + '\n');
  });
  check('exits 0', status === 0, stderr);
  check('one bullet', bullets.length === 1, bullets.join(' | '));
  check('it names the model version', (bullets[0] ?? '').startsWith('- **The bundled template holds a system prompt for Fable 5.2.** It is 320 characters'), bullets[0]);
  check('it replaces the Fable prompt, not the base', (bullets[0] ?? '').endsWith('carry it in place of the Fable prompt.'), bullets[0]);
  check('the PR summary names it the same way', summary.includes('- **Fable 5.2 system prompt:** new in the bundle, 320 characters.'), summary);
}

// A capture that moves only the label and the user-agent. The user-agent is a header
// value, so the note names it and vouches for nothing else.
header('rebake-release-prep.mjs on a label and user-agent bake');
{
  const git = (root, ...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  const { status, stderr, bullets } = runBot('rebake-release-prep.mjs', [], (root) => {
    const path = join(root, 'src', 'cc-template-data.json');
    const committed = JSON.parse(readFileSync(path, 'utf8'));
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    writeFileSync(path, JSON.stringify({ ...committed, _version: '2.1.281', header_values: { 'user-agent': 'claude-cli/2.1.281 (external, sdk-cli)' } }, null, 2) + '\n');
  });
  check('exits 0', status === 0, stderr);
  check('one bullet', bullets.length === 1, bullets.join(' | '));
  check('it names the label the bundle now carries and the one it held', (bullets[0] ?? '').includes('labelled Claude Code 2.1.281') && (bullets[0] ?? '').includes('It was labelled 2.1.280.'), bullets[0]);
  check('it names the user-agent value the bundle now holds', (bullets[0] ?? '').endsWith('Its `user-agent` value is `claude-cli/2.1.281 (external, sdk-cli)`.'), bullets[0]);
  check('it does not vouch for the other headers', !/headers are|unchanged|already held/i.test(bullets[0] ?? ''), bullets[0]);
}

// A bake captured from a Claude Code version past maxTested. With --carry-range the
// rebake PR is the one release for that version: it moves maxTested, lists the version
// and files the note cc-drift-watch.yml's own PR would have filed.
header('rebake-release-prep.mjs --carry-range');
{
  const git = (root, ...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  const PINNED = JSON.stringify(['2.1.279', '2.1.280'], null, 2) + '\n';
  // A bake that moves the label and one tool, from a bundle labelled `from` to one labelled `to`.
  const stage = (to, { pinned = PINNED, source } = {}) => (root) => {
    const path = join(root, 'src', 'cc-template-data.json');
    const tool = (description) => [{ name: 'Bash', description, input_schema: { type: 'object', properties: {} } }];
    const committed = { ...JSON.parse(readFileSync(path, 'utf8')), system_prompt: 'base', tools: tool('old text') };
    writeFileSync(path, JSON.stringify(committed, null, 2) + '\n');
    mkdirSync(join(root, 'test'));
    if (pinned !== null) writeFileSync(join(root, 'test', 'compat-pinned.json'), pinned);
    if (source !== undefined) writeFileSync(join(root, 'src', 'live-fingerprint.ts'), source);
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    writeFileSync(path, JSON.stringify({ ...committed, _version: to, tools: tool('new text') }, null, 2) + '\n');
  };
  const sourceOf = (root) => readFileSync(join(root, 'src', 'live-fingerprint.ts'), 'utf8');
  const pinnedOf = (root) => readFileSync(join(root, 'test', 'compat-pinned.json'), 'utf8');
  const RANGE_NOTE = '- **Claude Code 2.1.281 is in the supported range.** `dario doctor` and proxy startup no longer warn that it is untested, as they did for anything newer than 2.1.280.';

  const carried = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.281'));
  check('exits 0', carried.status === 0, carried.stderr);
  check('maxTested moves to the version the bundle was captured from', sourceOf(carried.root).includes("maxTested: '2.1.281'"), sourceOf(carried.root));
  check('the version is listed in test/compat-pinned.json', JSON.stringify(JSON.parse(pinnedOf(carried.root))) === JSON.stringify(['2.1.279', '2.1.280', '2.1.281']), pinnedOf(carried.root));
  check('the range note leads, in the words of cc-drift-watch.yml\'s own PR', carried.bullets[0] === RANGE_NOTE, carried.bullets[0]);
  check('the notes for the bake follow it', carried.bullets.length === 3 && carried.bullets[1].includes('`Bash`') && carried.bullets[2].includes('labelled Claude Code 2.1.281'), carried.bullets.join(' | '));
  check('the PR summary says the range moved and that no other PR moves it', carried.summary.startsWith('- **Supported range:** `SUPPORTED_CC_RANGE.maxTested` goes from 2.1.280 to 2.1.281, and `test/compat-pinned.json` lists 2.1.281. No separate PR moves it.\n'), carried.summary);
  check('the log line names the bump', carried.stderr.includes('maxTested 2.1.280'), carried.stderr);
  check('the new package version is still the only thing on stdout', carried.stdout === '6.11.4\n', carried.stdout);

  const plain = runBot('rebake-release-prep.mjs', [], stage('2.1.281'));
  check('without the flag: maxTested stays', plain.status === 0 && sourceOf(plain.root).includes("maxTested: '2.1.280'"), sourceOf(plain.root));
  check('without the flag: the list stays and no range note is filed', pinnedOf(plain.root) === PINNED && !plain.bullets.join(' ').includes('supported range') && !plain.summary.includes('Supported range'), plain.bullets.join(' | '));

  const same = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.280'));
  check('a bake from the version maxTested already names: nothing about the range', same.status === 0 && sourceOf(same.root).includes("maxTested: '2.1.280'") && pinnedOf(same.root) === PINNED && !same.bullets.join(' ').includes('supported range') && !same.summary.includes('Supported range'), same.bullets.join(' | '));

  const older = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.279'));
  check('a bake from an older version never moves maxTested back', older.status === 0 && sourceOf(older.root).includes("maxTested: '2.1.280'") && !older.bullets.join(' ').includes('supported range'), sourceOf(older.root));

  const odd = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.281-beta.1'));
  check('a bundle version that is not x.y.z leaves the range alone', odd.status === 0 && sourceOf(odd.root).includes("maxTested: '2.1.280'") && !odd.bullets.join(' ').includes('supported range'), sourceOf(odd.root));

  const noLine = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.281', { source: 'export const SUPPORTED_CC_RANGE = {};\n' }));
  check('a source file with no maxTested line: the rebake ships without the bump', noLine.status === 0 && noLine.stdout === '6.11.4\n' && pinnedOf(noLine.root) === PINNED && !noLine.bullets.join(' ').includes('supported range'), noLine.stderr);

  const noList = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.281', { pinned: null }));
  check('no pinned list: the bump ships and the summary does not claim the list', noList.status === 0 && sourceOf(noList.root).includes("maxTested: '2.1.281'") && noList.summary.startsWith('- **Supported range:** `SUPPORTED_CC_RANGE.maxTested` goes from 2.1.280 to 2.1.281. No separate PR moves it.\n'), noList.summary);

  const badList = runBot('rebake-release-prep.mjs', ['--carry-range'], stage('2.1.281', { pinned: '{"not":"a list"}\n' }));
  check('a pinned file that is not a list of versions is left byte for byte', badList.status === 0 && pinnedOf(badList.root) === '{"not":"a list"}\n' && !badList.summary.includes('compat-pinned.json'), badList.summary);
}

// cc-drift-watch.yml opens the PR from this metadata and commits with prTitle,
// so the title is the commit subject Redline reviews.
header('auto-draft-drift-fix.mjs PR metadata');
{
  const { status, stderr, stdout } = runBot('auto-draft-drift-fix.mjs', ['drift-report.json']);
  check('exits 0', status === 0, stderr);
  let meta = {};
  try { meta = JSON.parse(stdout); } catch { /* reported by the next check */ }
  check('emits fixed metadata', meta.fixed === true, stdout);
  const title = meta.prTitle ?? '';
  const body = meta.prBody ?? '';
  check('exact title for the fixture versions', title === 'chore(cc-drift): v6.11.4: maxTested to v2.1.281', title);
  check('title has no em dash', !title.includes('\u2014'), title);
  check('title has no arrow', !title.includes('\u2192'), title);
  // The body says what changes for users and nothing about drafting, merging or releasing.
  check('body names the new version and the package version', body.includes('Claude Code 2.1.281') && body.includes('6.11.4'), body);
  check('body has no headings, lists or workflow names', !/^#|^- |^\d\./m.test(body) && !/\.yml|Drafted|Merge|Release:|Scope/.test(body), body);
  const pinnedStaged = (meta.changedFiles ?? []).includes('test/compat-pinned.json');
  check('body says the version is listed exactly when the list was staged', body.includes('lists 2.1.281') === pinnedStaged && body.includes('2.1.281 is not in') === !pinnedStaged, body);
  const selfShip = /fully autonomous|no maintainer action required|ships itself|you only need to look if CI fails/i.exec(body);
  check('no unconditional self-shipping claim', selfShip === null, selfShip && selfShip[0]);
  check('body has no em dash', !body.includes('\u2014'));
  check('body has no arrow', !body.includes('\u2192'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// Each drift bot's release-prep script is run end to end against a staged repo and
// the CHANGELOG bullet it files (the release note users read) is read back.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
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

function runBot(script, args) {
  const root = mkdtempSync(join(tmpdir(), 'dario-drift-notes-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  for (const f of ['_drift-patch-helpers.mjs', script]) copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
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
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' });
  const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('## [6.11.4]'));
  const bullet = at === -1 ? '' : lines.slice(at + 1).find((l) => l.startsWith('- ')) ?? '';
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, bullet };
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
    // computeDrift compares tools by name only, so an empty result cannot vouch for the whole shape.
    const overclaim = /shape is unchanged|matched the bundled template|byte-identical/i.exec(bullet);
    check('no claim beyond the fields computeDrift compares', overclaim === null, overclaim && overclaim[0]);
    check('says tool schemas are not compared', bullet.includes('Tool descriptions and schemas are not part of that comparison.'), bullet);
  }
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
  check('body has the merge and release section', body.includes('\n### Merge and release\n'));
  const merge = body.split('\n').find((l) => l.startsWith('- **Merge:**')) ?? '';
  check('merge line requires an approving review', merge.includes('Redline approves'), merge);
  // The platform merges a cc-drift release itself since 2026-10-01 (askalf/platform#1544), only while
  // its version is above master's, so drift-pr-heal renumbers a collision loser before it can land.
  check('merge line names the version-above-master condition', merge.includes('It merges only while its `package.json` version is above the one on `master`.'), merge);
  check('merge line no longer sends a drift release to the operator', !merge.includes('waits for the operator'), merge);
  const steps = body.split('\n').find((l) => l.startsWith('3. ')) ?? '';
  check('changelog step matches the edit: a new section under [Unreleased], not a promotion', steps.includes('section to `CHANGELOG.md` under `## [Unreleased]`') && !/Promotes/.test(steps), steps);
  const selfShip = /fully autonomous|no maintainer action required|ships itself|you only need to look if CI fails/i.exec(body);
  check('no unconditional self-shipping claim', selfShip === null, selfShip && selfShip[0]);
  check('body has no em dash', !body.includes('\u2014'));
  check('body has no arrow', !body.includes('\u2192'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

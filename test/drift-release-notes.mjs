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
  return { status: r.status, stderr: r.stderr, bullet };
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
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

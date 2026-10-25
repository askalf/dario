#!/usr/bin/env node
/**
 * Tests for scripts/release-bump-commit.mjs: the commit a release is named after.
 *
 * The case that matters is the one nobody watches: a bot bump merges, an
 * unrelated PR merges right after, and the hourly tick releases from a HEAD
 * that is not the bump. Read off HEAD, the release would carry the wrong PR
 * and the wrong pre-release mark. Each scenario here is a throwaway git repo
 * with exactly that history.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findVersionBump, prNumberFromSubject, parseArgs } from '../scripts/release-bump-commit.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pkg = (version) => JSON.stringify({ name: 'fixture', version }, null, 2) + '\n';
const dirs = [];

// Builds master in a fresh repo, one commit per [subject, files] step, and returns the sha of each.
function repo(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'dario-bump-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'master');
  const shas = [];
  for (const [subject, files] of steps) {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', subject);
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, shas };
}

// master as the race leaves it: the bot bump, then a docs merge, then a dependency
// change that touches package.json without moving the version.
const history = [
  ['init (#1)', { 'package.json': pkg('1.0.0'), 'README.md': 'a\n' }],
  ['chore(cc-drift): v1.0.1: maxTested to v2.1.1 (#12)', { 'package.json': pkg('1.0.1') }],
  ['docs: readme (#13)', { 'README.md': 'b\n' }],
  ['chore(deps): bump something (#14)', { 'package.json': JSON.stringify({ name: 'fixture', version: '1.0.1', dependencies: {} }, null, 2) + '\n' }],
];

header('the bump commit, not HEAD');
{
  const { dir, shas } = repo(history.slice(0, 2));
  const atHead = findVersionBump('1.0.1', { cwd: dir });
  check('the bump at HEAD is found', atHead.sha === shas[1] && atHead.parentVersion === '1.0.0', JSON.stringify(atHead));
  check('its PR number comes from the subject', atHead.prNumber === 12);
  check('its subject is reported', atHead.subject === 'chore(cc-drift): v1.0.1: maxTested to v2.1.1 (#12)');

  const raced = repo(history);
  const r = findVersionBump('1.0.1', { cwd: raced.dir });
  check('with a docs merge and a dependency change after it, the bump is still the one found', r.sha === raced.shas[1] && r.prNumber === 12, JSON.stringify(r));
  check('HEAD is not the answer', r.sha !== raced.shas[3]);

  const two = repo([...history, ['release: v1.1.0 (#15)', { 'package.json': pkg('1.1.0') }]]);
  const second = findVersionBump('1.1.0', { cwd: two.dir });
  check('a later release is its own bump commit', second.sha === two.shas[4] && second.prNumber === 15 && second.parentVersion === '1.0.1');
  check('the earlier version still resolves to its own bump', findVersionBump('1.0.1', { cwd: two.dir }).sha === two.shas[1]);
}

header('not found: a reason, never a guess');
{
  const { dir } = repo(history);
  const none = findVersionBump('9.9.9', { cwd: dir });
  check('a version nobody set: sha null and the reason says so', none.sha === null && none.reason.includes('no fetched commit sets package.json to 9.9.9'), JSON.stringify(none));
  const capped = findVersionBump('1.0.1', { cwd: dir, max: 1 });
  check('max too small to reach the bump: sha null', capped.sha === null, JSON.stringify(capped));

  const empty = repo([['nothing yet (#2)', { 'README.md': 'x\n' }]]);
  const bare = findVersionBump('1.0.0', { cwd: empty.dir });
  check('no package.json in the history: sha null, the reason names package.json', bare.sha === null && bare.reason.includes('package.json'));

  // A shallow clone's boundary commit has no readable parent, so it cannot be judged.
  const shallow = mkdtempSync(join(tmpdir(), 'dario-bump-shallow-'));
  dirs.push(shallow);
  const clone = spawnSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(dir).href, 'r'], { cwd: shallow, encoding: 'utf8' });
  check('the fixture clones shallow', clone.status === 0, clone.stderr);
  if (clone.status === 0) {
    const cut = findVersionBump('1.0.1', { cwd: join(shallow, 'r') });
    check('a clone too shallow to reach the bump: sha null and the reason says so', cut.sha === null && cut.reason.includes('too shallow'), JSON.stringify(cut));
  }

  const plain = repo([['init', { 'package.json': pkg('1.0.0') }], ['bump', { 'package.json': pkg('1.0.1') }]]);
  const noPr = findVersionBump('1.0.1', { cwd: plain.dir });
  check('a bump whose subject has no (#N): found, prNumber null', noPr.sha === plain.shas[1] && noPr.prNumber === null);
}

header('prNumberFromSubject');
{
  check('trailing (#N) parses', prNumberFromSubject('fix: thing (#1234)') === 1234);
  check('(#N) in the middle does not count', prNumberFromSubject('fix (#12) more') === null);
  check('trailing whitespace is fine', prNumberFromSubject('x (#7)  ') === 7);
  check('no suffix: null', prNumberFromSubject('x') === null && prNumberFromSubject('') === null && prNumberFromSubject(undefined) === null);
}

header('parseArgs');
{
  const d = parseArgs(['6.16.1']);
  check('a version alone: cwd is the process cwd, max 50', d.version === '6.16.1' && d.cwd === process.cwd() && d.max === 50);
  const full = parseArgs(['--cwd', 'somewhere', '6.16.1', '--max', '10']);
  check('flags in any order', full.version === '6.16.1' && full.cwd === 'somewhere' && full.max === 10);
  const throws = (args) => { try { parseArgs(args); return false; } catch { return true; } };
  check('no version: usage error', throws([]));
  check('a tag or word is not a version', throws(['v6.16.1']) && throws(['latest']));
  check('two versions: error', throws(['1.2.3', '4.5.6']));
  check('max 0 or junk: error', throws(['1.2.3', '--max', '0']) && throws(['1.2.3', '--max', 'ten']));
  check('empty cwd: error', throws(['1.2.3', '--cwd', '']));
}

header('the CLI prints one JSON line');
{
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release-bump-commit.mjs');
  const { dir, shas } = repo(history);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const found = run('1.0.1', '--cwd', dir);
  check('found: exit 0 and the bump sha', found.status === 0 && JSON.parse(found.stdout).sha === shas[1], found.stderr);
  const missing = run('9.9.9', '--cwd', dir);
  check('not found: still exit 0, sha null', missing.status === 0 && JSON.parse(missing.stdout).sha === null);
  const bad = run('latest', '--cwd', dir);
  check('a usage error exits 2 and prints the usage', bad.status === 2 && bad.stderr.includes('usage:'));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

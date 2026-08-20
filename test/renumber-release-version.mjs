#!/usr/bin/env node
// Tests for scripts/renumber-release-version.mjs — the merge-time half of the
// version-collision fix.
//
// The shapes that matter are the ones seen in production: two PRs claiming the
// same version off the same base (#954/#955 took 5.5.10 off 5.5.9), and a PR
// claiming a version that has since been published (#1027 bumped 5.5.24 ->
// 5.5.25 with v5.5.25 already tagged).

import { renumber, isGreater, parseVersion } from '../scripts/renumber-release-version.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const pkgAt = (v) => JSON.stringify({ name: '@askalf/dario', version: v, type: 'module' }, null, 2) + '\n';
const clAt = (v) => `# Changelog\n\n## [Unreleased]\n\n## [${v}] - 2026-08-20\n\n- did a thing\n\n## [5.5.9] - 2026-08-19\n\n- older\n`;

header('parseVersion / isGreater');
{
  check('parses X.Y.Z', JSON.stringify(parseVersion('5.5.27')) === '[5,5,27]');
  check('rejects non X.Y.Z', parseVersion('5.5') === null && parseVersion('v5.5.1') === null);
  check('numeric compare, not lexical', isGreater('5.5.10', '5.5.9') === true);
  check('equal is not greater', isGreater('5.5.9', '5.5.9') === false);
  check('minor beats patch', isGreater('5.6.0', '5.5.99') === true);
}

header('collision: two PRs took the same version off the same base (#954/#955)');
{
  // The loser carries 5.5.10; master has since merged the winner and is 5.5.10.
  const r = renumber(pkgAt('5.5.10'), clAt('5.5.10'), '5.5.10');
  check('renumbers rather than leaving an equal version', r.ok && r.changed === true);
  check('lands strictly above the tip', r.after === '5.5.11');
  check('package.json carries the new version', JSON.parse(r.pkg).version === '5.5.11');
  check('CHANGELOG heading follows the version', r.changelog.includes('## [5.5.11] - 2026-08-20'));
  check('old heading is gone', !r.changelog.includes('## [5.5.10]'));
  check('unrelated sections untouched', r.changelog.includes('## [5.5.9] - 2026-08-19'));
  check('Unreleased heading preserved', r.changelog.includes('## [Unreleased]'));
}

header('stale draft: version already published (#1027)');
{
  // Drafted 5.5.24 -> 5.5.25; v5.5.25 shipped in the meantime, master at 5.5.27.
  const r = renumber(pkgAt('5.5.25'), clAt('5.5.25'), '5.5.27');
  check('jumps past the tip, not just +1 from itself', r.ok && r.after === '5.5.28');
  check('never renumbers downward', isGreater(r.after, '5.5.27') === true);
}

header('no-op when the PR already advances');
{
  const r = renumber(pkgAt('5.5.30'), clAt('5.5.30'), '5.5.27');
  check('reports ok', r.ok === true);
  check('changed=false', r.changed === false);
  check('version untouched', r.after === '5.5.30');
  check('no rewritten files handed back', r.pkg === undefined && r.changelog === undefined);
}

header('refuses rather than guessing');
{
  const noHeading = renumber(pkgAt('5.5.10'), '# Changelog\n\n## [Unreleased]\n\n## [5.5.9] - x\n', '5.5.10');
  check('no CHANGELOG heading for the version -> refuse', noHeading.ok === false);
  check('and says why', /0 headings for 5\.5\.10/.test(noHeading.reason));

  const dupe = renumber(pkgAt('5.5.10'), '# c\n\n## [5.5.10] - a\n\n## [5.5.10] - b\n', '5.5.10');
  check('two headings for the version -> refuse', dupe.ok === false && /2 headings/.test(dupe.reason));

  const badPkg = renumber(JSON.stringify({ name: 'x' }), clAt('5.5.10'), '5.5.10');
  check('package.json with no version -> refuse', badPkg.ok === false);

  const badFloor = renumber(pkgAt('5.5.10'), clAt('5.5.10'), 'not-a-version');
  check('non X.Y.Z floor -> refuse', badFloor.ok === false);

  const prerelease = renumber(pkgAt('5.5.10-rc.1'), clAt('5.5.10-rc.1'), '5.5.10');
  check('prerelease version -> refuse (never invent a bump for it)', prerelease.ok === false);
}

header('CRLF checkouts are handled, not silently skipped');
{
  // A Windows runner leaves headings as "## [5.5.10] - 2026-08-20\r". If the
  // heading match failed on those, this would come back as a REFUSAL (0
  // headings found) — safe, but permanently useless on that runner.
  const r = renumber(pkgAt('5.5.10').replace(/\n/g, '\r\n'), clAt('5.5.10').replace(/\n/g, '\r\n'), '5.5.10');
  check('finds the heading despite CRLF', r.ok === true && r.changed === true);
  check('renumbers correctly', r.after === '5.5.11');
  check('CHANGELOG keeps CRLF', r.changelog.includes('\r\n') && !/[^\r]\n/.test(r.changelog));
  check('package.json keeps CRLF', r.pkg.includes('\r\n'));
}

header('LF checkouts stay LF');
{
  const r = renumber(pkgAt('5.5.10'), clAt('5.5.10'), '5.5.10');
  check('no CR introduced into CHANGELOG', !r.changelog.includes('\r'));
  check('no CR introduced into package.json', !r.pkg.includes('\r'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

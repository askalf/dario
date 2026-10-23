// Unit tests for the pure helpers in scripts/_drift-patch-helpers.mjs
// (consumed by scripts/auto-draft-drift-fix.mjs — watcher arc, part 3).
//
// End-to-end behaviour of the auto-drafter (reads drift-report.json,
// patches files, emits PR metadata) is covered by a dry-run in the
// PR description; these tests pin the safety invariants of the pure
// patching logic.

import {
  isOlderThan,
  patchMaxTested,
  appendUnreleased,
  bumpPatch,
  bumpPackageJsonPatch,
  promoteUnreleased,
  syncLockfileVersion,
  buildPrBody,
  addPinnedVersion,
} from '../scripts/_drift-patch-helpers.mjs';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('isOlderThan — semver-ish comparison');
{
  check('2.1.117 older than 2.1.118',  isOlderThan('2.1.117', '2.1.118') === true);
  check('2.1.117 older than 2.2.0',    isOlderThan('2.1.117', '2.2.0')   === true);
  check('2.1.117 older than 3.0.0',    isOlderThan('2.1.117', '3.0.0')   === true);
  check('2.1.117 NOT older than 2.1.117', isOlderThan('2.1.117', '2.1.117') === false);
  check('2.1.118 NOT older than 2.1.117', isOlderThan('2.1.118', '2.1.117') === false);
  check('1.0.0   older than 2.0.0',    isOlderThan('1.0.0', '2.0.0')     === true);
  check('2.1     older than 2.1.1',    isOlderThan('2.1', '2.1.1')       === true);
}

// ─────────────────────────────────────────────────────────────
header('patchMaxTested — trivial bump');
{
  const src = `export const SUPPORTED_CC_RANGE = {
  min: '1.0.0',
  maxTested: '2.1.117',
} as const;`;
  const { patched, before, after } = patchMaxTested(src, '2.1.117', '2.1.118');
  check('before captured', before === '2.1.117');
  check('after matches input', after === '2.1.118');
  check('patched string has new version', patched.includes(`maxTested: '2.1.118'`));
  check('old version gone', !patched.includes(`maxTested: '2.1.117'`));
  check('rest of source preserved', patched.includes(`min: '1.0.0'`));
}

header('patchMaxTested — double-quote style');
{
  const src = `  maxTested: "2.1.117",`;
  const { patched, before, after } = patchMaxTested(src, '2.1.117', '2.1.118');
  check('double-quoted before captured', before === '2.1.117');
  check('double-quoted after',           after === '2.1.118');
  check('double-quoted patched',         patched === `  maxTested: "2.1.118",`);
}

header('patchMaxTested — refuses to move backward or noop');
{
  const src = `  maxTested: '2.1.118',`;
  // Requesting an OLDER version must be a no-op.
  const back = patchMaxTested(src, '2.1.118', '2.1.117');
  check('backward move → patched null',  back.patched === null);
  check('backward move → before recorded', back.before === '2.1.118');

  // Requesting the SAME version must be a no-op.
  const same = patchMaxTested(src, '2.1.118', '2.1.118');
  check('same version → patched null',   same.patched === null);
}

header('patchMaxTested — no maxTested property → null');
{
  const src = `const x = { other: 'thing', min: '1.0.0' };`;
  const { patched, before } = patchMaxTested(src, '1.0.0', '2.0.0');
  check('patched null',   patched === null);
  check('before null',    before === null);
}

header('patchMaxTested — stale report version tolerated');
{
  // The drift report says pinned was 2.1.117, but by the time this
  // workflow runs, the source has already been bumped to 2.1.118
  // (someone landed an unrelated patch). We should still bump to
  // 2.1.119 if that's what the report asked for.
  const src = `  maxTested: '2.1.118',`;
  const { patched, before, after } = patchMaxTested(src, '2.1.117', '2.1.119');
  check('patched using on-disk version as before',  before === '2.1.118');
  check('after matches requested target',           after === '2.1.119');
  check('patched string is the requested target',   patched.includes(`'2.1.119'`));
}

// ─────────────────────────────────────────────────────────────
header('appendUnreleased — bullet lands under the heading');
{
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added — something previous',
    '',
    '## [3.31.11] - 2026-04-23',
  ].join('\n');
  const out = appendUnreleased(changelog, '- new bullet');
  check('bullet present', out.includes('- new bullet'));
  // bullet should be BEFORE the "Added — something previous" section.
  const bulletIdx = out.indexOf('- new bullet');
  const addedIdx = out.indexOf('### Added');
  check('bullet lands before existing Unreleased content', bulletIdx < addedIdx);
  // bullet should be AFTER the heading line.
  const headingIdx = out.indexOf('## [Unreleased]');
  check('bullet lands after the heading', bulletIdx > headingIdx);
}

header('appendUnreleased — skips HTML-comment false-match');
{
  // Regression for a real bug in v1: the HTML comment at the top of
  // CHANGELOG.md (documenting the Unreleased convention) contained
  // the literal string `## [Unreleased]`, and a naive string indexOf
  // landed the bullet inside the comment body.
  const changelog = [
    '# Changelog',
    '',
    '<!--',
    'Release convention: land changes under `## [Unreleased]`. At release',
    'time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh',
    '`## [Unreleased]` above it.',
    '-->',
    '',
    '## [Unreleased]',
    '',
    '## [3.31.11] - 2026-04-23',
  ].join('\n');
  const out = appendUnreleased(changelog, '- new bullet');
  const bulletIdx = out.indexOf('- new bullet');
  const commentEndIdx = out.indexOf('-->');
  // Bullet must land AFTER the HTML comment ends, not inside it.
  check('bullet lands after HTML comment closes', bulletIdx > commentEndIdx);
  // Verify the comment block is still intact.
  check('HTML comment preserved', out.includes('<!--') && out.includes('-->'));
}

header('appendUnreleased — no heading → changelog unchanged');
{
  const changelog = '# Changelog\n\n## [3.31.0] - 2026-01-01\n\n### Added — stuff\n';
  const out = appendUnreleased(changelog, '- ignored');
  check('unchanged when no Unreleased heading', out === changelog);
}

// ─────────────────────────────────────────────────────────────
header('bumpPatch — increment last segment');
{
  check('3.31.11 → 3.31.12',   bumpPatch('3.31.11') === '3.31.12');
  check('1.0.0 → 1.0.1',       bumpPatch('1.0.0')   === '1.0.1');
  check('0.0.0 → 0.0.1',       bumpPatch('0.0.0')   === '0.0.1');
  check('10.9.99 → 10.9.100',  bumpPatch('10.9.99') === '10.9.100');
  check('2-segment: 1.0 → 1.1', bumpPatch('1.0')    === '1.1');
}

header('bumpPatch — rejects malformed versions');
{
  let threw;
  try { bumpPatch('1.2.3-rc'); threw = false; } catch { threw = true; }
  check('pre-release suffix rejected', threw === true);
  try { bumpPatch('1'); threw = false; } catch { threw = true; }
  check('single segment rejected', threw === true);
  try { bumpPatch(''); threw = false; } catch { threw = true; }
  check('empty rejected', threw === true);
}

header('bumpPackageJsonPatch');
{
  const src = JSON.stringify({
    name: '@askalf/dario',
    version: '3.31.11',
    description: 'test',
    scripts: { build: 'tsc' },
  }, null, 2) + '\n';
  const { content, before, after } = bumpPackageJsonPatch(src);
  check('before captured',  before === '3.31.11');
  check('after bumped',     after  === '3.31.12');
  check('content has new version', content.includes('"version": "3.31.12"'));
  check('content has old version NO MORE', !content.includes('"version": "3.31.11"'));
  check('other fields preserved', content.includes('"name": "@askalf/dario"') && content.includes('"scripts"'));
  check('content ends with newline', content.endsWith('\n'));
}

header('bumpPackageJsonPatch — rejects missing version');
{
  const src = JSON.stringify({ name: 'x' });
  let threw;
  try { bumpPackageJsonPatch(src); threw = false; } catch { threw = true; }
  check('missing version throws', threw === true);
}

header('promoteUnreleased — keeps the blank line under the new heading');
{
  const changelog = ['# Changelog', '', '## [Unreleased]', '', '### Fixed', '', '- **A fix.** Body.', '', '## [6.12.8] - 2026-09-27', ''].join('\n');
  const out = promoteUnreleased(changelog, '6.12.9', '2026-09-28');
  check('a blank line separates the new heading from its first subsection',
    out.includes('## [Unreleased]\n\n## [6.12.9] - 2026-09-28\n\n### Fixed\n\n- **A fix.** Body.'));
  check('everything after the heading is byte-for-byte unchanged',
    out.slice(out.indexOf('## [6.12.9] - 2026-09-28') + '## [6.12.9] - 2026-09-28'.length) === changelog.slice(changelog.indexOf('## [Unreleased]') + '## [Unreleased]'.length));
  const crlf = promoteUnreleased(changelog.replace(/\n/g, '\r\n'), '6.12.9', '2026-09-28');
  check('a CRLF file still promotes, blank line kept', crlf.includes('## [6.12.9] - 2026-09-28\r\n\r\n### Fixed'));
}

header('promoteUnreleased — promotes and opens fresh Unreleased above');
{
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- **CC drift patch** — maxTested bumped',
    '',
    '## [3.31.11] - 2026-04-23',
    '',
    '### Added — scope auto-detection',
  ].join('\n');
  const out = promoteUnreleased(changelog, '3.31.12', '2026-04-23');
  check('fresh Unreleased heading still present', out.includes('## [Unreleased]'));
  check('new dated heading present',              out.includes('## [3.31.12] - 2026-04-23'));
  check('previous Unreleased content preserved',  out.includes('- **CC drift patch** — maxTested bumped'));
  check('prior version heading untouched',        out.includes('## [3.31.11] - 2026-04-23'));

  // Order: `## [Unreleased]` should be ABOVE `## [3.31.12]`, which is
  // above `## [3.31.11]`.
  const unreleasedIdx = out.indexOf('## [Unreleased]');
  const newIdx = out.indexOf('## [3.31.12]');
  const oldIdx = out.indexOf('## [3.31.11]');
  check('Unreleased above new version',           unreleasedIdx < newIdx);
  check('new version above old version',          newIdx < oldIdx);
}

header('promoteUnreleased — no Unreleased heading → unchanged');
{
  const changelog = '# Changelog\n\n## [3.31.0] - 2026-01-01\n';
  const out = promoteUnreleased(changelog, '3.31.1', '2026-02-01');
  check('unchanged when no Unreleased heading', out === changelog);
}

header('appendUnreleased — custom heading regex (for auto-drafter)');
{
  // After promoteUnreleased, the auto-drafter appends its bullet under
  // the NEW dated heading, not the fresh Unreleased above it.
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [3.31.12] - 2026-04-23',
    '',
  ].join('\n');
  const out = appendUnreleased(
    changelog,
    '- drift bullet',
    /^## \[3\.31\.12\] - 2026-04-23\s*$/m,
  );
  check('bullet present', out.includes('- drift bullet'));
  const bulletIdx = out.indexOf('- drift bullet');
  const datedIdx = out.indexOf('## [3.31.12]');
  const unreleasedIdx = out.indexOf('## [Unreleased]');
  check('bullet lands after the dated heading', bulletIdx > datedIdx);
  check('bullet lands BELOW the fresh Unreleased', bulletIdx > unreleasedIdx);
}

header('syncLockfileVersion — mirrors both version slots');
{
  const lock = JSON.stringify({
    name: '@askalf/dario',
    version: '5.5.70',
    lockfileVersion: 3,
    packages: {
      '': { name: '@askalf/dario', version: '5.5.70', license: 'MIT' },
      'node_modules/tsx': { version: '4.19.0' },
    },
  }, null, 2) + '\n';
  const out = syncLockfileVersion(lock, '5.5.71');
  const parsed = JSON.parse(out);
  check('root slot bumped', parsed.version === '5.5.71');
  check('packages[""] slot bumped', parsed.packages[''].version === '5.5.71');
  check('dependency versions untouched', parsed.packages['node_modules/tsx'].version === '4.19.0');
  check('other fields preserved', parsed.lockfileVersion === 3 && parsed.name === '@askalf/dario');
  check('ends with newline', out.endsWith('\n'));
  check('canonical 2-space indent', out === JSON.stringify(parsed, null, 2) + '\n');
}

header('syncLockfileVersion — guards and absent slots');
{
  let threw;
  try { syncLockfileVersion('{"version":"1.0.0"}', 'not-a-version'); threw = false; } catch { threw = true; }
  check('non-numeric version rejected', threw === true);

  try { syncLockfileVersion('{ not json', '1.0.1'); threw = false; } catch { threw = true; }
  check('invalid JSON throws (fails loud, not silently skipped)', threw === true);

  // A lockfile without the packages[""] self-entry keeps parsing; the missing
  // slot is left alone rather than invented.
  const out = syncLockfileVersion(JSON.stringify({ version: '1.0.0', packages: {} }, null, 2) + '\n', '1.0.1');
  const parsed = JSON.parse(out);
  check('root slot bumped without self-entry', parsed.version === '1.0.1');
  check('absent slot not invented', parsed.packages[''] === undefined);
}

header('syncLockfileVersion — agrees with a package.json patch bump');
{
  // The invariant preflight.mjs asserts: after a bot bumps package.json, the
  // lockfile's two slots must equal the new version.
  const pkg = JSON.stringify({ name: '@askalf/dario', version: '5.5.70' }, null, 2) + '\n';
  const { content, after } = bumpPackageJsonPatch(pkg);
  const lock = JSON.stringify({ version: '5.5.70', packages: { '': { version: '5.5.70' } } }, null, 2) + '\n';
  const synced = JSON.parse(syncLockfileVersion(lock, after));
  const pkgVersion = JSON.parse(content).version;
  check('lockfile root == package.json', synced.version === pkgVersion);
  check('lockfile self-entry == package.json', synced.packages[''].version === pkgVersion);
}

// ─────────────────────────────────────────────────────────────
header('buildPrBody: what changes for users, no process text');
{
  const body = buildPrBody('2.1.309', '2.1.308', '6.13.30', true, true);
  check('names the new version and the old ceiling', body.includes('Claude Code 2.1.309') && body.includes('2.1.308'));
  check('names the package version and the pinned list', body.includes('6.13.30') && body.includes('test/compat-pinned.json') && body.includes('lists 2.1.309'));
  check('no headings, lists or workflow names', !/^#|^- |^\d\./m.test(body) && !/\.yml|Drafted|Merge|Release:|Scope/.test(body));
  check('no em or en dash', !/[\u2013\u2014]/.test(body));
  const unpinned = buildPrBody('2.1.309', '2.1.308', '6.13.30', false, true);
  check('without the version listed: says so, never that it is listed', unpinned.includes('2.1.309 is not in') && !unpinned.includes('lists 2.1.309'));
  const sentences = (t) => (t.match(/[.!?](?=\s|$)/g) ?? []).length;
  check('two sentences either way', sentences(body) === 2 && sentences(unpinned) === 2);
  check('without the case: no em or en dash', !/[\u2013\u2014]/.test(unpinned));
  check('with the changelog written: says it has an entry', body.includes('the changelog has an entry') && unpinned.includes('the changelog has an entry'));
  const noLog = [buildPrBody('2.1.309', '2.1.308', '6.13.30', true, false), buildPrBody('2.1.309', '2.1.308', '6.13.30', false, false)];
  check('without the changelog written: never claims an entry, says there is none', noLog.every((t) => !t.includes('the changelog has an entry') && t.includes('has no entry for it')));
  check('without the changelog written: still two sentences', noLog.every((t) => sentences(t) === 2));
}

header('auto-draft-drift-fix.mjs end to end: the body matches whether the version was listed');
{
  // The drafter patches the files under its own repo root, so each case runs a copy of it in a
  // scratch directory with just the files it reads.
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['scripts/auto-draft-drift-fix.mjs', 'scripts/_drift-patch-helpers.mjs', 'src/live-fingerprint.ts', 'package.json', 'package-lock.json', 'CHANGELOG.md', 'test/compat-pinned.json'];
  const maxTested = /maxTested:\s*'(\d+\.\d+\.\d+)'/.exec(readFileSync(join(repo, 'src/live-fingerprint.ts'), 'utf8'))?.[1];
  const [a, b, c] = String(maxTested).split('.').map(Number);
  const next = `${a}.${b}.${c + 1}`;
  const LIST = 'test/compat-pinned.json';
  const draft = (list, changelog) => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-draft-'));
    try {
      for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); copyFileSync(join(repo, f), join(dir, f)); }
      if (list === null) rmSync(join(dir, LIST));
      else if (list !== undefined) writeFileSync(join(dir, LIST), list);
      if (changelog === null) rmSync(join(dir, 'CHANGELOG.md'));
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ drift: true, ccVersion: next, pinned: { maxTested }, items: [{ category: 'compat.range', severity: 'medium', message: 'above the range' }] }));
      const r = spawnSync(process.execPath, [join(dir, 'scripts/auto-draft-drift-fix.mjs'), join(dir, 'report.json')], { encoding: 'utf8' });
      return { out: JSON.parse(r.stdout), list: list === null ? null : readFileSync(join(dir, LIST), 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ok = draft(undefined);
  check('a list: fixed, the version is added and staged', ok.out.fixed === true && ok.out.changedFiles.includes(LIST) && JSON.parse(ok.list).at(-1) === next);
  check('a list: the body says it is listed', ok.out.prBody.includes(`lists ${next}`));
  const bad = draft('not json\n');
  check('not a list: fixed, the file is left alone and not staged', bad.out.fixed === true && !bad.out.changedFiles.includes(LIST) && bad.list === 'not json\n');
  check('not a list: the body says the version is not listed', bad.out.prBody.includes(`${next} is not in`) && !bad.out.prBody.includes(`lists ${next}`));
  const gone = draft(null);
  check('no list: fixed, not staged, the body says the version is not listed', gone.out.fixed === true && !gone.out.changedFiles.includes(LIST) && gone.out.prBody.includes(`${next} is not in`));
  check('a changelog: staged, the body says it has an entry', ok.out.changedFiles.includes('CHANGELOG.md') && ok.out.prBody.includes('the changelog has an entry'));
  const noLog = draft(undefined, null);
  check('no changelog: fixed, not staged, the body says it has no entry', noLog.out.fixed === true && !noLog.out.changedFiles.includes('CHANGELOG.md') && !noLog.out.prBody.includes('the changelog has an entry') && noLog.out.prBody.includes('has no entry for it'));
}

header('addPinnedVersion: appends to the list test/compat-range.mjs checks');
{
  const real = readFileSync(new URL('./compat-pinned.json', import.meta.url), 'utf8');
  const out = addPinnedVersion(real, '9.9.9');
  check('appends the version', out !== null && JSON.parse(out).at(-1) === '9.9.9');
  check('keeps the versions already listed', out !== null && JSON.stringify(JSON.parse(out).slice(0, -1)) === JSON.stringify(JSON.parse(real)));
  check('a listed version: the text unchanged', out !== null && addPinnedVersion(out, '9.9.9') === out);
  check('not JSON: null', addPinnedVersion('// not json', '9.9.9') === null);
  check('not a list of versions: null', addPinnedVersion('{"a":1}', '9.9.9') === null && addPinnedVersion('["x"]', '9.9.9') === null);
  check('not x.y.z: null', addPinnedVersion(real, "9.9.9'); evil('") === null);
  check('compat-range.mjs reads the list', readFileSync(new URL('./compat-range.mjs', import.meta.url), 'utf8').includes("new URL('./compat-pinned.json', import.meta.url)"));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

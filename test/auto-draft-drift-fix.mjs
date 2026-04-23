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
} from '../scripts/_drift-patch-helpers.mjs';

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
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

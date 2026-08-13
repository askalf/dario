#!/usr/bin/env node
// Tests for scripts/resolve-release-conflicts.mjs.
//
// The fixtures are REAL conflicts from 2026-08-12, when four PRs (#952, #955,
// #960, #961) all had to be hand-resolved in a worktree within a few hours.
// Every one came out the same two ways, which is why the rule is code now.
//
// Both failure directions are silent, so both are asserted:
//   - resolving the version DOWNWARD publishes below an existing tag, and
//     cc-drift-auto-release's duplicate-tag guard then fast-exits GREEN having
//     shipped nothing;
//   - dropping a CHANGELOG side loses an entry for a release that shipped, and
//     nothing downstream notices.

import {
  resolvePackageJson, resolveChangelog, compareVersions, parseVersion, hasConflicts,
} from '../scripts/resolve-release-conflicts.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

header('semver comparison');
{
  check('5.5.99 < 5.6.0 (not a string compare)', compareVersions('5.5.99', '5.6.0') < 0);
  check('5.5.10 > 5.5.9', compareVersions('5.5.10', '5.5.9') > 0);
  check('equal is 0', compareVersions('5.5.11', '5.5.11') === 0);
  check('rejects non-X.Y.Z', parseVersion('5.5') === null);
  let threw = false;
  try { compareVersions('1.2.3', 'v1.2.4'); } catch { threw = true; }
  check('compare throws on a bad version', threw);
}

header('package.json — the #955 conflict');
{
  // Verbatim shape from PR #955 after merging master (which carried #954).
  const conflicted = `{
  "name": "@askalf/dario",
<<<<<<< HEAD
  "version": "5.5.11",
=======
  "version": "5.5.10",
>>>>>>> origin/master
  "description": "…",
  "type": "module"
}
`;
  const out = resolvePackageJson(conflicted);
  check('no markers survive', !hasConflicts(out));
  check('keeps the HIGHER version', /"version": "5\.5\.11"/.test(out), out);
  check('does not keep the lower one', !/"version": "5\.5\.10"/.test(out));
  check('preserves surrounding lines', /"name": "@askalf\/dario"/.test(out) && /"type": "module"/.test(out));
  check('valid JSON after resolution', (() => { try { JSON.parse(out); return true; } catch { return false; } })(), out);

  // Same conflict with the sides swapped — the higher version must still win,
  // so the outcome cannot depend on which branch happened to be "ours".
  const swapped = conflicted
    .replace('"version": "5.5.11",\n=======\n  "version": "5.5.10",', '"version": "5.5.10",\n=======\n  "version": "5.5.11",');
  const out2 = resolvePackageJson(swapped);
  check('order-independent: higher wins from either side', /"version": "5\.5\.11"/.test(out2), out2);
}

header('package.json — refuses anything else');
{
  const notJustVersion = `{
<<<<<<< HEAD
  "version": "5.5.11",
  "main": "dist/a.js",
=======
  "version": "5.5.10",
  "main": "dist/b.js",
>>>>>>> origin/master
}
`;
  let threw = false;
  try { resolvePackageJson(notJustVersion); } catch { threw = true; }
  check('refuses when more than the version conflicts', threw);
}

header('CHANGELOG — the #952 conflict (unreleased bullet vs new section)');
{
  const conflicted = `## [Unreleased]

<<<<<<< HEAD
- **check-overage-live.mjs no longer reports a false CLEAN.** Detail here.

=======
## [5.5.10] - 2026-08-11

- **CC drift patch** — maxTested bumped.
>>>>>>> origin/master
## [5.5.9] - 2026-08-11

- **Template rebake** — re-captured.
`;
  const out = resolveChangelog(conflicted);
  check('no markers survive', !hasConflicts(out));
  check('keeps the unreleased bullet', /false CLEAN/.test(out), out);
  check('keeps the new version section', /## \[5\.5\.10\]/.test(out), out);
  check('keeps the pre-existing section', /## \[5\.5\.9\]/.test(out));
  check('unreleased bullet stays ABOVE the version sections',
    out.indexOf('false CLEAN') < out.indexOf('## [5.5.10]'), out);
}

header('CHANGELOG — the #955 conflict (two version sections)');
{
  const conflicted = `## [Unreleased]

<<<<<<< HEAD
## [5.5.11] - 2026-08-12

- **Template label refresh** — 2.1.228.
=======
## [5.5.10] - 2026-08-11

- **CC drift patch** — maxTested.
>>>>>>> origin/master
## [5.5.9] - 2026-08-11

- **Template rebake** — earlier.
`;
  const out = resolveChangelog(conflicted);
  check('no markers survive', !hasConflicts(out));
  check('keeps BOTH sections', /## \[5\.5\.11\]/.test(out) && /## \[5\.5\.10\]/.test(out), out);
  check('newest first', out.indexOf('## [5.5.11]') < out.indexOf('## [5.5.10]'), out);
  check('older section still below', out.indexOf('## [5.5.10]') < out.indexOf('## [5.5.9]'), out);
  check('no duplicated heading', (out.match(/## \[5\.5\.10\]/g) || []).length === 1);
}

header('CHANGELOG — identical section on both sides collapses');
{
  const conflicted = `## [Unreleased]

<<<<<<< HEAD
## [5.5.12] - 2026-08-12

- **CC drift patch** — same text.
=======
## [5.5.12] - 2026-08-12

- **CC drift patch** — same text.
>>>>>>> origin/master
## [5.5.11] - 2026-08-12
`;
  const out = resolveChangelog(conflicted);
  check('appears exactly once', (out.match(/## \[5\.5\.12\]/g) || []).length === 1, out);
}

header('unreleased bullet left OUTSIDE the region by git');
{
  // Real shape from the e2e run: git put one side's `## [Unreleased]` bullet
  // AFTER the >>>>>>> line rather than inside the region. Emitting the merged
  // version sections first buried it under ## [5.5.13].
  const conflicted = `## [Unreleased]

<<<<<<< HEAD
## [5.5.14] - 2026-08-13

- **Competing bump** — synthetic.
=======
## [5.5.13] - 2026-08-13

- **Template label refresh** — labels.
>>>>>>> origin/master
- **check-overage-live.mjs no longer reports a false CLEAN.** Unreleased entry.

## [5.5.12] - 2026-08-12

- earlier.
`;
  const out = resolveChangelog(conflicted);
  check('no markers survive', !hasConflicts(out));
  check('the unreleased bullet survives', /false CLEAN/.test(out), out);
  check('it sits ABOVE the newest version section',
    out.indexOf('false CLEAN') < out.indexOf('## [5.5.14]'), out);
  check('it is NOT buried under 5.5.13',
    out.indexOf('false CLEAN') < out.indexOf('## [5.5.13]'), out);
  check('both version sections still present',
    /## \[5\.5\.14\]/.test(out) && /## \[5\.5\.13\]/.test(out));
  check('ordering still descending',
    out.indexOf('## [5.5.14]') < out.indexOf('## [5.5.13]')
      && out.indexOf('## [5.5.13]') < out.indexOf('## [5.5.12]'), out);
}

header('CRLF — the checkout this actually runs on');
{
  // Found by an end-to-end run against a real `git merge`, NOT by the LF
  // fixtures above, all of which passed while the script was blind to CRLF.
  // In JS `.` will not consume a carriage return and `$` (no `m` flag) will
  // not match before one, so "<<<<<<< HEAD\r" defeated every marker regex and
  // the script reported "no conflict" on a genuinely conflicted file — the
  // worst outcome available to it, since the caller then commits the markers.
  const lf = `{
  "name": "x",
<<<<<<< HEAD
  "version": "5.5.14",
=======
  "version": "5.5.13",
>>>>>>> origin/master
  "type": "module"
}
`;
  const crlf = lf.replace(/\n/g, '\r\n');

  check('detects conflicts in CRLF text', hasConflicts(crlf));
  const out = resolvePackageJson(crlf);
  check('resolves CRLF package.json', !hasConflicts(out));
  check('still keeps the higher version', /"version": "5\.5\.14"/.test(out));
  check('preserves CRLF endings', out.includes('\r\n') && !/[^\r]\n/.test(out));
  check('valid JSON after CRLF resolution',
    (() => { try { JSON.parse(out); return true; } catch { return false; } })());

  const clLf = `## [Unreleased]

<<<<<<< HEAD
## [5.5.11] - 2026-08-12

- ours.
=======
## [5.5.10] - 2026-08-11

- theirs.
>>>>>>> origin/master
## [5.5.9] - 2026-08-11
`;
  const clOut = resolveChangelog(clLf.replace(/\n/g, '\r\n'));
  check('resolves CRLF CHANGELOG', !hasConflicts(clOut));
  check('keeps both sections under CRLF',
    /## \[5\.5\.11\]/.test(clOut) && /## \[5\.5\.10\]/.test(clOut));
  check('CHANGELOG keeps CRLF endings', clOut.includes('\r\n') && !/[^\r]\n/.test(clOut));

  // And the converse: an LF file must not be silently converted to CRLF.
  check('LF input stays LF', !resolvePackageJson(lf).includes('\r'));
}

header('no-op and passthrough');
{
  const clean = '## [Unreleased]\n\n- nothing conflicting\n';
  check('clean CHANGELOG is returned unchanged', resolveChangelog(clean) === clean);
  const cleanPkg = '{\n  "version": "1.0.0"\n}\n';
  check('clean package.json is returned unchanged', resolvePackageJson(cleanPkg) === cleanPkg);
  check('hasConflicts is false on clean text', !hasConflicts(clean));
}

header('malformed input is refused, not guessed');
{
  let threw = false;
  try { resolveChangelog('<<<<<<< HEAD\nunterminated\n'); } catch { threw = true; }
  check('unterminated marker throws', threw);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Tests for scripts/version-bump-advice.mjs — the advisory that tells a PR
// author, while the PR is still open, that their change will merge green and
// release nothing.
//
// Worth testing for the same reason version-advances.sh is: both failure
// directions are quiet. Too permissive and it stays silent on exactly the PRs
// it exists for (#1153 / #1151 / #1150 / #1147 shape). Too noisy and it
// comments on every test-only and workflow-only PR, at which point people
// learn to scroll past it and the real warning goes unread too. Neither shows
// up as a red run.

import { adviseBump, shipsToUsers } from '../scripts/version-bump-advice.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

header('shipping vs non-shipping paths');
{
  for (const p of [
    'src/proxy.ts',
    'src/backends/codex-backend.ts',
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'docker-entrypoint.sh',
    'README.md',
    'docs/recovery.md',
  ]) {
    check(`${p} ships`, shipsToUsers(p) === true);
  }

  for (const p of [
    'test/proxy.mjs',
    '.github/workflows/ci.yml',
    'scripts/preflight.mjs',
    'tools/bench.mjs',
    'fuzz/headers.mjs',
    'reviews/2026-08-25.md',
    'cloudflare/worker.js',
    'redis-lock/lock.lua',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'RELEASING.md',
    'CLAUDE.md',
  ]) {
    check(`${p} does not ship`, shipsToUsers(p) === false);
  }

  check('empty path does not ship', shipsToUsers('') === false);
  check('undefined path does not ship', shipsToUsers(undefined) === false);

  // Prefix matching must not swallow a same-named root file: `scripts/` is
  // exempt, `scripts.ts` at the root would not be.
  check('a root file merely PREFIXED by an exempt dir still ships',
    shipsToUsers('scripts.ts') === true);
}

header('the shape this exists for');
{
  // #1153 / #1151 / #1150: source change, version untouched.
  const g = adviseBump('6.0.2', '6.0.2', ['src/proxy.ts', 'test/proxy.mjs']);
  check('flags a src change with no bump', g.needsBump === true, g.reason);
  check('names the stuck version', /stays at 6\.0\.2/.test(g.reason), g.reason);
  check('names the offending file', /src\/proxy\.ts/.test(g.reason), g.reason);
  check('counts only shipping files', g.shipping.length === 1, JSON.stringify(g.shipping));
}

header('bump present');
{
  const g = adviseBump('6.0.2', '6.0.3', ['src/proxy.ts', 'package.json', 'CHANGELOG.md']);
  check('stays quiet when the version moved', g.needsBump === false, g.reason);
  check('names both versions', /6\.0\.2 -> 6\.0\.3/.test(g.reason), g.reason);

  // A minor/major bump is a bump; the ordering question belongs to
  // version-advances.sh, not here.
  const minor = adviseBump('6.0.2', '6.1.0', ['src/proxy.ts']);
  check('accepts a minor bump', minor.needsBump === false, minor.reason);

  // Even a version moving BACKWARDS is "bumped" as far as this advisory is
  // concerned — wrong, but wrong in a way version-advances.sh already reports,
  // and duplicating that judgement here would give two different comments for
  // one defect.
  const back = adviseBump('6.0.2', '6.0.1', ['src/proxy.ts']);
  check('defers ordering to version-advances.sh', back.needsBump === false, back.reason);
}

header('nothing shipping changed');
{
  // A workflow-only or test-only PR releases nothing whether or not it bumps,
  // so nagging would train people to ignore the comment.
  const ci = adviseBump('6.0.2', '6.0.2', ['.github/workflows/ci.yml', 'test/all.test.mjs']);
  check('quiet on a CI-only PR', ci.needsBump === false, ci.reason);
  check('says why', /carry nothing/.test(ci.reason), ci.reason);

  const changelogOnly = adviseBump('6.0.2', '6.0.2', ['CHANGELOG.md']);
  check('quiet on a CHANGELOG-only PR', changelogOnly.needsBump === false, changelogOnly.reason);

  const empty = adviseBump('6.0.2', '6.0.2', []);
  check('quiet on an empty file list', empty.needsBump === false, empty.reason);

  const missing = adviseBump('6.0.2', '6.0.2', undefined);
  check('quiet on a missing file list', missing.needsBump === false, missing.reason);
}

header('the sample in the reason stays short');
{
  const many = adviseBump('6.0.2', '6.0.2', [
    'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts',
  ]);
  check('flags it', many.needsBump === true, many.reason);
  check('lists three then summarises', /\(\+2 more\)/.test(many.reason), many.reason);
  check('reason stays one line', !many.reason.includes('\n'), many.reason);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

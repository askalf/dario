#!/usr/bin/env node
// scripts/check-readme-line-count.mjs -- the "~Nk lines of TypeScript across N
// files" guard -- against fixtures. README.md is required; CONTRIBUTING.md and
// site/index.html are checked when present. Every copy and every way the claim
// is written gets a passing and a failing fixture here.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-readme-line-count.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};

/** A repository with `files` source files of `lines` lines each, and the given docs; returns { code, out }. */
function run({ files = 4, lines = 1000, readme, contributing, site }) {
  const root = mkdtempSync(join(tmpdir(), 'dario-line-count-'));
  mkdirSync(join(root, 'src', 'sub'), { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(root, 'src', i % 2 ? 'sub' : '', `f${i}.ts`), 'x\n'.repeat(lines));
  if (readme !== undefined) writeFileSync(join(root, 'README.md'), readme);
  if (contributing !== undefined) writeFileSync(join(root, 'CONTRIBUTING.md'), contributing);
  if (site !== undefined) { mkdirSync(join(root, 'site')); writeFileSync(join(root, 'site', 'index.html'), site); }
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('\n=== honest claims pass (4 files x 1000 lines = 4,000) ===');
{
  const r = run({
    readme: '<sub>0 deps · ~4k lines of TypeScript across 4 files ·</sub>\n\n| Source | **~4k** lines of TypeScript across **4** files. |\n',
    contributing: 'The codebase is ~4k lines across 4 TypeScript files.\n',
    site: '<div><b>~4k</b><span>lines of TypeScript across 4 files.</span></div>\n',
  });
  check('exit 0', r.code === 0, r.out);
  check('all four copies counted', /ok\s+4 line-count claim/.test(r.out), r.out);
}

console.log('\n=== a README with no claim fails ===');
{
  const r = run({ readme: '# dario\n\nno numbers here\n' });
  check('exit 1', r.code === 1, r.out);
  check('says the claim is gone', /no longer contains/.test(r.out), r.out);
}

console.log('\n=== a missing README fails ===');
{
  const r = run({});
  check('exit 1', r.code === 1, r.out);
  check('says README.md is missing', /README\.md is missing/.test(r.out), r.out);
  const withCopy = run({ contributing: 'The codebase is ~4k lines across 4 TypeScript files.\n' });
  check('missing README with an honest CONTRIBUTING: exit 1', withCopy.code === 1, withCopy.out);
}

console.log('\n=== the line count off by more than 1000 fails, within it passes ===');
{
  const off = run({ lines: 1500, readme: '~4k lines of TypeScript across 4 files\n' });
  check('6,000 actual vs ~4k: exit 1', off.code === 1, off.out);
  check('names the right number', /Update it to ~6k/.test(off.out), off.out);
  const near = run({ lines: 1200, readme: '~4k lines of TypeScript across 4 files\n' });
  check('4,800 actual vs ~4k: exit 0', near.code === 0, near.out);
}

console.log('\n=== the file count off by more than 5 fails ===');
{
  const r = run({ files: 12, lines: 333, readme: '~4k lines of TypeScript across 4 files\n' });
  check('12 files vs 4: exit 1', r.code === 1, r.out);
  check('names the file count', /claims 4 files; src\/ has 12/.test(r.out), r.out);
}

console.log('\n=== a stale copy outside the README fails ===');
{
  const contrib = run({ readme: '~4k lines of TypeScript across 4 files\n', contributing: 'The codebase is ~12k lines across 27 TypeScript files.\n' });
  check('CONTRIBUTING.md stale: exit 1', contrib.code === 1, contrib.out);
  check('names CONTRIBUTING.md', /CONTRIBUTING\.md:/.test(contrib.out), contrib.out);
  const site = run({ readme: '~4k lines of TypeScript across 4 files\n', site: '<b>~9k</b><span>lines of TypeScript across 4 files</span>\n' });
  check('site/index.html stale: exit 1', site.code === 1, site.out);
  check('names site/index.html', /site\/index\.html:/.test(site.out), site.out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

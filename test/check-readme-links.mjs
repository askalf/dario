#!/usr/bin/env node
// scripts/check-readme-links.mjs — the README link/anchor guard — against
// fixtures. Review on dario#1235 caught that the first version collected only
// inline `](target)` links and html attributes, so a reference-style
// `[text][guide]` + `[guide]: docs/renamed.md` pair slipped past the contract
// the script states. Every link form the README could use gets a passing and
// a failing fixture here.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-readme-links.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};

const root = mkdtempSync(join(tmpdir(), 'dario-readme-links-'));
mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
mkdirSync(join(root, 'img'));
writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\n## Setup steps\n\ntext\n\n<a id="custom-anchor"></a>\n\n## Setup steps\n');
writeFileSync(join(root, 'docs', 'sub', 'deep.md'), '# Deep\n');
writeFileSync(join(root, 'img', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

/** Run the guard on a README with the given body; returns { code, out }. */
function run(name, body) {
  const file = join(root, name);
  writeFileSync(file, body);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('\n=== every link form resolves → exit 0 ===');
{
  const r = run('ok.md', [
    '# Title',
    '',
    '## Section one',
    'inline [guide](docs/guide.md) and [anchor](docs/guide.md#setup-steps) and [dup](docs/guide.md#setup-steps-1)',
    'custom [anchor](docs/guide.md#custom-anchor) and local [section](#section-one)',
    'angle [brackets](<docs/sub/deep.md>) and a titled [link](docs/guide.md "the guide")',
    'image ![pic](img/pic.svg) and html <img src="img/pic.svg"> <a href="docs/guide.md">x</a>',
    '<picture><source media="(prefers-color-scheme: dark)" srcset="img/pic.svg"><img src="img/pic.svg"></picture>',
    'reference [setup][guide] and ![shot][pic] and [deep][]',
    'a footnote[^note] is prose, not a link',
    'external [x](https://example.com/nope.md) [m](mailto:a@b.c) are not checked',
    '',
    '```',
    '[in a fence](docs/does-not-exist.md) must be ignored',
    '```',
    '',
    '[guide]: docs/guide.md#setup-steps',
    '[pic]: <img/pic.svg> "a title"',
    '[deep]: docs/sub/deep.md',
    '[^note]: Pro at $20 a month, as listed on [pricing](https://example.com/pricing) today.',
  ].join('\n'));
  check('exit 0', r.code === 0, r.out.trim());
  check('counts the reference definitions among the checked targets', /\b1[3-9] relative/.test(r.out) || /\b2\d relative/.test(r.out), r.out.trim());
}

console.log('\n=== each broken form fails → exit 1, and names the line ===');
const broken = [
  ['inline file', '[x](docs/renamed.md)', 'renamed.md'],
  ['inline anchor', '[x](docs/guide.md#no-such-heading)', 'no-such-heading'],
  ['local anchor', '[x](#nowhere)', '#nowhere'],
  ['html src', '<img src="img/gone.svg">', 'gone.svg'],
  ['picture srcset', '<source srcset="img/gone-dark.svg">', 'gone-dark.svg'],
  ['reference definition', '[x][ref]\n\n[ref]: docs/renamed.md', 'renamed.md'],
  ['reference image', '![x][shot]\n\n[shot]: <img/gone.svg>', 'gone.svg'],
  ['reference anchor', '[x][ref]\n\n[ref]: docs/guide.md#nope', 'nope'],
];
for (const [name, body, needle] of broken) {
  const r = run(`bad-${name.replace(/\s/g, '-')}.md`, `# T\n\n${body}\n`);
  check(`${name}: exit 1`, r.code === 1, r.out.trim());
  check(`${name}: reports the target`, r.out.includes(needle) && /FAIL: .*:\d+ /.test(r.out), r.out.trim());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

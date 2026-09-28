// scripts/fold-unreleased.mjs — moves notes left under `## [Unreleased]` into
// the release that ships them. Pure function only; no git, no network.

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const { foldUnreleased } = await import('../scripts/fold-unreleased.mjs');

const HEAD = '# Changelog\n\n<!--\nRelease convention: land changes under `## [Unreleased]`.\n-->\n\n';
const OLD = '## [6.12.7] - 2026-09-26\n\n- old\n';

header('the #1450 shape: a contribution merged while the release PR was open');
{
  const md = HEAD + '## [Unreleased]\n\n### Fixed\n\n- **Contrib.** A.\n\n## [6.12.8] - 2026-09-27\n\n### Fixed\n\n- **Floor.** B.\n\n' + OLD;
  const r = foldUnreleased(md);
  check('reports what it moved and where', r.moved === 2 && r.release === '## [6.12.8] - 2026-09-27');
  check('Unreleased is left empty', /## \[Unreleased\]\n\n## \[6\.12\.8\]/.test(r.text));
  check('the bullet joins the existing ### Fixed, not a second one', (r.text.match(/### Fixed/g) || []).length === 1
    && /### Fixed\n\n- \*\*Contrib\.\*\* A\.\n- \*\*Floor\.\*\* B\./.test(r.text));
  check('older releases are untouched', r.text.endsWith(OLD));
  check('folding twice changes nothing', foldUnreleased(r.text).moved === 0 && foldUnreleased(r.text).text === r.text);
}

header('subsections and loose text');
{
  const md = HEAD + '## [Unreleased]\n\n- loose\n\n### Added\n\n- **Flag.** C.\n\n## [6.12.8] - 2026-09-27\n\n- own\n\n### Fixed\n\n- **Floor.** B.\n\n' + OLD;
  const r = foldUnreleased(md);
  const section = r.text.slice(r.text.indexOf('## [6.12.8]'), r.text.indexOf('## [6.12.7]'));
  check('loose text goes to the top of the release', /## \[6\.12\.8\] - 2026-09-27\n\n- loose\n\n- own/.test(section));
  check('a subsection the release lacks is created', section.includes('### Added\n\n- **Flag.** C.'));
  check('the release keeps its own subsection', section.includes('### Fixed\n\n- **Floor.** B.'));
  check('nothing is dropped', ['- loose', '- own', '- **Flag.** C.', '- **Floor.** B.'].every((b) => section.includes(b)));
}

header('nothing to do, or nowhere to put it');
{
  const clean = HEAD + '## [Unreleased]\n\n## [6.12.8] - 2026-09-27\n\n- own\n\n' + OLD;
  check('an empty Unreleased is a no-op', foldUnreleased(clean).moved === 0 && foldUnreleased(clean).text === clean);
  check('no Unreleased heading → release null', foldUnreleased('# Changelog\n\n' + OLD).release === null);
  check('no release below Unreleased → release null', foldUnreleased('# Changelog\n\n## [Unreleased]\n\n- x\n').release === null);
  const crlf = (HEAD + '## [Unreleased]\n\n- x\n\n## [6.12.8] - 2026-09-27\n\n- own\n\n' + OLD).replace(/\n/g, '\r\n');
  const r = foldUnreleased(crlf);
  check('CRLF files keep CRLF', r.moved === 1 && !/[^\r]\n/.test(r.text));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

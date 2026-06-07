// Unit tests for bumpTemplateLabels() in scripts/_drift-patch-helpers.mjs —
// the pure label-bump consumed by scripts/label-sync.mjs (the sdk-drift
// label-only autofix path of cc-drift-template-watch.yml).
//
// The invariant under test: bump ONLY the three version-label fields, leave
// the wire shape byte-identical, and fail loud rather than silently no-op.

import { bumpTemplateLabels } from '../scripts/_drift-patch-helpers.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// A minimal stand-in for the baked template, serialized exactly the way
// capture-and-bake writes it (JSON.stringify(obj, null, 2) + '\n'). Includes
// the fields bumpTemplateLabels must NOT touch so we can assert they survive.
function fixture(version) {
  return JSON.stringify({
    _version: version,
    _captured: '2026-06-04T12:25:00.361Z',
    _source: 'bundled',
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    anthropic_beta: 'claude-code-20250219,effort-2025-11-24',
    header_values: {
      'accept': 'application/json',
      'user-agent': `claude-cli/${version} (external, sdk-cli)`,
      'x-stainless-package-version': '0.94.0',
    },
    _supportedMaxTested: version,
  }, null, 2) + '\n';
}

// ─────────────────────────────────────────────────────────────
header('bumpTemplateLabels — happy path');
{
  const { text, before, after } = bumpTemplateLabels(fixture('2.1.162'), '2.1.168');
  check('before captured', before === '2.1.162');
  check('after matches input', after === '2.1.168');

  const obj = JSON.parse(text);
  check('_version bumped', obj._version === '2.1.168');
  check('_supportedMaxTested bumped', obj._supportedMaxTested === '2.1.168');
  check('user-agent version bumped', obj.header_values['user-agent'] === 'claude-cli/2.1.168 (external, sdk-cli)');

  // Untouched fields.
  check('_captured untouched', obj._captured === '2026-06-04T12:25:00.361Z');
  check('x-stainless untouched', obj.header_values['x-stainless-package-version'] === '0.94.0');
  check('tools untouched', JSON.stringify(obj.tools) === JSON.stringify([{ name: 'Bash' }, { name: 'Read' }]));
  check('anthropic_beta untouched', obj.anthropic_beta === 'claude-code-20250219,effort-2025-11-24');

  // Old version string must be fully gone — no stray 2.1.162 anywhere.
  check('no residual old version', !text.includes('2.1.162'));
}

// ─────────────────────────────────────────────────────────────
header('bumpTemplateLabels — surgical diff (only 3 lines change)');
{
  const before = fixture('2.1.162');
  const { text } = bumpTemplateLabels(before, '2.1.168');
  const a = before.split('\n');
  const b = text.split('\n');
  check('same line count', a.length === b.length);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  check('exactly 3 lines changed', changed === 3);
}

// ─────────────────────────────────────────────────────────────
header('bumpTemplateLabels — guards');
{
  let threw;

  threw = false;
  try { bumpTemplateLabels(fixture('2.1.162'), '2.1.162'); } catch { threw = true; }
  check('rejects equal version (not newer)', threw);

  threw = false;
  try { bumpTemplateLabels(fixture('2.1.168'), '2.1.162'); } catch { threw = true; }
  check('rejects older target (no backward bump)', threw);

  threw = false;
  try { bumpTemplateLabels(fixture('2.1.162'), 'v2.1.168'); } catch { threw = true; }
  check('rejects non-numeric target', threw);

  threw = false;
  try { bumpTemplateLabels(fixture('2.1.162'), '2.1.168-rc1'); } catch { threw = true; }
  check('rejects pre-release suffix', threw);

  // Shape drifted: no _supportedMaxTested field → must fail loud, not no-op.
  threw = false;
  const noMaxTested = JSON.stringify({
    _version: '2.1.162',
    header_values: { 'user-agent': 'claude-cli/2.1.162 (external, sdk-cli)' },
  }, null, 2) + '\n';
  try { bumpTemplateLabels(noMaxTested, '2.1.168'); } catch { threw = true; }
  check('throws when a label field is missing', threw);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

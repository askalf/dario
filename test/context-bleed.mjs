/**
 * dario#872 — instruction-file prose must not survive into a bake.
 *
 * The scrub already strips CC's host-context sections and flags any that
 * survive, but both halves of that are keyed on the `# claudeMd` heading shape.
 * Rename or reshape the heading and `removeSection` strips nothing while the
 * heading detector flags nothing — and once paths are scrubbed the leftover
 * prose carries no user path for the other detectors to see. These cases pin
 * the content-keyed half, which does not depend on the heading.
 *
 * The negative cases matter as much as the positives. A marker that appears in
 * CC's genuine prompt would fail every bake, so `CLAUDE.md` and
 * `system-reminder` are deliberately NOT markers: CC's own system prompt and
 * tool descriptions mention both.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUserPathHits } from '../dist/scrub-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundle = JSON.parse(
  readFileSync(join(__dirname, '..', 'src', 'cc-template-data.json'), 'utf-8'),
);

let pass = 0;
let fail = 0;

function header(name) {
  console.log(`\n${name}`);
}

function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

// A bleed sample in CC's real wrapper shape with paths ALREADY scrubbed — the
// case the path detectors are blind to by construction.
const WRAPPED = [
  'static prose that belongs in a prompt',
  '',
  '# claudeMd',
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions.',
  '',
  "Contents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):",
  '',
  'some private operator instruction',
  '',
].join('\n');

header('1. instruction-file prose is caught');
check('wrapper sentence flagged', findUserPathHits(WRAPPED).some((h) => h.includes('instruction-file wrapper')));
check(
  'Contents-of heading flagged',
  findUserPathHits(WRAPPED).some((h) => h.includes('instruction-file heading')),
);
check(
  'file annotation flagged',
  findUserPathHits("Contents of x (user's private global instructions for all projects):").some((h) =>
    h.includes('instruction-file annotation'),
  ),
);
check(
  'typographic apostrophe also flagged',
  findUserPathHits('(user’s private global instructions)').length > 0,
);
check(
  'OVERRIDE sentence flagged',
  findUserPathHits(
    'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them.',
  ).length > 0,
);
check(
  'memory annotation flagged',
  findUserPathHits("(user's auto-memory, persists across conversations)").length > 0,
);
check(
  'project-instruction wrapper flagged',
  findUserPathHits('Here are useful instructions from the repository:').length > 0,
);

header('2. the gap this closes — a heading CC renames');
// With the heading intact the old detector already fires. Renaming it disarms
// BOTH the strip and the heading detector; only the content markers survive.
const renamed = WRAPPED.replace('# claudeMd', '# projectInstructions');
check(
  'intact heading is caught by the heading detector',
  findUserPathHits(WRAPPED).some((h) => h.includes('host-context section not stripped')),
);
check(
  'renamed heading is NOT caught by the heading detector',
  !findUserPathHits(renamed).some((h) => h.includes('host-context section not stripped')),
);
check('renamed heading is still caught by the content markers', findUserPathHits(renamed).length > 0);

header('3. no false positives on the real baked template');
// If any of these fire, every bake fails. This is the case that disqualified
// `CLAUDE.md` and `system-reminder` as markers during design.
const slots = {
  agent_identity: bundle.agent_identity ?? '',
  system_prompt: bundle.system_prompt ?? '',
  tool_descriptions: (bundle.tools ?? []).map((t) => t.description ?? '').join('\n'),
  serialized: JSON.stringify(bundle),
};
for (const [key, value] of Object.entries(bundle.system_prompt_variants ?? {})) {
  slots[`variant:${key}`] = value;
}
for (const [name, text] of Object.entries(slots)) {
  const hits = findUserPathHits(text);
  check(`${name} is clean`, hits.length === 0);
  if (hits.length > 0) console.log(`       hits: ${JSON.stringify(hits.slice(0, 3))}`);
}

header('4. markers deliberately excluded');
check('bare CLAUDE.md mention is not bleed', findUserPathHits('see CLAUDE.md for details').length === 0);
check(
  'bare system-reminder mention is not bleed',
  findUserPathHits('wrapped in a <system-reminder> block').length === 0,
);
check(
  'the words "contents of" without a .md are not bleed',
  findUserPathHits('the contents of the response are streamed').length === 0,
);
check('ordinary prose is clean', findUserPathHits('be concise and direct\n# Tone\nbe nice').length === 0);

console.log(`\n# pass ${pass}`);
console.log(`# fail ${fail}`);
if (fail > 0) process.exit(1);

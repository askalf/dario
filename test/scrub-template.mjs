#!/usr/bin/env node
/**
 * Baked-template scrubber — dario#45.
 *
 * Captures routinely pick up host-specific paths (the capturing user's
 * home dir, CC's flattened path convention under ~/.claude/projects, the
 * user's own MCP tool set). Shipping any of that in the bundled template
 * leaks host identity on every new install's first request, which is
 * what v3.19.5 deferred rather than fix alongside the maxTested bump.
 *
 * scrubTemplate strips the `# auto memory` section (where CC inlines the
 * user's memory-dir path), replaces any residual user-dir paths with a
 * `user` placeholder, and drops `mcp__*` tools. findUserPathHits is the
 * detector used by check-cc-drift to guard against regression.
 *
 * Runs in-process. No proxy, no OAuth, no CC spawn.
 */

import { scrubTemplate, scrubText, findUserPathHits } from '../dist/scrub-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// ────────────────────────────────────────────────────────────────────
header('1. scrubText — Windows user paths');

check(
  'C:\\Users\\masterm1nd\\... → C:\\Users\\user\\...',
  scrubText('C:\\Users\\masterm1nd\\.claude\\projects\\foo') ===
    'C:\\Users\\user\\.claude\\projects\\foo',
);
check(
  'C:\\Users\\masterm1nd.DOCK\\... keeps trailing segments',
  scrubText('C:\\Users\\masterm1nd.DOCK\\.claude\\projects\\foo') ===
    'C:\\Users\\user\\.claude\\projects\\foo',
);
check(
  'C:\\Users\\user\\... left alone (idempotent)',
  scrubText('C:\\Users\\user\\project') === 'C:\\Users\\user\\project',
);

// ────────────────────────────────────────────────────────────────────
header('2. scrubText — POSIX user paths');

check(
  '/Users/masterm1nd/project → /Users/user/project',
  scrubText('/Users/masterm1nd/project') === '/Users/user/project',
);
check(
  '/home/alice/dario/log.txt → /home/user/dario/log.txt',
  scrubText('/home/alice/dario/log.txt') === '/home/user/dario/log.txt',
);
check(
  '/Users/user/project left alone (idempotent)',
  scrubText('/Users/user/project') === '/Users/user/project',
);

// ────────────────────────────────────────────────────────────────────
header('3. scrubText — CC flattened-path convention');

check(
  'C--Users-masterm1nd-DOCK-Desktop-recover-dario → C--Users-user-project',
  scrubText('C--Users-masterm1nd-DOCK-Desktop-recover-dario') ===
    'C--Users-user-project',
);
check(
  'flattened path inside a trailing string stops at backslash',
  scrubText('path C--Users-foo-bar-baz\\memory\\') === 'path C--Users-user-project\\memory\\',
);
check(
  'C--Users-user-project left alone (idempotent)',
  scrubText('C--Users-user-project') === 'C--Users-user-project',
);

// ────────────────────────────────────────────────────────────────────
header('4. scrubText — non-matches left alone');

check(
  'prose mentioning /Users in docs does not over-match',
  scrubText('(see /Users section)') === '(see /user section)' ||
    scrubText('(see /Users section)') === '(see /Users section)',
);
check(
  'arbitrary path /var/log/cc.log unchanged',
  scrubText('/var/log/cc.log') === '/var/log/cc.log',
);
check(
  'empty string',
  scrubText('') === '',
);

// ────────────────────────────────────────────────────────────────────
header('5. scrubTemplate — removes # auto memory section');

const sampleSystemPrompt = [
  'Header intro line.',
  '',
  '# section one',
  '',
  'Section one body.',
  '',
  '# auto memory',
  '',
  'You have a persistent, file-based memory system at `C:\\Users\\masterm1nd.DOCK\\.claude\\projects\\C--Users-masterm1nd-DOCK-Desktop-recover-dario\\memory\\`.',
  '',
  'Build it up over time.',
  '',
  '# Environment',
  'You have been invoked in the following environment:',
  ' - Primary working directory: C:\\Users\\masterm1nd\\project',
  ' - Git user: askalf',
  ' - Status: ?? foo.ts',
  '',
  '# userEmail',
  'The user\'s email address is foo@example.com.',
  '',
  '# currentDate',
  'Today\'s date is 2026-04-17.',
  '',
  '# section three',
  '',
  'Section three body.',
].join('\n');

const sampleTemplate = {
  _version: '2.1.112',
  _captured: '2026-04-17T00:00:00Z',
  _source: 'live',
  _schemaVersion: 2,
  agent_identity: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
  system_prompt: sampleSystemPrompt,
  tools: [
    { name: 'Bash', description: 'Run a command at /Users/masterm1nd/project', input_schema: { type: 'object' } },
    { name: 'mcp__askalf__search', description: 'User MCP tool — should be dropped', input_schema: { type: 'object' } },
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Defaults to /home/alice/x' } } } },
    { name: 'mcp__gmail__send', description: 'Another MCP tool', input_schema: { type: 'object' } },
  ],
  tool_names: ['Bash', 'mcp__askalf__search', 'Read', 'mcp__gmail__send'],
  header_order: ['accept', 'anthropic-version', 'user-agent'],
  header_values: { 'user-agent': 'claude-cli/2.1.112' },
  anthropic_beta: 'claude-code-20250219',
};

const scrubbed = scrubTemplate(sampleTemplate);

check('system_prompt no longer contains "# auto memory"', !scrubbed.system_prompt.includes('# auto memory'));
check('system_prompt no longer contains "# Environment"', !scrubbed.system_prompt.includes('# Environment'));
check('system_prompt no longer contains "# userEmail"', !scrubbed.system_prompt.includes('# userEmail'));
check('system_prompt no longer contains "# currentDate"', !scrubbed.system_prompt.includes('# currentDate'));
check('system_prompt no longer contains "Git user: askalf"', !scrubbed.system_prompt.includes('Git user: askalf'));
check('system_prompt no longer contains capturing user email', !scrubbed.system_prompt.includes('foo@example.com'));
check('system_prompt still contains "# section one"', scrubbed.system_prompt.includes('# section one'));
check('system_prompt still contains "# section three"', scrubbed.system_prompt.includes('# section three'));
check('system_prompt no longer contains "masterm1nd"', !scrubbed.system_prompt.includes('masterm1nd'));

// ────────────────────────────────────────────────────────────────────
header('6. scrubTemplate — drops mcp__* tools');

check('tools count: 4 → 2 (two mcp__ dropped)', scrubbed.tools.length === 2);
check('tools[0].name === Bash', scrubbed.tools[0].name === 'Bash');
check('tools[1].name === Read', scrubbed.tools[1].name === 'Read');
check('no tool name starts with mcp__', scrubbed.tools.every((t) => !t.name.startsWith('mcp__')));
check('tool_names mirrors filtered tools', JSON.stringify(scrubbed.tool_names) === JSON.stringify(['Bash', 'Read']));

// ────────────────────────────────────────────────────────────────────
header('7. scrubTemplate — scrubs tool description + input_schema strings');

check(
  'tools[0].description path scrubbed',
  scrubbed.tools[0].description === 'Run a command at /Users/user/project',
);
check(
  'tools[1].input_schema.properties.path.description scrubbed',
  scrubbed.tools[1].input_schema.properties.path.description === 'Defaults to /home/user/x',
);
check(
  'tools[1].input_schema shape preserved (nested properties unchanged)',
  scrubbed.tools[1].input_schema.type === 'object' &&
    scrubbed.tools[1].input_schema.properties.path.type === 'string',
);

// ────────────────────────────────────────────────────────────────────
header('8. scrubTemplate — fingerprint-sensitive fields preserved');

check('_version unchanged', scrubbed._version === '2.1.112');
check('_captured unchanged', scrubbed._captured === '2026-04-17T00:00:00Z');
check('_schemaVersion unchanged', scrubbed._schemaVersion === 2);
check(
  'header_order unchanged',
  JSON.stringify(scrubbed.header_order) === JSON.stringify(['accept', 'anthropic-version', 'user-agent']),
);
check(
  'header_values unchanged',
  scrubbed.header_values['user-agent'] === 'claude-cli/2.1.112',
);
check('anthropic_beta unchanged', scrubbed.anthropic_beta === 'claude-code-20250219');

// ────────────────────────────────────────────────────────────────────
header('9. scrubTemplate — input not mutated');

check('input system_prompt still contains "# auto memory"', sampleTemplate.system_prompt.includes('# auto memory'));
check('input tools still has 4 entries', sampleTemplate.tools.length === 4);
check('input tools[1].name === mcp__askalf__search', sampleTemplate.tools[1].name === 'mcp__askalf__search');

// ────────────────────────────────────────────────────────────────────
header('10. scrubTemplate — idempotent');

const scrubbedTwice = scrubTemplate(scrubbed);
check('scrub(scrub(x)) === scrub(x) — system_prompt', scrubbedTwice.system_prompt === scrubbed.system_prompt);
check('scrub(scrub(x)) === scrub(x) — tools count', scrubbedTwice.tools.length === scrubbed.tools.length);
check('scrub(scrub(x)) === scrub(x) — tool names', JSON.stringify(scrubbedTwice.tool_names) === JSON.stringify(scrubbed.tool_names));
check('scrub(scrub(x)) deep equal', JSON.stringify(scrubbedTwice) === JSON.stringify(scrubbed));

// ────────────────────────────────────────────────────────────────────
header('11. findUserPathHits — detector');

check('finds Windows path', findUserPathHits('C:\\Users\\masterm1nd\\x').length > 0);
check('finds POSIX path', findUserPathHits('/Users/alice/x').length > 0);
check('finds /home/ path', findUserPathHits('/home/bob/x').length > 0);
check('finds flattened CC path', findUserPathHits('C--Users-foo-bar-baz').length > 0);
check('does not flag scrubbed output', findUserPathHits(scrubbed.system_prompt).length === 0);
check(
  'does not flag C:\\Users\\user\\... or /Users/user/... (placeholders accepted)',
  findUserPathHits('C:\\Users\\user\\x /Users/user/y /home/user/z C--Users-user-project').length === 0,
);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// Unit tests for the drift-report helpers in scripts/drift-report.mjs.
// Lives in the test:serial set because it imports from .mjs (the parallel
// test runner spawns each file via node:test which is fine for imports
// too, but the existing pattern groups script-imports in serial).

import { unifiedDiff, computeDrift, describeTool, formatDriftReport, interpretDrift, formatDriftSummary } from '../scripts/drift-report.mjs';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}

function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ──────────────────────────────────────────────────────────────────────
header('1. unifiedDiff — identical inputs return empty');
{
  check('identical strings → []', unifiedDiff('foo\nbar', 'foo\nbar').length === 0);
  check('both empty → []', unifiedDiff('', '').length === 0);
}

// ──────────────────────────────────────────────────────────────────────
header('2. unifiedDiff — single-line change');
{
  const a = 'line one\nline two\nline three';
  const b = 'line one\nline two CHANGED\nline three';
  const diff = unifiedDiff(a, b);
  check('contains the removed line', diff.some((l) => l === '-line two'));
  check('contains the added line', diff.some((l) => l === '+line two CHANGED'));
  check('contains context (unchanged neighbors)', diff.some((l) => l === ' line one') && diff.some((l) => l === ' line three'));
}

// ──────────────────────────────────────────────────────────────────────
header('3. unifiedDiff — line insertion');
{
  const a = 'a\nb\nc';
  const b = 'a\nb\nNEW\nc';
  const diff = unifiedDiff(a, b);
  check('shows the inserted line as +', diff.some((l) => l === '+NEW'));
  check('no false deletes', !diff.some((l) => l.startsWith('-')));
}

// ──────────────────────────────────────────────────────────────────────
header('4. unifiedDiff — line deletion');
{
  const a = 'a\nb\nGONE\nc';
  const b = 'a\nb\nc';
  const diff = unifiedDiff(a, b);
  check('shows the deleted line as -', diff.some((l) => l === '-GONE'));
  check('no false adds', !diff.some((l) => l.startsWith('+')));
}

// ──────────────────────────────────────────────────────────────────────
header('5. unifiedDiff — maxLines cap');
{
  // 200 changed lines vs maxLines=10
  const a = Array.from({ length: 200 }, (_, i) => `prev-${i}`).join('\n');
  const b = Array.from({ length: 200 }, (_, i) => `now-${i}`).join('\n');
  const diff = unifiedDiff(a, b, { maxLines: 10, contextLines: 0 });
  check('output is bounded at maxLines (+ optional truncation marker)', diff.length <= 11);
  check('truncation marker mentions "more"', diff.some((l) => /more/.test(l)));
}

// ──────────────────────────────────────────────────────────────────────
header('6. unifiedDiff — empty input on one side');
{
  const a = '';
  const b = 'just one line';
  const diff = unifiedDiff(a, b);
  check('non-empty side shows as +', diff.some((l) => l === '+just one line'));
}

// ──────────────────────────────────────────────────────────────────────
header('7. unifiedDiff — preserves order of multiple hunks');
{
  const a = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
  const b = 'a\nb\nc\nX\ne\nf\ng\nh\nY\nj';   // d→X, i→Y; far enough apart for separate hunks
  const diff = unifiedDiff(a, b, { contextLines: 1 });
  // hunks are separated by " … " markers when there are unchanged lines
  // between them that aren't in context
  check('first hunk delete appears before second hunk delete', diff.indexOf('-d') < diff.indexOf('-i'));
  check('first hunk add appears before second hunk add', diff.indexOf('+X') < diff.indexOf('+Y'));
}

// ──────────────────────────────────────────────────────────────────────
header('8. describeTool — name + description + input keys');
{
  const tool = {
    name: 'SearchTool',
    description: 'Search the web for the given query.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
  };
  const lines = describeTool(tool);
  check('first line includes name + description prefix', lines[0].startsWith('SearchTool: Search the web'));
  check('input keys line lists property names', lines.some((l) => /input keys:.*query/.test(l) && /limit/.test(l)));
}

header('9. describeTool — missing description / schema graceful');
{
  const tool = { name: 'Bare' };
  const lines = describeTool(tool);
  check('returns at least one line', lines.length >= 1);
  check('first line is just the name when no description', lines[0] === 'Bare');
}

header('10. describeTool — null tool returns empty array');
{
  check('null → []', describeTool(null).length === 0);
  check('undefined → []', describeTool(undefined).length === 0);
}

// ──────────────────────────────────────────────────────────────────────
function makeTemplate(overrides = {}) {
  return {
    _version: '2.1.143',
    _captured: '2026-05-17T00:00:00Z',
    agent_identity: 'You are Claude Code.',
    system_prompt: 'You are an assistant.\nFollow instructions.',
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
    ],
    anthropic_beta: 'claude-code-20250219',
    body_field_order: ['model', 'system', 'messages'],
    header_order: ['accept', 'anthropic-version'],
    ...overrides,
  };
}

header('11. computeDrift — no differences → empty');
{
  const t = makeTemplate();
  check('identical templates → no drift', computeDrift(t, t).length === 0);
}

header('12. computeDrift — tools added carries detail');
{
  const prev = makeTemplate();
  const now = makeTemplate({
    tools: [
      ...prev.tools,
      { name: 'NewTool', description: 'A newly added tool', input_schema: { type: 'object', properties: { foo: { type: 'string' } } } },
    ],
  });
  const d = computeDrift(prev, now);
  check('one entry produced', d.length === 1);
  check('summary names the added tool', /tools added.*NewTool/.test(d[0].summary));
  check('detail describes the tool', d[0].detail?.some((l) => /NewTool:.*newly added/.test(l)));
  check('detail lists schema keys', d[0].detail?.some((l) => /input keys:.*foo/.test(l)));
}

header('13. computeDrift — tools removed carries detail');
{
  const prev = makeTemplate();
  const now = makeTemplate({ tools: prev.tools.filter((t) => t.name !== 'Bash') });
  const d = computeDrift(prev, now);
  check('summary names removed tool', /tools removed.*Bash/.test(d[0].summary));
  check('detail describes the removed tool', d[0].detail?.some((l) => /Bash:.*shell command/.test(l)));
}

header('14. computeDrift — system_prompt change carries unified diff');
{
  const prev = makeTemplate({ system_prompt: 'line one\nline two\nline three' });
  const now = makeTemplate({ system_prompt: 'line one\nline TWO\nline three' });
  const d = computeDrift(prev, now);
  check('one entry produced', d.length === 1);
  check('summary mentions char delta', /system_prompt content changed/.test(d[0].summary));
  check('detail contains the - line', d[0].detail?.some((l) => l === '-line two'));
  check('detail contains the + line', d[0].detail?.some((l) => l === '+line TWO'));
}

header('15. computeDrift — anthropic_beta added/removed are separate entries');
{
  const prev = makeTemplate({ anthropic_beta: 'a,b' });
  const now = makeTemplate({ anthropic_beta: 'b,c' });
  const d = computeDrift(prev, now);
  const summaries = d.map((e) => e.summary);
  check('beta added entry present', summaries.some((s) => /anthropic_beta added: c/.test(s)));
  check('beta removed entry present', summaries.some((s) => /anthropic_beta removed: a/.test(s)));
}

header('16. computeDrift — body_field_order detail shows before/after JSON');
{
  const prev = makeTemplate();
  const now = makeTemplate({ body_field_order: ['model', 'messages', 'system'] });
  const d = computeDrift(prev, now);
  check('one entry produced', d.length === 1);
  check('summary names the slot', d[0].summary === 'body_field_order changed');
  check('detail shows - and + lines with JSON arrays', d[0].detail?.length === 2 && d[0].detail[0].startsWith('-') && d[0].detail[1].startsWith('+'));
}

header('17. computeDrift — agent_identity change carries diff');
{
  const prev = makeTemplate({ agent_identity: 'You are Claude.' });
  const now = makeTemplate({ agent_identity: 'You are Claude Code.' });
  const d = computeDrift(prev, now);
  check('summary names the slot', /agent_identity content changed/.test(d[0].summary));
  check('detail produced (unified diff)', Array.isArray(d[0].detail) && d[0].detail.length > 0);
}

header('18. computeDrift — multi-axis drift returns multiple entries');
{
  const prev = makeTemplate();
  const now = makeTemplate({
    system_prompt: 'changed',
    anthropic_beta: 'claude-code-20250219,new-beta-2026-01-01',
    tools: [...prev.tools, { name: 'X', description: 'x', input_schema: { type: 'object' } }],
  });
  const d = computeDrift(prev, now);
  check('three entries produced (tools added + beta added + system_prompt changed)', d.length === 3);
}

// ──────────────────────────────────────────────────────────────────────
header('19. formatDriftReport — bullets summaries, indents details');
{
  const diff = [
    { summary: 'A changed', detail: ['-old', '+new'] },
    { summary: 'B changed' },
  ];
  const lines = formatDriftReport(diff);
  check('summary A appears as a bullet', lines.some((l) => l === '  • A changed'));
  check('detail lines indented under A', lines.some((l) => l === '      -old') && lines.some((l) => l === '      +new'));
  check('summary B has no detail lines', lines.includes('  • B changed') && lines.filter((l) => /^      /.test(l)).length === 2);
}

// ──────────────────────────────────────────────────────────────────────
// v4.7.0 — verdict + structured-summary helpers
header('20. interpretDrift — empty diff → benign verdict, zero counts');
{
  const r = interpretDrift([]);
  check('verdict = benign', r.verdict === 'benign');
  check('no tools added', r.toolsAdded.length === 0);
  check('no tools removed', r.toolsRemoved.length === 0);
  check('systemPromptDelta = 0', r.systemPromptDelta === 0);
}

header('21. interpretDrift — only system_prompt change → benign');
{
  const r = interpretDrift([{ summary: 'system_prompt content changed (12000 → 12150 chars, delta +150)' }]);
  check('verdict = benign', r.verdict === 'benign');
  check('systemPromptDelta captured +150', r.systemPromptDelta === 150);
}

header('22. interpretDrift — tool added → moderate verdict');
{
  const r = interpretDrift([{ summary: 'tools added: NewTool' }]);
  check('verdict = moderate', r.verdict === 'moderate');
  check('toolsAdded includes NewTool', r.toolsAdded.includes('NewTool'));
}

header('23. interpretDrift — tool removed → substantive verdict');
{
  const r = interpretDrift([{ summary: 'tools removed: OldTool' }]);
  check('verdict = substantive', r.verdict === 'substantive');
  check('toolsRemoved includes OldTool', r.toolsRemoved.includes('OldTool'));
}

header('24. interpretDrift — body_field_order change → substantive');
{
  const r = interpretDrift([{ summary: 'body_field_order changed' }]);
  check('verdict = substantive', r.verdict === 'substantive');
  check('bodyFieldOrderChanged = true', r.bodyFieldOrderChanged === true);
}

header('25. interpretDrift — beta change without tool change → moderate');
{
  const r = interpretDrift([
    { summary: 'anthropic_beta added: new-feature-2026-01-01' },
    { summary: 'anthropic_beta removed: old-beta-2025-12-31' },
  ]);
  check('verdict = moderate', r.verdict === 'moderate');
  check('betasAdded captured', r.betasAdded.includes('new-feature-2026-01-01'));
  check('betasRemoved captured', r.betasRemoved.includes('old-beta-2025-12-31'));
}

header('26. interpretDrift — substantive dominates moderate');
{
  // tool added AND tool removed → substantive (the removed one wins)
  const r = interpretDrift([
    { summary: 'tools added: NewTool' },
    { summary: 'tools removed: OldTool' },
  ]);
  check('verdict = substantive (tools removed wins)', r.verdict === 'substantive');
}

header('27. interpretDrift — agent_identity change → moderate');
{
  const r = interpretDrift([{ summary: 'agent_identity content changed (20 → 25 chars)' }]);
  check('verdict = moderate', r.verdict === 'moderate');
  check('agentIdentityChanged = true', r.agentIdentityChanged === true);
}

header('28. interpretDrift — multiple tools added, comma-split correctly');
{
  const r = interpretDrift([{ summary: 'tools added: ToolA, ToolB, ToolC' }]);
  check('all three tools captured', r.toolsAdded.length === 3 && r.toolsAdded.includes('ToolA') && r.toolsAdded.includes('ToolB') && r.toolsAdded.includes('ToolC'));
}

// ──────────────────────────────────────────────────────────────────────
header('29. formatDriftSummary — benign verdict with system_prompt only');
{
  const interp = { verdict: 'benign', toolsAdded: [], toolsRemoved: [], betasAdded: [], betasRemoved: [], systemPromptDelta: 50, agentIdentityChanged: false, bodyFieldOrderChanged: false, headerOrderChanged: false };
  const lines = formatDriftSummary(interp);
  check('verdict line has ✅ emoji + Benign label', lines[0].includes('✅') && /Benign/.test(lines[0]));
  check('system_prompt line shows +50 chars', lines.some((l) => /system_prompt.*\+50 chars/.test(l)));
  check('no tool bullets', !lines.some((l) => /Tools added/.test(l)));
}

header('30. formatDriftSummary — substantive verdict surfaces removed tools');
{
  const interp = { verdict: 'substantive', toolsAdded: [], toolsRemoved: ['DroppedTool'], betasAdded: [], betasRemoved: [], systemPromptDelta: 0, agentIdentityChanged: false, bodyFieldOrderChanged: false, headerOrderChanged: false };
  const lines = formatDriftSummary(interp);
  check('verdict line has 🔴 emoji + Substantive label', lines[0].includes('🔴') && /Substantive/.test(lines[0]));
  check('tools removed line shows DroppedTool with warn marker', lines.some((l) => /Tools removed.*DroppedTool.*⚠/.test(l)));
}

header('31. formatDriftSummary — moderate verdict with tool add + beta change');
{
  const interp = { verdict: 'moderate', toolsAdded: ['NewTool'], toolsRemoved: [], betasAdded: ['new-beta'], betasRemoved: [], systemPromptDelta: 0, agentIdentityChanged: false, bodyFieldOrderChanged: false, headerOrderChanged: false };
  const lines = formatDriftSummary(interp);
  check('verdict line has 🟡 emoji + Moderate label', lines[0].includes('🟡') && /Moderate/.test(lines[0]));
  check('tools added bullet present', lines.some((l) => /Tools added.*NewTool/.test(l)));
  check('beta added bullet present', lines.some((l) => /anthropic_beta added.*new-beta/.test(l)));
}

// ──────────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

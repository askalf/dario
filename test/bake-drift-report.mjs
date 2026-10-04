// Unit tests for the drift-report helpers in scripts/drift-report.mjs.
// Lives in the test:serial set because it imports from .mjs (the parallel
// test runner spawns each file via node:test which is fine for imports
// too, but the existing pattern groups script-imports in serial).

import { unifiedDiff, computeDrift, meaningfulTemplateKeys, TRANSIENT_TEMPLATE_FIELDS, describeTool, formatDriftReport, interpretDrift, formatDriftSummary, MODEL_CONDITIONAL_BETAS, REMOTE_CONFIG_CONDITIONAL_BETAS, normalizeMemoryPath, stripModelConditionalBetas, isOlderCCVersion, detectIssue881Residue, formatIssue881Warning, ISSUE_881_MARKER, ISSUE_881_BASELINE_LEN, ISSUE_881_ANOMALY_LEN } from '../scripts/drift-report.mjs';
import { describeBundleChange, formatRebakeSummary, formatRebakeChangelog, formatVariantOnlySummary, familyLabel, rebakePrAction } from '../scripts/drift-report.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  check('moderate verdict names what to verify, not just a severity', /requests rebuilt from the bundled template/.test(lines[0]) && !/worth a closer read/.test(lines[0]));
  check('moderate verdict separates label and guidance with a colon, no em dash', /Moderate: verify/.test(lines[0]) && !lines[0].includes('—'));
  check('tools added bullet present', lines.some((l) => /Tools added.*NewTool/.test(l)));
  check('beta added bullet present', lines.some((l) => /anthropic_beta added.*new-beta/.test(l)));
}

// ──────────────────────────────────────────────────────────────────────
// issue #484 — model-conditional betas (betaForModel) must not false-positive
header('32. computeDrift — context-1m appearing in capture is NOT drift');
{
  // base bundle omits context-1m (betaForModel appends it per [1m] request);
  // a capture that carries it must not be flagged.
  const prev = makeTemplate({ anthropic_beta: 'claude-code-20250219,afk-mode-2026-01-31' });
  const now = makeTemplate({ anthropic_beta: 'claude-code-20250219,afk-mode-2026-01-31,context-1m-2025-08-07' });
  const d = computeDrift(prev, now);
  check('no drift entry for the managed beta', d.length === 0);
}

header('33. computeDrift — fallback-credit appearing in capture is NOT drift');
{
  const prev = makeTemplate({ anthropic_beta: 'claude-code-20250219' });
  const now = makeTemplate({ anthropic_beta: 'claude-code-20250219,fallback-credit-2026-06-01' });
  check('managed beta suppressed', computeDrift(prev, now).length === 0);
  check('both managed betas are in the exported set', MODEL_CONDITIONAL_BETAS.has('context-1m-2025-08-07') && MODEL_CONDITIONAL_BETAS.has('fallback-credit-2026-06-01'));
}

header('34. computeDrift — a REAL base beta change still surfaces alongside managed ones');
{
  // Was written with afk-mode as the "real" beta. afk-mode is now remote-config
  // suppressed (case 22), so it can no longer play that role — a genuine base
  // beta stands in and the case tests what it was built to test.
  const prev = makeTemplate({ anthropic_beta: 'claude-code-20250219,advisor-tool-2026-03-01' });
  const now = makeTemplate({ anthropic_beta: 'claude-code-20250219,context-1m-2025-08-07' });
  const d = computeDrift(prev, now);
  const summaries = d.map((e) => e.summary);
  check('real beta removal still flagged', summaries.some((s) => /anthropic_beta removed: advisor-tool-2026-03-01/.test(s)));
  check('context-1m add NOT flagged', !summaries.some((s) => /context-1m/.test(s)));
}

// ──────────────────────────────────────────────────────────────────────
// issue #484 — cross-OS memory path is an env artifact, not system_prompt drift
header('35. normalizeMemoryPath — collapses Windows and Linux memory paths alike');
{
  const win = 'memory at `C:\\Users\\user\\.claude\\projects\\C--Users-user-project\\memory\\` here';
  const lin = 'memory at `/root/.claude/projects/project/memory/` here';
  check('windows path collapsed', normalizeMemoryPath(win) === 'memory at `<MEMORY_DIR>` here');
  check('linux path collapsed', normalizeMemoryPath(lin) === 'memory at `<MEMORY_DIR>` here');
  check('both normalize identically', normalizeMemoryPath(win) === normalizeMemoryPath(lin));
}

header('36. computeDrift — system_prompt differing only by memory path → no drift');
{
  const prev = makeTemplate({ system_prompt: 'Intro.\nmemory at `C:\\Users\\user\\.claude\\projects\\C--Users-user-project\\memory\\`.\nOutro.' });
  const now = makeTemplate({ system_prompt: 'Intro.\nmemory at `/root/.claude/projects/project/memory/`.\nOutro.' });
  check('path-only difference is not drift', computeDrift(prev, now).length === 0);
}

header('37. computeDrift — real prompt edit still flagged despite path normalization');
{
  const prev = makeTemplate({ system_prompt: 'Intro.\nmemory at `C:\\Users\\user\\.claude\\projects\\C--Users-user-project\\memory\\`.\nKeep this line.' });
  const now = makeTemplate({ system_prompt: 'Intro.\nmemory at `/root/.claude/projects/project/memory/`.\nThis line CHANGED.' });
  const d = computeDrift(prev, now);
  check('one entry produced', d.length === 1);
  check('summary is system_prompt', /system_prompt content changed/.test(d[0].summary));
  check('diff shows the real edit, not the path', d[0].detail?.some((l) => /CHANGED/.test(l)) && !d[0].detail?.some((l) => /\.claude/.test(l)));
}

// ──────────────────────────────────────────────────────────────────────
// issue #484 — the BAKE must strip model-conditional betas so a rebake can't
// re-introduce them to the base (undoing #475). Mirrors the detection filter.
header('38. stripModelConditionalBetas — removes context-1m / fallback-credit, keeps the rest');
{
  const captured = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24';
  const baked = stripModelConditionalBetas(captured);
  check('context-1m removed', !baked.includes('context-1m-2025-08-07'));
  check('base betas preserved in order', baked === 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24');
  check('fallback-credit removed too', stripModelConditionalBetas('claude-code-20250219,fallback-credit-2026-06-01') === 'claude-code-20250219');
  // Used afk-mode as its example of a beta the strip leaves alone. It is now
  // stripped too (remote-config class), so the no-op case needs a beta that
  // really is untouched. afk-mode's removal is asserted in case 22.
  check('no-op when no managed betas present', stripModelConditionalBetas('claude-code-20250219,advisor-tool-2026-03-01') === 'claude-code-20250219,advisor-tool-2026-03-01');
  check('remote-config beta IS stripped', stripModelConditionalBetas('claude-code-20250219,afk-mode-2026-01-31') === 'claude-code-20250219');
  check('empty / undefined safe', stripModelConditionalBetas('') === '' && stripModelConditionalBetas(undefined) === '');
}

header('39. bake-vs-check consistency — a re-baked base no longer drifts from the capture on managed betas');
{
  // Simulate: live capture carries context-1m (rode a [1m] request); the bake
  // strips it; computeDrift(baked-base, same-capture) must NOT re-flag it.
  const capture = makeTemplate({ anthropic_beta: 'claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24' });
  const baked = makeTemplate({ anthropic_beta: stripModelConditionalBetas(capture.anthropic_beta) });
  check('baked base omits context-1m', !baked.anthropic_beta.includes('context-1m'));
  check('no beta drift between baked base and the capture it came from', computeDrift(baked, capture).length === 0);
}

// ──────────────────────────────────────────────────────────────────────
header('isOlderCCVersion — stale-binary guard (PR #632 regression)');
{
  // The PR #632 shape: runner binary one patch behind the bundle's capture.
  check('2.1.197 is older than 2.1.198', isOlderCCVersion('2.1.197', '2.1.198') === true);
  check('equal versions are not older', isOlderCCVersion('2.1.198', '2.1.198') === false);
  check('newer patch is not older (legit forward rebake)', isOlderCCVersion('2.1.199', '2.1.198') === false);
  check('newer minor is not older', isOlderCCVersion('2.2.0', '2.1.198') === false);
  check('older minor is older despite bigger patch', isOlderCCVersion('2.1.198', '2.2.0') === true);
  check('major beats all segments', isOlderCCVersion('3.0.0', '2.9.9') === false);
  check('leading v tolerated', isOlderCCVersion('v2.1.197', '2.1.198') === true);
  check('shorter live version pads with zeros (2.1 < 2.1.1)', isOlderCCVersion('2.1', '2.1.1') === true);
  check('shorter bundled version pads with zeros (2.1.0 == 2.1)', isOlderCCVersion('2.1.0', '2.1') === false);
  // Fail-open cases: the guard must never block on unparseable versions.
  check('missing live version fails open', isOlderCCVersion(undefined, '2.1.198') === false);
  check('missing bundled version fails open', isOlderCCVersion('2.1.198', undefined) === false);
  check('non-numeric live version fails open', isOlderCCVersion('unknown', '2.1.198') === false);
  check('prerelease-style suffix fails open', isOlderCCVersion('2.1.197-beta.1', '2.1.198') === false);
  check('non-string fails open', isOlderCCVersion(2, '2.1.198') === false);
}


// ────────────────────────────────────────────────────────────────────
// Remote-config betas: CC toggles these on Anthropic's schedule, not with its
// version. afk-mode moved four times in twelve hours on 2026-07-26 (off at the
// #869 rebake, on for 8/8 captures and baked into 5.4.13, off again in #878),
// and each flip opened a rebake PR, bumped a version and cut a full release.
// Excluded from BOTH the baked base and the comparison, so neither state drifts.
header('22. remote-config betas do not drift in either direction');
{
  check('afk-mode is in the remote-config set', REMOTE_CONFIG_CONDITIONAL_BETAS.has('afk-mode-2026-01-31'));
  check('and NOT in the model-conditional set (different reason)', !MODEL_CONDITIONAL_BETAS.has('afk-mode-2026-01-31'));

  const withAfk = makeTemplate({ anthropic_beta: 'claude-code-20250219,effort-2025-11-24,afk-mode-2026-01-31' });
  const withoutAfk = makeTemplate({ anthropic_beta: 'claude-code-20250219,effort-2025-11-24' });

  const gone = computeDrift(withAfk, withoutAfk).map((e) => e.summary ?? e);
  const back = computeDrift(withoutAfk, withAfk).map((e) => e.summary ?? e);
  check('present -> absent reports no drift', gone.length === 0);
  check('absent -> present reports no drift (symmetric)', back.length === 0);

  // The suppression must not blind the detector to a real base-beta change.
  const genuine = makeTemplate({ anthropic_beta: 'claude-code-20250219,effort-2025-11-24,brand-new-2026-09-01' });
  const real = computeDrift(withoutAfk, genuine).map((e) => e.summary ?? e);
  check('a genuine new beta still surfaces', real.some((s) => /brand-new-2026-09-01/.test(s)));
  check('and it is reported as an addition', real.some((s) => /anthropic_beta added/.test(s)));

  // The bake side: whichever state the capture caught, the baked base is the same.
  check(
    'stripped base is identical whichever way the flag sits',
    stripModelConditionalBetas('claude-code-20250219,afk-mode-2026-01-31') ===
      stripModelConditionalBetas('claude-code-20250219'),
  );
  check(
    'and it drops the flag rather than keeping it',
    !stripModelConditionalBetas('claude-code-20250219,afk-mode-2026-01-31').includes('afk-mode'),
  );
}

// ──────────────────────────────────────────────────────────────────────
header('40. detectIssue881Residue — the #881 base-prompt tripwire');
{
  // Padding so the constructed prompts hit the exact #881 lengths without
  // needing the real 4759-char prompt inline.
  const pad = (n) => 'x'.repeat(n);
  const para = `\n\n# Context management\n${ISSUE_881_MARKER} Do not re-derive facts already established in the conversation.`;

  // --- marker clause -------------------------------------------------
  const bundleClean = `You are Claude Code.\n\n# Context management\nSome other paragraph.`;
  const captureWithPara = bundleClean + para;
  {
    const d = detectIssue881Residue(captureWithPara, bundleClean);
    check('marker in capture but not bundle → detected', d.detected === true);
    check('reported via the marker clause', d.reason === 'marker');
    check('carries both lengths for the annotation', d.capturedLen === captureWithPara.length && d.bundledLen === bundleClean.length);
  }

  // The heading alone must NOT trip it — the shipped 4759-char bundle already
  // contains `# Context management`, so a heading match would flag every run.
  check(
    'the bundle already having the heading is not enough to fire',
    detectIssue881Residue(bundleClean, bundleClean).detected === false,
  );

  // --- length clause -------------------------------------------------
  {
    const d = detectIssue881Residue(pad(ISSUE_881_ANOMALY_LEN), pad(ISSUE_881_BASELINE_LEN));
    check('5038 capture vs 4759 bundle → detected without the marker', d.detected === true);
    check('reported via the length clause', d.reason === 'length');
  }
  check(
    '5038 against some other bundle length does not fire',
    detectIssue881Residue(pad(ISSUE_881_ANOMALY_LEN), pad(4800)).detected === false,
  );
  check(
    '4759 against 4759 does not fire',
    detectIssue881Residue(pad(ISSUE_881_BASELINE_LEN), pad(ISSUE_881_BASELINE_LEN)).detected === false,
  );

  // --- specificity: genuine drift must flow through as normal drift ---
  // #881 cites the real 4754 -> 4759 CC prompt change as the case that must
  // NOT be flagged. Flagging every base-length change defeats the tripwire.
  check(
    'the genuine 4754 -> 4759 step is NOT flagged',
    detectIssue881Residue(pad(4759), pad(4754)).detected === false,
  );
  check(
    'an unrelated large prompt change is NOT flagged',
    detectIssue881Residue(pad(9000), pad(ISSUE_881_BASELINE_LEN)).detected === false,
  );

  // --- self-disarm ---------------------------------------------------
  // If the paragraph is ever legitimately baked in, the bundle gains the
  // marker and both clauses go false with no code change.
  check(
    'once the paragraph is baked into the bundle the tripwire disarms',
    detectIssue881Residue(captureWithPara, captureWithPara).detected === false,
  );

  // --- defensive -----------------------------------------------------
  check('undefined inputs do not throw', detectIssue881Residue(undefined, undefined).detected === false);
  check('non-string inputs do not throw', detectIssue881Residue(null, 42).detected === false);
}

// ──────────────────────────────────────────────────────────────────────
header('41. formatIssue881Warning — the Actions annotation');
{
  const d = detectIssue881Residue(
    'prompt\n' + ISSUE_881_MARKER,
    'prompt',
  );
  const lines = formatIssue881Warning(d);
  check('first line is a GitHub Actions warning command', lines[0].startsWith('::warning '));
  // A `[bake] ` prefix (or anything else before `::`) stops Actions parsing
  // the line as a workflow command — the annotation is the whole point.
  check('nothing precedes the :: on line 1', lines[0].indexOf('::') === 0);
  check('the annotation names the issue', lines[0].includes('881'));
  check('and points at the issue URL', lines[0].includes('github.com/askalf/dario/issues/881'));
  check('reports the captured length', lines[0].includes(String(d.capturedLen)));
  check('body explains it is residue, not a genuine change', lines.join('\n').includes('NOT a genuine CC prompt change'));
  check('body tells the reader to re-run', lines.join('\n').includes('Re-run the'));

  const byLength = formatIssue881Warning(detectIssue881Residue('y'.repeat(ISSUE_881_ANOMALY_LEN), 'y'.repeat(ISSUE_881_BASELINE_LEN)));
  check('the length clause renders its own explanation', byLength[0].includes(`exactly ${ISSUE_881_ANOMALY_LEN} chars`));
}

// ──────────────────────────────────────────────────────────────────────
header('42. meaningfulTemplateKeys — the content-empty rebake gate (dario#990)');
{
  // The exact shape of PR #990: every content key identical to the previous
  // release, only the provenance stamp moved. This must read as "ships
  // nothing" or the workflow cuts a release for drift that did not happen.
  const v5517 = {
    _captured: '2026-08-15T04:59:39.819Z',
    _version: '2.1.233',
    _source: 'bundled',
    _schemaVersion: 1,
    agent_identity: 'You are Claude Code',
    system_prompt: 'base prompt',
    tools: [{ name: 'Bash', description: 'run a command' }],
    tool_names: ['Bash'],
    header_order: ['a', 'b'],
    anthropic_beta: 'oauth-2025-04-20',
    header_values: { 'user-agent': 'claude-cli/2.1.233' },
    body_field_order: ['model', 'messages'],
    _supportedMaxTested: '2.1.233',
    system_prompt_variants: { fable: 'v' },
  };
  const v5518 = { ...v5517, _captured: '2026-08-16T23:50:32.289Z' };

  check('only _captured moved → no meaningful keys', meaningfulTemplateKeys(v5517, v5518).length === 0);
  check('identical objects → no meaningful keys', meaningfulTemplateKeys(v5517, v5517).length === 0);
  check('_captured is the transient set', TRANSIENT_TEMPLATE_FIELDS.has('_captured'));

  // A real prompt edit still surfaces — the gate must not swallow genuine drift.
  check(
    'system_prompt change is reported',
    meaningfulTemplateKeys(v5517, { ...v5518, system_prompt: 'base prompt EDITED' }).join() === 'system_prompt',
  );
  check(
    'tools change is reported',
    meaningfulTemplateKeys(v5517, { ...v5518, tools: [] }).join() === 'tools',
  );
  check(
    'anthropic_beta change is reported',
    meaningfulTemplateKeys(v5517, { ...v5518, anthropic_beta: 'oauth-2025-04-20,afk-mode-2026-01-31' }).join() === 'anthropic_beta',
  );
  check(
    'a nested variant change is reported',
    meaningfulTemplateKeys(v5517, { ...v5518, system_prompt_variants: { fable: 'CHANGED' } }).join() === 'system_prompt_variants',
  );

  // A label-only move is NOT transient — that IS the content of a label-sync
  // PR, so it must still open one.
  check(
    '_version move is reported (label-sync must still ship)',
    meaningfulTemplateKeys(v5517, { ...v5518, _version: '2.1.234' }).join() === '_version',
  );

  // Added / removed keys count as drift in both directions.
  const { anthropic_beta, ...missingBeta } = v5518;
  check('a removed key is reported', meaningfulTemplateKeys(v5517, missingBeta).join() === 'anthropic_beta');
  check('an added key is reported', meaningfulTemplateKeys(v5517, { ...v5518, brand_new: 1 }).join() === 'brand_new');

  // Multiple changes come back sorted and complete.
  const multi = meaningfulTemplateKeys(v5517, { ...v5518, tools: [], system_prompt: 'x' });
  check('multiple changes are all reported, sorted', multi.join() === 'system_prompt,tools');

  // Key order inside a nested object is not a content change.
  check(
    'nested key order is not drift',
    meaningfulTemplateKeys(
      { ...v5517, header_values: { a: '1', b: '2' } },
      { ...v5518, header_values: { a: '1', b: '2' } },
    ).length === 0,
  );
}

// ──────────────────────────────────────────────────────────────────────
header('43. describeBundleChange: a rebake described from its two bundles');
{
  // A bake that moves a prompt variant, two tool definitions, an SDK header value and
  // the version label, while --check names the variant alone.
  const tool = (name, description, props = {}) => ({ name, description, input_schema: { type: 'object', properties: props } });
  const before = {
    _version: '2.1.288', _captured: '2026-09-29T19:36:19.800Z',
    system_prompt: 'base prompt',
    system_prompt_variants: { fable: 'F'.repeat(9363), 'opus-5': 'O'.repeat(8450), 'sonnet-5': 'S'.repeat(13719) },
    tools: [tool('Bash', 'max 600000.', { timeout: { description: 'max 600000' } }), tool('WebSearch', 'reworded sentence'), tool('Read', 'reads')],
    anthropic_beta: 'a-1,b-2',
    header_order: ['user-agent', 'x-stainless-package-version'],
    header_values: { 'user-agent': 'claude-cli/2.1.288 (external, sdk-cli)', 'x-stainless-package-version': '0.112.1', 'x-stainless-os': 'Linux' },
    _variantShapeHashes: { 'sonnet-5': ['aa'] },
  };
  const after = {
    ...before,
    _version: '2.1.289', _captured: '2026-10-04T21:27:34.373Z',
    system_prompt_variants: { ...before.system_prompt_variants, 'sonnet-5': 's'.repeat(7804) },
    tools: [tool('Bash', 'max 600000 for a foreground command.', { timeout: { description: 'max 600000 for a foreground command' } }), tool('WebSearch', 'captured sentence'), tool('Read', 'reads')],
    header_values: { 'user-agent': 'claude-cli/2.1.289 (external, sdk-cli)', 'x-stainless-package-version': '0.128.0', 'x-stainless-os': 'Windows' },
    _variantShapeHashes: { 'sonnet-5': ['aa', 'bb'] },
  };
  const DASH = String.fromCharCode(0x2014);
  const ARROW = String.fromCharCode(0x2192);
  const c = describeBundleChange(before, after);
  check('names the one variant that moved, with both lengths', JSON.stringify(c.variants) === JSON.stringify([{ key: 'sonnet-5', before: 13719, after: 7804 }]));
  check('lists the variants that did not move', JSON.stringify(c.unchangedVariants) === JSON.stringify(['fable', 'opus-5']));
  check('finds tools whose text changed, and which part', JSON.stringify(c.toolsChanged) === JSON.stringify([{ name: 'Bash', description: true, schema: true }, { name: 'WebSearch', description: true, schema: false }]));
  check('an untouched tool is not listed', !c.toolsChanged.some((t) => t.name === 'Read') && c.toolsAdded.length === 0 && c.toolsRemoved.length === 0);
  check('finds header values that changed', c.headerValues.map((h) => h.name).join(',') === 'user-agent,x-stainless-package-version');
  check('a header value that describes the capturing host is not a change', !c.headerValues.some((h) => h.name === 'x-stainless-os'));
  check('the base prompt, betas and header order are unchanged', c.systemPrompt === null && c.betasAdded.length === 0 && c.betasRemoved.length === 0 && c.headerOrder === false);
  check('a field it does not break down is named, not dropped', JSON.stringify(c.otherKeys) === JSON.stringify(['_variantShapeHashes']));

  const summary = formatRebakeSummary(c);
  const text = summary.join('\n');
  check('summary: the variant with its two lengths', summary.includes('- **Sonnet 5 system prompt:** `system_prompt_variants.sonnet-5` goes from 13719 to 7804 characters.'), text);
  check('summary: each changed tool and what changed in it', summary.includes('- **`Bash` tool:** its description and input schema changed.') && summary.includes('- **`WebSearch` tool:** its description changed.'), text);
  check('summary: the SDK header value with both values', summary.includes('- **Header value `x-stainless-package-version`:** goes from `0.112.1` to `0.128.0`.'), text);
  check('summary: the label', summary.includes('- **Label:** `_version` goes from 2.1.288 to 2.1.289.'), text);
  check('summary: the field it does not break down', summary.includes('- **Other fields:** `_variantShapeHashes` differ in a way not broken down here. See the diff of the bundle.'), text);
  check('summary: what was compared and did not move', summary[summary.length - 1] === '- Unchanged: the base system prompt, the Fable and Opus 5 prompts, the tool names, `anthropic_beta` and the header order.', summary[summary.length - 1]);
  check('summary: the unchanged line speaks of tool names, never of the tools', !/\btools?\b(?! names)/i.test(summary[summary.length - 1]), summary[summary.length - 1]);
  check('summary: no verdict line, no em dash, no arrow', !/Verdict/.test(text) && !text.includes(DASH) && !text.includes(ARROW));

  const notes = formatRebakeChangelog(c);
  const note = notes.join('\n');
  check('release note: the variant, with what requests built from the bundle carry', notes[0] === '- **The bundled Sonnet 5 system prompt is the one captured from Claude Code 2.1.289.** It is 7804 characters; the bundle held a 13719-character one. Requests for Sonnet 5 models built from the bundled template carry it.', notes[0]);
  check('release note: the tools in one bullet', notes.includes('- **The bundled `Bash` and `WebSearch` tool definitions changed.** With the capture from Claude Code 2.1.289: `Bash` (description and input schema) and `WebSearch` (description).'), note);
  check('release note: the header value as what the bundle holds', notes.includes('- **The bundled `x-stainless-package-version` header value is `0.128.0`.** It was `0.112.1`.'), note);
  check('release note: the label and the user-agent in one bullet', notes.includes('- **The bundled template is labelled Claude Code 2.1.289.** It was labelled 2.1.288. Its `user-agent` value is `claude-cli/2.1.289 (external, sdk-cli)`.'), note);
  check('release note: the field it does not break down', notes.includes("- **The bundle's `_variantShapeHashes` field differs** in a way these notes do not break down."), note);
  check('release note: says nothing about what requests send except for the prompt', notes.filter((n) => /requests/i.test(n)).length === 1 && /^- \*\*The bundled Sonnet 5 system prompt/.test(notes.find((n) => /requests/i.test(n))), note);
  check('release note: no em dash, no arrow, no workflow narration', !note.includes(DASH) && !note.includes(ARROW) && !/re-captured|watcher|capture-and-bake|detected/i.test(note), note);

  const all3 = formatRebakeSummary(describeBundleChange(before, { ...before, system_prompt: 'another base' }));
  check('summary: three unchanged variants read as a list', all3[all3.length - 1].includes('the Fable, Opus 5 and Sonnet 5 prompts'), all3[all3.length - 1]);

  const gone = formatRebakeChangelog(describeBundleChange(before, { ...before, system_prompt_variants: { fable: before.system_prompt_variants.fable, 'opus-5': before.system_prompt_variants['opus-5'] } }));
  check('release note: a variant that left the bundle', gone[0] === '- **The bundled template no longer holds a system prompt for Sonnet 5.** Requests for Sonnet 5 models built from it carry the base prompt.', gone[0]);
  const born = formatRebakeChangelog(describeBundleChange({ ...before, system_prompt_variants: { fable: before.system_prompt_variants.fable } }, { ...before, system_prompt_variants: { fable: before.system_prompt_variants.fable, 'opus-5': 'o'.repeat(120) } }));
  check('release note: a variant new to the bundle', born[0].startsWith('- **The bundled template holds a system prompt for Opus 5.** It is 120 characters'), born[0]);

  // The bake strips the beta flags the proxy manages per request, so a flag that left
  // the bundle is not evidence of what Claude Code sends.
  const flags = formatRebakeChangelog(describeBundleChange(before, { ...before, anthropic_beta: 'a-1,c-3', tools: [...before.tools, tool('Extra', 'x')] })).join('\n');
  check('release note: tools and beta flags added and dropped, as bundle facts', flags.includes('- **The bundled tool list gains `Extra`.**') && flags.includes('- **The bundled `anthropic_beta` set gains `c-3`.**') && flags.includes('- **The bundled `anthropic_beta` set drops `b-2`.**'), flags);
  check('release note: no claim about what Claude Code or a request sends for them', !/sends?|carr(y|ies)/i.test(flags), flags);

  // The proxy sets some headers itself after overlaying the captured values, so a bundled
  // header value is reported as what the bundle holds and nothing more.
  const { 'x-stainless-package-version': dropped, ...restOfHeaders } = before.header_values;
  const headerGone = describeBundleChange(before, { ...before, header_values: restOfHeaders });
  const goneSummary = formatRebakeSummary(headerGone).join('\n');
  const goneNote = formatRebakeChangelog(headerGone).join('\n');
  check('summary: a header value that left the bundle', goneSummary.includes('- **Header value `x-stainless-package-version`:** removed from the bundle (it held `0.112.1`).'), goneSummary);
  check('release note: the same', goneNote.includes('- **The bundle no longer holds a value for the `x-stainless-package-version` header.** It held `0.112.1`.'), goneNote);
  const headerNew = describeBundleChange({ ...before, header_values: restOfHeaders }, before);
  check('a header value new to the bundle', formatRebakeChangelog(headerNew).join('\n').includes('- **The bundle holds a value for the `x-stainless-package-version` header, `0.112.1`.**') && formatRebakeSummary(headerNew).join('\n').includes('- **Header value `x-stainless-package-version`:** new in the bundle, `0.112.1`.'));
  const pinned = formatRebakeChangelog(describeBundleChange({ ...before, header_values: { ...before.header_values, 'anthropic-version': '2023-06-01' } }, { ...before, header_values: { ...before.header_values, 'anthropic-version': '2026-01-01' } })).join('\n');
  check('a header the proxy sets itself is still only a bundle fact', pinned.includes('- **The bundled `anthropic-version` header value is `2026-01-01`.** It was `2023-06-01`.'), pinned);
  check('no header bullet says what requests send or stop sending', !/requests|no longer sen[dt]|stopped sending/i.test(goneSummary + goneNote + pinned), goneSummary + ' | ' + goneNote + ' | ' + pinned);

  const label = formatRebakeChangelog(describeBundleChange(before, { ...before, _version: '2.1.289' }));
  check('release note: a label that moved alone', label.length === 1 && label[0] === '- **The bundled template is labelled Claude Code 2.1.289.** It was labelled 2.1.288.', label.join(' | '));
  const labelAndAgent = formatRebakeChangelog(describeBundleChange(before, { ...before, _version: '2.1.289', header_values: { ...before.header_values, 'user-agent': 'claude-cli/2.1.289 (external, sdk-cli)' } }));
  check('release note: the label and the user-agent alone', labelAndAgent.length === 1 && labelAndAgent[0].endsWith('Its `user-agent` value is `claude-cli/2.1.289 (external, sdk-cli)`.'), labelAndAgent.join(' | '));
  check('release note: neither vouches for what did not move', !/unchanged|already held|byte-identical/i.test(label[0] + labelAndAgent[0]));
  const { 'user-agent': agentValue, ...noAgent } = before.header_values;
  const agentGone = formatRebakeChangelog(describeBundleChange(before, { ...before, header_values: noAgent })).join('\n');
  check('release note: a user-agent value that left the bundle is reported like any other', agentGone.includes('- **The bundle no longer holds a value for the `user-agent` header.**'), agentGone);

  // Changes the bake can make that are not broken down field by field: the PR gate lets
  // them through, so the summary and the note must name them.
  const reordered = describeBundleChange(before, { ...before, tools: [...before.tools].reverse() });
  check('a reordered tool list is named as an undescribed change to tools', JSON.stringify(reordered.otherKeys) === JSON.stringify(['tools']));
  check('its note names the field and does not say the label moved', formatRebakeChangelog(reordered).join('\n') === "- **The bundle's `tools` field differs** in a way these notes do not break down.");
  check('its summary names the field', formatRebakeSummary(reordered).some((l) => l.startsWith('- **Other fields:** `tools` differ')));
  const same = describeBundleChange(before, { ...before, _captured: 'later' });
  check('a bundle against itself has nothing to report but its provenance stamp', same.otherKeys.length === 0 && formatRebakeChangelog(same).join('\n') === '- **The bundled template was baked again** and reads the same in every field these notes cover.');

  check('familyLabel reads a family key as a name', familyLabel('sonnet-5') === 'Sonnet 5' && familyLabel('fable') === 'Fable' && familyLabel('opus-5') === 'Opus 5');
}

// ──────────────────────────────────────────────────────────────────────
header('44. formatVariantOnlySummary: the check says what it did not compare');
{
  const lines = formatVariantOnlySummary([{ key: 'sonnet-5', before: 13719, after: 7804 }]);
  const text = lines.join('\n');
  check('names the variant and both lengths', lines.includes('- **system_prompt_variants.sonnet-5:** from 13719 to 7804 chars'), text);
  check('says the tool NAMES match, not the tools', text.includes('the tool names') && !/\btools?\b(?! names)[^.\n]*match/i.test(text), text);
  check('says tool text, header values and managed beta flags are outside the check', text.includes('Tool text, header values and the beta flags the proxy manages per request are not compared by this check.'));
  check('no em dash and no arrow', !text.includes(String.fromCharCode(0x2014)) && !text.includes(String.fromCharCode(0x2192)));
}

// ──────────────────────────────────────────────────────────────────────
header('45. the published --check log never says where Claude Code is installed');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'capture-and-bake.mjs'), 'utf8');
  const announces = src.split('\n').filter((l) => /^\s*log\(`using CC/.test(l));
  check('the line that announces the binary is found', announces.length === 1, String(announces.length));
  check('it names the version and interpolates nothing else', announces.every((l) => l.includes('${ccVersion') && !l.includes('ccPath') && !/\$\{(?!ccVersion|CHECK_MODE)/.test(l)), announces.join(' | '));
}

// ──────────────────────────────────────────────────────────────────────
header('46. rebakePrAction: what the watcher does with an open rebake PR');
{
  // --check exit codes: 0 matches live, 2 drifted, 3 label only, 1 could not tell.
  const at = (prChecks, masterCheck, extra = {}) => rebakePrAction({ ageHours: 5, staleAfterHours: 2, prChecks, masterCheck, ...extra });
  check('master=A, PR=B, live=C on two captures: the PR is replaced', at([2, 2], 2) === 'replace');
  check('master=A, PR=B, live=A on two captures: the PR is closed with no new bake', at([2, 2], 0) === 'close');
  check('the same when master is only behind on its label', at([2, 2], 3) === 'close');
  check('one capture reporting drift is not enough to close', at([2], 2) === 'keep');
  check('drift that the second capture does not confirm keeps the PR', at([2, 0], 2) === 'keep' && at([2, 3], 2) === 'keep' && at([2, 1], 2) === 'keep');
  check('master=A, PR=B, live=B: the PR matches live and stays', at([0], 2) === 'keep');
  check('a PR whose label alone lags live stays', at([3], 2) === 'keep');
  check('a check that could not run never closes a PR', at([1], 2) === 'keep' && at([], 2) === 'keep' && at([NaN, NaN], 2) === 'keep');
  check('a capture that hit the #881 tripwire never closes a PR', at([2, 2], 2, { residue: true }) === 'keep');
  check('a PR younger than the threshold stays, whatever the checks say', at([2, 2], 2, { ageHours: 1 }) === 'keep');
  check('a PR exactly at the threshold is judged', at([2, 2], 2, { ageHours: 2 }) === 'replace');
  check('an unreadable age keeps the PR', at([2, 2], 2, { ageHours: NaN }) === 'keep');

  const cli = (...args) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rebake-pr-action.mjs'), ...args], { encoding: 'utf8' }).stdout;
  check('the workflow reads the same decision from the command line', cli('5', '2', '0', 'false', '2', '2') === 'close\n' && cli('5', '2', '2', 'false', '2', '2') === 'replace\n');
  check('the command line keeps a PR on one capture, on residue, and when no check ran', cli('5', '2', '2', 'false', '2') === 'keep\n' && cli('5', '2', '2', 'true', '2', '2') === 'keep\n' && cli('1', '2', '2', 'false') === 'keep\n');
}

// ──────────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

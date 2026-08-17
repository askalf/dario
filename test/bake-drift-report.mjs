// Unit tests for the drift-report helpers in scripts/drift-report.mjs.
// Lives in the test:serial set because it imports from .mjs (the parallel
// test runner spawns each file via node:test which is fine for imports
// too, but the existing pattern groups script-imports in serial).

import { unifiedDiff, computeDrift, meaningfulTemplateKeys, TRANSIENT_TEMPLATE_FIELDS, describeTool, formatDriftReport, interpretDrift, formatDriftSummary, MODEL_CONDITIONAL_BETAS, REMOTE_CONFIG_CONDITIONAL_BETAS, normalizeMemoryPath, stripModelConditionalBetas, isOlderCCVersion, detectIssue881Residue, formatIssue881Warning, ISSUE_881_MARKER, ISSUE_881_BASELINE_LEN, ISSUE_881_ANOMALY_LEN } from '../scripts/drift-report.mjs';

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
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

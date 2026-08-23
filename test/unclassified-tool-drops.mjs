#!/usr/bin/env node
/**
 * unclassifiedToolDrops — the guard that keeps preservation-list rot LOUD.
 *
 * Background (dario#1062): a report claimed a headless capture drops 24 tools
 * of which preservedToolReason classifies only 10. Measured against real
 * captures (win32 + linux, CC 2.1.236 and 2.1.241, four runs) that did NOT
 * reproduce — every absent tool was classified. But the roster is
 * remote-config-shaped: the config-scoped four flipped between the 8/11 and
 * 8/15 bakes, and WaitForMcpServers appeared in one capture and vanished in
 * the next minutes apart. So instead of rewriting the merge on an unverified
 * premise, this helper names any capture drop NO set classifies, the bake
 * refuses to write through one (exit 4, --allow-tool-drops to override), and
 * the live path warns. This file pins the helper's semantics.
 */
import { unclassifiedToolDrops, mergePreservedTools } from '../dist/live-fingerprint.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
const T = (...names) => names.map((name) => ({ name }));

console.log('\n=== classified absences are not drops ===');
{
  // Everything the three sets cover, absent at once — the real linux shape.
  const bundle = T('Bash', 'Read', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
    'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'PowerShell', 'Glob', 'Grep');
  const capture = T('Bash', 'Read');
  check('linux: interactive + config-scoped + win32-only all classified',
    unclassifiedToolDrops(capture, bundle, 'linux').length === 0);
}

console.log('\n=== an unclassified absence is named ===');
{
  const bundle = T('Bash', 'WebSearch', 'WebFetch', 'AskUserQuestion');
  const capture = T('Bash');
  const drops = unclassifiedToolDrops(capture, bundle, 'linux');
  check('WebSearch and WebFetch are reported', drops.length === 2 && drops.includes('WebSearch') && drops.includes('WebFetch'));
  check('the classified absence (AskUserQuestion) is not', !drops.includes('AskUserQuestion'));
}

console.log('\n=== platform subtlety: a win32 tool missing ON win32 is a real drop ===');
{
  // On linux, Glob missing is expected (win32-only). On win32 itself, the
  // capture was supposed to carry it — its absence is unclassified, i.e. loud.
  const bundle = T('Bash', 'Glob');
  const capture = T('Bash');
  check('linux: Glob absence is classified', unclassifiedToolDrops(capture, bundle, 'linux').length === 0);
  check('win32: Glob absence is a drop', unclassifiedToolDrops(capture, bundle, 'win32').join(',') === 'Glob');
}

console.log('\n=== the merge and the guard agree ===');
{
  // mergePreservedTools restores only classified tools; whatever it cannot
  // restore is exactly what unclassifiedToolDrops names. The two must
  // partition the absent set — a name in neither is a hole in the guard.
  const bundle = T('Bash', 'AskUserQuestion', 'TaskCreate', 'WebSearch', 'Monitor');
  const capture = T('Bash');
  const { tools } = mergePreservedTools(capture, bundle, 'linux');
  const merged = new Set(tools.map((t) => t.name));
  const drops = new Set(unclassifiedToolDrops(capture, bundle, 'linux'));
  const unaccounted = bundle.filter((t) => !merged.has(t.name) && !drops.has(t.name));
  check('every absent bundle tool is either restored or reported', unaccounted.length === 0);
  check('restored: AskUserQuestion + TaskCreate', merged.has('AskUserQuestion') && merged.has('TaskCreate'));
  check('reported: WebSearch + Monitor', drops.has('WebSearch') && drops.has('Monitor'));
}

console.log('\n=== an identical capture is silent ===');
{
  const bundle = T('Bash', 'Read', 'Write');
  check('no absence, no drops', unclassifiedToolDrops(bundle, bundle, 'linux').length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

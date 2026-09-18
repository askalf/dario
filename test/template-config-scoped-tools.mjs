#!/usr/bin/env node
/**
 * Regression: the bundled CC template must always carry the config-scoped tools
 * (TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, advisor).
 *
 * Bug (2026-08-15, auto-rebake PR #984): CC's REMOTE config — not its version,
 * and not the headless capture mode — decides whether it advertises these. The
 * 2026-08-11 bake on CC v2.1.232 captured all four task-management tools; the
 * 2026-08-15 bake on v2.1.233 captured none of them, while TaskOutput and
 * TaskStop stayed put. The auto-rebake therefore proposed dropping four tools
 * from src/cc-template-data.json.
 *
 * 2026-09-18 widened the set to the whole task subsystem plus `advisor`, after
 * seven consecutive red cc-drift-template-watch runs: `advisor` entered the
 * bundle in the 01:25Z bake on v2.1.275 and was gone by 06:34Z on v2.1.276,
 * then TaskOutput dropped at 20:56Z on v2.1.277 while TaskStop survived. Same
 * runner, same headless mode — remote-config flap, not retirement.
 *
 * Why that is a regression and not a faithful capture: CC_NATIVE_NAMES_UNION is
 * derived from the bundle, and buildCCRequest identity-maps only names in that
 * set. Drop TaskCreate and a CC client that still declares it falls into the
 * unmapped round-robin — renamed onto a fallback slot with junk args, which is
 * exactly the v4.8.93 failure mode. The reverse is inert: advertise is the
 * INTERSECTION of the bundle with the client's declared tools, so a bundle entry
 * no client declares is never sent upstream.
 *
 * Fix: CONFIG_SCOPED_TOOLS in src/cc-template.ts + a preservation merge in
 * scripts/capture-and-bake.mjs, mirroring PLATFORM_ONLY_TOOLS and
 * INTERACTIVE_ONLY_TOOLS. This test guards the resulting invariant so a future
 * config-scoped capture (or a manual edit) can't silently re-drop them.
 *
 * In-process — no proxy / OAuth / upstream.
 */

import {
  CC_TEMPLATE,
  CC_TOOL_DEFINITIONS,
  CC_NATIVE_NAMES_UNION,
  CONFIG_SCOPED_TOOLS,
  INTERACTIVE_ONLY_TOOLS,
  PLATFORM_ONLY_TOOLS,
} from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

/**
 * Names CC advertises as a bare stub — `description: ""` and `input_schema: {}`
 * on the wire. `advisor` captured that way on v2.1.275, the only bake that ever
 * saw it. The preservation rule is about the NAME surviving into
 * CC_NATIVE_NAMES_UNION so the tool identity-maps; the body is whatever CC sent,
 * and asserting it is non-empty would be asserting something about CC we don't
 * control. Shape is still pinned below for every name, stub or not.
 */
const STUB_DEFINITION_TOOLS = new Set(['advisor']);

header('bundled template carries every config-scoped tool');
{
  check('CONFIG_SCOPED_TOOLS is non-empty', CONFIG_SCOPED_TOOLS.size > 0);

  const templateNames = new Set((CC_TEMPLATE.tools || []).map((t) => t.name));
  for (const name of CONFIG_SCOPED_TOOLS) {
    check(`template tools[] contains ${name}`, templateNames.has(name));
    const def = (CC_TEMPLATE.tools || []).find((t) => t.name === name);
    check(`${name} has a string description`, !!def && typeof def.description === 'string');
    if (!STUB_DEFINITION_TOOLS.has(name)) {
      check(`${name} has a non-empty description`,
        !!def && typeof def.description === 'string' && def.description.length > 0);
    }
    check(`${name} has an input_schema`, !!def && typeof def.input_schema === 'object' && def.input_schema !== null);
  }
}

header('config-scoped tools identity-map (the thing dropping them breaks)');
{
  // CC_NATIVE_NAMES_UNION is derived from the bundle and is what buildCCRequest
  // consults before falling through to TOOL_MAP / the unmapped round-robin.
  for (const name of CONFIG_SCOPED_TOOLS) {
    check(`CC_NATIVE_NAMES_UNION contains ${name}`, CC_NATIVE_NAMES_UNION.has(name));
  }
}

header('the whole task subsystem is classified, not just the half that flapped first');
{
  // TaskOutput/TaskStop were originally left out because the 8/11-vs-8/15
  // episode didn't move them. The 2026-09-18 v2.1.277 capture dropped
  // TaskOutput while keeping TaskStop, proving the split was an artifact of
  // the sample. Named explicitly so a future edit can't quietly re-narrow it.
  for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate']) {
    check(`${name} is config-scoped`, CONFIG_SCOPED_TOOLS.has(name));
  }
  check('advisor is config-scoped', CONFIG_SCOPED_TOOLS.has('advisor'));
}

header('config-scoped tools are NOT platform-filtered (present on every host)');
{
  // Like the interactive-only set and unlike PowerShell/Glob/Grep, these are not
  // registered in PLATFORM_ONLY_TOOLS — they must survive the per-host filter.
  const platformScoped = new Set(Object.values(PLATFORM_ONLY_TOOLS).flatMap((s) => [...s]));
  const ccNames = new Set(CC_TOOL_DEFINITIONS.map((t) => t.name));
  for (const name of CONFIG_SCOPED_TOOLS) {
    check(`${name} is not platform-scoped`, !platformScoped.has(name));
    check(`CC_TOOL_DEFINITIONS (platform ${process.platform}) contains ${name}`, ccNames.has(name));
  }
}

header('the preservation sets stay disjoint');
{
  // Each set drives its own merge in capture-and-bake.mjs. Overlap would double-
  // add a definition, and the `!scrubbed.tools.some(...)` guard in each merge
  // only dedupes against the capture — not against a sibling merge.
  const overlap = [...CONFIG_SCOPED_TOOLS].filter((n) => INTERACTIVE_ONLY_TOOLS.has(n));
  check('CONFIG_SCOPED_TOOLS ∩ INTERACTIVE_ONLY_TOOLS is empty', overlap.length === 0);
  const platformScoped = new Set(Object.values(PLATFORM_ONLY_TOOLS).flatMap((s) => [...s]));
  const platOverlap = [...CONFIG_SCOPED_TOOLS].filter((n) => platformScoped.has(n));
  check('CONFIG_SCOPED_TOOLS ∩ PLATFORM_ONLY_TOOLS is empty', platOverlap.length === 0);
}

console.log(`\ntemplate-config-scoped-tools: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

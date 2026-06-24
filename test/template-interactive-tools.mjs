#!/usr/bin/env node
/**
 * Regression: the bundled CC template must always carry the interactive-only
 * tools (AskUserQuestion, EnterPlanMode, ExitPlanMode).
 *
 * Bug (v4.8.93): the bake captures CC headlessly (`claude --print -p hi`, see
 * live-fingerprint.ts). CC v2.1.187 stopped advertising the plan-mode /
 * clarification tools in `--print` mode, so an auto-rebake dropped them from
 * src/cc-template-data.json. Because buildCCRequest advertises only the
 * INTERSECTION of the client's declared tools and the bundled template, a full
 * CC client that declared AskUserQuestion no longer had it advertised — the
 * "advertise-respects-client" contract broke (tool-advertise-respects-client.mjs
 * caught it). These tools are not platform-scoped, so they must remain in the
 * template (and in CC_TOOL_DEFINITIONS) on EVERY host, the same way the bake
 * preserves win32-only PowerShell/Glob/Grep from the previous bundle.
 *
 * Fix: scripts/capture-and-bake.mjs preserves INTERACTIVE_ONLY_TOOLS from the
 * previous bundle on every bake; this test guards the resulting invariant so a
 * future headless bake (or manual edit) can't silently re-drop them.
 *
 * In-process — no proxy / OAuth / upstream.
 */

import { CC_TEMPLATE, CC_TOOL_DEFINITIONS, INTERACTIVE_ONLY_TOOLS } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

header('bundled template carries every interactive-only tool');
{
  check('INTERACTIVE_ONLY_TOOLS is non-empty', INTERACTIVE_ONLY_TOOLS.size > 0);

  const templateNames = new Set((CC_TEMPLATE.tools || []).map((t) => t.name));
  for (const name of INTERACTIVE_ONLY_TOOLS) {
    check(`template tools[] contains ${name}`, templateNames.has(name));
    const def = (CC_TEMPLATE.tools || []).find((t) => t.name === name);
    check(`${name} has a non-empty description`,
      !!def && typeof def.description === 'string' && def.description.length > 0);
    check(`${name} has an input_schema`, !!def && typeof def.input_schema === 'object' && def.input_schema !== null);
  }
}

header('interactive-only tools are NOT platform-filtered (present on every host)');
{
  // CC_TOOL_DEFINITIONS is the current platform's filtered view of the bundle.
  // Interactive tools must survive that filter everywhere — unlike PowerShell/
  // Glob/Grep, they are not registered in PLATFORM_ONLY_TOOLS.
  const ccNames = new Set(CC_TOOL_DEFINITIONS.map((t) => t.name));
  for (const name of INTERACTIVE_ONLY_TOOLS) {
    check(`CC_TOOL_DEFINITIONS (platform ${process.platform}) contains ${name}`, ccNames.has(name));
  }
}

console.log(`\ntemplate-interactive-tools: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

#!/usr/bin/env node
// Unit tests for platform-scoped tool filtering.
//
// CC's tool set is platform-dependent. Windows CC advertises PowerShell and,
// as of v2.1.162, the Glob/Grep tools; POSIX CC installs advertise none of
// them (they steer the agent to shell `find`/`grep` instead). dario's bundled
// template is a union capture (whichever platform the maintainer baked from),
// and `cc-template.ts` filters it down to the running platform at module load
// so outbound requests match what real CC on that host would declare.

import { filterToolsForPlatform } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// Bash/Read/Write are cross-platform; PowerShell/Glob/Grep are win32-only.
const UNION_TOOLS = [
  { name: 'Bash',       description: 'POSIX shell',   input_schema: {} },
  { name: 'PowerShell', description: 'Windows shell',  input_schema: {} },
  { name: 'Glob',       description: 'glob search',    input_schema: {} },
  { name: 'Grep',       description: 'content search', input_schema: {} },
  { name: 'Read',       description: 'read a file',    input_schema: {} },
  { name: 'Write',      description: 'write a file',   input_schema: {} },
];

// ─────────────────────────────────────────────────────────────
header('Windows keeps PowerShell + Glob + Grep');
{
  const filtered = filterToolsForPlatform(UNION_TOOLS, 'win32');
  const names = filtered.map(t => t.name);
  check('all six tools retained', filtered.length === 6);
  check('PowerShell kept on win32', names.includes('PowerShell'));
  check('Glob kept on win32', names.includes('Glob'));
  check('Grep kept on win32', names.includes('Grep'));
  check('Bash kept on win32', names.includes('Bash'));
}

// ─────────────────────────────────────────────────────────────
header('POSIX drops PowerShell + Glob + Grep');
{
  for (const plat of ['linux', 'darwin', 'freebsd', 'openbsd']) {
    const filtered = filterToolsForPlatform(UNION_TOOLS, plat);
    const names = filtered.map(t => t.name);
    check(`PowerShell dropped on ${plat}`, !names.includes('PowerShell'));
    check(`Glob dropped on ${plat}`, !names.includes('Glob'));
    check(`Grep dropped on ${plat}`, !names.includes('Grep'));
    check(`Bash kept on ${plat}`, names.includes('Bash'));
    check(`Read kept on ${plat}`, names.includes('Read'));
    check(`Write kept on ${plat}`, names.includes('Write'));
    check(`result length is 3 on ${plat}`, filtered.length === 3);
  }
}

// ─────────────────────────────────────────────────────────────
header('Array with no platform-scoped tools passes through unchanged');
{
  const noScoped = [
    { name: 'Read',  input_schema: {} },
    { name: 'Write', input_schema: {} },
    { name: 'Edit',  input_schema: {} },
  ];
  const filtered = filterToolsForPlatform(noScoped, 'linux');
  check('length unchanged', filtered.length === 3);
  check('same tool identity (no clone)', filtered[0] === noScoped[0]);
}

// ─────────────────────────────────────────────────────────────
header('Empty array is a no-op');
{
  const filtered = filterToolsForPlatform([], 'win32');
  check('returns empty', filtered.length === 0);
  check('returns an array', Array.isArray(filtered));
}

// ─────────────────────────────────────────────────────────────
header('Unknown platform string behaves like POSIX (drops win32-only)');
{
  const filtered = filterToolsForPlatform(UNION_TOOLS, 'unknown_platform');
  const names = filtered.map(t => t.name);
  check('PowerShell dropped on unknown platform', !names.includes('PowerShell'));
  check('Glob dropped on unknown platform', !names.includes('Glob'));
  check('Grep dropped on unknown platform', !names.includes('Grep'));
  check('other tools retained', filtered.length === 3);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// The `Prompt variants` doctor row (dario#lock-step): a family the bake
// recorded as sharing the base prompt is healthy; any other missing variant
// warns. Pure, plus one run against the shipped bundle.

import { readFileSync } from 'node:fs';
import { checkPromptVariants } from '../dist/doctor-core.js';
import { CC_TEMPLATE } from '../dist/cc-template.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { console.log(`  OK ${label}`); pass++; } else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; } };
const header = (l) => console.log(`\n=== ${l} ===`);

const tpl = (extra = {}) => ({
  _version: '2.1.288',
  _captured: new Date(0).toISOString(),
  agent_identity: 'x',
  system_prompt: 'BASE',
  tools: [],
  tool_names: [],
  ...extra,
});

header('the shipped bundle reads as healthy');
{
  const bundled = JSON.parse(readFileSync(new URL('../dist/cc-template-data.json', import.meta.url), 'utf8'));
  const row = checkPromptVariants(bundled);
  check('bundle → ok', row.status === 'ok', row.detail);
  check('names the family that shares the base', /sonnet-5 shares CC's base prompt/.test(row.detail), row.detail);
  check('the loaded template agrees', checkPromptVariants(CC_TEMPLATE).status === 'ok', checkPromptVariants(CC_TEMPLATE).detail);
}

header('every family carried → ok');
{
  const row = checkPromptVariants(tpl({ system_prompt_variants: { fable: 'F', 'opus-5': 'O', 'sonnet-5': 'S' } }));
  check('status ok', row.status === 'ok', row.detail);
  check('all families carried', /all 3 model families carried \(fable, opus-5, sonnet-5\)/.test(row.detail), row.detail);
}

header('a missing variant not recorded as base-sharing → warn');
{
  const row = checkPromptVariants(tpl({ system_prompt_variants: { fable: 'F', 'opus-5': 'O' } }));
  check('status warn', row.status === 'warn', row.detail);
  check('names the missing family', /missing: sonnet-5/.test(row.detail), row.detail);
}

header('a recorded base-sharing family does not hide another missing one');
{
  const row = checkPromptVariants(tpl({ system_prompt_variants: { fable: 'F' }, _baseVariantFamilies: ['sonnet-5'] }));
  check('status warn', row.status === 'warn', row.detail);
  check('names only the unrecorded family', /missing: opus-5 —/.test(row.detail), row.detail);
}

header('a stored variant wins over a stale base-sharing entry');
{
  const row = checkPromptVariants(tpl({ system_prompt_variants: { fable: 'F', 'opus-5': 'O', 'sonnet-5': 'S' }, _baseVariantFamilies: ['sonnet-5'] }));
  check('status ok', row.status === 'ok', row.detail);
  check('reported as carried', /all 3 model families carried/.test(row.detail), row.detail);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

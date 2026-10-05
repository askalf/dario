#!/usr/bin/env node
/**
 * What cc-drift-template-watch.yml does with an open rebake PR.
 *
 *   node scripts/rebake-pr-action.mjs <ageHours> <staleAfterHours> <masterCheck> <residue> [prCheck ...]
 *
 * masterCheck is the exit code of `capture-and-bake.mjs --check` against
 * master's bundle. Each prCheck is the exit code of one run of the same check
 * against the PR's bundle, in order. residue is `true` when one of those runs
 * hit the dario#881 tripwire. Prints keep, replace or close. The decision is
 * `rebakePrAction` in drift-report.mjs, where it is tested.
 */
import { rebakePrAction } from './drift-report.mjs';

const [ageHours, staleAfterHours, masterCheck, residue, ...prChecks] = process.argv.slice(2);
process.stdout.write(rebakePrAction({
  ageHours: Number(ageHours),
  staleAfterHours: Number(staleAfterHours),
  masterCheck: Number(masterCheck),
  residue: residue === 'true',
  prChecks: prChecks.map(Number),
}) + '\n');

#!/usr/bin/env node
/**
 * What cc-drift-template-watch.yml does with an open rebake PR.
 *
 *   node scripts/rebake-pr-action.mjs <ageHours> <staleAfterHours> <prCheck> <masterCheck>
 *
 * prCheck is the exit code of `capture-and-bake.mjs --check` run against the
 * PR's bundle (or `not-run`), masterCheck the exit code of the same check
 * against master's. Prints keep, replace or close. The decision is
 * `rebakePrAction` in drift-report.mjs, where it is tested.
 */
import { rebakePrAction } from './drift-report.mjs';

const [ageHours, staleAfterHours, prCheck, masterCheck] = process.argv.slice(2);
process.stdout.write(rebakePrAction({
  ageHours: Number(ageHours),
  staleAfterHours: Number(staleAfterHours),
  prCheck: Number(prCheck),
  masterCheck: Number(masterCheck),
}) + '\n');

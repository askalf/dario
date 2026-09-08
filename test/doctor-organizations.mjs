#!/usr/bin/env node
// dario#1244 — the `Organizations` doctor row: which seats sit on which
// Anthropic organization, from the ids persisted on their records. Pure.

import { checkOrganizations } from '../dist/doctor-core.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { console.log(`  OK ${label}`); pass++; } else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; } };
const header = (l) => console.log(`\n=== ${l} ===`);

header('fewer than two observed seats → nothing to say');
{
  check('empty pool → no row', checkOrganizations({ accounts: [] }).length === 0);
  check('one seat → no row', checkOrganizations({ accounts: [{ alias: 'a', organizationId: 'org-A' }] }).length === 0);
  check('two seats, one unobserved → no row', checkOrganizations({ accounts: [{ alias: 'a', organizationId: 'org-A' }, { alias: 'b' }] }).length === 0);
}

header('every seat on its own organization → ok');
{
  const rows = checkOrganizations({ accounts: [
    { alias: 'a', organizationId: 'org-A' }, { alias: 'b', organizationId: 'org-B' }, { alias: 'c' },
  ] });
  check('one row', rows.length === 1 && rows[0].label === 'Organizations');
  check('status ok', rows[0].status === 'ok');
  check('counts observed seats and organizations, notes the unobserved one', /2 seats on 2 organizations \(1 not yet observed\)/.test(rows[0].detail), rows[0].detail);
  check('says they are distinct', /own organization/.test(rows[0].detail));
}

header('two seats on one organization → info, naming them');
{
  const rows = checkOrganizations({ accounts: [
    { alias: 'busy', organizationId: '927b430e-44e5-4504-a2bd-4ec1e286094c' },
    { alias: 'twin', organizationId: '927b430e-44e5-4504-a2bd-4ec1e286094c' },
    { alias: 'spare', organizationId: '1a2b3c4d-0000-4000-8000-00000000000b' },
  ] });
  check('status info (may be one subscription; the window says for sure)', rows[0].status === 'info', rows[0].status);
  check('names the pair and the short org id', /busy \+ twin share 927b430e…/.test(rows[0].detail), rows[0].detail);
  check('3 seats on 2 organizations', /3 seats on 2 organizations/.test(rows[0].detail), rows[0].detail);
  check('points at the Accounts row rather than asserting a shared limit', /Accounts row/.test(rows[0].detail) && /not one subscription/.test(rows[0].detail));
}

header('singular wording');
{
  const rows = checkOrganizations({ accounts: [{ alias: 'a', organizationId: 'org-A' }, { alias: 'b', organizationId: 'org-A' }] });
  check('2 seats on 1 organization', /2 seats on 1 organization —/.test(rows[0].detail), rows[0].detail);
}

console.log(`\ndoctor-organizations: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

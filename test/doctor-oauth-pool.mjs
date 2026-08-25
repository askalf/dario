// Unit tests for oauthCheckRow (src/doctor.ts) — the OAuth doctor row must
// report what SERVES, not what the legacy credentials.json says.
//
// The bug (dario#1105, 2026-08-25): dario#805 deliberately keeps a newer pool
// token and refuses to overwrite the legacy credentials.json, so "legacy is
// stale" is an EXPECTED steady state — every recovery that restores a pool
// account leaves one behind. The doctor row read only the legacy file, so it
// printed `OAuth expired` while the proxy was answering 200s on both Haiku and
// Sonnet, and dario-doctor-watch filed an issue for it on every single run. A
// watcher that cries wolf on a healthy proxy trains its reader to ignore it.
import { oauthCheckRow } from '../dist/doctor.js';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  ✅ ${label}`); pass++; } else { console.log(`  ❌ ${label}`); fail++; } };
const header = (l) => console.log(`\n=== ${l} ===`);

header('a live pool overrides a dead legacy credential (the #1105 case)');
{
  const r = oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: false, poolHealthy: 1, poolTotal: 1 });
  check('status is ok — the proxy can serve', r.status === 'ok');
  check('label stays OAuth', r.label === 'OAuth');
  check('says the pool is what is live', /pool credential live \(1\/1 account\)/.test(r.detail));
  // Honest, not hidden: the stale legacy file is still named, with the issue
  // that explains why it is left alone.
  check('still discloses the stale legacy file', /legacy credentials\.json is expired and unused/.test(r.detail));
  check('cites dario#805 so the next reader knows it is deliberate', /dario#805/.test(r.detail));
}

header('pluralisation of the account count');
{
  const one = oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: false, poolHealthy: 1, poolTotal: 1 });
  const many = oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: false, poolHealthy: 2, poolTotal: 3 });
  check('singular for one account', /1\/1 account\b/.test(one.detail) && !/accounts/.test(one.detail));
  check('plural for several', /2\/3 accounts/.test(many.detail));
}

header('nothing can serve → the failure is still reported');
{
  // The whole point of the row: silencing a real outage would be worse than
  // the false alarm it replaces.
  const refreshable = oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: true, poolHealthy: 0, poolTotal: 1 });
  check('expired + refreshable → warn', refreshable.status === 'warn');
  check('warn detail is the legacy status', refreshable.detail === 'expired');

  const dead = oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: false, poolHealthy: 0, poolTotal: 1 });
  check('expired + unrefreshable → fail', dead.status === 'fail');

  const none = oauthCheckRow({ legacyStatus: 'none', legacyCanRefresh: false, poolHealthy: 0, poolTotal: 0 });
  check('never authenticated → fail with the login hint', none.status === 'fail' && /dario login/.test(none.detail));
}

header('an empty pool is not a live pool');
{
  // poolTotal>0 with poolHealthy=0 is the all-expired pool; poolTotal=0 is no
  // pool at all. Neither may claim the ok row.
  check('0/0 does not claim ok', oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: true, poolHealthy: 0, poolTotal: 0 }).status !== 'ok');
  check('0/2 does not claim ok', oauthCheckRow({ legacyStatus: 'expired', legacyCanRefresh: true, poolHealthy: 0, poolTotal: 2 }).status !== 'ok');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

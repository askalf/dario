// Unit tests for src/refresh-grant.ts (grant ageing, thresholds, pool-wide
// level) and the doctor "Refresh grant" row (checkRefreshGrant). Pure
// functions — no filesystem, no network, no clock: `now` is always passed.

import { grantAge, grantThresholds, worstGrantLevel, describeGrantAge } from '../dist/refresh-grant.js';
import { checkRefreshGrant } from '../dist/doctor-core.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 5, 11, 54, 24); // 2026-09-05T11:54:24Z — the fleet seat's real re-grant
const DEFAULTS = { lifetimeDays: 28, warnDays: 21, urgentDays: 26 };

header('thresholds: defaults and env overrides, ordering clamped');
{
  const d = grantThresholds({});
  check('defaults 28/21/26', d.lifetimeDays === 28 && d.warnDays === 21 && d.urgentDays === 26);
  const e = grantThresholds({ DARIO_REFRESH_GRANT_LIFETIME_DAYS: '14', DARIO_REFRESH_GRANT_WARN_DAYS: '7', DARIO_REFRESH_GRANT_URGENT_DAYS: '12' });
  check('env overrides honoured', e.lifetimeDays === 14 && e.warnDays === 7 && e.urgentDays === 12);
  const bad = grantThresholds({ DARIO_REFRESH_GRANT_LIFETIME_DAYS: 'x', DARIO_REFRESH_GRANT_WARN_DAYS: '-3' });
  check('garbage falls back to defaults', bad.lifetimeDays === 28 && bad.warnDays === 21);
  const inv = grantThresholds({ DARIO_REFRESH_GRANT_WARN_DAYS: '40', DARIO_REFRESH_GRANT_URGENT_DAYS: '35' });
  check('warn ≤ urgent ≤ lifetime enforced (40/35 → 28/28)', inv.warnDays === 28 && inv.urgentDays === 28 && inv.lifetimeDays === 28);
}

header('grantAge: levels across the calendar');
{
  const a1 = grantAge(T0, T0 + 1 * DAY + 3600_000, DEFAULTS);
  check('1 day → ok, ageDays 1', a1.level === 'ok' && a1.ageDays === 1);
  check('wall = grant + 28d', a1.wallAt === T0 + 28 * DAY);
  check('daysToWall 26', a1.daysToWall === 26);
  const a20 = grantAge(T0, T0 + 20 * DAY + DAY - 1, DEFAULTS);
  check('20.99 days → still ok (whole days)', a20.level === 'ok' && a20.ageDays === 20);
  const a21 = grantAge(T0, T0 + 21 * DAY, DEFAULTS);
  check('21 days → warn', a21.level === 'warn' && a21.ageDays === 21 && a21.daysToWall === 7);
  const a26 = grantAge(T0, T0 + 26 * DAY, DEFAULTS);
  check('26 days → urgent', a26.level === 'urgent' && a26.daysToWall === 2);
  const a30 = grantAge(T0, T0 + 30 * DAY, DEFAULTS);
  check('past the wall → urgent, daysToWall negative', a30.level === 'urgent' && a30.daysToWall === -2);
  const fut = grantAge(T0 + DAY, T0, DEFAULTS);
  check('grant in the future (clock skew) → ok, age 0', fut.level === 'ok' && fut.ageDays === 0);
}

header('grantAge: unknown grants');
{
  for (const [label, v] of [['undefined', undefined], ['null', null], ['0', 0], ['NaN', NaN], ['negative', -5]]) {
    const a = grantAge(v, T0, DEFAULTS);
    check(`${label} → unknown with null fields`, a.level === 'unknown' && a.ageDays === null && a.wallAt === null && a.daysToWall === null);
  }
}

header('worstGrantLevel: worst seat wins, unknown sits between ok and warn');
{
  check('[] → ok', worstGrantLevel([]) === 'ok');
  check('[ok, ok] → ok', worstGrantLevel(['ok', 'ok']) === 'ok');
  check('[ok, unknown] → unknown', worstGrantLevel(['ok', 'unknown']) === 'unknown');
  check('[unknown, warn] → warn', worstGrantLevel(['unknown', 'warn']) === 'warn');
  check('[warn, urgent, ok] → urgent', worstGrantLevel(['warn', 'urgent', 'ok']) === 'urgent');
}

header('describeGrantAge: operator-facing lines');
{
  check('ok line names age and wall', /grant 1d old, ~27d to the ~28d wall$/.test(describeGrantAge(grantAge(T0, T0 + DAY, DEFAULTS), DEFAULTS)));
  check('warn line says this week', /re-grant this week/.test(describeGrantAge(grantAge(T0, T0 + 21 * DAY, DEFAULTS), DEFAULTS)));
  check('urgent line says TODAY', /re-grant TODAY/.test(describeGrantAge(grantAge(T0, T0 + 26 * DAY, DEFAULTS), DEFAULTS)));
  check('past-wall line says PAST', /2d PAST the ~28d wall/.test(describeGrantAge(grantAge(T0, T0 + 30 * DAY, DEFAULTS), DEFAULTS)));
  check('unknown line tells how to start the clock', /grant date unknown — re-grant/.test(describeGrantAge(grantAge(undefined, T0, DEFAULTS), DEFAULTS)));
}

header('checkRefreshGrant: doctor row');
{
  check('no accounts → no row', checkRefreshGrant({ accounts: [], now: T0 }).length === 0);
  const ok = checkRefreshGrant({ accounts: [{ alias: 'login', grantedAt: T0 }], now: T0 + DAY, thresholds: DEFAULTS });
  check('fresh seat → ok row labelled Refresh grant', ok.length === 1 && ok[0].status === 'ok' && ok[0].label === 'Refresh grant');
  check('ok row carries no fix text', !ok[0].detail.includes('re-grant with'));
  const unk = checkRefreshGrant({ accounts: [{ alias: 'login', grantedAt: T0 }, { alias: 'old' }], now: T0 + DAY, thresholds: DEFAULTS });
  check('one unstamped seat → info', unk[0].status === 'info' && unk[0].detail.includes('old: grant date unknown'));
  const warn = checkRefreshGrant({ accounts: [{ alias: 'login', grantedAt: T0 }, { alias: 'b', grantedAt: T0 - 21 * DAY }], now: T0 + DAY, thresholds: DEFAULTS });
  check('one warn seat → warn, both seats listed', warn[0].status === 'warn' && warn[0].detail.includes('login: grant 1d old') && warn[0].detail.includes('b: grant 22d old'));
  check('warn row names the re-grant command', warn[0].detail.includes('dario accounts add <alias>') && warn[0].detail.includes('dario login --force-reauth'));
  const urg = checkRefreshGrant({ accounts: [{ alias: 'login', grantedAt: T0 - 27 * DAY }], now: T0, thresholds: DEFAULTS });
  check('urgent seat → fail', urg[0].status === 'fail' && urg[0].detail.includes('re-grant TODAY'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// dario#1244 — one subscription under two aliases.
//
// Two seats whose last readings name the same live window (same representative
// claim, same reset second) are one subscription counted twice. windowKey /
// windowPeers / distinctWindows derive that from readings the pool already
// holds; noteOrganization records which organization answered.

import {
  AccountPool,
  EMPTY_SNAPSHOT,
  windowKey,
  windowPeers,
  distinctWindows,
} from '../dist/pool.js';
import { withObservedOrganization } from '../dist/accounts.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`, ...rest); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const NOW = 1_788_715_000_000;
const SECS = Math.floor(NOW / 1000);
const NOT_EXPIRING = Math.max(NOW, Date.now()) + 8 * 3_600_000;

function poolWith(aliases) {
  const pool = new AccountPool();
  for (const alias of aliases) {
    pool.add(alias, {
      accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`, expiresAt: NOT_EXPIRING,
      deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
    });
  }
  return pool;
}
const reading = (claim, reset, util5h = 0.3) => ({ ...EMPTY_SNAPSHOT, status: 'allowed', claim, reset, util5h, updatedAt: NOW });

// ----------------------------------------------------------------------
header('windowKey — the identity of a live window');
// ----------------------------------------------------------------------
{
  check('claim + reset second', windowKey(reading('five_hour', SECS + 600), NOW) === `five_hour@${SECS + 600}`);
  check('no reset → null', windowKey(reading('five_hour', 0), NOW) === null);
  check('a reset that has passed → null (that window no longer exists)', windowKey(reading('five_hour', SECS - 1), NOW) === null);
  check('unknown claim → null', windowKey(reading('unknown', SECS + 600), NOW) === null);
  check('never measured → null', windowKey(EMPTY_SNAPSHOT, NOW) === null);
}

// ----------------------------------------------------------------------
header('windowPeers — same window, either way round; different window, not');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['busy', 'twin', 'spare', 'idle']);
  pool.updateRateLimits('busy', reading('five_hour', SECS + 600, 0.9));
  pool.updateRateLimits('twin', reading('five_hour', SECS + 600, 0.9));
  pool.updateRateLimits('spare', reading('five_hour', SECS + 601, 0.1));   // one second apart: another window
  const peers = windowPeers(pool.all(), NOW);
  check('busy ↔ twin', JSON.stringify(peers.get('busy')) === '["twin"]' && JSON.stringify(peers.get('twin')) === '["busy"]');
  check('spare stands alone (reset differs by one second)', peers.get('spare').length === 0);
  check('an unmeasured seat has no peers', peers.get('idle').length === 0);
  check('every seat has an entry', peers.size === 4);

  // The organization id is NOT the key: two seats on one organization with
  // different windows are two windows.
  pool.noteOrganization('busy', 'org-A');
  pool.noteOrganization('spare', 'org-A');
  check('same organization, different reset → still not peers', windowPeers(pool.all(), NOW).get('spare').length === 0);

  // Different claims are different windows even at the same reset second.
  pool.updateRateLimits('spare', reading('seven_day', SECS + 600, 0.1));
  check('same reset second, different claim → not peers', windowPeers(pool.all(), NOW).get('spare').length === 0);

  // Three aliases on one window each list the other two.
  pool.updateRateLimits('spare', reading('five_hour', SECS + 600, 0.9));
  const three = windowPeers(pool.all(), NOW);
  check('three on one window', three.get('busy').length === 2 && three.get('spare').includes('twin'));
}

// ----------------------------------------------------------------------
header('distinctWindows — how many windows the pool really has');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a', 'b', 'c', 'd']);
  check('nothing measured → every seat is its own window', distinctWindows(pool.all(), NOW) === 4);
  pool.updateRateLimits('a', reading('five_hour', SECS + 600));
  pool.updateRateLimits('b', reading('five_hour', SECS + 600));
  check('a and b share one → 3', distinctWindows(pool.all(), NOW) === 3);
  pool.updateRateLimits('c', reading('five_hour', SECS + 900));
  check('c on its own → still 3', distinctWindows(pool.all(), NOW) === 3);
  pool.updateRateLimits('d', reading('five_hour', SECS - 1));
  check('a rolled reading counts as unmeasured, not as a window → 3', distinctWindows(pool.all(), NOW) === 3);
}

// ----------------------------------------------------------------------
header('peers expire with their window');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a', 'b']);
  pool.updateRateLimits('a', reading('five_hour', SECS + 60));
  pool.updateRateLimits('b', reading('five_hour', SECS + 60));
  check('inside the window → peers', windowPeers(pool.all(), NOW).get('a').length === 1);
  check('after it rolls → no claim about a window that no longer exists', windowPeers(pool.all(), NOW + 61_000).get('a').length === 0);
}

// ----------------------------------------------------------------------
header('noteOrganization — learned once, persisted by the caller, carried by add()');
// ----------------------------------------------------------------------
{
  const pool = poolWith(['a']);
  check('first observation is news', pool.noteOrganization('a', 'org-A') === true);
  check('recorded', pool.get('a').organizationId === 'org-A');
  check('same again is not news', pool.noteOrganization('a', 'org-A') === false);
  check('a change is news', pool.noteOrganization('a', 'org-B') === true);
  check('empty id ignored', pool.noteOrganization('a', '') === false && pool.get('a').organizationId === 'org-B');
  check('unknown alias → false', pool.noteOrganization('nope', 'org-A') === false);

  // A reconcile carrying the same grant keeps what was learned; the record's
  // own persisted value wins when it has one.
  pool.add('a', { accessToken: 't2', refreshToken: 'r2', expiresAt: NOT_EXPIRING, deviceId: 'd', accountUuid: 'u' });
  check('kept across a same-grant reconcile', pool.get('a').organizationId === 'org-B');
  pool.add('a', { accessToken: 't3', refreshToken: 'r3', expiresAt: NOT_EXPIRING, deviceId: 'd', accountUuid: 'u', organizationId: 'org-disk' });
  check('a persisted value on the record is taken', pool.get('a').organizationId === 'org-disk');
  // A re-grant is a new credential: the organization is unknown until seen.
  pool.add('a', { accessToken: 't4', refreshToken: 'r4', expiresAt: NOT_EXPIRING, deviceId: 'd', accountUuid: 'u', grantedAt: NOW });
  check('a re-grant forgets the old organization', pool.get('a').organizationId === undefined);
}

// ----------------------------------------------------------------------
header('withObservedOrganization — the refresh write carries what the pool learned');
// ----------------------------------------------------------------------
{
  const record = { alias: 'a', accessToken: 't', refreshToken: 'r', expiresAt: NOT_EXPIRING, scopes: [], deviceId: 'd', accountUuid: 'u' };
  const carried = withObservedOrganization(record, 'org-A');
  check('adds the observed organization', carried.organizationId === 'org-A');
  check('does not mutate the input', record.organizationId === undefined);
  check('tokens untouched', carried.accessToken === 't' && carried.refreshToken === 'r');
  check('nothing observed → the record as it was', withObservedOrganization(record, undefined) === record);
  const stated = { ...record, organizationId: 'org-disk' };
  check('a record that states one keeps it', withObservedOrganization(stated, 'org-A').organizationId === 'org-disk');
}

console.log(`\npool-window-peers: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

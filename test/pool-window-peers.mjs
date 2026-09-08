#!/usr/bin/env node
// dario#1244 / #1263 — one subscription under two aliases, by identity.
//
// The first version of this file tested `windowKey` / `windowPeers`: two seats
// whose last readings named the same live window (same claim, same reset
// second) were declared one subscription, on the premise that independent
// windows all but never share a reset second. The premise is false: Anthropic
// aligns the five-hour reset to a 20-minute grid (two demonstrably different
// accounts, both resetting at exactly :40:00), so a window has 15 possible
// reset seconds and a pool of 18 seats collides by pigeonhole. That heuristic
// told an operator seven independent colleagues were one subscription.
//
// `accountPeers` / `distinctAccounts` use the OAuth account uuid on the record
// instead. Same uuid → same account, full stop. No uuid → not yet identified,
// never guessed. noteOrganization and withObservedOrganization are unchanged.

import { AccountPool, EMPTY_SNAPSHOT, accountPeers, distinctAccounts } from '../dist/pool.js';
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

function poolWith(seats) {
  const pool = new AccountPool();
  for (const [alias, accountId, accountEmail] of seats) {
    pool.add(alias, {
      accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`, expiresAt: NOT_EXPIRING,
      deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
      ...(accountId ? { accountId } : {}), ...(accountEmail ? { accountEmail } : {}),
    });
  }
  return pool;
}
const reading = (claim, reset, util5h = 0.3) => ({ ...EMPTY_SNAPSHOT, status: 'allowed', claim, reset, util5h, updatedAt: NOW });

// ----------------------------------------------------------------------
header('accountPeers — same account uuid, either way round; different, not');
// ----------------------------------------------------------------------
{
  const pool = poolWith([['busy', 'acct-A', 'm@x.y'], ['twin', 'acct-A'], ['spare', 'acct-B'], ['idle']]);
  const peers = accountPeers(pool.all());
  check('busy ↔ twin', JSON.stringify(peers.get('busy')) === '["twin"]' && JSON.stringify(peers.get('twin')) === '["busy"]');
  check('spare stands alone', peers.get('spare').length === 0);
  check('an unidentified seat has no peers and is nobody\'s peer', peers.get('idle').length === 0 && !peers.get('busy').includes('idle'));
  check('every seat has an entry', peers.size === 4);
  check('identity is carried on the account', pool.get('busy').accountId === 'acct-A' && pool.get('busy').accountEmail === 'm@x.y');
}

// ----------------------------------------------------------------------
header('the reset-second collision that broke the old inference is NOT a peer relation');
// ----------------------------------------------------------------------
{
  // Two different accounts (matteo, test on #1244) whose readings name the
  // same claim and land on the same grid-aligned reset second.
  const pool = poolWith([['matteo', 'acct-M'], ['test', 'acct-T'], ['colleague', 'acct-C']]);
  const grid = SECS - (SECS % 1200) + 1200; // the next :00/:20/:40 boundary
  pool.updateRateLimits('matteo', reading('five_hour', grid, 1.02));
  pool.updateRateLimits('test', reading('five_hour', grid, 0.04));
  pool.updateRateLimits('colleague', reading('five_hour', grid, 0.5));
  const peers = accountPeers(pool.all());
  check('same claim, same reset second, different accounts → no peers', peers.get('matteo').length === 0 && peers.get('test').length === 0 && peers.get('colleague').length === 0);
  check('three distinct accounts', distinctAccounts(pool.all()) === 3);
  // And the organization id is not the key either: a Team is many accounts.
  for (const a of ['matteo', 'test', 'colleague']) pool.noteOrganization(a, 'org-team');
  check('same organization → still not peers', accountPeers(pool.all()).get('matteo').length === 0);
}

// ----------------------------------------------------------------------
header('distinctAccounts — how many accounts the pool really has');
// ----------------------------------------------------------------------
{
  check('nothing identified → every seat is its own', distinctAccounts(poolWith([['a'], ['b'], ['c'], ['d']]).all()) === 4);
  check('a and b share one → 3', distinctAccounts(poolWith([['a', 'X'], ['b', 'X'], ['c'], ['d']]).all()) === 3);
  check('c identified on its own → still 3', distinctAccounts(poolWith([['a', 'X'], ['b', 'X'], ['c', 'Y'], ['d']]).all()) === 3);
  check('seven aliases of one account → 1', distinctAccounts(poolWith([['1', 'X'], ['2', 'X'], ['3', 'X'], ['4', 'X'], ['5', 'X'], ['6', 'X'], ['7', 'X']]).all()) === 1);
}

// ----------------------------------------------------------------------
header('identity survives reconcile; a record that states one is taken');
// ----------------------------------------------------------------------
{
  const pool = poolWith([['a', 'acct-1', 'e@x.y']]);
  pool.add('a', { accessToken: 't2', refreshToken: 'r2', expiresAt: NOT_EXPIRING, deviceId: 'dev-a', accountUuid: 'uuid-a' });
  check('kept across a same-grant reconcile that states none', pool.get('a').accountId === 'acct-1' && pool.get('a').accountEmail === 'e@x.y');
  pool.add('a', { accessToken: 't3', refreshToken: 'r3', expiresAt: NOT_EXPIRING, deviceId: 'dev-a', accountUuid: 'uuid-a', accountId: 'acct-2' });
  check('a record that states one is taken', pool.get('a').accountId === 'acct-2');
}

// ----------------------------------------------------------------------
header('a changed on-disk client identity is presented, the session kept');
// ----------------------------------------------------------------------
{
  const pool = poolWith([['a', 'acct-1']]);
  const session = pool.get('a').identity.sessionId;
  pool.add('a', { accessToken: 't', refreshToken: 'r', expiresAt: NOT_EXPIRING, deviceId: 'dev-fresh', accountUuid: 'uuid-fresh' });
  check('new deviceId/accountUuid taken without a restart', pool.get('a').identity.deviceId === 'dev-fresh' && pool.get('a').identity.accountUuid === 'uuid-fresh');
  check('session id kept', pool.get('a').identity.sessionId === session);
  pool.add('a', { accessToken: 't', refreshToken: 'r', expiresAt: NOT_EXPIRING, deviceId: 'dev-fresh', accountUuid: 'uuid-fresh' });
  check('an unchanged identity keeps the same object', pool.get('a').identity.sessionId === session);
}

// ----------------------------------------------------------------------
header('noteOrganization — learned once, persisted by the caller, carried by add()');
// ----------------------------------------------------------------------
{
  const pool = poolWith([['a']]);
  check('first observation is news', pool.noteOrganization('a', 'org-A') === true);
  check('recorded', pool.get('a').organizationId === 'org-A');
  check('same again is not news', pool.noteOrganization('a', 'org-A') === false);
  check('a change is news', pool.noteOrganization('a', 'org-B') === true);
  check('empty id ignored', pool.noteOrganization('a', '') === false && pool.get('a').organizationId === 'org-B');
  check('unknown alias → false', pool.noteOrganization('nope', 'org-A') === false);
  pool.add('a', { accessToken: 't2', refreshToken: 'r2', expiresAt: NOT_EXPIRING, deviceId: 'dev-a', accountUuid: 'uuid-a' });
  check('kept across a same-grant reconcile', pool.get('a').organizationId === 'org-B');
  pool.add('a', { accessToken: 't3', refreshToken: 'r3', expiresAt: NOT_EXPIRING, deviceId: 'dev-a', accountUuid: 'uuid-a', organizationId: 'org-disk' });
  check('a persisted value on the record is taken', pool.get('a').organizationId === 'org-disk');
  pool.add('a', { accessToken: 't4', refreshToken: 'r4', expiresAt: NOT_EXPIRING, deviceId: 'dev-a', accountUuid: 'uuid-a', grantedAt: NOW });
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

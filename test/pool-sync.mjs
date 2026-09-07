#!/usr/bin/env node
// Shared pool state (src/pool-sync.ts): two instances, one stub of the
// refresh-lock service's pool endpoints. Readings taken by one instance reach
// the other; a newer local reading is never overwritten; a parked seat parks
// on the peer too; sticky bindings cross over; an outage fails open.

import { AccountPool, EMPTY_SNAPSHOT } from '../dist/pool.js';
import { PoolSync, shouldAdopt, SHARED_SEAT_MAX_AGE_MS } from '../dist/pool-sync.js';
import { startPoolStateStub } from './helpers/pool-state-stub.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = 1_788_715_000_000;
const SECS = Math.floor(NOW / 1000);
const NOT_EXPIRING = Date.now() + 8 * 3_600_000;
const poolWith = (aliases) => {
  const pool = new AccountPool();
  for (const alias of aliases) pool.add(alias, { accessToken: `t-${alias}`, refreshToken: `r-${alias}`, expiresAt: NOT_EXPIRING, deviceId: 'd', accountUuid: 'u' });
  return pool;
};
const reading = (util5h, at, extra = {}) => ({ ...EMPTY_SNAPSHOT, status: 'allowed', claim: 'five_hour', reset: Math.floor(at / 1000) + 600, util5h, updatedAt: at, ...extra });

header('shouldAdopt — pure');
{
  const local = reading(0.1, NOW);
  const remote = { instance: 'peer', at: NOW + 1000, snapshot: reading(0.9, NOW + 1000), rejected: false };
  check('a newer reading from another instance is adopted', shouldAdopt(local, remote, 'me', NOW + 2000) === true);
  check('our own report is not', shouldAdopt(local, { ...remote, instance: 'me' }, 'me', NOW + 2000) === false);
  check('an older reading is not', shouldAdopt(local, { ...remote, at: NOW - 1 }, 'me', NOW + 2000) === false);
  check('the same instant is not (strictly newer wins)', shouldAdopt(local, { ...remote, at: NOW }, 'me', NOW + 2000) === false);
  check('a stale reading is not', shouldAdopt(local, remote, 'me', NOW + 1000 + SHARED_SEAT_MAX_AGE_MS + 1) === false);
  check('a malformed record is not', shouldAdopt(local, { instance: 'peer', at: 'x', snapshot: null }, 'me', NOW) === false);
  check('a never-measured local seat adopts anything current', shouldAdopt(EMPTY_SNAPSHOT, remote, 'me', NOW + 2000) === true);
}

const stub = await startPoolStateStub({ token: 'tok' });
const logA = [], logB = [];
const poolA = poolWith(['busy', 'spare']);
const poolB = poolWith(['busy', 'spare']);
const syncA = new PoolSync(poolA, { baseUrl: stub.url, token: 'tok', instance: 'A', intervalMs: 200, log: (l) => logA.push(l) });
const syncB = new PoolSync(poolB, { baseUrl: stub.url, token: 'tok', instance: 'B', intervalMs: 200, log: (l) => logB.push(l) });

header('a reading taken on A reaches B; B\'s counters stay B\'s');
{
  poolA.updateRateLimits('busy', reading(0.7, Date.now()));
  syncA.reportSeat('busy');
  await sleep(150);
  check('A reported once', syncA.status().reported === 1 && stub.seats.get('busy')?.instance === 'A', JSON.stringify(stub.seats.get('busy')));
  const adopted = await syncB.pullOnce();
  check('B adopted one reading', adopted === 1 && syncB.status().adopted === 1);
  const b = poolB.get('busy');
  check('B holds A\'s utilisation', b.rateLimit.util5h === 0.7 && b.rateLimit.status === 'allowed');
  check('B remembers where it came from', b.adoptedFrom === 'A');
  check('B\'s own counters untouched', b.requestCount === 0 && b.rejectedCount === 0);
  check('pulling again adopts nothing new', (await syncB.pullOnce()) === 0);
}

header('a newer local reading is never overwritten by an older peer one');
{
  const later = Date.now() + 5_000;
  poolB.updateRateLimits('busy', reading(0.2, later));
  check('B\'s own reading clears adoptedFrom', poolB.get('busy').adoptedFrom === undefined);
  check('B keeps its newer reading', (await syncB.pullOnce()) === 0 && poolB.get('busy').rateLimit.util5h === 0.2);
}

header('a 429 on A parks the seat on B');
{
  const at = Date.now() + 10_000;
  const parked = poolA.markRejected('busy', reading(1.04, at, { status: 'rejected' }));
  check('parked on A', parked === true);
  syncA.reportSeat('busy');
  await sleep(150);
  check('the report says rejected', stub.seats.get('busy')?.rejected === true);
  await syncB.pullOnce();
  const b = poolB.get('busy');
  check('B parks the seat on A\'s reading', b.rateLimit.status === 'rejected' && b.rateLimit.util5h === 1.04);
  check('B did not count a 429 it never took', b.rejectedCount === 0 && b.adoptedFrom === 'A');
  check('B routes around it', poolB.select()?.alias === 'spare');
}

header('reports coalesce: a burst of readings is one or two pushes');
{
  const before = stub.calls.filter((c) => c.path === '/pool/seat/spare').length;
  for (let i = 0; i < 20; i++) {
    poolA.updateRateLimits('spare', reading(0.01 * i, Date.now() + i));
    syncA.reportSeat('spare');
  }
  await sleep(200);
  const pushes = stub.calls.filter((c) => c.path === '/pool/seat/spare').length - before;
  check('at most two pushes for twenty readings', pushes >= 1 && pushes <= 2, pushes);
  check('the last push carries the last reading', Math.abs(stub.seats.get('spare').snapshot.util5h - 0.19) < 1e-9, stub.seats.get('spare')?.snapshot.util5h);
}

header('sticky bindings cross instances');
{
  syncA.bindSticky('abcdef0123456789', 'spare');
  await sleep(100);
  check('A pushed the binding', syncA.status().stickyPushed === 1 && stub.sticky.get('abcdef0123456789')?.alias === 'spare');
  check('B looks it up', (await syncB.lookupSticky('abcdef0123456789')) === 'spare' && syncB.status().stickyAdopted === 1);
  check('an unknown key is null', (await syncB.lookupSticky('0000000000000000')) === null);
}

header('the interval pulls on its own');
{
  syncB.start();
  const at = Date.now() + 20_000;
  poolA.updateRateLimits('busy', reading(0.33, at));
  syncA.reportSeat('busy');
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) { await sleep(100); seen = poolB.get('busy').rateLimit.util5h === 0.33; }
  check('B picked up A\'s later reading without being asked', seen);
  check('status carries lastPullAt / lastOkAt', typeof syncB.status().lastPullAt === 'number' && typeof syncB.status().lastOkAt === 'number');
  syncB.stop();
}

header('an outage fails open and is said once');
{
  stub.down();
  const errorsBefore = syncB.status().errors;
  check('pull returns 0, no throw', (await syncB.pullOnce()) === 0);
  check('lookup returns null, no throw', (await syncB.lookupSticky('abcdef0123456789')) === null);
  syncB.bindSticky('abcdef0123456789', 'busy');
  await sleep(100);
  check('errors counted', syncB.status().errors >= errorsBefore + 3 && typeof syncB.status().lastError === 'string');
  check('one "unreachable" line for the whole outage', logB.filter((l) => l.includes('unreachable')).length === 1, JSON.stringify(logB));
  check('local state untouched', poolB.get('busy').rateLimit.util5h === 0.33);
  stub.up();
  await syncB.pullOnce();
  check('one "reachable again" line on recovery', logB.filter((l) => l.includes('reachable again')).length === 1, JSON.stringify(logB));
}

header('a wrong token is an error, not an adoption');
{
  const syncX = new PoolSync(poolWith(['busy']), { baseUrl: stub.url, token: 'wrong', instance: 'X', log: () => {} });
  check('unauthorized → 0 adopted, 1 error', (await syncX.pullOnce()) === 0 && syncX.status().errors === 1 && /HTTP 401/.test(syncX.status().lastError));
}

await stub.close();
console.log(`\npool-sync: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

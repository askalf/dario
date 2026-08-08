// Tests for RequestQueue.snapshot().stalledSince — the #905 wedge signal.
//
// #910 exposed `active` / `queued` on /health, which made slot exhaustion
// visible but not DIAGNOSABLE: a 14h wedge and a healthy one-second burst
// produce the identical sample (`active === maxConcurrent, queued > 0`).
//
// The distinguishing property is turnover, not depth. These tests pin exactly
// that: a queue running flat-out at its cap must never accumulate stall age so
// long as slots keep being released, and a queue whose slots stop turning over
// must accumulate it from the moment the stall began — not from the moment
// someone happened to look.
//
// The clock is injected, so none of this depends on timers or wall time.

import { RequestQueue } from '../dist/request-queue.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

/** A queue on an injected clock. Timeouts are far out of the way. */
function makeQueue(clockRef, opts = {}) {
  return new RequestQueue({
    maxConcurrent: 2,
    maxQueued: 10,
    queueTimeoutMs: 10_000_000,
    unrefTimers: true,
    now: () => clockRef.t,
    ...opts,
  });
}
/** Enqueue without awaiting — these only settle on release. */
function enqueue(q) {
  const p = q.acquire();
  p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------------------
header('idle and busy-with-headroom are not stalls');
{
  const clock = { t: 1000 };
  const q = makeQueue(clock);
  check('fresh queue → null', q.snapshot().stalledSince === null);
  await q.acquire();
  check('one active, headroom left → null', q.snapshot().stalledSince === null);
  await q.acquire();
  check('at cap but NOTHING waiting → null', q.snapshot().stalledSince === null);
  check('  (nothing is being denied, so nothing is stalled)', q.snapshot().active === 2 && q.snapshot().queued === 0);
}

// ---------------------------------------------------------------------------
header('at capacity WITH a backlog starts the clock');
{
  const clock = { t: 1000 };
  const q = makeQueue(clock);
  await q.acquire(); await q.acquire();
  enqueue(q);
  check('stamped on entering the stall', q.snapshot().stalledSince === 1000);
  check('queued reflects the waiter', q.snapshot().queued === 1);

  clock.t = 1500;
  enqueue(q);
  check('a LATER arrival does not refresh the stamp', q.snapshot().stalledSince === 1000);
  check('  (otherwise steady traffic would mask a permanent wedge)', q.snapshot().queued === 2);
}

// ---------------------------------------------------------------------------
header('THE wedge — no turnover, age accumulates from where it began');
{
  const clock = { t: 1000 };
  const q = makeQueue(clock);
  await q.acquire(); await q.acquire();
  enqueue(q); enqueue(q);
  check('stall opens at 1000', q.snapshot().stalledSince === 1000);

  // Hours pass. Nothing is ever released — this is #905.
  clock.t = 1000 + 8 * 3600 * 1000;
  const s = q.snapshot();
  check('stamp unchanged after 8h', s.stalledSince === 1000);
  check('still pinned at capacity', s.active === 2 && s.queued === 2);
  check('a single sample shows an 8h stall', clock.t - s.stalledSince === 28_800_000);
}

// ---------------------------------------------------------------------------
header('THE false positive it must not produce — saturated but flowing');
{
  const clock = { t: 1000 };
  const q = makeQueue(clock);
  await q.acquire(); await q.acquire();
  enqueue(q); enqueue(q);
  check('stall window opens at 1000', q.snapshot().stalledSince === 1000);

  // Real traffic: a slot frees and is immediately refilled from the backlog.
  // Depth is unchanged — still at cap, still a waiter — but this is turnover.
  clock.t = 2000;
  q.release();
  const s = q.snapshot();
  check('still at capacity with a waiter', s.active === 2 && s.queued === 1);
  check('but the stamp RESET to the release (fresh window)', s.stalledSince === 2000);
  check('so measured stall age is 0, not 1000', clock.t - s.stalledSince === 0);

  // Keep serving. A busy dario must never accumulate age here.
  for (let i = 0; i < 5; i++) {
    clock.t += 500;
    enqueue(q);
    q.release();
  }
  const busy = q.snapshot();
  check('after sustained flat-out service, age stays ~one service interval',
    busy.stalledSince !== null && (clock.t - busy.stalledSince) <= 500);
}

// ---------------------------------------------------------------------------
header('draining clears the stall entirely');
{
  const clock = { t: 1000 };
  const q = makeQueue(clock);
  await q.acquire(); await q.acquire();
  enqueue(q);
  check('stalled', q.snapshot().stalledSince === 1000);

  clock.t = 2000;
  q.release(); // hands the slot to the waiter — queue now empty
  check('no waiters left → null', q.snapshot().stalledSince === null);
  check('  active still at cap, but nothing denied', q.snapshot().active === 2 && q.snapshot().queued === 0);

  clock.t = 3000;
  q.release();
  check('below cap → still null', q.snapshot().stalledSince === null);
}

// ---------------------------------------------------------------------------
header('a queue-timeout eviction re-evaluates the stall');
{
  const clock = { t: 1000 };
  const q = new RequestQueue({
    maxConcurrent: 1, maxQueued: 10, queueTimeoutMs: 20,
    unrefTimers: false, now: () => clock.t,
  });
  await q.acquire();
  const waiter = q.acquire();
  check('stalled while the waiter waits', q.snapshot().stalledSince === 1000);

  let rejected = false;
  await waiter.catch(() => { rejected = true; });
  check('waiter timed out', rejected === true);
  check('evicting the last waiter clears the stall', q.snapshot().stalledSince === null);
  check('queued back to 0', q.snapshot().queued === 0);
}

// ---------------------------------------------------------------------------
header('snapshot keeps its existing shape');
{
  const q = makeQueue({ t: 0 });
  const s = q.snapshot();
  check('active', s.active === 0);
  check('queued', s.queued === 0);
  check('maxConcurrent', s.maxConcurrent === 2);
  check('maxQueued', s.maxQueued === 10);
  check('stalledSince present', 'stalledSince' in s);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Unit tests for the bounded request queue that replaced the v3.30.x
// unbounded semaphore in dario#80. The pure decision function
// (`decideAdmit`) and timeout check (`isQueueEntryExpired`) exercise
// every branch without touching real timers; the `RequestQueue` class
// tests use short timeouts and assert the promise-based flow.

import {
  decideConsumerAdmit,
  decideAdmit,
  isQueueEntryExpired,
  RequestQueue,
  QueueFullError,
  QueueTimeoutError,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUED,
  DEFAULT_QUEUE_TIMEOUT_MS,
} from '../dist/request-queue.js';
import { parsePositiveIntEnv } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('decideAdmit — admit when active < maxConcurrent');
{
  check('active=0, queued=0, cap=10 → admit',
    decideAdmit({ active: 0, queued: 0, maxConcurrent: 10, maxQueued: 128 }).action === 'admit');
  check('active=9, queued=0, cap=10 → admit',
    decideAdmit({ active: 9, queued: 0, maxConcurrent: 10, maxQueued: 128 }).action === 'admit');
}

header('decideAdmit — enqueue when active full and queue has room');
{
  check('active=10, queued=0, cap=10, q=128 → enqueue',
    decideAdmit({ active: 10, queued: 0, maxConcurrent: 10, maxQueued: 128 }).action === 'enqueue');
  check('active=10, queued=127, cap=10, q=128 → enqueue',
    decideAdmit({ active: 10, queued: 127, maxConcurrent: 10, maxQueued: 128 }).action === 'enqueue');
}

header('decideAdmit — reject when both active and queue are full');
{
  const d = decideAdmit({ active: 10, queued: 128, maxConcurrent: 10, maxQueued: 128 });
  check('active=10, queued=128 → reject', d.action === 'reject');
  check('reject reason is "queue-full"', d.action === 'reject' && d.reason === 'queue-full');
}

header('decideAdmit — zero caps');
{
  check('maxConcurrent=0 always rejects when queue is 0 too',
    decideAdmit({ active: 0, queued: 0, maxConcurrent: 0, maxQueued: 0 }).action === 'reject');
  check('maxConcurrent=0 enqueues while queue has room',
    decideAdmit({ active: 0, queued: 0, maxConcurrent: 0, maxQueued: 5 }).action === 'enqueue');
}

// ─────────────────────────────────────────────────────────────
header('isQueueEntryExpired — pure timeout check');
{
  check('now at exactly enqueuedAt → not expired', isQueueEntryExpired(1000, 1000, 60_000) === false);
  check('now 1ms before timeout → not expired', isQueueEntryExpired(1000, 61_000, 60_000) === false);
  check('now 1ms past timeout → expired', isQueueEntryExpired(1000, 61_001, 60_000) === true);
  check('huge gap, short timeout → expired', isQueueEntryExpired(0, 10_000_000, 1_000) === true);
  check('timeout=0 degenerate → any positive gap expires', isQueueEntryExpired(1000, 1001, 0) === true);
}

// ─────────────────────────────────────────────────────────────
header('DEFAULT constants match the documented defaults');
{
  check('DEFAULT_MAX_CONCURRENT = 10', DEFAULT_MAX_CONCURRENT === 10);
  check('DEFAULT_MAX_QUEUED = 128', DEFAULT_MAX_QUEUED === 128);
  check('DEFAULT_QUEUE_TIMEOUT_MS = 60000', DEFAULT_QUEUE_TIMEOUT_MS === 60_000);
}

// ─────────────────────────────────────────────────────────────
header('RequestQueue — immediate admit under capacity');
{
  const q = new RequestQueue({ maxConcurrent: 2, maxQueued: 4, queueTimeoutMs: 5_000 });
  await q.acquire();
  await q.acquire();
  const s1 = q.snapshot();
  check('both acquired immediately → active=2', s1.active === 2);
  check('queued=0', s1.queued === 0);
  q.release();
  q.release();
  const s2 = q.snapshot();
  check('after both release → active=0', s2.active === 0);
}

header('RequestQueue — queue-full rejects fast');
{
  const q = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 10_000 });
  await q.acquire(); // active 1/1
  const p2 = q.acquire(); // queued 1/1
  let thrown;
  try {
    await q.acquire(); // over capacity
  } catch (err) {
    thrown = err;
  }
  check('3rd acquire throws', thrown !== undefined);
  check('error is QueueFullError', thrown instanceof QueueFullError);
  // drain
  q.release();
  await p2;
  q.release();
}

header('RequestQueue — release admits next queued in FIFO');
{
  const q = new RequestQueue({ maxConcurrent: 1, maxQueued: 10, queueTimeoutMs: 10_000 });
  await q.acquire(); // 1st admitted
  const order = [];
  const p2 = q.acquire().then(() => order.push('second'));
  const p3 = q.acquire().then(() => order.push('third'));
  // Nothing has been released yet; 2nd and 3rd should still be queued.
  check('two requests queued', q.snapshot().queued === 2);
  q.release();
  await p2;
  check('FIFO: second acquired before third', order[0] === 'second');
  q.release();
  await p3;
  check('third also admitted after second released', order[1] === 'third');
  q.release();
}

header('RequestQueue — queue-timeout rejects the waiter');
{
  // `unrefTimers: false` — this test is the only thing on the event loop,
  // and the default-unref'd timer would let the process exit before the
  // 50ms timeout fires, hanging forever on the `await q.acquire()` below.
  // Production code (`src/proxy.ts`) takes the default `unrefTimers: true`
  // so a leaked queue entry can't pin the proxy alive on shutdown.
  const q = new RequestQueue({ maxConcurrent: 1, maxQueued: 4, queueTimeoutMs: 50, unrefTimers: false });
  await q.acquire(); // 1/1
  let thrown;
  try {
    await q.acquire(); // will enqueue, then time out after 50ms
  } catch (err) {
    thrown = err;
  }
  check('queued acquire throws after timeout', thrown !== undefined);
  check('error is QueueTimeoutError', thrown instanceof QueueTimeoutError);
  q.release();
}

// ─────────────────────────────────────────────────────────────
header('parsePositiveIntEnv — valid + invalid forms');
{
  check('undefined       → undefined', parsePositiveIntEnv(undefined) === undefined);
  check('""              → undefined', parsePositiveIntEnv('') === undefined);
  check('"10"            → 10',        parsePositiveIntEnv('10') === 10);
  check('"  42  " (ws)   → 42',        parsePositiveIntEnv('  42  ') === 42);
  check('"0"             → undefined', parsePositiveIntEnv('0') === undefined);
  check('"-5"            → undefined', parsePositiveIntEnv('-5') === undefined);
  check('"abc"           → undefined', parsePositiveIntEnv('abc') === undefined);
  check('"3.14" → 3 (parseInt truncates)', parsePositiveIntEnv('3.14') === 3);
}

// ─────────────────────────────────────────────────────────────
header('decideConsumerAdmit — the per-consumer gate is pure and only bites at the cap');
{
  const state = { active: 1, queued: 0, maxConcurrent: 10, maxQueued: 128 };
  check('cap off → null (not this gate\'s business)', decideConsumerAdmit(5, 0, state) === null);
  check('under the cap → null', decideConsumerAdmit(1, 2, state) === null);
  check('at the cap with queue room → enqueue', decideConsumerAdmit(2, 2, state)?.action === 'enqueue');
  check('at the cap, queue full → reject queue-full', decideConsumerAdmit(2, 2, { ...state, queued: 128 })?.action === 'reject');
}

// ─────────────────────────────────────────────────────────────
header('RequestQueue — a capped consumer waits while others keep flowing');
{
  const q = new RequestQueue({ maxConcurrent: 4, maxQueued: 8, maxConcurrentPerConsumer: 1, unrefTimers: false, queueTimeoutMs: 5_000 });
  await q.acquire('alice');                         // alice holds her one slot
  let aliceSecondAdmitted = false;
  const aliceSecond = q.acquire('alice').then(() => { aliceSecondAdmitted = true; });
  await new Promise((r) => setTimeout(r, 10));
  check('alice\'s second request queues although 3 slots are free', !aliceSecondAdmitted && q.snapshot().queued === 1 && q.snapshot().active === 1);
  await q.acquire('bob');                           // bob is not held up by alice's waiter
  check('bob is admitted at once past alice\'s waiter', q.snapshot().active === 2 && q.snapshot().queued === 1);
  check('snapshot reports the cap and the consumers in flight', q.snapshot().maxConcurrentPerConsumer === 1 && q.snapshot().consumersActive === 2);
  q.release('bob');
  await new Promise((r) => setTimeout(r, 10));
  check('bob\'s release does not admit alice\'s waiter (she is still at her cap)', !aliceSecondAdmitted && q.snapshot().active === 1);
  q.release('alice');
  await aliceSecond;
  check('alice\'s own release admits her waiter', aliceSecondAdmitted && q.snapshot().active === 1 && q.snapshot().queued === 0);
  q.release('alice');
  check('all released → no consumers in flight', q.snapshot().active === 0 && q.snapshot().consumersActive === 0);
}

// ─────────────────────────────────────────────────────────────
header('RequestQueue — FIFO among the admissible; an unnamed request is never capped');
{
  const q = new RequestQueue({ maxConcurrent: 1, maxQueued: 8, maxConcurrentPerConsumer: 1, unrefTimers: false, queueTimeoutMs: 5_000 });
  await q.acquire('alice');
  const order = [];
  const w1 = q.acquire('alice').then(() => order.push('alice-2'));
  const w2 = q.acquire('carol').then(() => order.push('carol'));
  const w3 = q.acquire().then(() => order.push('anon'));
  await new Promise((r) => setTimeout(r, 10));
  check('three waiters queued behind one slot', q.snapshot().queued === 3);
  q.release('alice');                               // slot frees; alice-2 is first in line but capped? no — alice released, so she is under cap again
  await w1;
  check('alice\'s waiter goes first once her slot is back (FIFO)', order[0] === 'alice-2');
  q.release('alice');
  await w2;
  check('then carol', order[1] === 'carol');
  q.release('carol');
  await w3;
  check('then the unnamed request', order[2] === 'anon');
  q.release();
  check('drained', q.snapshot().active === 0 && q.snapshot().queued === 0);
}

// ─────────────────────────────────────────────────────────────
header('RequestQueue — cap off behaves exactly as before');
{
  const q = new RequestQueue({ maxConcurrent: 2, maxQueued: 8, unrefTimers: false });
  await q.acquire('alice'); await q.acquire('alice');
  check('two for one consumer admitted with no cap', q.snapshot().active === 2 && q.snapshot().maxConcurrentPerConsumer === 0);
  q.release('alice'); q.release('alice');
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Unit tests for the bounded request queue that replaced the v3.30.x
// unbounded semaphore in dario#80. The pure decision function
// (`decideAdmit`) and timeout check (`isQueueEntryExpired`) exercise
// every branch without touching real timers; the `RequestQueue` class
// tests use short timeouts and assert the promise-based flow.

import {
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
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

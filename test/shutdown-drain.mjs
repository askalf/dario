#!/usr/bin/env node
// Unit tests for the SIGTERM drain (dario#1370). `waitForIdle` takes the
// in-flight count, the clock and the sleep as inputs, so every branch runs
// against a fake clock: no server, no real timers.
import {
  waitForIdle,
  DEFAULT_SHUTDOWN_GRACE_MS,
  SHUTDOWN_POLL_MS,
} from '../dist/shutdown-drain.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/** A clock that only moves when the drain sleeps. */
function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

/** An in-flight count that follows a script, one value per read. */
function scripted(values) {
  const reads = [];
  return {
    getActive: () => { const v = values.length > 1 ? values.shift() : values[0]; reads.push(v); return v; },
    reads,
  };
}

console.log('idle at once');
{
  const clock = fakeClock();
  const lines = [];
  const r = await waitForIdle(() => 0, { graceMs: 1000, now: clock.now, sleep: clock.sleep, log: (l) => lines.push(l) });
  check('drained', r.drained === true);
  check('waited nothing', r.waitedMs === 0 && r.remaining === 0);
  check('never slept', clock.sleeps.length === 0);
  check('said nothing', lines.length === 0);
}

console.log('drains within the grace');
{
  const clock = fakeClock();
  const lines = [];
  const count = scripted([2, 2, 1, 0]);
  const r = await waitForIdle(count.getActive, { graceMs: 5000, pollMs: 100, now: clock.now, sleep: clock.sleep, log: (l) => lines.push(l) });
  check('drained', r.drained === true && r.remaining === 0);
  check('waited three polls', r.waitedMs === 300);
  check('polled at the given interval', clock.sleeps.every((ms) => ms === 100));
  check('one line when the wait starts', lines[0] === '[dario] draining 2 in-flight request(s) before exit (up to 5s)');
  check('one line when it ends', lines[1] === '[dario] drained after 0.3s');
  check('nothing per poll', lines.length === 2);
}

console.log('gives up at the grace');
{
  const clock = fakeClock();
  const lines = [];
  const r = await waitForIdle(() => 3, { graceMs: 1000, pollMs: 250, now: clock.now, sleep: clock.sleep, log: (l) => lines.push(l) });
  check('not drained', r.drained === false);
  check('reports what is left', r.remaining === 3);
  check('waited exactly the grace', r.waitedMs === 1000);
  check('four polls', clock.sleeps.length === 4);
  check('says it is exiting anyway', lines[1] === '[dario] still 3 in flight after 1s; exiting');
  check('two lines only', lines.length === 2);
}

console.log('defaults');
{
  check('default grace is 90s', DEFAULT_SHUTDOWN_GRACE_MS === 90_000);
  check('default poll is 250ms', SHUTDOWN_POLL_MS === 250);
  const clock = fakeClock();
  await waitForIdle(scripted([1, 0]).getActive, { graceMs: 1000, now: clock.now, sleep: clock.sleep, log: () => {} });
  check('polls at SHUTDOWN_POLL_MS when unset', clock.sleeps[0] === SHUTDOWN_POLL_MS);
  const clock2 = fakeClock();
  await waitForIdle(scripted([1, 0]).getActive, { graceMs: 1000, pollMs: 0, now: clock2.now, sleep: clock2.sleep, log: () => {} });
  check('a zero poll is clamped to 1ms, never a busy loop', clock2.sleeps[0] === 1);
}

console.log('the count is re-read, not cached');
{
  const clock = fakeClock();
  const count = scripted([1, 1, 0]);
  await waitForIdle(count.getActive, { graceMs: 1000, pollMs: 10, now: clock.now, sleep: clock.sleep, log: () => {} });
  check('read once up front and once per poll', count.reads.length === 3);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

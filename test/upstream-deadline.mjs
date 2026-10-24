#!/usr/bin/env node
/**
 * test/upstream-deadline.mjs
 *
 * The upstream timeout caps the wait until the response streams, then only
 * the gap between chunks of a 2xx body. One timer over the whole request
 * aborted agent turns still streaming after five minutes. Pure unit checks
 * with a hand-driven clock, plus a short real-timer run and a source scan of
 * the call sites. Spawns nothing and reads no ~/.dario.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { upstreamDeadline } from '../dist/upstream-deadline.js';
import { MAX_TIMER_MS } from '../dist/timer-ms.js';
import { resolveUpstreamTimeoutMs } from '../dist/cli.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

/** A clock and timer queue that only move when told to. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const delays = [];
  return {
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; delays.push(ms); pending.set(id, { at: now + ms, fn }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
      now: () => now,
    },
    /** Move the clock to `now + ms`, running every timer that comes due, in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of pending) if (t.at <= end && (next === null || t.at < next[1].at)) next = [id, t];
        if (next === null) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    get now() { return now; },
    get pending() { return pending.size; },
    delays,
  };
}

const LIMIT = 300_000;

header('headers phase: one cap over the whole wait');
{
  const f = fakeTimers();
  let fires = 0;
  const d = upstreamDeadline(LIMIT, () => { fires++; }, f.timers);
  f.advance(LIMIT - 1);
  d.touch();
  check('not fired 1 ms before the limit', fires === 0 && !d.fired);
  f.advance(1);
  check('fires at the limit', fires === 1 && d.fired);
  check('touch() before streaming() does not extend it', fires === 1);
  f.advance(LIMIT * 3);
  check('fires once only', fires === 1, String(fires));
  check('nothing left armed after firing', f.pending === 0, String(f.pending));
}

header('streaming: a live stream is never cut');
{
  const f = fakeTimers();
  let fires = 0;
  const d = upstreamDeadline(LIMIT, () => { fires++; }, f.timers);
  f.advance(10_000);
  d.streaming();
  let maxPending = 0;
  // 30 minutes, a chunk every 100 s: six times the old whole-stream cap.
  for (let i = 0; i < 18; i++) {
    f.advance(100_000);
    d.touch();
    maxPending = Math.max(maxPending, f.pending);
  }
  check('no fire across 30 minutes of chunks', fires === 0 && !d.fired);
  check('at most one timer armed at a time', maxPending === 1, String(maxPending));
  check('touch() does not arm a timer per chunk', f.delays.length < 18, String(f.delays.length));
  const lastChunk = f.now;
  f.advance(LIMIT - 1);
  check('not fired 1 ms short of the idle limit after the last chunk', fires === 0);
  f.advance(1);
  check('fires the idle limit after the last chunk', fires === 1 && f.now - lastChunk === LIMIT);
}

header('streaming: chunks just inside the limit keep it alive');
{
  const f = fakeTimers();
  let fires = 0;
  const d = upstreamDeadline(LIMIT, () => { fires++; }, f.timers);
  d.streaming();
  for (let i = 0; i < 10; i++) { f.advance(LIMIT - 1); d.touch(); }
  check('a gap of limit minus 1 ms, ten times over, never fires', fires === 0);
  f.advance(LIMIT);
  check('a gap of the full limit fires', fires === 1);
}

header('streaming(): the idle gap counts from the switch, once');
{
  const f = fakeTimers();
  let fires = 0;
  const d = upstreamDeadline(LIMIT, () => { fires++; }, f.timers);
  f.advance(250_000);
  d.streaming();
  f.advance(100_000);
  check('time spent before headers is not charged to the idle gap', fires === 0);
  d.streaming();
  f.advance(LIMIT - 100_000);
  check('a second streaming() does not restart the gap', fires === 1, `fired at ${f.now}`);
}

header('clear(): disarms for good');
{
  const f = fakeTimers();
  let fires = 0;
  const d = upstreamDeadline(LIMIT, () => { fires++; }, f.timers);
  d.clear();
  check('nothing armed after clear() in the headers phase', f.pending === 0);
  f.advance(LIMIT * 2);
  check('never fires after clear()', fires === 0 && !d.fired);
  d.streaming();
  d.touch();
  f.advance(LIMIT * 2);
  check('streaming() and touch() after clear() stay disarmed', fires === 0 && f.pending === 0);
  d.clear();
  check('a second clear() is harmless', fires === 0);

  const g = fakeTimers();
  let gFires = 0;
  const e = upstreamDeadline(LIMIT, () => { gFires++; }, g.timers);
  e.streaming();
  g.advance(LIMIT / 2);
  e.clear();
  g.advance(LIMIT * 2);
  check('clear() while streaming disarms too', gFires === 0 && g.pending === 0);
}

header('the limit goes through clampTimerMs');
{
  const f = fakeTimers();
  upstreamDeadline(1e15, () => {}, f.timers);
  check('a huge value arms the longest timer, not 1 ms', f.delays[0] === MAX_TIMER_MS, String(f.delays[0]));
  const g = fakeTimers();
  let fires = 0;
  upstreamDeadline(Number.NaN, () => { fires++; }, g.timers);
  check('NaN arms 0', g.delays[0] === 0, String(g.delays[0]));
  g.advance(0);
  check('and fires at once', fires === 1);
  const h = fakeTimers();
  const d = upstreamDeadline(1e15, () => {}, h.timers);
  h.advance(10);
  d.streaming();
  h.advance(5);
  d.touch();
  h.advance(MAX_TIMER_MS - 1);
  check('the early-fire re-arm stays inside the timer ceiling', h.delays.every((ms) => ms >= 0 && ms <= MAX_TIMER_MS), h.delays.join());
}

header('real timers: a short stream with chunks, then silence');
{
  let fires = 0;
  const d = upstreamDeadline(60, () => { fires++; });
  d.streaming();
  const started = performance.now();
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 20));
    d.touch();
  }
  check('no fire while chunks arrive every 20 ms for 160 ms', fires === 0, `${fires} after ${Math.round(performance.now() - started)} ms`);
  await new Promise((r) => setTimeout(r, 250));
  check('fires once the stream goes quiet', fires === 1, String(fires));
  d.clear();
}

header('--upstream-timeout over DARIO_UPSTREAM_TIMEOUT_MS');
{
  check('flag only', resolveUpstreamTimeoutMs(5000, undefined) === 5000);
  check('env only', resolveUpstreamTimeoutMs(undefined, '1000') === 1000);
  check('flag wins over env', resolveUpstreamTimeoutMs(5000, '1000') === 5000);
  check('an explicit flag of 0 keeps the default over a positive env', resolveUpstreamTimeoutMs(0, '1000') === undefined);
  check('flag of 0 alone keeps the default', resolveUpstreamTimeoutMs(0, undefined) === undefined);
  check('env of 0 keeps the default', resolveUpstreamTimeoutMs(undefined, '0') === undefined);
  check('neither set keeps the default', resolveUpstreamTimeoutMs(undefined, undefined) === undefined);
}

header('call sites: no whole-request upstream timer is left');
{
  const src = (f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
  const sites = { 'proxy.ts': 2, 'codex-backend.ts': 2, 'openai-backend.ts': 1, 'midstream.ts': 1 };
  for (const [file, want] of Object.entries(sites)) {
    const s = src(file);
    const stale = s.split('\n').filter((l) => /setTimeout\(/.test(l) && /upstreamTimeoutMs|r\.timeoutMs/.test(l));
    check(`${file}: no setTimeout armed with the upstream timeout`, stale.length === 0, stale.join(' | '));
    const made = (s.match(/upstreamDeadline\(/g) ?? []).length;
    check(`${file}: ${want} upstreamDeadline site(s)`, made === want, String(made));
    const switched = (s.match(/\.streaming\(\)/g) ?? []).length;
    const touched = (s.match(/\.touch\(\)/g) ?? []).length;
    check(`${file}: each site switches to the idle gap and touches per chunk`, switched === want && touched === want, `streaming ${switched}, touch ${touched}`);
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

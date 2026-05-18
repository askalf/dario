#!/usr/bin/env node
// Tests for the v4 Analytics streaming behavior.
//
// Pins:
//   - Analytics extends EventEmitter and emits 'record' on append
//   - recent(n) returns the last n records (newest last)
//   - A misbehaving subscriber's exception is swallowed (proxy hot-path
//     must never crash because of an analytics observer)
//   - Listener limit is wide enough (TUI will attach multiple subscribers
//     across panels without hitting Node's default 10-listener warning)
//
// The /analytics/stream HTTP endpoint itself is exercised end-to-end
// in the TUI integration tests (M4). This file isolates the data-plane
// contract so a regression in the EventEmitter wiring is caught
// independently of the network surface.

import { Analytics } from '../dist/analytics.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

function makeRecord(overrides = {}) {
  return {
    timestamp: Date.now(),
    account: '__default__',
    model: 'claude-opus-4-7',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    thinkingTokens: 0,
    claim: 'five_hour',
    util5h: 0.1,
    util7d: 0.05,
    overageUtil: 0,
    latencyMs: 1234,
    status: 200,
    isStream: false,
    isOpenAI: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
header('Analytics extends EventEmitter');
{
  const a = new Analytics();
  check('has .on method',         typeof a.on === 'function');
  check('has .off method',        typeof a.off === 'function');
  check('has .emit method',       typeof a.emit === 'function');
  check('has .removeAllListeners', typeof a.removeAllListeners === 'function');
}

// ─────────────────────────────────────────────────────────────
header('record() emits the new record on a "record" event');
{
  const a = new Analytics();
  let received = null;
  a.on('record', (r) => { received = r; });
  const sent = makeRecord({ model: 'claude-haiku-4-5' });
  a.record(sent);
  check('listener fired',         received !== null);
  check('payload matches sent',   received && received.model === 'claude-haiku-4-5');
  check('account propagates',     received && received.account === '__default__');
  check('tokens propagate',       received && received.inputTokens === 100);
}

// ─────────────────────────────────────────────────────────────
header('Multiple subscribers all fire');
{
  const a = new Analytics();
  const seen = [];
  const subA = (r) => seen.push(['A', r.model]);
  const subB = (r) => seen.push(['B', r.model]);
  const subC = (r) => seen.push(['C', r.model]);
  a.on('record', subA);
  a.on('record', subB);
  a.on('record', subC);
  a.record(makeRecord({ model: 'x' }));
  check('all three subscribers received the event', seen.length === 3);
  check('subA fired',             seen.some(([who]) => who === 'A'));
  check('subB fired',             seen.some(([who]) => who === 'B'));
  check('subC fired',             seen.some(([who]) => who === 'C'));
}

// ─────────────────────────────────────────────────────────────
header('off() unsubscribes cleanly');
{
  const a = new Analytics();
  let fired = 0;
  const sub = () => { fired++; };
  a.on('record', sub);
  a.record(makeRecord());
  check('subscriber fired once before off()',  fired === 1);
  a.off('record', sub);
  a.record(makeRecord());
  a.record(makeRecord());
  check('subscriber did not fire after off()', fired === 1);
}

// ─────────────────────────────────────────────────────────────
header('Misbehaving subscriber does NOT crash record()');
{
  const a = new Analytics();
  const errs = [];
  const orig = console.error;
  console.error = (...args) => errs.push(args.join(' '));
  try {
    let goodFired = false;
    a.on('record', () => { throw new Error('subscriber boom'); });
    a.on('record', () => { goodFired = true; });
    // Node EventEmitter's emit-throws-from-listener path:
    // Default behavior is "first listener throw aborts subsequent
    // listeners". Analytics wraps the whole emit in try/catch so the
    // CALLER doesn't crash, but later listeners on the same emit ARE
    // skipped (per Node's spec). That's documented in the class.
    a.record(makeRecord());
    check('record() did not throw to caller', true);
    check('error swallowed + logged',         errs.some(e => e.includes('subscriber threw')));
    // Note: `goodFired` is intentionally NOT asserted true — Node's
    // EventEmitter halts subsequent listeners on the first throw.
    // The TUI surface should defensively not throw in its handlers.
    void goodFired;
  } finally {
    console.error = orig;
  }
}

// ─────────────────────────────────────────────────────────────
header('recent(n) returns last n records, newest last');
{
  const a = new Analytics();
  for (let i = 0; i < 10; i++) {
    a.record(makeRecord({ model: `m${i}` }));
  }
  const last5 = a.recent(5);
  check('recent(5) returns 5',    last5.length === 5);
  check('newest last',            last5[last5.length - 1].model === 'm9');
  check('drops oldest 5',         !last5.some(r => r.model === 'm0'));

  const all = a.recent(100);
  check('recent(N) where N > count returns all', all.length === 10);

  const def = a.recent();
  check('recent() default is 100',
    def.length === 10);   // 10 records exist, default cap is 100, so returns all 10
}

// ─────────────────────────────────────────────────────────────
header('record() respects maxRecords ring-buffer');
{
  const a = new Analytics(5);  // cap of 5
  for (let i = 0; i < 12; i++) {
    a.record(makeRecord({ model: `m${i}` }));
  }
  const all = a.recent(100);
  check('only 5 records retained', all.length === 5);
  check('oldest dropped',          all[0].model === 'm7');
  check('newest preserved',        all[all.length - 1].model === 'm11');
}

// ─────────────────────────────────────────────────────────────
header('Listener-cap is generous (TUI will attach several)');
{
  const a = new Analytics();
  // Default Node EventEmitter warns at 10 — we set 100. Attach 50 and
  // verify no warning is emitted.
  const warnings = [];
  const origWarn = process.emitWarning;
  process.emitWarning = (msg, ...rest) => warnings.push([msg, ...rest]);
  try {
    for (let i = 0; i < 50; i++) a.on('record', () => {});
    a.record(makeRecord());
    const memLeakWarnings = warnings.filter(w => String(w[0]).includes('MaxListenersExceeded'));
    check('no MaxListenersExceeded warning at 50 listeners',
      memLeakWarnings.length === 0,
      memLeakWarnings.length > 0 ? warnings.map(w => w[0]).join(' | ') : '');
  } finally {
    process.emitWarning = origWarn;
  }
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

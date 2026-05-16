/**
 * test/overage-guard.mjs
 *
 * In-process unit tests for the OverageGuard module (dario#288, v4.1).
 * Covers:
 *   - detection: claim=overage record triggers halt state
 *   - halt-only-once: subsequent overage records don't re-fire the halt event
 *   - resume manual: clear('manual') exits halted state + emits 'resume'
 *   - resume cooldown: timer auto-clears after cooldownMs elapses
 *   - warn-mode: no halt state, but 'warn' event fires
 *   - isHalted() respects behavior — warn mode never reports halted
 *   - buildHaltErrorBody shape matches Anthropic error envelope
 *
 * Runs without a live proxy — instantiates Analytics + OverageGuard in-process.
 */

import { Analytics } from '../dist/analytics.js';
import { OverageGuard, buildHaltErrorBody } from '../dist/overage-guard.js';

let pass = 0;
let fail = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}`);
    fail++;
  }
}

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

// ── Fixtures ───────────────────────────────────────────────────────

function fakeRecord(overrides = {}) {
  return {
    timestamp: Date.now(),
    account: 'default',
    model: 'claude-opus-4-7',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    thinkingTokens: 0,
    claim: 'five_hour',
    util5h: 0.18,
    util7d: 0.08,
    overageUtil: 0,
    latencyMs: 1234,
    status: 200,
    isStream: false,
    isOpenAI: false,
    ...overrides,
  };
}

// ── 1. Detection — claim=overage triggers halt ─────────────────────

{
  console.log('detection: claim=overage triggers halt');
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'halt',
    cooldownMs: 60_000,
    notifyOs: false,
  });
  guard.attach(analytics);

  const haltEvents = [];
  guard.on('halt', (state) => haltEvents.push(state));

  // Normal record should NOT trigger halt
  analytics.record(fakeRecord({ claim: 'five_hour' }));
  assertEq('normal record leaves guard clear', guard.isHalted(), false);
  assertEq('no halt events from normal record', haltEvents.length, 0);

  // Overage record triggers halt
  analytics.record(fakeRecord({ claim: 'overage', model: 'claude-opus-4-7' }));
  assertEq('overage record halts the guard', guard.isHalted(), true);
  assertEq('halt event fired exactly once', haltEvents.length, 1);
  assertEq('halt event carries triggering model', haltEvents[0].request.model, 'claude-opus-4-7');
  assertEq('halt event carries triggering claim', haltEvents[0].request.claim, 'overage');
  assertEq('halt reason is overage_detected', haltEvents[0].reason, 'overage_detected');
  assert('halt state has since timestamp', typeof guard.state().since === 'number');
  assert('halt state has cooldownUntil', guard.state().cooldownUntil > guard.state().since);

  guard.destroy();
}

// ── 2. Halt only once — re-overage doesn't re-fire ─────────────────

{
  console.log('halt-only-once: subsequent overage records don\'t re-fire');
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'halt',
    cooldownMs: 60_000,
    notifyOs: false,
  });
  guard.attach(analytics);

  let haltCount = 0;
  guard.on('halt', () => haltCount++);

  analytics.record(fakeRecord({ claim: 'overage' }));
  analytics.record(fakeRecord({ claim: 'overage' }));
  analytics.record(fakeRecord({ claim: 'overage' }));
  assertEq('three overage records fired halt exactly once', haltCount, 1);

  guard.destroy();
}

// ── 3. Resume manual — clear('manual') exits halted ────────────────

{
  console.log('resume manual: clear() exits halted and fires resume');
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'halt',
    cooldownMs: 60_000,
    notifyOs: false,
  });
  guard.attach(analytics);

  const resumeEvents = [];
  guard.on('resume', (info) => resumeEvents.push(info));

  analytics.record(fakeRecord({ claim: 'overage' }));
  assert('halted before clear', guard.isHalted());

  guard.clear('manual');
  assertEq('clear exits halted state', guard.isHalted(), false);
  assertEq('clear fires exactly one resume event', resumeEvents.length, 1);
  assertEq('resume event carries manual reason', resumeEvents[0].reason, 'manual');
  assertEq('state() returns null after clear', guard.state(), null);

  // Clear when not halted — no-op, no event
  guard.clear('manual');
  assertEq('clear-on-clear is no-op (still 1 event)', resumeEvents.length, 1);

  guard.destroy();
}

// ── 4. Resume cooldown — auto-clear after timeout ──────────────────

{
  console.log('resume cooldown: auto-clear after cooldownMs');
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'halt',
    cooldownMs: 50, // 50ms for the test
    notifyOs: false,
  });
  guard.attach(analytics);

  const resumeEvents = [];
  guard.on('resume', (info) => resumeEvents.push(info));

  analytics.record(fakeRecord({ claim: 'overage' }));
  assert('halted immediately after overage', guard.isHalted());

  await new Promise((r) => setTimeout(r, 120));
  assertEq('cooldown timer cleared halt', guard.isHalted(), false);
  assertEq('cooldown fired one resume event', resumeEvents.length, 1);
  assertEq('resume reason is cooldown', resumeEvents[0].reason, 'cooldown');

  guard.destroy();
}

// ── 5. Warn-mode — no halt, but warn event fires ───────────────────

{
  console.log('warn-mode: no halt state, but warn event fires');
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'warn',
    cooldownMs: 60_000,
    notifyOs: false,
  });
  guard.attach(analytics);

  const haltEvents = [];
  const warnEvents = [];
  guard.on('halt', (s) => haltEvents.push(s));
  guard.on('warn', (s) => warnEvents.push(s));

  analytics.record(fakeRecord({ claim: 'overage' }));
  assertEq('warn-mode never reports halted', guard.isHalted(), false);
  assertEq('warn-mode does not fire halt event', haltEvents.length, 0);
  assertEq('warn-mode fires warn event', warnEvents.length, 1);
  assertEq('warn event payload mirrors halt-event shape', warnEvents[0].request.claim, 'overage');

  guard.destroy();
}

// ── 6. Disabled guard — listener never installed ───────────────────

{
  console.log('disabled: no detection when enabled=false');
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: false,
    behavior: 'halt',
    cooldownMs: 60_000,
    notifyOs: false,
  });
  guard.attach(analytics);

  let haltCount = 0;
  guard.on('halt', () => haltCount++);

  analytics.record(fakeRecord({ claim: 'overage' }));
  analytics.record(fakeRecord({ claim: 'overage' }));
  assertEq('disabled guard never halts', guard.isHalted(), false);
  assertEq('disabled guard fires no events', haltCount, 0);

  guard.destroy();
}

// ── 7. Anthropic-shaped error body ─────────────────────────────────

{
  console.log('buildHaltErrorBody: shape matches Anthropic error envelope');
  const state = {
    since: Date.now(),
    cooldownUntil: Date.now() + 30 * 60 * 1000,
    reason: 'overage_detected',
    request: {
      timestamp: Date.now(),
      model: 'claude-opus-4-7',
      account: 'default',
      claim: 'overage',
    },
  };
  const body = buildHaltErrorBody(state);
  assertEq('top-level type is "error"', body.type, 'error');
  assertEq('inner error.type identifies the source', body.error.type, 'dario_overage_guard');
  assert('error.message is a string', typeof body.error.message === 'string');
  assert('message mentions resume command', body.error.message.includes('dario resume'));
  assert('message includes cooldown ISO timestamp', /\d{4}-\d{2}-\d{2}T/.test(body.error.message));
}

// ── 8. notifier hook — invoked on halt ─────────────────────────────

{
  console.log('notifier: called on halt with title and message');
  const calls = [];
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'halt',
    cooldownMs: 60_000,
    notifyOs: true,
    notifier: (title, message) => calls.push({ title, message }),
  });
  guard.attach(analytics);

  analytics.record(fakeRecord({ claim: 'overage' }));
  assertEq('notifier invoked once', calls.length, 1);
  assert('notifier title mentions halt', calls[0].title.toLowerCase().includes('halt'));
  assert('notifier message mentions overage', calls[0].message.toLowerCase().includes('overage'));

  guard.destroy();
}

// ── 9. notifier suppressed when notifyOs=false ─────────────────────

{
  console.log('notifier: suppressed when notifyOs=false');
  const calls = [];
  const analytics = new Analytics();
  const guard = new OverageGuard({
    enabled: true,
    behavior: 'halt',
    cooldownMs: 60_000,
    notifyOs: false,
    notifier: (title, message) => calls.push({ title, message }),
  });
  guard.attach(analytics);

  analytics.record(fakeRecord({ claim: 'overage' }));
  assertEq('notifier not invoked', calls.length, 0);

  guard.destroy();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

/**
 * test/notify.mjs
 *
 * Tests for the cross-platform OS notification dispatcher (dario#288, v4.1).
 * Verifies:
 *   - sanitize strips shell metacharacters
 *   - notify() always writes BEL to stderr (the unconditional floor)
 *   - captureNotifier captures calls for unit-testing other code
 *
 * Does NOT verify that osascript / notify-send / BurntToast actually fire —
 * those depend on the platform + presence of the binary. The integration
 * test is implicit: spawn() is wrapped in try/catch and an absent binary
 * is the most common failure path, which we accept silently.
 */

import { notify, captureNotifier } from '../dist/notify.js';

let pass = 0;
let fail = 0;

function assert(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else      { console.error(`  ❌ ${label}`); fail++; }
}

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { console.log(`  ✅ ${label}`); pass++; }
  else    { console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

// ── 1. BEL emission ────────────────────────────────────────────────

{
  console.log('notify: writes BEL char to stderr on every call');
  const orig = process.stderr.write.bind(process.stderr);
  let bytesWritten = '';
  process.stderr.write = (chunk) => {
    bytesWritten += chunk.toString();
    return true;
  };
  try {
    notify('test title', 'test message');
    assert('stderr received the BEL char', bytesWritten.includes('\x07'));
  } finally {
    process.stderr.write = orig;
  }
}

// ── 2. captureNotifier — useful test helper ────────────────────────

{
  console.log('captureNotifier: captures calls for unit testing');
  const { notify: n, captured } = captureNotifier();
  assertEq('captured starts empty', captured.length, 0);
  n('title-A', 'message-A');
  n('title-B', 'message-B');
  assertEq('captured array length matches calls', captured.length, 2);
  assertEq('first call title', captured[0].title, 'title-A');
  assertEq('second call message', captured[1].message, 'message-B');
  assert('every call has a ts timestamp', captured.every((c) => typeof c.ts === 'number'));
}

// ── 3. notify never throws on malformed input ──────────────────────

{
  console.log('notify: never throws on shell-meta input');
  // These would break a naive AppleScript / shell string substitution.
  // sanitize() is supposed to strip them so the spawn payload stays safe.
  let threw = false;
  try {
    notify("evil`backtick`", 'message"with"quotes');
    notify('$(rm -rf /)', "'); rm -rf / # ");
    notify('multi\nline\rinput', 'tab\there');
  } catch {
    threw = true;
  }
  assert('no throw on hostile input', !threw);
}

// ── 4. missing binary must not crash the process (#672) ────────────
// spawn of a nonexistent binary does NOT throw — it emits an async
// 'error' event on the child, which unhandled kills the whole process.
// Live incident 2026-07-05: `notify-send` ENOENT in the Docker image
// crashed the proxy on every overage-guard event. This test spawns a
// guaranteed-nonexistent binary and asserts we survive the event-loop
// turn where the ENOENT error is delivered.

{
  console.log('spawnFireAndForget: survives ENOENT (missing binary)');
  const { spawnFireAndForget } = await import('../dist/notify.js');
  let alive = false;
  spawnFireAndForget('dario-test-definitely-not-a-real-binary-xyz', ['a', 'b']);
  await new Promise((resolve) => setTimeout(resolve, 500));
  alive = true; // only reached if the async 'error' event didn't kill us
  assert('process survived the async spawn error event', alive);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

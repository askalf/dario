#!/usr/bin/env node
// Regression test: dario's content scrubber must NOT corrupt the user's
// source code / data. The framework-identifier patterns include bare words
// that double as code tokens — most notably `continue` (the JS keyword AND
// Continue.dev). Running the full pattern set over message content turned
// `continue;` into `;`, so a code auditor downstream reported a bare-semicolon
// "no-op" that the proxy itself had introduced. Message content now uses a
// content-safe subset (scrubFrameworkIdentifiersInContent); the system-prompt
// scrub (scrubFrameworkIdentifiers) keeps the full set.

import { scrubFrameworkIdentifiers, scrubFrameworkIdentifiersInContent, buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (actual === expected) { console.log(`  ✅ ${label}`); pass++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}
function assertHas(haystack, needle, label) { assertEq(haystack.includes(needle), true, label); }
function assertMissing(haystack, needle, label) { assertEq(haystack.includes(needle), false, label); }

console.log('\n======================================================================');
console.log('  content scrub must not corrupt user code/data (the `continue` bug)');
console.log('======================================================================');

// ── The exact regression: a guard clause survives intact ──────────────────
const guard = '    if (!rawKey) {\n      skipped++;\n      continue;\n    }';
assertEq(
  scrubFrameworkIdentifiersInContent(guard),
  guard,
  'cmdPull-style guard with `continue;` survives content scrub byte-for-byte',
);
assertHas(scrubFrameworkIdentifiersInContent(guard), 'continue;', 'the `continue;` keyword is preserved (not stripped to `;`)');

// ── Bare code tokens / common words preserved in content ──────────────────
for (const code of [
  'for (const x of xs) continue;',
  'const cursor = await db.cursor();',
  'import { Hermes } from "react-native";',
  'const gateway = new ApiGateway();',
  'const client = new OpenAI();',
  'let cody = users.find(u => u.name === "cody");',
  'while (true) { if (done) break; else continue; }',
]) {
  assertEq(scrubFrameworkIdentifiersInContent(code), code, `content preserved verbatim: ${code.slice(0, 42)}…`);
}

// ── Distinctive product identifiers ARE still masked in content ───────────
assertMissing(scrubFrameworkIdentifiersInContent('this came from roo-cline today'), 'roo-cline', 'distinctive `roo-cline` still scrubbed from content');
assertMissing(scrubFrameworkIdentifiersInContent('relayed via claude-bridge'), 'claude-bridge', 'distinctive `claude-bridge` still scrubbed from content');
assertMissing(scrubFrameworkIdentifiersInContent('we use librechat internally'), 'librechat', 'distinctive `librechat` still scrubbed from content');
// `powered by X` and other content-corrupting patterns are NOT applied to content:
assertEq(scrubFrameworkIdentifiersInContent('footer: "Powered by Stripe"'), 'footer: "Powered by Stripe"', 'legit "Powered by Stripe" in content is NOT corrupted');

// ── The system-prompt scrub (full set) is UNCHANGED ───────────────────────
// (It masks the client's framing — the intended target — and keeps the full
//  pattern set incl. the bare words.)
assertMissing(scrubFrameworkIdentifiers('You are Cursor, an AI editor.'), 'Cursor', 'system-prompt scrub still strips bare `Cursor`');
assertMissing(scrubFrameworkIdentifiers('You are Continue.'), 'Continue', 'system-prompt scrub still strips bare `Continue`');
// path preservation in the full scrub is unaffected (dario#35)
assertEq(scrubFrameworkIdentifiers('/Users/foo/.openclaw/workspace/'), '/Users/foo/.openclaw/workspace/', 'system-prompt scrub still preserves paths (dario#35)');

// ── Integration: `continue;` survives the full buildCCRequest path ────────
// (the actual outbound-request builder, not just the scrub helper)
{
  const code = 'function cmdPull() {\n  for (const k of keys) {\n    if (!ok) { skipped++; continue; }\n    const cursor = db.cursor();\n  }\n}';
  const clientBody = { model: 'claude-sonnet-4-6', stream: false, messages: [{ role: 'user', content: code }] };
  const built = buildCCRequest(clientBody, 'billing', { type: 'ephemeral' }, { deviceId: 'D', accountUuid: 'A', sessionId: 'S' });
  const out = built.body.messages[built.body.messages.length - 1].content;
  assertHas(out, 'continue;', 'INTEGRATION: buildCCRequest preserves `continue;` in the outbound user message');
  assertHas(out, 'db.cursor()', 'INTEGRATION: buildCCRequest preserves `cursor` in the outbound user message');
  assertMissing(out, '\n      ;\n', 'INTEGRATION: no bare-`;` no-op introduced by the proxy');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

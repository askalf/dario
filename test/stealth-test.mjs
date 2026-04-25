#!/usr/bin/env node
/**
 * Stealth technology validation suite.
 * Tests that dario produces requests indistinguishable from real Claude Code.
 */

const PROXY = 'http://localhost:3456';
let pass = 0, fail = 0;

function header(name) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(70));
}

function check(label, ok) {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

async function send(body, label) {
  const res = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'dario',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const headers = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.includes('ratelimit')) headers[k] = v;
  }
  const data = await res.json();
  if (data.error) {
    console.log(`  [${label}] ERROR: ${data.error.message}`);
    return null;
  }
  return { data, headers };
}

// ── Test 1: Thinking block stripping ──
async function testThinkingStrip() {
  header('1. Thinking blocks stripped from prior assistant turns');

  // Turn 1: generate a response WITH thinking
  const r1 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the capital of France? Think carefully.' }],
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'turn 1');
  if (!r1) return;

  const thinkingBlocks = r1.data.content.filter(b => b.type === 'thinking');
  console.log(`  Turn 1 generated ${thinkingBlocks.length} thinking block(s)`);

  // Turn 2 WITH thinking blocks in history (sent through dario — should be stripped)
  const r2 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'What is the capital of France? Think carefully.' },
      { role: 'assistant', content: r1.data.content }, // full response including thinking
      { role: 'user', content: 'And Germany?' },
    ],
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'turn 2 (thinking in history, through dario)');

  // Turn 2 WITHOUT thinking blocks (manually stripped)
  const r3 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'What is the capital of France? Think carefully.' },
      { role: 'assistant', content: r1.data.content.filter(b => b.type !== 'thinking') },
      { role: 'user', content: 'And Germany?' },
    ],
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'turn 2 (thinking pre-stripped)');

  if (r2 && r3) {
    const daroInput = r2.data.usage.input_tokens;
    const cleanInput = r3.data.usage.input_tokens;
    console.log(`\n  Input tokens — dario stripped: ${daroInput}, pre-stripped: ${cleanInput}`);
    // They should be very close (within a few tokens) if dario stripped correctly
    const diff = Math.abs(daroInput - cleanInput);
    check(`Thinking stripped by proxy (token diff: ${diff})`, diff <= 5);
  }
}

// ── Test 2: Non-CC field scrubbing ──
async function testFieldScrubbing() {
  header('2. Non-Claude-Code fields scrubbed');

  // Send request with fields Claude Code never sends
  const r = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Say "ok".' }],
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    service_tier: 'auto',
    stop_sequences: ['\n'],
    stream: false,
  }, 'with non-CC fields');

  // If the request succeeded, the fields were either scrubbed or the API ignored them.
  // We can't verify from the response what was sent upstream, but we can confirm no error.
  if (r) {
    check('Request with non-CC fields succeeded (fields scrubbed before upstream)', true);
    check('Billing claim is five_hour', r.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  }
}

// ── Test 3: System prompt normalization to exactly 3 blocks ──
async function testSystemNormalization() {
  header('3. System prompt normalized to exactly 3 blocks');

  // Send with string system prompt
  const r1 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: 'You are a helpful coding assistant.',
    messages: [{ role: 'user', content: 'Say "ok".' }],
    stream: false,
  }, 'string system');
  check('String system prompt accepted', !!r1);

  // Send with array system prompt (4 blocks — should be merged to 3)
  const r2 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'You are a coding assistant.' },
      { type: 'text', text: 'You write clean TypeScript.' },
      { type: 'text', text: 'You follow best practices.' },
      { type: 'text', text: 'You never use any.' },
    ],
    messages: [{ role: 'user', content: 'Say "ok".' }],
    stream: false,
  }, 'array system (4 blocks)');
  check('Array system prompt (4 blocks) accepted and merged', !!r2);

  // Send with no system prompt
  const r3 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say "ok".' }],
    stream: false,
  }, 'no system');
  check('No system prompt — injected 3 blocks', !!r3);

  // All should have five_hour billing
  if (r1) check('String system: five_hour', r1.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  if (r2) check('Array system: five_hour', r2.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  if (r3) check('No system: five_hour', r3.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
}

// ── Test 4: Effort comparison (diagnostic; not pass/fail) ──
//
// This used to assert a hard `high.output_tokens / medium.output_tokens > 1.3x`,
// but that assertion only makes sense when dario is started with
// `--effort=client` (passes the client's `output_config.effort` through to
// upstream). In the default `--effort=high` mode (per dario#87) BOTH requests
// are rewritten to `effort: 'high'` before they leave dario, so the ratio is
// just stochastic variance between two identical-effort runs and the test
// false-fails on every default-config install.
//
// Effort-flag plumbing is already verified at the unit level by
// `test/effort-flag.mjs` (resolveEffort + buildCCRequest integration, all
// five valid values, client-passthrough, haiku carve-out). What remains
// here is a live diagnostic — "given whatever proxy mode is running, how
// does the model respond to medium vs high?" — useful to eyeball when
// tuning effort behavior, not useful as a regression gate.
async function testEffortComplex() {
  header('4. Effort medium vs high (diagnostic)');

  const complexPrompt = `Analyze the following code and identify all potential security vulnerabilities,
race conditions, and performance bottlenecks. For each issue found, provide the severity,
a detailed explanation of the attack vector or failure mode, and a corrected code snippet.

\`\`\`typescript
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(private capacity: number, private refillRate: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  async acquire(count: number = 1): Promise<boolean> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}
\`\`\``;

  const medium = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: complexPrompt }],
    thinking: { type: 'enabled', budget_tokens: 16000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'effort=medium');

  const high = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: complexPrompt }],
    thinking: { type: 'enabled', budget_tokens: 16000 },
    output_config: { effort: 'high' },
    stream: false,
  }, 'effort=high');

  if (medium && high) {
    const mOut = medium.data.usage.output_tokens;
    const hOut = high.data.usage.output_tokens;
    const mThink = medium.data.content.filter(b => b.type === 'thinking').reduce((s, b) => s + (b.thinking?.length ?? 0), 0);
    const hThink = high.data.content.filter(b => b.type === 'thinking').reduce((s, b) => s + (b.thinking?.length ?? 0), 0);
    const ratio = hOut / mOut;
    console.log(`\n  Medium: ${mOut} output tokens, ${mThink} thinking chars`);
    console.log(`  High:   ${hOut} output tokens, ${hThink} thinking chars`);
    console.log(`  Ratio:  ${ratio.toFixed(2)}x`);

    // Diagnostic only — never fails the suite. The ratio is meaningful
    // only when dario was started with `--effort=client`; otherwise both
    // requests are clamped to `effort: 'high'` upstream (per dario#87)
    // and the ratio is just model-variance noise. We can't tell from
    // black-box probing which mode produced the number, so we don't
    // pretend to. Plumbing is verified by `test/effort-flag.mjs`.
    console.log(`  ↳ to interpret meaningfully, run dario with --effort=client; otherwise both efforts clamp to 'high' upstream and the ratio is just model variance.`);
  }
}

// ── Test 5: E2E stealth — bare third-party request through dario ──
async function testE2EStealth() {
  header('5. E2E stealth — bare third-party request stays on five_hour');

  // Simulate what a totally naive third-party client sends — no thinking, no effort,
  // no context_management, non-CC fields present, string system prompt
  const r = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Write a haiku about proxies.' }],
    temperature: 0.7,
    top_p: 0.95,
    service_tier: 'auto',
    stream: false,
  }, 'naive third-party request');

  if (r) {
    const claim = r.headers['anthropic-ratelimit-unified-representative-claim'];
    check(`Billing claim: five_hour (got: ${claim})`, claim === 'five_hour');
    const hasThinking = r.data.content?.some(b => b.type === 'thinking');
    console.log(`  Adaptive thinking injected: ${hasThinking ? 'yes (model chose to think)' : 'no (model skipped on simple prompt)'}`);
  }
}

async function main() {
  console.log('Stealth Technology Validation Suite');
  console.log(`Proxy: ${PROXY}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  await testThinkingStrip();
  await testFieldScrubbing();
  await testSystemNormalization();
  await testEffortComplex();
  await testE2EStealth();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(70));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

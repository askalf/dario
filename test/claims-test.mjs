#!/usr/bin/env node
/**
 * Claims verification test suite.
 * Tests every technical claim we made in Discussion #9 and Issue #7 responses.
 *
 * Tests:
 * 1. effort: medium vs high — token consumption difference
 * 2. context_management: clear_thinking — does it strip thinking server-side?
 * 3. thinking: adaptive vs enabled — token difference
 * 4. Thinking blocks in messages array — do they burn input tokens?
 * 5. dario default injection — are defaults applied correctly?
 * 6. CLAUDE_CODE_EFFORT_LEVEL env var — does it do anything in Claude Code CLI?
 */

const PROXY = 'http://localhost:3456';
const DIRECT_PROMPT = 'Reply with exactly: "Hello." Nothing else.';

function header(name) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  TEST: ${name}`);
  console.log('='.repeat(70));
}

function extractTokens(usage) {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cache_read: usage?.cache_read_input_tokens ?? 0,
    cache_creation: usage?.cache_creation_input_tokens ?? 0,
  };
}

function extractThinkingTokens(content) {
  if (!Array.isArray(content)) return 0;
  return content
    .filter(b => b.type === 'thinking')
    .reduce((sum, b) => sum + (b.thinking?.length ?? 0), 0);
}

async function sendRequest(body, label) {
  const res = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'dario',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const rateHeaders = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.includes('ratelimit') || k.includes('billing')) {
      rateHeaders[k] = v;
    }
  }

  const data = await res.json();
  if (data.error) {
    console.log(`  [${label}] ERROR: ${data.error.message}`);
    return null;
  }

  const tokens = extractTokens(data.usage);
  const thinkingChars = extractThinkingTokens(data.content);
  const claim = rateHeaders['anthropic-ratelimit-unified-representative-claim'] ?? '?';
  const util5h = rateHeaders['anthropic-ratelimit-unified-5h-utilization'] ?? '?';

  console.log(`  [${label}]`);
  console.log(`    input=${tokens.input} output=${tokens.output} cache_read=${tokens.cache_read} cache_create=${tokens.cache_creation}`);
  console.log(`    thinking_chars=${thinkingChars} claim=${claim} 5h_util=${util5h}`);

  return { tokens, thinkingChars, claim, util5h, data, rateHeaders };
}

// ── Test 1: effort medium vs high ──
async function testEffort() {
  header('1. effort: medium vs high token consumption');

  const base = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Explain what a binary search tree is in 2 sentences.' }],
    thinking: { type: 'enabled', budget_tokens: 8000 },
    stream: false,
  };

  const medium = await sendRequest({
    ...base,
    output_config: { effort: 'medium' },
  }, 'effort=medium');

  const high = await sendRequest({
    ...base,
    output_config: { effort: 'high' },
  }, 'effort=high');

  if (medium && high) {
    const ratio = high.tokens.output / medium.tokens.output;
    console.log(`\n  RESULT: high/medium output ratio = ${ratio.toFixed(2)}x`);
    console.log(`  CLAIM "2-3x difference": ${ratio >= 1.5 ? 'PLAUSIBLE' : 'NOT CONFIRMED'}`);
  }
}

// ── Test 2: context_management clear_thinking ──
async function testClearThinking() {
  header('2. context_management: clear_thinking strips thinking from history');

  // First request generates thinking
  const r1 = await sendRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is 2+2?' }],
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'turn 1');

  if (!r1) return;

  // Build history WITH thinking blocks
  const historyWithThinking = [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: r1.data.content }, // includes thinking blocks
    { role: 'user', content: 'What is 3+3?' },
  ];

  // Build history WITHOUT thinking blocks
  const historyClean = [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: r1.data.content.filter(b => b.type !== 'thinking') },
    { role: 'user', content: 'What is 3+3?' },
  ];

  // With thinking in history, WITH context_management
  const r2a = await sendRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: historyWithThinking,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    stream: false,
  }, 'thinking in history + clear_thinking');

  // With thinking in history, WITHOUT context_management
  const r2b = await sendRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: historyWithThinking,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'thinking in history, no clear_thinking');

  // Clean history (thinking stripped client-side)
  const r2c = await sendRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: historyClean,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    output_config: { effort: 'medium' },
    stream: false,
  }, 'thinking stripped client-side');

  if (r2a && r2b && r2c) {
    console.log('\n  INPUT TOKEN COMPARISON:');
    console.log(`    With thinking + clear_thinking:    ${r2a.tokens.input}`);
    console.log(`    With thinking, no clear_thinking:   ${r2b.tokens.input}`);
    console.log(`    Thinking stripped client-side:       ${r2c.tokens.input}`);
    console.log(`\n  CLAIM "clear_thinking strips server-side":`);
    console.log(`    ${r2a.tokens.input < r2b.tokens.input ? 'CONFIRMED — fewer input tokens with clear_thinking' : 'NOT CONFIRMED — same input tokens'}`);
    console.log(`  CLAIM "client-side stripping reduces input tokens":`);
    console.log(`    ${r2c.tokens.input < r2b.tokens.input ? 'CONFIRMED' : 'NOT CONFIRMED'}`);
  }
}

// ── Test 3: adaptive vs enabled thinking ──
async function testAdaptiveVsEnabled() {
  header('3. thinking: adaptive vs enabled token difference');

  const base = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: DIRECT_PROMPT }],
    output_config: { effort: 'medium' },
    stream: false,
  };

  const adaptive = await sendRequest({
    ...base,
    thinking: { type: 'adaptive' },
  }, 'adaptive');

  const enabled = await sendRequest({
    ...base,
    thinking: { type: 'enabled', budget_tokens: 8000 },
  }, 'enabled (budget=8000)');

  if (adaptive && enabled) {
    console.log('\n  OUTPUT TOKEN COMPARISON:');
    console.log(`    adaptive: ${adaptive.tokens.output} (thinking_chars: ${adaptive.thinkingChars})`);
    console.log(`    enabled:  ${enabled.tokens.output} (thinking_chars: ${enabled.thinkingChars})`);
    console.log(`\n  CLAIM "adaptive lets model skip thinking on trivial tasks":`);
    console.log(`    ${adaptive.thinkingChars < enabled.thinkingChars ? 'CONFIRMED' : 'NOT CONFIRMED'}`);
  }
}

// ── Test 4: dario default injection ──
async function testDarioDefaults() {
  header('4. dario injects defaults (send bare request, check response)');

  // Send minimal request — no thinking, no effort, no context_management
  const r = await sendRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'Say "test".' }],
    stream: false,
  }, 'bare request through dario');

  if (r) {
    const hasThinking = r.data.content?.some(b => b.type === 'thinking');
    console.log(`\n  Response has thinking blocks: ${hasThinking ? 'YES — adaptive thinking was injected' : 'NO'}`);
    console.log(`  CLAIM "dario injects adaptive thinking": ${hasThinking ? 'CONFIRMED' : 'INCONCLUSIVE (model may skip thinking on trivial prompt)'}`);
  }
}

// ── Test 5: CLAUDE_CODE_EFFORT_LEVEL env var ──
async function testEnvVar() {
  header('5. CLAUDE_CODE_EFFORT_LEVEL env var');

  const { execSync } = await import('child_process');

  try {
    // Check if claude CLI exists
    const version = execSync('claude --version 2>&1', { encoding: 'utf8', timeout: 5000 }).trim();
    console.log(`  Claude CLI: ${version}`);

    // Test with effort env var
    const result = execSync(
      'CLAUDE_CODE_EFFORT_LEVEL=low claude --print "Say test" 2>&1',
      { encoding: 'utf8', timeout: 30000 }
    ).trim();
    console.log(`  With CLAUDE_CODE_EFFORT_LEVEL=low: got response (${result.length} chars)`);
    console.log(`  RESULT: Env var accepted (no error) — but can't verify it changed effort without comparing token counts`);
  } catch (e) {
    console.log(`  Claude CLI not available or errored: ${e.message?.slice(0, 100)}`);
    console.log(`  RESULT: CANNOT VERIFY — env var existence is from binary string analysis only`);
  }
}

// ── Run all ──
async function main() {
  console.log('Claims Verification Test Suite');
  console.log(`Proxy: ${PROXY}`);
  console.log(`Time: ${new Date().toISOString()}`);

  await testEffort();
  await testClearThinking();
  await testAdaptiveVsEnabled();
  await testDarioDefaults();
  await testEnvVar();

  console.log('\n' + '='.repeat(70));
  console.log('  DONE');
  console.log('='.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });

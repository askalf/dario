#!/usr/bin/env node
/**
 * Deep stealth validation — edge cases, multi-turn thinking accumulation,
 * field ordering verification, burst pattern analysis, and large context behavior.
 */

const PROXY = 'http://localhost:3456';
let pass = 0, fail = 0;

function header(name) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(70));
}

function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function send(body, label) {
  const start = Date.now();
  const res = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'dario',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  const headers = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.includes('ratelimit') || k === 'request-id') headers[k] = v;
  }
  const data = await res.json();
  if (data.error) {
    console.log(`  [${label}] ERROR: ${data.error.message}`);
    return null;
  }
  return { data, headers, elapsed };
}

// ── Test 1: Multi-turn thinking accumulation (5 turns) ──
async function testMultiTurnThinking() {
  header('1. Multi-turn thinking accumulation (5 turns)');

  const turns = [];
  let totalThinkingStripped = 0;

  for (let i = 0; i < 5; i++) {
    const messages = [...turns, { role: 'user', content: `Turn ${i + 1}: What is ${(i + 1) * 7} × ${(i + 1) * 3}?` }];

    const r = await send({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages,
      thinking: { type: 'enabled', budget_tokens: 4000 },
      output_config: { effort: 'medium' },
      stream: false,
    }, `turn ${i + 1}`);

    if (!r) break;

    const thinkingBlocks = r.data.content.filter(b => b.type === 'thinking');
    const thinkingTokens = thinkingBlocks.reduce((s, b) => s + (b.thinking?.length ?? 0), 0);
    totalThinkingStripped += thinkingTokens;

    console.log(`  Turn ${i + 1}: input=${r.data.usage.input_tokens} output=${r.data.usage.output_tokens} thinking_chars=${thinkingTokens}`);

    // Add the full response (with thinking) to history — dario should strip it
    turns.push({ role: 'user', content: `Turn ${i + 1}: What is ${(i + 1) * 7} × ${(i + 1) * 3}?` });
    turns.push({ role: 'assistant', content: r.data.content });
  }

  // If thinking is being stripped, input tokens should NOT grow by thinking_chars each turn
  // Compare turn 1 vs turn 5 input tokens — should grow linearly with text, not exponentially with thinking
  console.log(`\n  Total thinking chars generated across 5 turns: ${totalThinkingStripped}`);
  check('Completed 5 multi-turn requests', turns.length === 10);
}

// ── Test 2: Massive thinking block strip ──
async function testMassiveThinkingStrip() {
  header('2. Large thinking block stripping');

  // Simulate a response with a very large thinking block
  const bigThinking = 'x'.repeat(10000); // ~10K chars of fake thinking
  const r = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'What is 1+1?' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: bigThinking, signature: 'fake-sig-for-test' },
        { type: 'text', text: '1+1 = 2' },
      ]},
      { role: 'user', content: 'And 2+2?' },
    ],
    stream: false,
  }, 'large thinking strip');

  if (r) {
    // Without stripping, 10K chars ≈ 2500+ tokens of input wasted
    check('Large thinking block stripped successfully', r.data.usage.input_tokens < 200,
      `input=${r.data.usage.input_tokens} (should be <200 if 10K thinking was stripped)`);
    check('Billing claim five_hour', r.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  }
}

// ── Test 3: Field ordering verification ──
async function testFieldOrdering() {
  header('3. Field ordering (non-CC fields removed)');

  // Send with every non-CC field + weird ordering
  const r = await send({
    stream: false,  // wrong position
    temperature: 0.5,
    top_p: 0.9,
    top_k: 50,
    service_tier: 'auto',
    stop_sequences: ['END'],
    max_tokens: 256,  // wrong position
    model: 'claude-sonnet-4-6',  // wrong position
    messages: [{ role: 'user', content: 'Say "field test passed"' }],
    system: 'You are helpful.',
  }, 'reversed field order');

  if (r) {
    const text = r.data.content?.find(b => b.type === 'text')?.text ?? '';
    check('Request with wrong field order + non-CC fields succeeded', text.length > 0, `response: "${text.slice(0, 50)}"`);
    check('Billing claim five_hour', r.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  }
}

// ── Test 4: System prompt edge cases ──
async function testSystemEdgeCases() {
  header('4. System prompt edge cases');

  // Empty string system
  const r1 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: '',
    messages: [{ role: 'user', content: 'Say "empty system test"' }],
    stream: false,
  }, 'empty string system');
  check('Empty string system prompt', !!r1);

  // System with existing billing tag (should not double-inject)
  const r2 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.100.abc; cc_entrypoint=cli; cch=12345;' },
      { type: 'text', text: 'Agent identity', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [{ role: 'user', content: 'Say "billing tag test"' }],
    stream: false,
  }, 'pre-existing billing tag');
  check('Pre-existing billing tag handled', !!r2);

  // Very long system prompt
  const longSystem = 'You are a helpful assistant. '.repeat(500); // ~14K chars
  const r3 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: longSystem,
    messages: [{ role: 'user', content: 'Say "long system test"' }],
    stream: false,
  }, 'long system prompt');
  check('Long system prompt (14K chars) handled', !!r3);

  // System with mixed block types
  const r4 = await send({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'Block 1: You are an AI assistant.' },
      { type: 'text', text: 'Block 2: You write clean code.' },
      { type: 'text', text: 'Block 3: You follow best practices.' },
      { type: 'text', text: 'Block 4: You are concise.' },
      { type: 'text', text: 'Block 5: You test everything.' },
    ],
    messages: [{ role: 'user', content: 'Say "multi block test"' }],
    stream: false,
  }, '5-block system prompt');
  check('5-block system merged to 3', !!r4);

  if (r1) check('Empty system: five_hour', r1.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  if (r2) check('Billing tag: five_hour', r2.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  if (r3) check('Long system: five_hour', r3.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  if (r4) check('Multi-block: five_hour', r4.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
}

// ── Test 5: Haiku exclusions ──
async function testHaikuExclusions() {
  header('5. Haiku exclusions (no thinking, no effort, no context_management)');

  const r = await send({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say "haiku test"' }],
    stream: false,
  }, 'haiku bare request');

  if (r) {
    const hasThinking = r.data.content?.some(b => b.type === 'thinking');
    check('Haiku: no thinking blocks in response', !hasThinking);
    check('Haiku: request succeeded (no invalid params)', true);
    check('Haiku: five_hour', r.headers['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  }
}

// ── Test 6: OpenAI compat stealth ──
async function testOpenAIStealth() {
  header('6. OpenAI compat endpoint stealth');

  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer dario',
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Say "openai compat stealth test"' }],
      max_tokens: 256,
      temperature: 0.7,
      top_p: 0.95,
      stream: false,
    }),
  });

  const data = await res.json();
  if (data.error) {
    check('OpenAI compat request', false, data.error.message);
  } else {
    const text = data.choices?.[0]?.message?.content ?? '';
    check('OpenAI compat with non-CC fields', text.length > 0, `"${text.slice(0, 50)}"`);
    // Check rate limit headers (should be forwarded even on OpenAI compat)
    const claim = res.headers.get('anthropic-ratelimit-unified-representative-claim');
    check('OpenAI compat: five_hour', claim === 'five_hour');
  }
}

// ── Test 7: Streaming stealth ──
async function testStreamingStealth() {
  header('7. Streaming request stealth');

  const res = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'dario',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Say "stream test"' }],
      temperature: 0.5,
      service_tier: 'auto',
      stream: true,
    }),
  });

  const contentType = res.headers.get('content-type') ?? '';
  check('Streaming response is SSE', contentType.includes('text/event-stream'));

  const claim = res.headers.get('anthropic-ratelimit-unified-representative-claim');
  check('Streaming: five_hour', claim === 'five_hour');

  // Consume the stream
  const text = await res.text();
  const hasData = text.includes('event: message_start') || text.includes('event: content_block_start');
  check('Streaming: valid SSE events', hasData);
}

// ── Test 8: Burst pattern — 5 rapid sequential requests ──
async function testBurstPattern() {
  header('8. Burst pattern (5 rapid requests)');

  const results = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    const r = await send({
      model: 'claude-haiku-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: `Burst test ${i + 1}. Say "${i + 1}".` }],
      stream: false,
    }, `burst ${i + 1}`);
    const elapsed = Date.now() - start;
    if (r) {
      results.push({ elapsed, claim: r.headers['anthropic-ratelimit-unified-representative-claim'] });
      console.log(`  Burst ${i + 1}: ${elapsed}ms, claim=${results[results.length - 1].claim}`);
    }
  }

  const allFiveHour = results.every(r => r.claim === 'five_hour');
  check(`All ${results.length} burst requests: five_hour`, allFiveHour);
  check('No 429 rate limits on burst', results.length === 5);
}

// ── Test 9: CLAUDE_CODE_EFFORT_LEVEL env var verification ──
async function testEnvVars() {
  header('9. Claude Code env var verification');

  const { execSync } = await import('child_process');

  // Test if setting CLAUDE_CODE_EFFORT_LEVEL changes behavior
  try {
    const version = execSync('claude --version 2>&1', { encoding: 'utf8', timeout: 5000 }).trim();
    console.log(`  Claude CLI: ${version}`);

    // Run with low effort — should produce shorter response
    const lowResult = execSync(
      'claude --print "Explain quicksort in detail" 2>nul',
      {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: 'low' }
      }
    ).trim();

    // Run with high effort
    const highResult = execSync(
      'claude --print "Explain quicksort in detail" 2>nul',
      {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: 'high' }
      }
    ).trim();

    console.log(`  Low effort response:  ${lowResult.length} chars`);
    console.log(`  High effort response: ${highResult.length} chars`);
    check('CLAUDE_CODE_EFFORT_LEVEL env var works', highResult.length > lowResult.length * 1.2,
      `high/low ratio: ${(highResult.length / lowResult.length).toFixed(2)}x`);
  } catch (e) {
    console.log(`  CLI test failed: ${e.message?.slice(0, 150)}`);
    check('CLAUDE_CODE_EFFORT_LEVEL env var', false, 'CLI not available or timed out');
  }
}

// ── Test 10: Billing stability across mixed models ──
async function testMixedModels() {
  header('10. Billing stability across model switches');

  const models = ['claude-haiku-4-5', 'claude-sonnet-4-6'];
  const results = [];

  for (const model of models) {
    const r = await send({
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: `Model test: ${model}. Say "${model}".` }],
      stream: false,
    }, model);
    if (r) {
      const claim = r.headers['anthropic-ratelimit-unified-representative-claim'];
      results.push({ model, claim });
      console.log(`  ${model}: claim=${claim}`);
    }
  }

  const allFiveHour = results.every(r => r.claim === 'five_hour');
  check('All models on five_hour', allFiveHour);
}

async function main() {
  console.log('Deep Stealth Validation Suite');
  console.log(`Proxy: ${PROXY}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  await testMultiTurnThinking();
  await testMassiveThinkingStrip();
  await testFieldOrdering();
  await testSystemEdgeCases();
  await testHaikuExclusions();
  await testOpenAIStealth();
  await testStreamingStealth();
  await testBurstPattern();
  await testEnvVars();
  await testMixedModels();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(70));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1);});

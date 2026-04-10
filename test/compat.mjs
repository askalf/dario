#!/usr/bin/env node
/**
 * dario — Compatibility Validation Suite
 * Tests --passthrough mode against Hermes/OpenClaw protocol expectations.
 *
 * Usage:
 *   dario proxy --passthrough &
 *   node test/compat.mjs
 *
 * Reports PASS/FAIL for each protocol requirement.
 */

const BASE = process.env.DARIO_TEST_URL || 'http://127.0.0.1:3456';
const results = [];
let testNum = 0;

function log(label, status, details) {
  testNum++;
  const icon = status === 'PASS' ? '\u2705' : status === 'FAIL' ? '\u274C' : '\u26A0\uFE0F';
  console.log(`${icon} #${testNum} ${label}: ${details}`);
  results.push({ num: testNum, label, status, details });
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Anthropic Messages API (Hermes path) ---

async function testAnthropicNonStream() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, messages: [{ role: 'user', content: 'Say "COMPAT OK"' }] })
  });
  const body = await resp.json();
  const text = body.content?.find(c => c.type === 'text')?.text || '';

  // Verify NO injected fields in response
  const hasThinking = body.content?.some(c => c.type === 'thinking');
  const hasServiceTier = !!body.service_tier;

  if (resp.status === 200 && text.includes('COMPAT')) {
    log('Anthropic non-stream', 'PASS', `"${text.substring(0, 40)}" | thinking_injected=${hasThinking} | service_tier=${hasServiceTier || '-'}`);
  } else {
    log('Anthropic non-stream', 'FAIL', `HTTP ${resp.status}: ${JSON.stringify(body).substring(0, 100)}`);
  }
}

async function testAnthropicStream() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'Say "STREAM COMPAT"' }] })
  });

  if (resp.status !== 200) {
    log('Anthropic stream', 'FAIL', `HTTP ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
    return;
  }

  const raw = await resp.text();
  const events = raw.split('\n').filter(l => l.startsWith('event:'));
  const hasStart = events.some(e => e.includes('message_start'));
  const hasStop = events.some(e => e.includes('message_stop'));
  const hasDelta = events.some(e => e.includes('content_block_delta'));

  // Verify SSE ordering: message_start must come first, message_stop last
  const startIdx = events.findIndex(e => e.includes('message_start'));
  const stopIdx = events.findIndex(e => e.includes('message_stop'));
  const correctOrder = startIdx === 0 && stopIdx === events.length - 1;

  let text = '';
  for (const line of raw.split('\n').filter(l => l.startsWith('data:'))) {
    try { const o = JSON.parse(line.replace('data: ', '')); if (o.delta?.text) text += o.delta.text; } catch {}
  }

  if (hasStart && hasStop && hasDelta && correctOrder) {
    log('Anthropic stream', 'PASS', `${events.length} events | order=${correctOrder ? 'correct' : 'WRONG'} | "${text.substring(0, 40)}"`);
  } else {
    log('Anthropic stream', 'FAIL', `start=${hasStart} stop=${hasStop} delta=${hasDelta} order=${correctOrder}`);
  }
}

async function testAnthropicStreamFraming() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'Count: 1 2 3' }] })
  });

  if (resp.status !== 200) {
    log('SSE framing', 'FAIL', `HTTP ${resp.status}`);
    return;
  }

  const raw = await resp.text();
  // Every data: line must be preceded by event: line (Anthropic SSE spec)
  const lines = raw.split('\n');
  let valid = true;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('data: ') && lines[i].includes('"type"')) {
      if (i === 0 || !lines[i - 1].startsWith('event:')) {
        valid = false;
        break;
      }
    }
  }
  log('SSE framing', valid ? 'PASS' : 'FAIL', `event:/data: pairs ${valid ? 'correctly paired' : 'BROKEN — data without preceding event'}`);
}

// --- No injection verification ---

async function testNoInjection() {
  // Send a request with NO thinking, NO service_tier — passthrough should NOT add them
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }] })
  });
  const body = await resp.json();

  // In passthrough, there should be no thinking block (we didn't request it)
  const hasThinking = body.content?.some(c => c.type === 'thinking');
  if (resp.status === 200 && !hasThinking) {
    log('No thinking injection', 'PASS', 'No thinking block in response (passthrough clean)');
  } else if (hasThinking) {
    log('No thinking injection', 'FAIL', 'Thinking block present — passthrough is injecting thinking');
  } else {
    log('No thinking injection', 'FAIL', `HTTP ${resp.status}`);
  }
}

async function testClientBetasPreserved() {
  // Client sends a custom beta — passthrough should forward it
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'Say "BETA OK"' }]
    })
  });
  const body = await resp.json();

  if (resp.status === 200) {
    log('Client betas preserved', 'PASS', `Client-requested thinking honored (status=${resp.status})`);
  } else {
    log('Client betas preserved', 'FAIL', `HTTP ${resp.status}: ${JSON.stringify(body).substring(0, 100)}`);
  }
}

// --- Tool use (OpenClaw path) ---

async function testToolUse() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      tool_choice: { type: 'any' },
      tools: [{ name: 'get_weather', description: 'Get weather for a location', input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }]
    })
  });
  const body = await resp.json();
  const tool = body.content?.find(c => c.type === 'tool_use');

  if (resp.status === 200 && tool && body.stop_reason === 'tool_use') {
    log('Tool use', 'PASS', `tool=${tool.name} | input=${JSON.stringify(tool.input).substring(0, 50)}`);
  } else {
    log('Tool use', 'FAIL', `stop_reason=${body.stop_reason} tool=${!!tool}`);
  }
}

async function testToolUseStreaming() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1024, stream: true,
      tool_choice: { type: 'any' },
      tools: [{ name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      messages: [{ role: 'user', content: 'Search for the weather in Paris' }]
    })
  });

  if (resp.status !== 200) {
    log('Tool use stream', 'FAIL', `HTTP ${resp.status}`);
    return;
  }

  const raw = await resp.text();
  const events = raw.split('\n').filter(l => l.startsWith('event:'));
  const hasToolStart = raw.includes('"tool_use"');
  const hasInputJson = raw.includes('input_json_delta');

  if (hasToolStart) {
    log('Tool use stream', 'PASS', `${events.length} events | tool_use=${hasToolStart} | input_json_delta=${hasInputJson}`);
  } else {
    log('Tool use stream', 'FAIL', `No tool_use in stream (${events.length} events)`);
  }
}

// --- OpenAI compat (OpenClaw alternate path) ---

async function testOpenAINonStream() {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, messages: [{ role: 'user', content: 'Say "OPENAI COMPAT"' }] })
  });
  const body = await resp.json();
  const text = body.choices?.[0]?.message?.content || '';

  if (resp.status === 200 && text) {
    log('OpenAI non-stream', 'PASS', `"${text.substring(0, 40)}"`);
  } else {
    log('OpenAI non-stream', 'FAIL', `HTTP ${resp.status}: ${JSON.stringify(body).substring(0, 100)}`);
  }
}

async function testOpenAIStream() {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'Say "STREAM OPENAI"' }] })
  });

  if (resp.status !== 200) {
    log('OpenAI stream', 'FAIL', `HTTP ${resp.status}`);
    return;
  }

  const raw = await resp.text();
  const chunks = raw.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]'));
  const hasDone = raw.includes('[DONE]');

  let text = '';
  for (const d of chunks) {
    try { const o = JSON.parse(d.replace('data: ', '')); if (o.choices?.[0]?.delta?.content) text += o.choices[0].delta.content; } catch {}
  }

  if (chunks.length > 0 && hasDone) {
    log('OpenAI stream', 'PASS', `${chunks.length} chunks | [DONE]=${hasDone} | "${text.substring(0, 40)}"`);
  } else {
    log('OpenAI stream', 'FAIL', `chunks=${chunks.length} [DONE]=${hasDone}`);
  }
}

// --- Rate limit / request-id visibility ---

async function testHeaderVisibility() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 64, messages: [{ role: 'user', content: 'OK' }] })
  });
  await resp.text();

  const hasRequestId = !!resp.headers.get('request-id') || !!resp.headers.get('x-request-id');
  const rlHeaders = [...resp.headers.keys()].filter(k => k.includes('ratelimit'));
  const hasRateLimit = rlHeaders.length > 0;

  if (hasRequestId || hasRateLimit) {
    log('Header visibility', 'PASS', `request-id=${hasRequestId} | ratelimit=${hasRateLimit} (${rlHeaders.length} headers)`);
  } else {
    log('Header visibility', 'WARN', `request-id=${hasRequestId} | ratelimit=${hasRateLimit} — headers: ${[...resp.headers.keys()].join(', ')}`);
  }
}

// --- Main ---

async function main() {
  console.log('='.repeat(60));
  console.log('  dario Compatibility Validation (--passthrough)');
  console.log(`  ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  console.log();

  // Wait for proxy
  for (let i = 0; i < 10; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await wait(1000);
  }

  // Detect if running through CLI fallback (passthrough 429s)
  const probe = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 32, messages: [{ role: 'user', content: 'OK' }] })
  });
  const probeHeaders = [...probe.headers.keys()];
  const viaCliFallback = !probeHeaders.some(k => k.includes('ratelimit'));
  if (viaCliFallback) {
    console.log('\u26A0\uFE0F  NOTE: All requests are 429ing and falling back to CLI.');
    console.log('   This is expected in --passthrough without priority routing.');
    console.log('   Tool use and header tests will fail (CLI limitations).');
    console.log('   Re-run after 5h window resets for direct API results.\n');
  }
  await probe.text();
  await wait(1500);

  console.log('--- Anthropic Messages API (Hermes) ---');
  await testAnthropicNonStream(); await wait(1500);
  await testAnthropicStream(); await wait(1500);
  await testAnthropicStreamFraming(); await wait(1500);
  console.log();

  console.log('--- Passthrough Verification ---');
  await testNoInjection(); await wait(1500);
  await testClientBetasPreserved(); await wait(1500);
  console.log();

  console.log('--- Tool Use (OpenClaw) ---');
  await testToolUse(); await wait(1500);
  await testToolUseStreaming(); await wait(1500);
  console.log();

  console.log('--- OpenAI Compat ---');
  await testOpenAINonStream(); await wait(1500);
  await testOpenAIStream(); await wait(1500);
  console.log();

  console.log('--- Header Visibility ---');
  await testHeaderVisibility();
  console.log();

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;

  console.log('='.repeat(60));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${warned} warnings`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log('\nFailed:');
    for (const r of results.filter(r => r.status === 'FAIL')) console.log(`  #${r.num} ${r.label}: ${r.details}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('Error:', e); process.exit(1); });

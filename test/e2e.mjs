#!/usr/bin/env node
/**
 * dario — E2E Test Suite
 * Requires a running dario proxy on localhost:3456
 *
 * Usage: node test/e2e.mjs
 *   or:  npm run e2e
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

function extractRateLimitInfo(headers) {
  const info = {};
  for (const [k, v] of headers) {
    if (k.includes('ratelimit-unified')) {
      info[k.replace('anthropic-ratelimit-unified-', '')] = v;
    }
  }
  return info;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Infrastructure ---

async function testHealth() {
  const resp = await fetch(`${BASE}/health`);
  const body = await resp.json();
  if (resp.status === 200 && body.status === 'ok' && body.oauth) {
    log('Health endpoint', 'PASS', `oauth=${body.oauth}, expires=${body.expiresIn}`);
  } else {
    log('Health endpoint', 'FAIL', JSON.stringify(body));
  }
}

async function testStatus() {
  const resp = await fetch(`${BASE}/status`);
  const body = await resp.json();
  if (resp.status === 200 && body.status) {
    log('Status endpoint', 'PASS', `status=${body.status}, expires=${body.expiresIn}`);
  } else {
    log('Status endpoint', 'FAIL', JSON.stringify(body));
  }
}

async function testModels() {
  const resp = await fetch(`${BASE}/v1/models`);
  const body = await resp.json();
  if (resp.status === 200 && body.data?.length > 0) {
    log('Models endpoint', 'PASS', `${body.data.length} models listed`);
  } else {
    log('Models endpoint', 'FAIL', JSON.stringify(body));
  }
}

// --- Non-streaming ---

async function testNonStreaming(model, label) {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'Respond with exactly: "E2E OK"' }] })
  });
  const rl = extractRateLimitInfo(resp.headers);
  const body = await resp.json();

  if (resp.status !== 200) {
    log(`${label} non-stream`, 'FAIL', `HTTP ${resp.status}: ${body.error?.message || JSON.stringify(body)}`);
    return { rl };
  }

  const text = body.content?.find(c => c.type === 'text')?.text || '';
  const hasThinking = body.content?.some(c => c.type === 'thinking');

  log(`${label} non-stream`, 'PASS', `"${text.substring(0, 40)}" | thinking=${hasThinking ? 'adaptive' : 'none'}`);
  return { rl };
}

// --- Streaming ---

async function testStreaming(model, label) {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Respond with exactly: "STREAM OK"' }] })
  });
  const rl = extractRateLimitInfo(resp.headers);

  if (resp.status !== 200) {
    log(`${label} stream`, 'FAIL', `HTTP ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
    return { rl };
  }

  const rawText = await resp.text();
  const events = rawText.split('\n').filter(l => l.startsWith('event:'));
  const dataLines = rawText.split('\n').filter(l => l.startsWith('data:'));

  const hasStart = events.some(e => e.includes('message_start'));
  const hasStop = events.some(e => e.includes('message_stop'));
  const hasDelta = events.some(e => e.includes('content_block_delta'));
  const hasThinking = dataLines.some(d => d.includes('thinking_delta'));

  let text = '';
  for (const d of dataLines) {
    try { const o = JSON.parse(d.replace('data: ', '')); if (o.delta?.text) text += o.delta.text; } catch {}
  }

  if (hasStart && hasStop && hasDelta) {
    log(`${label} stream`, 'PASS', `${events.length} events | thinking=${hasThinking ? 'yes' : 'no'} | "${text.substring(0, 40)}"`);
  } else {
    log(`${label} stream`, 'FAIL', `start=${hasStart} stop=${hasStop} delta=${hasDelta}`);
  }
  return { rl };
}

// --- OpenAI compat ---

async function testOpenAINonStream() {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: 'Respond with exactly: "OPENAI OK"' }] })
  });

  if (resp.status !== 200) {
    log('OpenAI non-stream', 'FAIL', `HTTP ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
    return;
  }

  const body = await resp.json();
  log('OpenAI non-stream', 'PASS', `model=${body.model} | "${(body.choices?.[0]?.message?.content || '').substring(0, 40)}"`);
}

async function testOpenAIStream() {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Respond with exactly: "OPENAI STREAM OK"' }] })
  });

  if (resp.status !== 200) {
    log('OpenAI stream', 'FAIL', `HTTP ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
    return;
  }

  const rawText = await resp.text();
  const dataLines = rawText.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]'));

  let text = '';
  for (const d of dataLines) {
    try { const o = JSON.parse(d.replace('data: ', '')); if (o.choices?.[0]?.delta?.content) text += o.choices[0].delta.content; } catch {}
  }

  if (dataLines.length > 0 && rawText.includes('[DONE]')) {
    log('OpenAI stream', 'PASS', `${dataLines.length} chunks | "${text.substring(0, 40)}"`);
  } else {
    log('OpenAI stream', 'FAIL', `chunks=${dataLines.length} [DONE]=${rawText.includes('[DONE]')}`);
  }
}

// --- Tool use ---

async function testToolUse() {
  const resp = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }]
    })
  });

  if (resp.status !== 200) {
    log('Tool use', 'FAIL', `HTTP ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
    return;
  }

  const body = await resp.json();
  const tool = body.content?.find(c => c.type === 'tool_use');
  if (tool && body.stop_reason === 'tool_use') {
    log('Tool use', 'PASS', `tool=${tool.name} | input=${JSON.stringify(tool.input).substring(0, 50)}`);
  } else {
    log('Tool use', 'FAIL', `no tool_use block, stop_reason=${body.stop_reason}`);
  }
}

// --- Rate limit headers ---

async function testRateLimitHeaders(allRl) {
  const sample = allRl.find(rl => Object.keys(rl).length > 0) || {};
  const checks = [];
  if (sample['status']) checks.push('unified-status');
  if (sample['7d-utilization']) checks.push('7d-util');
  if (sample['5h-utilization']) checks.push('5h-util');
  if (sample['representative-claim']) checks.push('billing-claim');
  if (sample['fallback-percentage']) checks.push('fallback-pct');
  if (sample['overage-utilization'] !== undefined || sample['overage-status']) checks.push('overage');
  const hasPerModel = Object.keys(sample).some(k => k.match(/7d_(sonnet|opus|haiku)/));
  if (hasPerModel) checks.push('per-model-routing');

  if (checks.length >= 4) {
    log('Rate limit headers', 'PASS', checks.join(', '));
  } else {
    log('Rate limit headers', 'WARN', `only ${checks.length}: ${checks.join(', ')}`);
  }

  console.log('\n--- Rate Limit Snapshot ---');
  for (const [k, v] of Object.entries(sample).sort()) console.log(`  ${k}: ${v}`);
}

// --- Main ---

async function main() {
  console.log('='.repeat(60));
  console.log(`  dario E2E — ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  console.log();

  // Wait for proxy
  for (let i = 0; i < 10; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await wait(1000);
  }

  const allRl = [];

  await testHealth(); await testStatus(); await testModels();
  console.log();

  console.log('--- Non-streaming ---');
  for (const [model, label] of [['claude-haiku-4-5-20251001', 'Haiku'], ['claude-sonnet-4-6', 'Sonnet'], ['claude-opus-4-6', 'Opus']]) {
    const r = await testNonStreaming(model, label); allRl.push(r.rl); await wait(1500);
  }
  console.log();

  console.log('--- Streaming ---');
  for (const [model, label] of [['claude-sonnet-4-6', 'Sonnet'], ['claude-opus-4-6', 'Opus']]) {
    const r = await testStreaming(model, label); allRl.push(r.rl); await wait(1500);
  }
  console.log();

  console.log('--- OpenAI Compat ---');
  await testOpenAINonStream(); await wait(1500);
  await testOpenAIStream(); await wait(1500);
  console.log();

  console.log('--- Tool Use ---');
  await testToolUse();
  console.log();

  console.log('--- Rate Limits ---');
  await testRateLimitHeaders(allRl);
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

main().catch(e => { console.error('Test suite error:', e); process.exit(1); });

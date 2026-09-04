#!/usr/bin/env node
// Manual/live Codex contract check. Kept outside npm test: it needs a running
// dario with a real ChatGPT subscription and intentionally makes live calls.
// Usage: DARIO_URL=http://127.0.0.1:3456 DARIO_API_KEY=dario node test/manual/codex-wire-contract.mjs [slug]

const base = (process.env.DARIO_URL || '').replace(/\/$/, '');
const key = process.env.DARIO_API_KEY || '';
const requestedSlug = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body, text };
}

if (!base || !key) {
  console.error('DARIO_URL and DARIO_API_KEY are required. This is a live-account check.');
  process.exit(2);
}

try {
  const models = await request('/v1/models', { method: 'GET' });
  assert(models.response.ok, `/v1/models returned ${models.response.status}`);
  assert(models.body?.object === 'list' && Array.isArray(models.body.data), '/v1/models must be an OpenAI list');
  const slug = requestedSlug || models.body.data.find(m => typeof m?.id === 'string' && m.id.startsWith('gpt-'))?.id;
  assert(typeof slug === 'string', 'no Codex gpt-* slug advertised; pass one explicitly after configuring an account');

  const completion = await request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: slug, messages: [{ role: 'user', content: 'Reply exactly: pong' }], max_tokens: 16 }),
  });
  assert(completion.response.ok, `non-stream completion returned ${completion.response.status}: ${completion.text.slice(0, 300)}`);
  assert(completion.body?.object === 'chat.completion', 'non-stream response must be chat.completion');
  assert(completion.body?.choices?.[0]?.message?.role === 'assistant', 'non-stream response lacks assistant message');

  const streamed = await request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: slug, stream: true, messages: [{ role: 'user', content: 'Reply exactly: pong' }], max_tokens: 16 }),
  });
  assert(streamed.response.ok, `stream completion returned ${streamed.response.status}: ${streamed.text.slice(0, 300)}`);
  const frames = streamed.text.split('\n\n').filter(frame => frame.startsWith('data: '));
  const payloads = frames.map(frame => frame.slice(6));
  assert(payloads.at(-1) === '[DONE]', 'SSE stream must terminate with data: [DONE]');
  const chunks = payloads.slice(0, -1).map(payload => JSON.parse(payload));
  assert(chunks.some(chunk => chunk?.object === 'chat.completion.chunk' && chunk?.choices?.[0]?.delta?.role === 'assistant'), 'SSE stream lacks assistant role opener');

  const tools = await request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: slug, messages: [{ role: 'user', content: 'Call the echo tool with value pong; do not answer normally.' }], tools: [{ type: 'function', function: { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] } }),
  });
  assert(tools.response.ok, `tool completion returned ${tools.response.status}: ${tools.text.slice(0, 300)}`);
  for (const call of tools.body?.choices?.[0]?.message?.tool_calls || []) {
    assert(typeof call?.function?.arguments === 'string', 'tool-call arguments must be a JSON string');
    JSON.parse(call.function.arguments);
  }

  const error = await request('/v1/chat/completions', { method: 'POST', body: '{' });
  assert(!error.response.ok, 'invalid request unexpectedly succeeded');
  assert(typeof error.body?.error === 'string' || typeof error.body?.error?.message === 'string', 'error response lacks .error.message-compatible shape');
  console.log(`Codex wire contract passed for ${slug}.`);
} catch (error) {
  console.error(`Codex wire contract failed: ${error.message}`);
  process.exit(1);
}

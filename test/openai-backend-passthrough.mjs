// Smoke test for the OpenAI-compat backend passthrough path.
//
// Backs the README's claim that Codex CLI "just works" through dario by
// verifying the underlying behavior: a Codex-CLI-shaped request body
// (function-calling tools array, streaming flag, reasoning-model
// `o1-`/`o3-`/`o4-` model name) reaches the configured backend
// byte-for-byte, with the Authorization header swapped to the backend's
// key. Doesn't exercise an actual Codex CLI binary or hit OpenAI — uses
// an in-process mock server bound on an ephemeral port to capture what
// `forwardToOpenAI` actually sends upstream.
//
// Run: `node test/openai-backend-passthrough.mjs`
// Auto-discovered by test/all.test.mjs.

import { createServer } from 'node:http';
import { forwardToOpenAI } from '../dist/openai-backend.js';

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else      { console.log(`  ❌ ${label}`); fail++; }
}

// Spin up a mock OpenAI-compat upstream that captures the request it
// receives, then replies with a canned chat-completions response.
function startMockUpstream() {
  return new Promise((resolve) => {
    const captured = { headers: null, body: null, path: null, method: null };
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        captured.headers = req.headers;
        captured.body = Buffer.concat(chunks);
        captured.path = req.url;
        captured.method = req.method;

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ratelimit-limit-requests': '500',
          'x-ratelimit-remaining-requests': '499',
          'openai-organization': 'test-org',
          'request-id': 'req_mock_test',
        });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, captured, port });
    });
  });
}

// Build a Codex-CLI-shape request body — what an OpenAI SDK client doing
// function-calling against /v1/chat/completions sends. Includes a tools
// array, tool_choice, streaming false, plus reasoning-model parameters
// Codex CLI uses for o1-/o3- families.
function codexCliBody() {
  return Buffer.from(JSON.stringify({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'List files in cwd.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } },
              workdir: { type: 'string' },
            },
            required: ['command'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    stream: false,
    temperature: 0.2,
  }));
}

// Mock IncomingMessage + ServerResponse just enough for forwardToOpenAI.
function mockReqRes(body) {
  const reqHeaders = {
    'content-type': 'application/json',
    'authorization': 'Bearer dario-client-key',
    'accept': 'application/json',
    'content-length': String(body.length),
  };
  const req = { headers: reqHeaders };

  const captured = { status: 0, headers: {}, chunks: [] };
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      Object.assign(captured.headers, headers || {});
      captured.headersSent = true;
    },
    write(chunk) { captured.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
    end(chunk) {
      if (chunk) captured.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      captured.ended = true;
    },
    headersSent: false,
  };
  return { req, res, captured };
}

(async () => {
  console.log('\n======================================================================');
  console.log('  openai-backend — Codex-CLI-shape passthrough smoke');
  console.log('======================================================================');

  const { server, captured: upstream, port } = await startMockUpstream();
  try {
    const backend = {
      provider: 'openai',
      name: 'openai',
      apiKey: 'sk-mock-backend-key',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    };
    const body = codexCliBody();
    const { req, res, captured: client } = mockReqRes(body);

    await forwardToOpenAI(
      req,
      res,
      body,
      backend,
      'http://localhost:3456',
      { 'X-Content-Type-Options': 'nosniff' },
      30_000,
      false,
    );

    // Path: dario rewrites baseUrl/chat/completions → upstream sees /v1/chat/completions
    assert(upstream.path === '/v1/chat/completions', `upstream path is /v1/chat/completions (got ${upstream.path})`);
    assert(upstream.method === 'POST', 'upstream method is POST');

    // Body byte-for-byte (Codex's tools array survives intact)
    assert(upstream.body.equals(body), 'upstream body equals client body byte-for-byte');
    const upstreamParsed = JSON.parse(upstream.body.toString('utf8'));
    assert(Array.isArray(upstreamParsed.tools) && upstreamParsed.tools.length === 1, 'tools array preserved');
    assert(upstreamParsed.tools[0].function.name === 'shell', 'tool function.name preserved');
    assert(upstreamParsed.tool_choice === 'auto', 'tool_choice preserved');
    assert(upstreamParsed.stream === false, 'stream flag preserved');

    // Authorization swap: client's "Bearer dario-client-key" → backend key
    assert(upstream.headers['authorization'] === 'Bearer sk-mock-backend-key', 'Authorization swapped to backend key');
    assert(upstream.headers['content-type'] === 'application/json', 'Content-Type forwarded');

    // No Anthropic-specific headers leak through
    assert(!('anthropic-beta' in upstream.headers), 'anthropic-beta not forwarded');
    assert(!('x-api-key' in upstream.headers), 'x-api-key not forwarded');

    // Response: status forwarded, rate-limit + request-id headers passed through
    assert(client.status === 200, `client got 200 (was ${client.status})`);
    assert(client.headers['x-ratelimit-limit-requests'] === '500', 'x-ratelimit-* header forwarded');
    assert(client.headers['openai-organization'] === 'test-org', 'openai-* header forwarded');
    assert(client.headers['request-id'] === 'req_mock_test', 'request-id forwarded');
    assert(client.headers['Access-Control-Allow-Origin'] === 'http://localhost:3456', 'CORS origin set');

    // Body forwarded
    const clientBody = Buffer.concat(client.chunks).toString('utf8');
    const clientParsed = JSON.parse(clientBody);
    assert(clientParsed.id === 'chatcmpl-mock', 'response id passes through');
    assert(clientParsed.choices[0].message.content === 'ok', 'response content passes through');
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n  ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('Test threw:', err);
  process.exit(1);
});

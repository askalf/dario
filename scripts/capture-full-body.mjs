#!/usr/bin/env node
// One-shot capture of the FULL outbound /v1/messages body from the
// installed `claude` binary. The existing capture-and-bake script only
// retains structural axes (header_order, body_field_order, tool names,
// system prompt) — it doesn't surface the actual VALUES of effort,
// max_tokens, model, etc. This script does.
//
// Usage:
//   node scripts/capture-full-body.mjs
//   MODEL=claude-sonnet-4-6 node scripts/capture-full-body.mjs
//
// Spawns CC against a loopback MITM, captures the first POST that hits
// /v1/messages*, prints the fingerprint-relevant fields as JSON, exits.
// Useful for verifying what the installed CC version actually wires for
// `effort`, `max_tokens`, `thinking`, etc. — values the bake script
// strips during scrubTemplate. Maintainer-only diagnostic; not invoked
// from CI or runtime paths.

import http from 'node:http';
import { spawn } from 'node:child_process';

const CC_BIN = process.env.DARIO_CLAUDE_BIN
  || 'C:/Users/masterm1nd.DOCK/.local/bin/claude.exe';
const TIMEOUT_MS = 25_000;

let captured = null;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.error(`[capture] ${req.method} ${req.url} (body ${body.length} bytes)`);
    if (req.url.startsWith('/v1/messages') && req.method === 'POST' && !captured) {
      try {
        captured = { headers: req.headers, body: JSON.parse(body) };
      } catch {
        captured = { headers: req.headers, raw: body };
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: error\ndata: {"type":"error","error":{"type":"capture_only","message":"capture-full-body.mjs"}}\n\n');
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = ['--print', '-p', 'hi'];
  if (process.env.MODEL) args.unshift('--model', process.env.MODEL);

  console.error(`[capture] MITM listening on ${baseUrl}`);
  console.error(`[capture] spawning ${CC_BIN} ${args.join(' ')} ...`);

  const cc = spawn(CC_BIN, args, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'sk-capture-stub',
      CLAUDE_NONINTERACTIVE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  cc.stderr.on('data', (d) => { process.stderr.write('[cc-stderr] ' + d); });
  cc.stdout.on('data', (d) => { process.stderr.write('[cc-stdout] ' + d); });
  cc.on('exit', (code) => {
    setTimeout(finish, 100);
  });
  cc.on('error', (err) => {
    console.error('[capture] spawn error:', err.message);
    finish();
  });

  setTimeout(() => {
    console.error('[capture] TIMEOUT — CC did not send a /v1/messages within ' + TIMEOUT_MS + 'ms');
    cc.kill();
    finish();
  }, TIMEOUT_MS);
});

function finish() {
  if (!captured) {
    console.error('[capture] no request captured');
    process.exit(1);
  }
  // Surface only the fingerprint-relevant fields. Strip the messages
  // (just user 'hi') and tools (verbose, already covered by bake).
  const { body } = captured;
  const fingerprint = {
    model: body.model,
    max_tokens: body.max_tokens,
    stream: body.stream,
    thinking: body.thinking,
    output_config: body.output_config,
    context_management: body.context_management,
    metadata_keys: body.metadata ? Object.keys(body.metadata) : null,
    metadata_user_id_shape: body.metadata?.user_id ? typeof body.metadata.user_id : null,
    system_block_count: Array.isArray(body.system) ? body.system.length : (typeof body.system === 'string' ? 1 : 0),
    tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
    body_field_order: Object.keys(body),
    user_agent: captured.headers['user-agent'],
    anthropic_beta: captured.headers['anthropic-beta'],
    anthropic_version: captured.headers['anthropic-version'],
  };
  console.log(JSON.stringify(fingerprint, null, 2));
  process.exit(0);
}

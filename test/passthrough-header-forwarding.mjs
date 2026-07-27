/**
 * dario#885 — on the genuine-CC path, forward the client's own identity headers
 * instead of substituting template values.
 *
 * Two layers, because each catches a different mistake:
 *
 *   1. Pure unit tests over forwardClientCCIdentityHeaders — allow/deny, prefix
 *      rules, array values, blank rejection.
 *   2. A live request through the real proxy with SENTINEL header values,
 *      upstream captured via ProxyOptions.fetchImpl.
 *
 * Layer 2 is not redundant. The first version of the fix typechecked, passed
 * every unit test, and forwarded NOTHING — it gated on `passthrough`, a startup
 * CLI flag, instead of the per-request genuine-CC signal. Only a real request
 * through the assembled proxy showed 0 forwarded. Keep both.
 */
import { startProxy } from '../dist/proxy.js';
import { forwardClientCCIdentityHeaders } from '../dist/cc-template.js';

let pass = 0;
let fail = 0;
function header(name) { console.log(`\n${name}`); }
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

// ─────────────────────────────────────────────────────────────
header('1. forwardClientCCIdentityHeaders — what it forwards');
{
  const got = forwardClientCCIdentityHeaders({
    'user-agent': 'claude-cli/2.1.220 (external, sdk-cli)',
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-stainless-os': 'MacOS',
    'x-stainless-arch': 'arm64',
    'x-stainless-retry-count': '2',
    'x-claude-code-agent-id': 'agent-123',
    'x-client-request-id': 'rid-abc',
  });
  check('user-agent forwarded', got['user-agent'] === 'claude-cli/2.1.220 (external, sdk-cli)');
  check('x-app forwarded', got['x-app'] === 'cli');
  check('browser-access flag forwarded', got['anthropic-dangerous-direct-browser-access'] === 'true');
  check('x-stainless-* forwarded by prefix', got['x-stainless-os'] === 'MacOS' && got['x-stainless-arch'] === 'arm64');
  check('retry-count forwarded (real count beats a hardcoded 0)', got['x-stainless-retry-count'] === '2');
  check('x-claude-code-* forwarded by prefix', got['x-claude-code-agent-id'] === 'agent-123');
  check('x-client-* forwarded by prefix', got['x-client-request-id'] === 'rid-abc');
}

// ─────────────────────────────────────────────────────────────
header('2. what it must never forward');
{
  const got = forwardClientCCIdentityHeaders({
    // auth must become the pool account's credential
    'authorization': 'Bearer sk-ant-client-token',
    'x-api-key': 'sk-ant-client-key',
    // session rotation is a feature
    'x-claude-code-session-id': 'client-session-id',
    // merged with operator pins + the per-account rejection cache
    'anthropic-beta': 'client-beta-set',
    'anthropic-version': '2023-06-01',
    // body framing / transport, owned by the proxy and the HTTP stack
    'accept': 'application/xml',
    'content-type': 'text/plain',
    'content-length': '999',
    'host': 'evil.example',
    'connection': 'close',
    'accept-encoding': 'identity',
    'transfer-encoding': 'chunked',
  });
  for (const k of [
    'authorization', 'x-api-key', 'x-claude-code-session-id', 'anthropic-beta',
    'anthropic-version', 'accept', 'content-type', 'content-length', 'host',
    'connection', 'accept-encoding', 'transfer-encoding',
  ]) {
    check(`${k} NOT forwarded`, !(k in got));
  }
  check('nothing else leaked in', Object.keys(got).length === 0);
}

// ─────────────────────────────────────────────────────────────
header('3. value handling');
{
  check('array value takes the first entry',
    forwardClientCCIdentityHeaders({ 'x-app': ['cli', 'other'] })['x-app'] === 'cli');
  check('empty string is skipped, so a blank cannot erase a dario value',
    !('x-app' in forwardClientCCIdentityHeaders({ 'x-app': '' })));
  check('undefined is skipped',
    !('x-app' in forwardClientCCIdentityHeaders({ 'x-app': undefined })));
  check('uppercase header names are matched case-insensitively',
    forwardClientCCIdentityHeaders({ 'X-Stainless-OS': 'Linux' })['x-stainless-os'] === 'Linux');
}

// ─────────────────────────────────────────────────────────────
header('4. live request through the real proxy (the layer that caught the bug)');
{
  const PORT = 39873;
  const BASE = `http://127.0.0.1:${PORT}`;
  let upstream = null;

  const fakeFetch = async (url, init) => {
    const h = {};
    const raw = init?.headers;
    if (Array.isArray(raw)) for (const [k, v] of raw) h[String(k).toLowerCase()] = String(v);
    else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) h[String(k).toLowerCase()] = String(v);
    // dario also fires a non-JSON presence ping through fetchImpl; only the
    // messages call is the subject here.
    if (String(url).includes('/v1/messages')) upstream = { headers: h };
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await startProxy({
    port: PORT, host: '127.0.0.1',
    upstreamApiKey: 'sk-ant-test-not-a-real-key',
    noClaudeAuth: true,
    fetchImpl: fakeFetch,
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // isGenuineCCClient: system[0] carries the billing header, system[1] opens
  // with a real CC opener.
  const genuineBody = {
    model: 'claude-opus-4-8', max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cli' },
      { type: 'text', text: 'You are Claude Code, Anthropic official CLI for Claude.' },
    ],
  };
  const SENTINELS = {
    'user-agent': 'claude-cli/9.9.9 (external, SENTINEL-UA)',
    'x-app': 'SENTINEL-APP',
    'x-stainless-os': 'SENTINEL-OS',
    'x-stainless-arch': 'SENTINEL-ARCH',
    'x-stainless-retry-count': '7',
    'x-claude-code-agent-id': 'SENTINEL-AGENTID',
    'x-client-request-id': 'SENTINEL-REQID',
  };

  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dario', ...SENTINELS },
    body: JSON.stringify(genuineBody),
  });
  await res.text();

  check('upstream request was captured', upstream !== null);
  if (upstream) {
    for (const [k, sent] of Object.entries(SENTINELS)) {
      check(`${k} reached upstream unchanged`, upstream.headers[k] === sent);
    }
    // dario must still own these even though the client sent its own.
    check('session id is dario’s, not the client’s', upstream.headers['x-claude-code-session-id'] !== undefined);
    check('upstream auth is the configured key, not the client’s',
      upstream.headers['x-api-key'] === 'sk-ant-test-not-a-real-key');
  }
}

console.log(`\n# pass ${pass}`);
console.log(`# fail ${fail}`);
if (fail > 0) process.exit(1);
process.exit(0);

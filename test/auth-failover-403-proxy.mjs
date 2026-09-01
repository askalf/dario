#!/usr/bin/env node
// Proxy-path regression: classifying a non-passthrough 403 consumes its body,
// but a generic 403 must still enter account-pool auth failover. The saved body
// is only forwarded when the pool has no healthy peer.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`); fail++; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-auth403-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
for (const [alias, token] of [['a-main', 'bad-token'], ['b-peer', 'good-token']]) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias, accessToken: token, refreshToken: `${token}-refresh`,
    expiresAt: Date.now() + 6 * 3_600_000,
    scopes: ['user:inference'], deviceId: `device-${alias}`, accountUuid: `uuid-${alias}`,
  }));
}

const seenTokens = [];
const fakeFetch = async (url, init = {}) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const token = new Headers(init.headers).get('authorization');
  seenTokens.push(token);
  if (token === 'Bearer bad-token') {
    return new Response(JSON.stringify({ error: { type: 'permission_error', message: 'generic forbidden' } }), {
      status: 403, headers: { 'content-type': 'application/json', 'request-id': 'req-denied' },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_peer', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'served by peer' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { startProxy } = await import('../dist/proxy.js');
const port = 38847;
await startProxy({ port, host: '127.0.0.1', noLiveCapture: true, fetchImpl: fakeFetch });
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(50); }
}
const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});
const text = await response.text();
check('first pool account receives the request', seenTokens[0] === 'Bearer bad-token', JSON.stringify(seenTokens));
check('generic 403 retries with the healthy peer', seenTokens[1] === 'Bearer good-token', JSON.stringify(seenTokens));
check('client receives peer success, not consumed 403', response.status === 200 && text.includes('served by peer'), `${response.status} ${text}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

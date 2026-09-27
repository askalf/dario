#!/usr/bin/env node
/** Explicit headroom-floor parking reaches the proxy's local 429 path. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); fail++; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const home = await mkdtemp(join(tmpdir(), 'dario-floor-proxy-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_POOL_FALLBACK;
delete process.env.DARIO_CODEX_BASE_URL;

await mkdir(join(home, '.dario', 'accounts'), { recursive: true });
await writeFile(join(home, '.dario', 'accounts', 'only.json'), JSON.stringify({
  alias: 'only',
  accessToken: 'only-token',
  refreshToken: 'only-refresh',
  expiresAt: Date.now() + 6 * 3_600_000,
  scopes: ['user:inference'],
  deviceId: 'dev-only',
  accountUuid: 'uuid-only',
}));

const reset = Math.floor(Date.now() / 1000) + 300;
let inferenceCalls = 0;
const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  inferenceCalls++;
  return new Response(JSON.stringify({
    id: 'msg_floor', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-utilization': '0.96',
    'anthropic-ratelimit-unified-7d-utilization': '0.10',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(reset),
  } });
};

const { startProxy } = await import('../dist/proxy.js');
const port = await freePort();
await startProxy({
  host: '127.0.0.1', port, passthrough: true, noLiveCapture: true,
  poolHeadroomFloor: '5%', fetchImpl,
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${base}/health`); break; } catch { await sleep(50); }
}

const messages = () => fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});

const first = await messages();
await first.text();
check('the first request learns the below-floor reading upstream', first.status === 200 && inferenceCalls === 1,
  `${first.status}, calls=${inferenceCalls}`);

const second = await messages();
const secondBody = await second.text();
check('the next request is answered locally with 429', second.status === 429, `${second.status} ${secondBody}`);
check('nothing else was sent upstream', inferenceCalls === 1, inferenceCalls);
check('retry-after points at the known reset', Number(second.headers.get('retry-after')) > 0 && Number(second.headers.get('retry-after')) <= 300,
  second.headers.get('retry-after'));
check('the parked marker is present', second.headers.get('x-dario-upstream-rejection') === 'pool_parked',
  second.headers.get('x-dario-upstream-rejection'));

console.log(`\npool-headroom-floor-proxy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

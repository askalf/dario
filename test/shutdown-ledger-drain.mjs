#!/usr/bin/env node
// SIGTERM drain and the ledger (dario#1370): a request that completes DURING
// the drain is the case the drain exists for (one long streamed agent run),
// so it must reach the lifetime ledger, the key's daily budget total and the
// request log. The ledger closes, and the log ends, only after the drain.
//
// Runs startProxy in-process, holds one request upstream, delivers SIGTERM by
// emitting it on `process` (portable: a real signal on Windows kills the
// process without running handlers), releases the upstream once the drain has
// started, and reads what shutdown left on disk when it calls process.exit.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

const realExit = process.exit.bind(process);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');

process.on('uncaughtException', (e) => { out('UNCAUGHT: ' + (e && e.stack || e)); realExit(1); });
process.on('unhandledRejection', (e) => { out('UNHANDLED: ' + (e && e.stack || e)); realExit(1); });
// Nothing below may hang the suite.
setTimeout(() => { out('FAIL timed out'); realExit(1); }, 60_000).unref();

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-shutdown-ledger-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_API_KEY; delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_CODEX_BASE_URL; delete process.env.DARIO_ANALYTICS_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH; delete process.env.DARIO_LEDGER;
const LEDGER_PATH = join(tmpHome, 'ledger.json');
const LOG_PATH = join(tmpHome, 'requests.log');
process.env.DARIO_LEDGER_PATH = LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

// A named key with a budget, so the drained request also has to reach the
// per-key daily total the budget check reads.
const created = await new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'keys', 'create', 'runner', '--budget=$500/day'], { env: { ...process.env }, cwd: tmpHome });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
  p.on('close', (code) => resolve({ code, out: o }));
});
const KEY = (created.out.match(/dk_[0-9a-f]{48}/) ?? [null])[0];
check('a budgeted key exists', created.code === 0 && KEY !== null, created.out);

// The upstream holds the marked request until the test lets it go.
const INPUT = 700_000, OUTPUT = 3_000;
let upstreamSeen = null;
let releaseUpstream = null;
const released = new Promise((r) => { releaseUpstream = r; });
const seen = new Promise((r) => { upstreamSeen = r; });
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  upstreamSeen();
  await released;
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: INPUT, output_tokens: OUTPUT, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
    },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const exited = new Promise((resolve) => { process.exit = (code) => { resolve(code ?? 0); }; });

const { startProxy } = await import('../dist/proxy.js');
await startProxy({
  host: '127.0.0.1', port: PORT, verbose: false, noLiveCapture: true, fetchImpl,
  pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false, maxTokens: 'client',
  keys: true, logFile: LOG_PATH, shutdownGraceMs: 20_000,
});
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

out('\n=== a request that completes during the SIGTERM drain is counted ===');
const inFlight = fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'long run' }] }),
});
await seen;
process.emit('SIGTERM', 'SIGTERM');
// Let shutdown run its synchronous part and whatever it does before the drain.
await sleep(300);
releaseUpstream();
const res = await inFlight;
const text = await res.text();
check('the in-flight request is served through the drain', res.status === 200 && text.includes('PONG'), `${res.status} ${text.slice(0, 200)}`);
const code = await Promise.race([exited, sleep(15_000).then(() => 'no-exit')]);
check('shutdown exits 0 once drained', code === 0, code);
check('the drain narrated its wait', log.some((l) => l.includes('draining 1 in-flight')), log.filter((l) => l.includes('drain')).join(' | '));

let ledger = null;
try { ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8')); } catch (err) { ledger = { error: err.message }; }
const days = ledger && ledger.days ? Object.values(ledger.days) : [];
const json = JSON.stringify(ledger);
check('the ledger file on disk holds the drained request', json.includes(String(INPUT)) && json.includes(String(OUTPUT)), json.slice(0, 500));
check('…under the key that sent it (the budget total)', json.includes('"runner"'), json.slice(0, 500));
check('…and there is one day of it', days.length === 1, days.length);

let requestLog = '';
try { requestLog = await readFile(LOG_PATH, 'utf8'); } catch { /* checked below */ }
check('the request log has the drained request', requestLog.split('\n').some((l) => l.includes('"status":200') && l.includes('/v1/messages')), requestLog.slice(-400));

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-25).join('\n'));
realExit(fail === 0 ? 0 : 1);

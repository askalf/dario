#!/usr/bin/env node
// Operator-set delays that reach a timer are capped at 2^31 - 1 ms
// (dario#1400, dario#1370). Node replaces a larger delay with 1 ms, so an
// over-long DARIO_CODEX_USAGE_POLL_MS became a 1 ms poll loop and an
// over-long DARIO_SHUTDOWN_GRACE_MS fired the force-exit at once, skipping
// the drain. The last section runs a real startProxy with such a grace and
// SIGTERMs it (emitted on `process`, portable to Windows) mid-request.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.mjs';
import { clampTimerMs, MAX_TIMER_MS } from '../dist/timer-ms.js';
import { resolveCodexUsagePollMs } from '../dist/codex-usage.js';
import { shutdownTimers, SHUTDOWN_FORCE_EXIT_MARGIN_MS } from '../dist/shutdown-drain.js';
import { RequestQueue } from '../dist/request-queue.js';
import { PoolSync } from '../dist/pool-sync.js';
import { OverageGuard } from '../dist/overage-guard.js';

const realExit = process.exit.bind(process);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { out('FAIL timed out'); realExit(1); }, 60_000).unref();

// Any timer this file arms with an out-of-range delay shows up here.
const overflows = [];
process.on('warning', (w) => { if (w.name === 'TimeoutOverflowWarning') overflows.push(w.message); });

const HUGE = 3_000_000_000;

header('clampTimerMs');
{
  check('the ceiling is 2^31 - 1', MAX_TIMER_MS === 2_147_483_647);
  check('in range is unchanged', clampTimerMs(90_000) === 90_000 && clampTimerMs(MAX_TIMER_MS) === MAX_TIMER_MS);
  check('above the ceiling is the ceiling', clampTimerMs(HUGE) === MAX_TIMER_MS && clampTimerMs(MAX_TIMER_MS + 1) === MAX_TIMER_MS);
  check('Infinity is the ceiling', clampTimerMs(Infinity) === MAX_TIMER_MS);
  check('negative, -Infinity and NaN are 0', clampTimerMs(-5) === 0 && clampTimerMs(-Infinity) === 0 && clampTimerMs(NaN) === 0);
}

header('DARIO_CODEX_USAGE_POLL_MS (dario#1400)');
{
  check('3000000000 is capped at the ceiling', resolveCodexUsagePollMs(String(HUGE)) === MAX_TIMER_MS, resolveCodexUsagePollMs(String(HUGE)));
  check('1e12 too', resolveCodexUsagePollMs('1e12') === MAX_TIMER_MS);
  check('0 is still off, small values still floored at a minute', resolveCodexUsagePollMs('0') === 0 && resolveCodexUsagePollMs('1000') === 60_000);
  check('a normal value is unchanged', resolveCodexUsagePollMs('600000') === 600_000);
}

header('the shutdown grace and its force-exit guard (dario#1370)');
{
  const d = shutdownTimers(90_000);
  check('a normal grace: guard 5s past it', d.graceMs === 90_000 && d.forceExitMs === 90_000 + SHUTDOWN_FORCE_EXIT_MARGIN_MS, JSON.stringify(d));
  const h = shutdownTimers(HUGE);
  check('a huge grace: the guard still fits a timer', h.forceExitMs <= MAX_TIMER_MS, JSON.stringify(h));
  check('…and still fires after the drain gives up', h.forceExitMs - h.graceMs === SHUTDOWN_FORCE_EXIT_MARGIN_MS && h.graceMs > 24 * 86_400_000, JSON.stringify(h));
  const top = shutdownTimers(MAX_TIMER_MS);
  check('a grace at the ceiling leaves room for the margin', top.forceExitMs === MAX_TIMER_MS, JSON.stringify(top));
}

header('queue timeout, pool-sync interval, overage cooldown');
{
  const q = new RequestQueue({ maxConcurrent: 1, queueTimeoutMs: HUGE });
  check('queue timeout capped', q.queueTimeoutMs === MAX_TIMER_MS, q.queueTimeoutMs);
  await q.acquire();
  let rejected = null;
  const waiting = q.acquire().then(() => 'got', (e) => { rejected = e; return 'rejected'; });
  await sleep(50);
  check('a queued request is not timed out after 1 ms', rejected === null, rejected && rejected.message);
  q.release();
  check('…and gets the slot when it frees', (await waiting) === 'got');
  q.release();

  const ps = new PoolSync({}, { baseUrl: 'http://127.0.0.1:9', token: '', intervalMs: HUGE });
  check('pool-sync interval capped', ps.intervalMs === MAX_TIMER_MS, ps.intervalMs);

  const g = new OverageGuard({ enabled: true, behavior: 'halt', cooldownMs: HUGE, notifyOs: false });
  check('overage cooldown capped', g.config().cooldownMs === MAX_TIMER_MS, g.config().cooldownMs);
  g.onOverageDetected({ timestamp: Date.now(), model: 'claude-sonnet-5', account: 'one', claim: 'overage', status: 200 });
  await sleep(50);
  check('a halt with a huge cooldown is still halted 50 ms later', g.isHalted());
  g.destroy();
}

header('SIGTERM with DARIO_SHUTDOWN_GRACE_MS past the timer ceiling still drains');
{
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const tmpHome = await mkdtemp(join(tmpdir(), 'dario-timer-clamp-'));
  process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
  process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
  process.env.DARIO_LEDGER_PATH = join(tmpHome, 'ledger.json');
  process.env.DARIO_CODEX_USAGE_POLL_MS = String(HUGE);
  delete process.env.DARIO_API_KEY; delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
  delete process.env.DARIO_CODEX_BASE_URL; delete process.env.DARIO_ANALYTICS_TOKEN;
  const accountsDir = join(tmpHome, '.dario', 'accounts');
  await mkdir(accountsDir, { recursive: true });
  await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
    alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
    expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
  }));

  let release;
  const released = new Promise((r) => { release = r; });
  let seen;
  const upstreamSeen = new Promise((r) => { seen = r; });
  const fetchImpl = async (url) => {
    if (String(url).includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    seen();
    await released;
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' } });
  };

  const log = [];
  for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
  let exitedAt = null;
  const exited = new Promise((resolve) => { process.exit = (code) => { if (exitedAt === null) exitedAt = Date.now(); resolve(code ?? 0); }; });

  const { startProxy } = await import('../dist/proxy.js');
  await startProxy({ host: '127.0.0.1', port: PORT, verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false, shutdownGraceMs: HUGE });
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

  const inFlight = fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'long run' }] }),
  });
  await upstreamSeen;
  const sigtermAt = Date.now();
  process.emit('SIGTERM', 'SIGTERM');
  await sleep(500);
  check('the process has not exited 500 ms into the drain', exitedAt === null, exitedAt === null ? '' : `exited ${exitedAt - sigtermAt} ms after SIGTERM`);
  release();
  const res = await inFlight;
  await res.text();
  check('the in-flight request is served', res.status === 200, res.status);
  const code = await Promise.race([exited, sleep(10_000).then(() => 'no-exit')]);
  check('shutdown exits 0 once the request drains', code === 0, code);
  check('no timer was armed with an out-of-range delay', overflows.length === 0, overflows.join(' | '));
  if (fail > 0) out(log.slice(-20).join('\n'));
}

out(`\n${pass} passed, ${fail} failed`);
realExit(fail === 0 ? 0 : 1);

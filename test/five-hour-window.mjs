#!/usr/bin/env node
// A seat with no five-hour window says so, dario#1893.
//
// Anthropic renamed Max 20x to Ultra on 2026-10-30, and a verified Ultra
// account has no five-hour limit. Read on a live pool on 2026-11-15: the Ultra
// seat's responses carry the weekly headers and no `5h-*` header at all, with
// `representative-claim: seven_day`; the Max seat beside it carries both
// windows. dario read the missing header as 0, which routes correctly, and
// printed `5h 0%`, which reads as a window nobody has used.
//
// The header sets below are those two responses, with the resets moved to
// stay ahead of the clock. Part 1 is in-process. Part 2 drives the real proxy
// on a fake upstream and reads every surface that prints the figure, and the
// one line dario writes when a response carries a usage-limit signal it does
// not act on.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const out = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const ADMIN_TOKEN = 'five-hour-window-admin-token';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-5h-window-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_PORT;
delete process.env.DARIO_POOL_STRATEGY;

const P = 'anthropic-ratelimit-unified-';
const soon = (hours) => String(Math.floor(Date.now() / 1000) + Math.round(hours * 3600));
// The Ultra seat's response: no five-hour header of any kind.
const ULTRA = () => ({
  [`${P}7d-reset`]: soon(90), [`${P}7d-status`]: 'allowed', [`${P}7d-utilization`]: '0.09',
  [`${P}fallback-percentage`]: '0.5', [`${P}overage-disabled-reason`]: 'out_of_credits', [`${P}overage-status`]: 'rejected',
  [`${P}representative-claim`]: 'seven_day', [`${P}reset`]: soon(90), [`${P}status`]: 'allowed',
});
// The Max seat's response: both windows, the five-hour one unused.
const MAX = () => ({
  [`${P}5h-reset`]: soon(2), [`${P}5h-status`]: 'allowed', [`${P}5h-utilization`]: '0.0',
  [`${P}7d-reset`]: soon(40), [`${P}7d-status`]: 'allowed', [`${P}7d-utilization`]: '0.05',
  [`${P}fallback-percentage`]: '0.5', [`${P}overage-disabled-reason`]: 'out_of_credits', [`${P}overage-status`]: 'rejected',
  [`${P}representative-claim`]: 'five_hour', [`${P}reset`]: soon(2), [`${P}status`]: 'allowed',
});

const {
  AccountPool, parseRateLimits, computeHeadroom, describeRateLimitSnapshot, describeRejection,
  fiveHourText, withKnownWindows, usageLimitSignals, EMPTY_SNAPSHOT,
} = await import('../dist/pool.js');
const { formatLiveAccountsListing } = await import('../dist/cli.js');

header('parseRateLimits: which windows the response named');
{
  const ultra = parseRateLimits(new Headers(ULTRA()));
  const max = parseRateLimits(new Headers(MAX()));
  check('Ultra: no five-hour window', ultra.has5h === false, ultra.has5h);
  check('Ultra: the reading is unchanged (5h 0, 7d 0.09, claim seven_day)', ultra.util5h === 0 && ultra.util7d === 0.09 && ultra.claim === 'seven_day', ultra);
  check('Ultra: headroom is its week alone', Math.abs(computeHeadroom(ultra) - 0.91) < 1e-9, computeHeadroom(ultra));
  check('Max: a five-hour window at 0%', max.has5h === true && max.util5h === 0, max);
  check('no rate-limit headers: nothing is claimed either way', !('has5h' in parseRateLimits(new Headers({ 'content-type': 'application/json' }))));
  check('a status header with no window: nothing is claimed', !('has5h' in parseRateLimits(new Headers({ [`${P}status`]: 'rejected' }))));
  check('a five-hour status with no utilization still names the window', parseRateLimits(new Headers({ [`${P}5h-status`]: 'allowed', [`${P}7d-utilization`]: '0.2' })).has5h === true);
  check('an empty five-hour header is a missing one', parseRateLimits(new Headers({ [`${P}5h-utilization`]: '', [`${P}7d-utilization`]: '0.2' })).has5h === false);
  check('the empty snapshot claims nothing', !('has5h' in EMPTY_SNAPSHOT));
}

header('what gets printed');
{
  const ultra = parseRateLimits(new Headers(ULTRA()));
  const max = parseRateLimits(new Headers(MAX()));
  check('fiveHourText: none for Ultra, a percentage for Max and for the unknown',
    fiveHourText(ultra) === 'none' && fiveHourText(max) === '0%' && fiveHourText({ util5h: 0.424 }) === '42%');
  check('the log line names it', describeRateLimitSnapshot(ultra).startsWith('5h none, 7d 9%, claim seven_day, resets in '), describeRateLimitSnapshot(ultra));
  check('the Max line is as it was', describeRateLimitSnapshot(max).startsWith('5h 0%, 7d 5%, claim five_hour, resets in '), describeRateLimitSnapshot(max));

  const listing = (seat) => formatLiveAccountsListing({ accounts: [{ alias: 'seat', status: 'allowed', util5h: 0, util7d: 0.09, utilAgeMs: 1000, ...seat }] }, 3456, Date.now()).join('\n');
  check('live listing: 5h none when the seat has no window', /seat\s+allowed\s+5h none\s+7d 9%/.test(listing({ has5hWindow: false })), listing({ has5hWindow: false }));
  check('live listing: 5h 0% when it has one', /seat\s+allowed\s+5h 0%\s+7d 9%/.test(listing({ has5hWindow: true })), listing({ has5hWindow: true }));
  check('live listing: 5h 0% from an older proxy that sends no field', /seat\s+allowed\s+5h 0%\s+7d 9%/.test(listing({})), listing({}));
}

header('the pool keeps what a seat showed when a response names no window');
{
  const pool = new AccountPool('headroom');
  const add = (alias) => pool.add(alias, {
    accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + 3600_000, deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
  });
  add('ultra');
  check('before any response: unknown', pool.get('ultra').rateLimit.has5h === undefined);
  pool.updateRateLimits('ultra', parseRateLimits(new Headers(ULTRA())));
  check('after its first response: no five-hour window', pool.get('ultra').rateLimit.has5h === false);
  // A 529 from the upstream carries no rate-limit header at all.
  pool.updateRateLimits('ultra', parseRateLimits(new Headers({ 'content-type': 'application/json' })));
  check('a response with no rate-limit headers does not un-learn it', pool.get('ultra').rateLimit.has5h === false, pool.get('ultra').rateLimit);
  pool.updateRateLimits('ultra', parseRateLimits(new Headers(MAX())));
  check('a response that carries the window is believed', pool.get('ultra').rateLimit.has5h === true);
  pool.updateRateLimits('ultra', parseRateLimits(new Headers(ULTRA())));
  check('and one that drops it again is believed too', pool.get('ultra').rateLimit.has5h === false);

  // The week runs out: the 429 names the weekly window and still no five-hour one.
  const weekOut = { ...ULTRA(), [`${P}7d-utilization`]: '1.0', [`${P}7d-status`]: 'rejected', [`${P}status`]: 'rejected' };
  pool.markRejected('ultra', parseRateLimits(new Headers(weekOut)));
  const parked = describeRejection(pool.get('ultra').rateLimit);
  check('the parking line reads 5h none, 7d 100%', parked.startsWith('5h none, 7d 100%, claim seven_day') && parked.endsWith('parked until the window rolls'), parked);

  add('bare');
  pool.updateRateLimits('bare', parseRateLimits(new Headers(ULTRA())));
  pool.markRejected('bare', parseRateLimits(new Headers({ 'retry-after': '30' })));
  const cooled = describeRejection(pool.get('bare').rateLimit);
  check('a 429 with no headers keeps it, and its line says none', pool.get('bare').rateLimit.has5h === false && cooled.includes('(5h none, 7d 0%, claim unknown'), cooled);

  check('withKnownWindows leaves a reading that names a window alone',
    withKnownWindows({ ...EMPTY_SNAPSHOT, has5h: false }, { ...EMPTY_SNAPSHOT, has5h: true }).has5h === true
      && withKnownWindows({ ...EMPTY_SNAPSHOT }, { ...EMPTY_SNAPSHOT }).has5h === undefined);
}

header('usageLimitSignals: the slow and grace headers, and nothing else');
{
  check('none on an ordinary response', usageLimitSignals(new Headers(MAX())) === null && usageLimitSignals(new Headers(ULTRA())) === null);
  const offer = usageLimitSignals(new Headers({ ...MAX(), [`${P}slow-offer`]: 'treatment', [`${P}slow-retry-after`]: '20', [`${P}slow-max-wait`]: '1200' }));
  check('an offer: the pairs in name order', offer?.text === 'slow-max-wait=1200, slow-offer=treatment, slow-retry-after=20', offer);
  check('its key leaves the numbers out', offer?.key === 'slow-max-wait,slow-offer=treatment,slow-retry-after', offer);
  const later = usageLimitSignals(new Headers({ ...MAX(), [`${P}slow-offer`]: 'treatment', [`${P}slow-retry-after`]: '45', [`${P}slow-max-wait`]: '900' }));
  check('other retry times: the same key', later?.key === offer?.key && later?.text !== offer?.text, later);
  const status = usageLimitSignals(new Headers({ [`${P}slow-status`]: 'slot_busy', [`${P}slow-budget-utilization`]: '0.4' }));
  check('another status: another key', status?.key === 'slow-budget-utilization,slow-status=slot_busy', status);
  const grace = usageLimitSignals(new Headers({ [`${P}grace-5h-utilization`]: '0.12' }));
  check('a grace reading counts', grace?.text === 'grace-5h-utilization=0.12' && grace?.key === 'grace-5h-utilization', grace);
  check('header names are read whatever their case', usageLimitSignals({ entries: () => [['Anthropic-RateLimit-Unified-Slow-Offer', 'control']][Symbol.iterator]() })?.text === 'slow-offer=control');
  check('a header that only resembles one is not', usageLimitSignals(new Headers({ 'x-slow-offer': 'treatment', [`${P}overage-status`]: 'rejected', 'anthropic-ratelimit-slow-offer': 'treatment' })) === null);
}

// ─── Part 2: the real proxy on a fake upstream ───
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
const seat = (alias, token) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`, accountId: `acct-${alias}`,
});
await writeFile(join(accountsDir, 'max.json'), seat('max', 'max-token'));
await writeFile(join(accountsDir, 'ultra.json'), seat('ultra', 'ultra-token'));

const calls = [];
let maxAnswers = 0;
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const bearer = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]).replace(/^Bearer\s+/i, '');
  calls.push(bearer);
  // The Max seat's answers also carry the offer Claude Code reads at a limit,
  // with a retry time that changes from one answer to the next.
  const limits = bearer === 'ultra-token' ? ULTRA()
    : { ...MAX(), [`${P}slow-offer`]: 'treatment', [`${P}slow-retry-after`]: String(20 + maxAnswers++), [`${P}slow-max-wait`]: '1200' };
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `req_${calls.length}`, ...limits } });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };

const { startProxy } = await import('../dist/proxy.js');
await startProxy({ host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const pinned = (alias, content) => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-dario-account': alias, 'x-dario-admin-token': ADMIN_TOKEN },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});

header('both seats answer through the proxy');
{
  const statuses = [];
  for (const [alias, n] of [['ultra', 1], ['max', 3]]) {
    for (let i = 0; i < n; i++) { const r = await pinned(alias, `${alias} ${i}`); statuses.push(r.status); await r.text(); }
  }
  check('one answer from Ultra and three from Max, all 200', statuses.join(',') === '200,200,200,200' && calls.filter((c) => c === 'ultra-token').length === 1 && calls.filter((c) => c === 'max-token').length === 3, { statuses, calls });
}

header('GET /accounts and GET /admin/accounts');
{
  const by = Object.fromEntries((await (await fetch(`${BASE}/accounts`)).json()).accounts.map((a) => [a.alias, a]));
  check('/accounts: Ultra has no five-hour window, and the figure is still 0', by.ultra?.has5hWindow === false && by.ultra?.util5h === 0 && by.ultra?.util7d === 0.09, by.ultra);
  check('/accounts: Max has one', by.max?.has5hWindow === true && by.max?.util5h === 0, by.max);
  const admin = Object.fromEntries((await (await fetch(`${BASE}/admin/accounts`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()).accounts.map((a) => [a.alias, a]));
  check('/admin/accounts says the same in snake_case', admin.ultra?.has_5h_window === false && admin.max?.has_5h_window === true, { ultra: admin.ultra, max: admin.max });
}

header('the usage-limit signal is said once per seat');
{
  const lines = log.filter((l) => l.includes('usage-limit signals dario does not act on'));
  check('one line for three answers that carried it', lines.length === 1, lines);
  check('it names the seat and the signals as first seen', /account "max" sent usage-limit signals dario does not act on: slow-max-wait=1200, slow-offer=treatment, slow-retry-after=20$/.test(lines[0] ?? ''), lines[0]);
  check('nothing is said about the seat that carried none', !lines.some((l) => l.includes('"ultra"')));
}

header('dario accounts list --live, as a real child process');
{
  const cli = join(__dirname, '..', 'dist', 'cli.js');
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete env.DARIO_API_KEY;
  const { stdout } = await execFileP(process.execPath, [cli, 'accounts', 'list', '--live', `--port=${PORT}`], { env, timeout: 20_000 });
  check('Ultra reads 5h none', /ultra\s+allowed\s+5h none\s+7d 9%/.test(stdout), stdout);
  check('Max reads 5h 0%', /max\s+allowed\s+5h 0%\s+7d 5%/.test(stdout), stdout);
}

out(`\nfive-hour-window: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

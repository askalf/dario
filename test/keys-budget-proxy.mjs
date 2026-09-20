#!/usr/bin/env node
// Per-key daily budgets through the real proxy (dario#1318 follow-up):
// a key created with `--budget=$X/day` is served until the ledger says its
// day's traffic reached the cap, then refused with 429 in the request's own
// wire shape and a retry-after at UTC midnight; a `--budget-tokens` key the
// same on tokens; a key without a budget is untouched; the served responses
// and the refusal carry x-dario-budget-* headers; `dario keys budget` and
// POST /admin/keys/<name>/budget change it live; /analytics and /metrics
// show every budgeted key's use; with the ledger off a budget is announced as
// unenforced and traffic flows.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');

process.on('uncaughtException', (e) => { out('UNCAUGHT: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { out('UNHANDLED: ' + (e && e.stack || e)); process.exit(1); });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT_KEY = 'root-secret-for-the-budget-test';
const ADMIN_TOKEN = 'admin-secret-for-the-budget-test';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-keys-budget-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_CODEX_BASE_URL; delete process.env.DARIO_ANALYTICS_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

// Every served request costs the same: 100k input + 1k output on sonnet-5.
const INPUT = 100_000, OUTPUT = 1_000;
const fetchImpl = async (url) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
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
const { costOfTokens } = await import('../dist/analytics.js');
const PER_REQUEST_USD = costOfTokens('claude-sonnet-5', Date.now(), { requests: 1, inputTokens: INPUT, outputTokens: OUTPUT, cacheReadTokens: 0, cacheCreateTokens: 0 });
const PER_REQUEST_TOKENS = INPUT + OUTPUT;
// Caps sized so the THIRD request of the day is the first refused one.
const USD_CAP = (PER_REQUEST_USD * 2).toFixed(2);
const TOKENS_CAP = PER_REQUEST_TOKENS * 2;

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const { startProxy } = await import('../dist/proxy.js');
await startProxy({ host: '127.0.0.1', port: PORT, verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (key, content = 'ping') => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const chat = (key) => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
});
const analytics = async () => (await (await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } })).json());
const admin = (method, path, body) => fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
const runCli = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: tmpHome });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
  p.on('close', (code) => resolve({ code, out: o }));
});
const secretIn = (s) => (s.match(/dk_[0-9a-f]{48}/) ?? [null])[0];
const served = async (key) => { const r = await messages(key); const b = await r.text(); return { r, b }; };

header('create: --budget and --budget-tokens, shown in the list');
let alice, bob, carol;
{
  const a = await runCli(['keys', 'create', 'alice', `--budget=$${USD_CAP}/day`]);
  alice = secretIn(a.out);
  check('alice created with a dollar budget', a.code === 0 && alice !== null, a.out);
  const b = await runCli(['keys', 'create', 'bob', `--budget-tokens=${TOKENS_CAP}`]);
  bob = secretIn(b.out);
  check('bob created with a token budget', b.code === 0 && bob !== null, b.out);
  const c = await runCli(['keys', 'create', 'carol']);
  carol = secretIn(c.out);
  check('carol created with no budget', c.code === 0 && carol !== null, c.out);
  const bad = await runCli(['keys', 'create', 'dave', '--budget=lots']);
  check('a budget that does not parse exits 1 and says the forms', bad.code === 1 && bad.out.includes('--budget:') && bad.out.includes('$5/day'), bad.out);
  const list = await runCli(['keys', 'list']);
  check('list shows a BUDGET column with both shapes', list.out.includes('BUDGET') && list.out.includes(`$${USD_CAP}/day`) && list.out.includes('tok/day'), list.out);
  const json = await runCli(['keys', 'list', '--json']);
  const parsed = JSON.parse(json.out);
  check('list --json carries usd_per_day / tokens_per_day / null', parsed.keys.find((k) => k.name === 'alice').budget.usd_per_day === Number(USD_CAP) && parsed.keys.find((k) => k.name === 'bob').budget.tokens_per_day === TOKENS_CAP && parsed.keys.find((k) => k.name === 'carol').budget === null, JSON.stringify(parsed.keys.map((k) => k.budget)));
}

header('the dollar cap: served, served, refused at request start');
{
  const one = await served(alice);
  check('first request served', one.r.status === 200, one.r.status);
  check('…with the budget headers: cap and $0 used so far', one.r.headers.get('x-dario-budget-key') === 'alice' && one.r.headers.get('x-dario-budget-usd') === String(Number(USD_CAP)) && one.r.headers.get('x-dario-budget-used-usd') === '0.0000', [...one.r.headers.entries()].filter(([k]) => k.startsWith('x-dario-budget')));
  check('…and a reset stamp at UTC midnight', /T00:00:00\.000Z$/.test(one.r.headers.get('x-dario-budget-resets-at') ?? ''), one.r.headers.get('x-dario-budget-resets-at'));
  await sleep(50);
  const two = await served(alice);
  check('second request served (one request of use is under the cap)', two.r.status === 200, two.r.status);
  check('…used-usd now shows the first request', Number(two.r.headers.get('x-dario-budget-used-usd')) > 0 && Number(two.r.headers.get('x-dario-budget-used-usd')) < Number(USD_CAP), two.r.headers.get('x-dario-budget-used-usd'));
  await sleep(50);
  const three = await served(alice);
  check('third request refused with 429', three.r.status === 429, `${three.r.status} ${three.b.slice(0, 200)}`);
  const body = JSON.parse(three.b);
  check('…Anthropic shape: rate_limit_error naming the key, the cap and the reset', body.type === 'error' && body.error.type === 'rate_limit_error' && body.error.message.includes('"alice"') && body.error.message.includes('API-equivalent per day') && body.error.message.includes('UTC midnight'), three.b);
  const ra = Number(three.r.headers.get('retry-after'));
  check('…retry-after is the seconds to UTC midnight', ra >= 1 && ra <= 86_400, ra);
  check('…and the budget headers say how far over', Number(three.r.headers.get('x-dario-budget-used-usd')) >= Number(USD_CAP), three.r.headers.get('x-dario-budget-used-usd'));
  const four = await chat(alice); const fourBody = await four.json();
  check('OpenAI shape: 429 with code key_budget_exceeded', four.status === 429 && fourBody.error?.code === 'key_budget_exceeded' && fourBody.error.type === 'rate_limit_error', JSON.stringify(fourBody));
  const a = await analytics();
  check('/analytics window counts the two served requests for alice, not the refusals', a.perConsumer?.alice?.requests === 2, JSON.stringify(a.perConsumer?.alice));
}

header('the token cap, and a key without a budget');
{
  const r1 = await served(bob); const r2 = await served(bob); const r3 = await served(bob);
  check('bob: served, served, refused', r1.r.status === 200 && r2.r.status === 200 && r3.r.status === 429, [r1.r.status, r2.r.status, r3.r.status]);
  const body = JSON.parse(r3.b);
  check('…the message names tokens', body.error.message.includes('tokens per day'), body.error.message);
  check('…headers carry the token cap and use', r3.r.headers.get('x-dario-budget-tokens') === String(TOKENS_CAP) && Number(r3.r.headers.get('x-dario-budget-used-tokens')) >= TOKENS_CAP, [...r3.r.headers.entries()].filter(([k]) => k.startsWith('x-dario-budget')));
  let ok = true;
  for (let i = 0; i < 4; i++) { const r = await served(carol); if (r.r.status !== 200) ok = false; }
  const c = await served(carol);
  check('carol (no budget) is served every time, with no budget headers', ok && c.r.status === 200 && c.r.headers.get('x-dario-budget-key') === null);
  const root = await served(ROOT_KEY);
  check('the root key is never budgeted', root.r.status === 200 && root.r.headers.get('x-dario-budget-key') === null);
}

header('/analytics and /metrics show every budgeted key');
{
  const a = await analytics();
  check('budgets block lists alice and bob, not carol', a.budgets && a.budgets.alice && a.budgets.bob && !a.budgets.carol, JSON.stringify(a.budgets));
  check('alice: usd cap and use', a.budgets.alice.usdPerDay === Number(USD_CAP) && a.budgets.alice.usedUsd >= Number(USD_CAP) && a.budgets.alice.tokensPerDay === null, JSON.stringify(a.budgets.alice));
  check('bob: token cap and use', a.budgets.bob.tokensPerDay === TOKENS_CAP && a.budgets.bob.usedTokens === TOKENS_CAP && a.budgets.bob.usdPerDay === null, JSON.stringify(a.budgets.bob));
  const m = await (await fetch(`${BASE}/metrics`, { headers: { 'x-api-key': ROOT_KEY } })).text();
  const lines = m.split('\n');
  check('metrics: cap and used families per key', lines.includes(`dario_key_budget_usd_per_day{key="alice"} ${Number(USD_CAP)}`) && lines.some((l) => l.startsWith('dario_key_budget_used_usd{key="alice"} ')) && lines.includes(`dario_key_budget_tokens_per_day{key="bob"} ${TOKENS_CAP}`) && lines.includes(`dario_key_budget_used_tokens{key="bob"} ${TOKENS_CAP}`), lines.filter((l) => l.includes('key_budget')).join(' | '));
  check('metrics: HELP/TYPE pairs intact', lines.every((l, i) => !l.startsWith('# HELP') || lines[i + 1]?.startsWith('# TYPE')));
}

header('changing a budget live: CLI and admin API');
{
  const raise = await runCli(['keys', 'budget', 'alice', '--budget=$100/day']);
  check('dario keys budget raises the cap', raise.code === 0 && raise.out.includes('$100/day'), raise.out);
  await sleep(150); // the proxy re-reads the file when its mtime moves
  const r = await served(alice);
  check('alice is served again under the new cap', r.r.status === 200 && r.r.headers.get('x-dario-budget-usd') === '100', `${r.r.status} ${r.r.headers.get('x-dario-budget-usd')}`);
  const clear = await runCli(['keys', 'budget', 'bob', '--clear']);
  check('dario keys budget --clear', clear.code === 0 && clear.out.includes('cleared'), clear.out);
  await sleep(150);
  const b = await served(bob);
  check('bob is served with no budget headers once cleared', b.r.status === 200 && b.r.headers.get('x-dario-budget-key') === null, `${b.r.status} ${b.r.headers.get('x-dario-budget-key')}`);
  const usage = await runCli(['keys', 'budget', 'alice']);
  check('budget with no flags prints usage and exits 1', usage.code === 1 && usage.out.includes('Usage: dario keys budget'), usage.out);

  const set = await admin('POST', '/admin/keys/bob/budget', { budget_tokens_per_day: 5 });
  const setBody = await set.json();
  check('POST /admin/keys/<name>/budget sets it', set.status === 200 && setBody.key.budget.tokens_per_day === 5, JSON.stringify(setBody));
  await sleep(150);
  const refused = await served(bob);
  check('…and the proxy enforces the new cap on the next request', refused.r.status === 429, refused.r.status);
  const cleared = await admin('POST', '/admin/keys/bob/budget', {});
  check('…an empty body clears it', cleared.status === 200 && (await cleared.json()).key.budget === null);
  const badAdmin = await admin('POST', '/admin/keys/bob/budget', { budget_usd_per_day: -3 });
  check('a bad cap is a 400', badAdmin.status === 400, badAdmin.status);
  const missing = await admin('POST', '/admin/keys/nobody/budget', { budget_usd_per_day: 1 });
  check('an unknown key is a 404', missing.status === 404, missing.status);
  const created = await admin('POST', '/admin/keys', { name: 'erin', budget_usd_per_day: '2.50', budget_tokens_per_day: '1M' === '1M' ? 1_000_000 : 0 });
  const createdBody = await created.json();
  check('POST /admin/keys accepts budget fields', created.status === 201 && createdBody.key.budget.usd_per_day === 2.5 && createdBody.key.budget.tokens_per_day === 1_000_000, JSON.stringify(createdBody.key));
  const listed = await (await admin('GET', '/admin/keys')).json();
  check('GET /admin/keys shows budgets', listed.keys.find((k) => k.name === 'erin').budget.usd_per_day === 2.5 && listed.keys.find((k) => k.name === 'carol').budget === null);
}

header('ledger off: a budget is announced as unenforced, traffic flows');
{
  const PORT2 = await freePort();
  const before = log.length;
  await startProxy({ host: '127.0.0.1', port: PORT2, verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false, ledger: false });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT2}/health`); break; } catch { await sleep(100); } }
  const warned = log.slice(before).some((l) => l.includes('NOT enforced') && l.includes('alice'));
  check('startup names the budgeted keys as unenforced', warned, log.slice(before).filter((l) => l.includes('keys')).join(' | '));
  // bob is currently over a 5-token cap? No — it was cleared; give alice a tiny cap and confirm she is still served here.
  await runCli(['keys', 'budget', 'alice', '--budget=$0.01/day']);
  await sleep(150);
  let ok = true;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`http://127.0.0.1:${PORT2}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': alice }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }) });
    await r.text(); if (r.status !== 200) ok = false;
  }
  check('with no ledger the cap cannot bite', ok);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-25).join('\n'));
process.exit(fail === 0 ? 0 : 1);

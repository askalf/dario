#!/usr/bin/env node
// The key-budget reservation is priced on the model the request will be
// billed as (dario#1378), not the client's raw body.model. A short name
// (`fable`) or a server-wide --model override (`opus` over a haiku request)
// used to fall back to the sonnet-4-6 rate, 3.3x under fable's and 4x under
// opus-5-5's cache-write rate, so a burst on a budgeted key could complete
// for several times its cap. A model with no published rate is reserved at
// the highest one (fail closed).
//
// Each case holds one request upstream and sends a second on the same key
// with a cap between the too-cheap reservation and the right one: priced
// right, the second is refused and names what is reserved for the first.

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

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-budget-model-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_API_KEY; delete process.env.DARIO_ADMIN; delete process.env.DARIO_ADMIN_TOKEN;
delete process.env.DARIO_CODEX_BASE_URL; delete process.env.DARIO_ANALYTICS_TOKEN;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_MODEL_ALIASES;
process.env.DARIO_LEDGER_PATH = join(tmpHome, 'ledger.json');
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

// A request whose body says `hold-me` waits upstream until released.
const holds = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    const ids = ['claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id, type: 'model' })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const text = init?.body ? new TextDecoder().decode(init.body) : '';
  if (text.includes('hold-me')) await new Promise((r) => holds.push(r));
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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
const { startProxy } = await import('../dist/proxy.js');
const { requestBudgetReservation } = await import('../dist/keys.js');
const { costOfTokens } = await import('../dist/analytics.js');
const { CC_TEMPLATE_PROMPT_BYTES } = await import('../dist/cc-template.js');

const runCli = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env }, cwd: tmpHome });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
  p.on('close', (code) => resolve({ code, out: o }));
});
const secretIn = (s) => (s.match(/dk_[0-9a-f]{48}/) ?? [null])[0];

const bodyFor = (model, content) => JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content }] });
const post = (base, key, model, content) => fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: bodyFor(model, content),
});
/** What one request of `model` is reserved at, given what the client sent. */
const reserveAt = (billedAs, clientModel) => requestBudgetReservation(
  billedAs, Buffer.byteLength(bodyFor(clientModel, 'hold-me')), 16, costOfTokens, Date.now(), CC_TEMPLATE_PROMPT_BYTES,
).usd;

async function startOn(opts) {
  const port = await freePort();
  await startProxy({ host: '127.0.0.1', port, verbose: false, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false, maxTokens: 'client', keys: true, ...opts });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/health`); break; } catch { await sleep(100); } }
  return base;
}

/**
 * Hold one `clientModel` request on a fresh key whose cap sits halfway
 * between the reservation at `cheapModel` and at `billedAs`, then send a
 * second. Returns the second response and both reservations.
 */
async function burstCase(base, keyName, clientModel, billedAs, cheapModel) {
  const right = reserveAt(billedAs, clientModel);
  const cheap = reserveAt(cheapModel, clientModel);
  const cap = ((right + cheap) / 2).toFixed(2);
  const made = await runCli(['keys', 'create', keyName, `--budget=$${cap}/day`]);
  const key = secretIn(made.out);
  const before = holds.length;
  const held = post(base, key, clientModel, 'hold-me');
  for (let i = 0; i < 100 && holds.length === before; i++) await sleep(20);
  const second = await post(base, key, clientModel, 'probe');
  const body = await second.text();
  holds.splice(before).forEach((r) => r());
  await (await held).text();
  return { key, right, cheap, cap: Number(cap), status: second.status, body, created: made.code === 0 && key !== null };
}
const reservedIn = (body) => { const m = /\+ \$(\d+\.\d\d) reserved for 1 in flight/.exec(body); return m ? Number(m[1]) : null; };

const BASE = await startOn({});

header('a short name is reserved at the model it resolves to');
{
  const c = await burstCase(BASE, 'fable-runner', 'fable', 'claude-fable-5', 'claude-sonnet-4-6');
  check('the sonnet-4-6 fallback really is ~3x cheaper than fable', c.right > c.cheap * 3, `${c.right} vs ${c.cheap}`);
  check('key created with a cap between the two', c.created && c.cap > c.cheap && c.cap < c.right, JSON.stringify(c));
  check('with one `fable` request in flight, the next is refused', c.status === 429, `${c.status} ${c.body.slice(0, 300)}`);
  check('…and the reservation named is fable\'s', reservedIn(c.body) === Number(c.right.toFixed(2)), `${reservedIn(c.body)} vs ${c.right.toFixed(2)}`);
}

header('a model with no published rate is reserved at the highest one');
{
  const c = await burstCase(BASE, 'mystery-runner', 'claude-mystery-9', 'claude-fable-5', 'claude-sonnet-4-6');
  check('refused behind one in-flight request of an unknown model', c.status === 429, `${c.status} ${c.body.slice(0, 300)}`);
  check('…reserved at the highest published rate', reservedIn(c.body) === Number(c.right.toFixed(2)), `${reservedIn(c.body)} vs ${c.right.toFixed(2)}`);
}

header('a server-wide --model override is what the reservation prices');
{
  const OVERRIDE_BASE = await startOn({ model: 'opus' });
  const c = await burstCase(OVERRIDE_BASE, 'haiku-runner', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-haiku-4-5');
  check('opus-5-5 really is ~4x haiku', c.right > c.cheap * 3.5, `${c.right} vs ${c.cheap}`);
  check('a haiku request under --model=opus reserves at opus: the next is refused', c.status === 429, `${c.status} ${c.body.slice(0, 300)}`);
  check('…and the reservation named is opus-5-5\'s', reservedIn(c.body) === Number(c.right.toFixed(2)), `${reservedIn(c.body)} vs ${c.right.toFixed(2)}`);
}

header('a model the key is priced right for is unchanged');
{
  const c = await burstCase(BASE, 'sonnet-runner', 'claude-sonnet-5', 'claude-sonnet-5', 'claude-haiku-4-5');
  check('a sonnet-5 request is reserved at sonnet-5 (refused with the cap below it)', c.status === 429 && reservedIn(c.body) === Number(c.right.toFixed(2)), `${c.status} ${c.body.slice(0, 300)}`);
  const roomy = await runCli(['keys', 'create', 'sonnet-roomy', `--budget=$${(c.right * 2.5).toFixed(2)}/day`]);
  const key = secretIn(roomy.out);
  const before = holds.length;
  const held = post(BASE, key, 'claude-sonnet-5', 'hold-me');
  for (let i = 0; i < 100 && holds.length === before; i++) await sleep(20);
  const second = await post(BASE, key, 'claude-sonnet-5', 'probe');
  await second.text();
  holds.splice(before).forEach((r) => r());
  await (await held).text();
  check('…and served when the cap has room for both', second.status === 200, second.status);
}

out(`\n${pass} passed, ${fail} failed`);
if (fail > 0) out(log.slice(-25).join('\n'));
process.exit(fail === 0 ? 0 : 1);

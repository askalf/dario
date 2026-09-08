#!/usr/bin/env node
// dario#1244 — one subscription under two aliases, end to end.
//
// Three seats on a fake upstream: `busy` and `twin` answer with the same
// organization id and the same five-hour window (same reset second); `spare`
// is on another organization with its own window. Drives the real proxy,
// then asserts what every operator surface says: GET /accounts, GET
// /admin/accounts, the seat records on disk, the proxy log, and
// `dario accounts list --live` run as a real child process.

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
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
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => out(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await freePort();
const ADMIN_TOKEN = 'org-window-admin-token';
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-orgwin-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
delete process.env.DARIO_API_KEY;
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_PORT;
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
// busy and twin are ONE Anthropic account under two aliases: same OAuth
// account uuid on the record (what `dario accounts add` now writes from the
// token's profile). spare is its own. The upstream below gives busy and twin
// the same reset second too — which proves nothing on its own, since
// Anthropic aligns resets to a 20-minute grid (dario#1263).
const ACCT_A = 'acct-aaaaaaaa-0000-4000-8000-00000000000a';
const seat = (alias, token, accountId = `acct-${alias}`, accountEmail = undefined) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
  accountId, ...(accountEmail ? { accountEmail } : {}),
});
await writeFile(join(accountsDir, 'busy.json'), seat('busy', 'busy-token', ACCT_A, 'matteo@example.com'));
await writeFile(join(accountsDir, 'twin.json'), seat('twin', 'twin-token', ACCT_A, 'matteo@example.com'));
await writeFile(join(accountsDir, 'spare.json'), seat('spare', 'spare-token'));

const ORG_A = '927b430e-0000-4000-8000-00000000000a';
const ORG_B = '1a2b3c4d-0000-4000-8000-00000000000b';
const RESET_A = Math.floor(Date.now() / 1000) + 37 * 60;
const RESET_B = Math.floor(Date.now() / 1000) + 4 * 3600;
const bySeat = {
  'busy-token': { org: ORG_A, reset: RESET_A, util5h: 0.42 },
  'twin-token': { org: ORG_A, reset: RESET_A, util5h: 0.42 },
  'spare-token': { org: ORG_B, reset: RESET_B, util5h: 0.05 },
};
const calls = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const auth = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]);
  const bearer = auth.replace(/^Bearer\s+/i, '');
  calls.push(bearer);
  const s = bySeat[bearer];
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-organization-id': s.org,
      'request-id': `req_${calls.length}`,
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(s.util5h),
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(s.reset),
    },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const sharedLines = () => log.filter((l) => l.includes('are the same account'));

const { startProxy } = await import('../dist/proxy.js');
await startProxy({ host: '127.0.0.1', port: PORT, passthrough: false, verbose: false, noLiveCapture: true, fetchImpl });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (content) => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const accounts = async () => (await (await fetch(`${BASE}/accounts`)).json());
const adminAccounts = async () => (await (await fetch(`${BASE}/admin/accounts`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()).accounts;

header('every seat serves once (max-headroom picks the unmeasured seat first)');
{
  // Distinct first messages = distinct conversations; a measured seat has
  // headroom < 1.0, so each request lands on a seat not yet measured.
  for (let i = 0; i < 6 && new Set(calls).size < 3; i++) {
    const r = await messages(`conversation ${i} ${Math.random()}`);
    await r.text();
  }
  check('busy, twin and spare each answered', new Set(calls).size === 3, calls.join(','));
}

header('GET /accounts — organization, same account, distinct accounts');
{
  const body = await accounts();
  const by = Object.fromEntries(body.accounts.map((a) => [a.alias, a]));
  check('organizationId learned per seat', by.busy.organizationId === ORG_A && by.twin.organizationId === ORG_A && by.spare.organizationId === ORG_B, JSON.stringify([by.busy.organizationId, by.spare.organizationId]));
  check('busy ↔ twin are the same account (identity, not reset second)', JSON.stringify(by.busy.sharesWindowWith) === '["twin"]' && JSON.stringify(by.twin.sameAccountAs) === '["busy"]' && by.busy.accountId === ACCT_A && by.busy.accountEmail === 'ma***@example.com', JSON.stringify([by.busy.sharesWindowWith, by.twin.sharesWindowWith]));
  check('spare shares with nobody', Array.isArray(by.spare.sharesWindowWith) && by.spare.sharesWindowWith.length === 0);
  check('distinctWindows / distinctAccounts count the account once → 2', body.distinctWindows === 2 && body.distinctAccounts === 2, body.distinctWindows);
  check('the pool still lists 3 seats', body.accounts.length === 3);
}

header('GET /admin/accounts — the same facts, snake_case');
{
  const by = Object.fromEntries((await adminAccounts()).map((a) => [a.alias, a]));
  check('organization_id', by.busy.organization_id === ORG_A && by.spare.organization_id === ORG_B);
  check('shares_window_with / same_account_as / account_id', JSON.stringify(by.twin.shares_window_with) === '["busy"]' && JSON.stringify(by.twin.same_account_as) === '["busy"]' && by.spare.shares_window_with.length === 0 && by.busy.account_id === ACCT_A && by.busy.account_email === 'ma***@example.com');
}

header('the request path never writes the seat record (the refresh does)');
{
  const busy = JSON.parse(await readFile(join(accountsDir, 'busy.json'), 'utf8'));
  check('busy.json untouched by serving', busy.organizationId === undefined && busy.accessToken === 'busy-token');
}

header('a record that already states its organization is known before any request');
{
  // A seat written with organizationId (by an earlier refresh) is loaded with
  // it. Reconcile from disk is what an admin change triggers: add the file,
  // remove another seat through the admin API, and the pool reloads.
  const ORG_C = 'c0ffee00-0000-4000-8000-00000000000c';
  await writeFile(join(accountsDir, 'late.json'), JSON.stringify({ ...JSON.parse(seat('late', 'late-token')), organizationId: ORG_C }));
  const del = await fetch(`${BASE}/admin/accounts/spare`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check('spare removed via the admin API', del.status === 200, del.status);
  const by = Object.fromEntries((await accounts()).accounts.map((a) => [a.alias, a]));
  check('late is in the pool with its recorded organization, unmeasured', by.late?.organizationId === ORG_C && by.late?.requestCount === 0, JSON.stringify(by.late));
  check('busy kept what it learned across the reload', by.busy?.organizationId === ORG_A);
  check('spare is gone', by.spare === undefined);
}

header('the proxy says it once');
{
  check('exactly one shared-window line', sharedLines().length === 1, JSON.stringify(sharedLines()));
  check('it names both seats, the masked email and the account count', /seats "(busy|twin)" and "(busy|twin)" are the same account \(ma\*\*\*@example\.com\).*2 distinct accounts across 3 seats/.test(sharedLines()[0] ?? ''), sharedLines()[0]);
  // More traffic on the pair must not repeat it.
  for (let i = 0; i < 3; i++) { const r = await messages(`again ${i} ${Math.random()}`); await r.text(); }
  check('still one line after more requests', sharedLines().length === 1, sharedLines().length);
}

header('dario accounts list --live — the running proxy\'s view, as a real child process');
{
  const cli = join(__dirname, '..', 'dist', 'cli.js');
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete env.DARIO_API_KEY;
  const { stdout } = await execFileP(process.execPath, [cli, 'accounts', 'list', '--live', `--port=${PORT}`], { env, timeout: 20_000 });
  check('headline says it is live and counts accounts', /Accounts \(live/.test(stdout) && /3 seats on 2 distinct accounts/.test(stdout), stdout.slice(0, 400));
  check('the unmeasured seat says so', /late[\s\S]*never measured/.test(stdout), stdout);
  check('a seat row carries status and reading', /busy\s+allowed\s+5h 42%/.test(stdout), stdout);
  check('organization short id shown', stdout.includes(`org ${ORG_A.slice(0, 8)}`), stdout);
  check('same account named both ways, with the masked email', /busy[\s\S]*same account as twin/.test(stdout) && /twin[\s\S]*same account as busy/.test(stdout) && /account ma\*\*\*@example\.com/.test(stdout), stdout);
  check('served / 429s counters shown', /served \d+  ·  429s 0/.test(stdout), stdout);

  // Without a proxy the flag falls back to the on-disk listing with a note.
  const dead = await freePort();
  const r2 = await execFileP(process.execPath, [cli, 'accounts', 'list', '--live', `--port=${dead}`], { env, timeout: 20_000 });
  check('no proxy → note + on-disk listing', /no proxy on http:\/\/127\.0\.0\.1:\d+/.test(r2.stdout) && /token expires in/.test(r2.stdout), r2.stdout.slice(0, 300));
}

out(`\npool-org-window-surfaces: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

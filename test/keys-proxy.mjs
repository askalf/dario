#!/usr/bin/env node
// Named keys through the real proxy (dario#1318): `dario keys create` →
// the running proxy accepts the key on its next request with no restart;
// attribution rides the credential (a header cannot overrule it) into
// /analytics, the ledger (`dario usage --by-key`) and the log file; a key's
// preferred seat is taken while eligible and passed over when parked; a
// key's model allowlist refuses in both wire shapes before anything goes
// upstream; revoke / rotate / expire take effect at once, from the CLI and
// from /admin/keys; the root DARIO_API_KEY keeps working beside them;
// --no-keys ignores the file; a proxy with no root key still refuses an
// unknown dk_ credential.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT_KEY = 'root-secret-for-the-test';
const ADMIN_TOKEN = 'admin-secret-for-the-test';

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-keys-proxy-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
process.env.DARIO_API_KEY = ROOT_KEY;
process.env.DARIO_ADMIN = '1';
process.env.DARIO_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
delete process.env.DARIO_CODEX_BASE_URL;
delete process.env.DARIO_KEYS; delete process.env.DARIO_KEYS_PATH;
delete process.env.DARIO_LEDGER; delete process.env.DARIO_LEDGER_PATH;
const KEYS = join(tmpHome, '.dario', 'keys.json');
const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
const seat = (alias, token) => JSON.stringify({
  alias, accessToken: token, refreshToken: `${token}-refresh`,
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'],
  deviceId: `dev-${alias}`, accountUuid: `uuid-${alias}`,
});
await writeFile(join(accountsDir, 'one.json'), seat('one', 'one-token'));
await writeFile(join(accountsDir, 'two.json'), seat('two', 'two-token'));
const logFile = join(tmpHome, 'proxy.log');

// Upstream stub: records the bearer each call presented; can 429 one seat.
let rejectTwo = false;
const started = [];
const fetchImpl = async (url, init) => {
  if (String(url).includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }, { id: 'claude-opus-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const h = init?.headers;
  const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
  const bearer = String((pairs.find(([k]) => String(k).toLowerCase() === 'authorization') ?? [, ''])[1]).replace(/^Bearer\s+/i, '');
  started.push(bearer);
  const base = {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
  };
  if (rejectTwo && bearer === 'two-token') {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'parked' } }), {
      status: 429,
      headers: { ...base, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.0', 'anthropic-ratelimit-unified-7d-utilization': '0.5', 'retry-after': '3600' },
    });
  }
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), {
    status: 200,
    headers: { ...base, 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.10', 'anthropic-ratelimit-unified-7d-utilization': '0.05' },
  });
};

const log = [];
for (const m of ['log', 'error', 'warn']) console[m] = (...a) => { log.push(a.map(String).join(' ')); };
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
// The harness's check/header print through console.log, which is captured above.
const say = (s) => out(s);
const check2 = (name, cond, detail) => { const before = log.length; check(name, cond, detail); say(log.splice(before).join('\n')); };
const header2 = (n) => say(`\n=== ${n} ===`);

const { startProxy } = await import('../dist/proxy.js');
const { readKeysFile, writeKeysFile } = await import('../dist/keys.js');
const proxyOpts = { host: '127.0.0.1', verbose: true, noLiveCapture: true, fetchImpl, pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false };
await startProxy({ ...proxyOpts, port: PORT, logFile });
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); } }

const messages = (content, headers = {}, model = 'claude-sonnet-5') => fetch(`${BASE}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const chat = (content, headers = {}, model = 'claude-sonnet-5') => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content }] }),
});
const analytics = async () => (await (await fetch(`${BASE}/analytics`, { headers: { 'x-api-key': ROOT_KEY } })).json());
const admin = (method, path, body) => fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
const runCli = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: tmpHome });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
  p.on('close', (code) => resolve({ code, out: o }));
});
const secretIn = (s) => (s.match(/dk_[0-9a-f]{48}/) ?? [null])[0];

header2('dario keys create: the secret once, a hash on disk, the proxy sees it next request');
let alice, bob, carol;
{
  const empty = await runCli(['keys', 'list']);
  check2('list before any key says so', empty.code === 0 && empty.out.includes('No named keys yet'), empty.out);
  const a = await runCli(['keys', 'create', 'alice']);
  alice = secretIn(a.out);
  check2('create prints the secret and where it counts', a.code === 0 && alice !== null && a.out.includes('Key "alice" created') && a.out.includes('Shown once'), a.out);
  const b = await runCli(['keys', 'create', 'bob', '--seat=two', '--models=claude-sonnet-5,claude-haiku*']);
  bob = secretIn(b.out);
  check2('create with a seat and models', b.code === 0 && bob !== null && b.out.includes('Preferred seat: two') && b.out.includes('Models: claude-sonnet-5, claude-haiku*'), b.out);
  const c = await runCli(['keys', 'create', 'carol', '--expires=1h']);
  carol = secretIn(c.out);
  check2('create with an expiry', c.code === 0 && carol !== null && /Expires: \d{4}-/.test(c.out), c.out);
  const dup = await runCli(['keys', 'create', 'alice']);
  check2('a duplicate name is refused', dup.code === 1 && dup.out.includes('already exists'), dup.out);
  const raw = await readFile(KEYS, 'utf8');
  check2('the file holds hashes, never a secret', raw.includes('"hash"') && ![alice, bob, carol].some((s) => raw.includes(s)) && JSON.parse(raw).keys.length === 3, raw);
  const j = await runCli(['keys', 'list', '--json']);
  const parsed = JSON.parse(j.out);
  check2('list --json: three keys, no hash field, bob carries seat and models', parsed.count === 3 && parsed.keys.every((k) => !('hash' in k)) && parsed.keys.find((k) => k.name === 'bob').seat === 'two' && parsed.keys.find((k) => k.name === 'bob').models.length === 2, j.out);
}

header2('authentication: root key, named keys, neither');
{
  let r = await messages('no key'); await r.text();
  check2('no credential → 401 (root key is set)', r.status === 401);
  r = await messages('root', { 'x-api-key': ROOT_KEY }); await r.text();
  check2('root key still works', r.status === 200);
  r = await messages('alice x-api-key', { 'x-api-key': alice }); await r.text();
  check2('alice via x-api-key', r.status === 200);
  r = await messages('alice bearer', { authorization: `Bearer ${alice}` }); await r.text();
  check2('alice via Authorization: Bearer', r.status === 200);
  r = await messages('alice pretending', { 'x-api-key': alice, 'x-dario-consumer': 'mallory' }); await r.text();
  check2('a header cannot overrule the credential (served)', r.status === 200);
  r = await messages('unknown dk', { 'x-api-key': 'dk_' + 'f'.repeat(48) }); await r.text();
  check2('an unknown dk_ credential → 401', r.status === 401);
  check2('-v names the reject as a named key, without the value', log.some((l) => l.includes('named key unknown, revoked or expired')) && !log.some((l) => l.includes('f'.repeat(48))), log.filter((l) => l.includes('401')).join(' | '));
  const a = await analytics();
  check2('/analytics.perConsumer: alice has 3 requests and mallory does not exist', a.perConsumer?.alice?.requests === 3 && !('mallory' in (a.perConsumer ?? {})), JSON.stringify(a.perConsumer));
  check2('/analytics.lifetime.perConsumer carries the same split', a.lifetime?.perConsumer?.alice?.requests === 3 && a.lifetime.perConsumer.alice.apiEquivalentCost === 6, JSON.stringify(a.lifetime?.perConsumer));
}

header2('seat preference: taken while eligible, passed over when parked, sticky follows the key');
{
  started.length = 0;
  let r = await messages('bob conversation A', { 'x-api-key': bob }); await r.text();
  r = await messages('bob conversation B', { 'x-api-key': bob }); await r.text();
  r = await messages('bob conversation A', { 'x-api-key': bob }); await r.text();
  check2('every bob request landed on seat two', r.status === 200 && started.length === 3 && started.every((b) => b === 'two-token'), started.join(','));
  const a = await analytics();
  check2('bob is attributed, with seat two listed', a.perConsumer?.bob?.requests === 3 && a.perConsumer.bob.accounts?.includes('two'), JSON.stringify(a.perConsumer?.bob));
  // Seat two 429s with a live window: the request fails over (unchanged), and
  // the next bob request does not wait for a parked seat.
  rejectTwo = true;
  started.length = 0;
  r = await messages('bob while two is parked', { 'x-api-key': bob }); await r.text();
  check2('a 429 on the preferred seat fails over to another seat mid-request', r.status === 200 && started[0] === 'two-token' && started[started.length - 1] === 'one-token', `${r.status} ${started.join(',')}`);
  rejectTwo = false;
  started.length = 0;
  r = await messages('bob after the park', { 'x-api-key': bob }); await r.text();
  check2('with two parked, bob routes normally (seat one) instead of failing', r.status === 200 && started.length === 1 && started[0] === 'one-token', `${r.status} ${started.join(',')}`);
  // A key naming a seat that does not exist routes normally.
  const ghost = await runCli(['keys', 'create', 'ghost', '--seat=nine']);
  started.length = 0;
  r = await messages('ghost seat', { 'x-api-key': secretIn(ghost.out) }); await r.text();
  check2('a preferred seat that is not in the pool is ignored', r.status === 200 && started.length === 1, `${r.status} ${started.join(',')}`);
}

header2('model allowlist: 403 in both wire shapes, nothing sent upstream');
{
  started.length = 0;
  let r = await messages('bob wants opus', { 'x-api-key': bob }, 'claude-opus-5');
  let j = await r.json();
  check2('Anthropic shape: 403 with a permission_error naming the key and the allowed models', r.status === 403 && j.type === 'error' && j.error.type === 'permission_error' && j.error.message.includes('"bob"') && j.error.message.includes('claude-sonnet-5'), JSON.stringify(j));
  r = await chat('bob wants opus', { authorization: `Bearer ${bob}` }, 'claude-opus-5');
  j = await r.json();
  check2('OpenAI shape: 403 with error.code model_not_allowed', r.status === 403 && j.error?.code === 'model_not_allowed' && j.error.param === 'model', JSON.stringify(j));
  check2('nothing went upstream', started.length === 0);
  r = await messages('bob haiku', { 'x-api-key': bob }, 'claude-haiku-4-5'); await r.text();
  check2('a prefix* entry admits the model', r.status !== 403, r.status);
  r = await messages('alice opus', { 'x-api-key': alice }, 'claude-opus-5'); await r.text();
  check2('a key without a list is not restricted', r.status === 200);
}

header2('revoke, expire, rotate: at once, no restart');
{
  const rv = await runCli(['keys', 'revoke', 'alice']);
  check2('dario keys revoke', rv.code === 0 && rv.out.includes('revoked'), rv.out);
  let r = await messages('alice after revoke', { 'x-api-key': alice }); await r.text();
  check2('a revoked key is refused on the next request', r.status === 401);
  await sleep(30);
  const file = readKeysFile(KEYS);
  file.keys.find((k) => k.name === 'carol').expires = new Date(Date.now() - 1000).toISOString();
  writeKeysFile(KEYS, file);
  r = await messages('carol after expiry', { 'x-api-key': carol }); await r.text();
  check2('an expired key is refused', r.status === 401);
  const ls = await runCli(['keys', 'list']);
  check2('list shows revoked and expired', /alice\s+revoked/.test(ls.out) && /carol\s+expired/.test(ls.out) && /bob\s+active\s+two/.test(ls.out), ls.out);
  const rt = await runCli(['keys', 'rotate', 'bob']);
  const bob2 = secretIn(rt.out);
  check2('dario keys rotate prints a new secret', rt.code === 0 && bob2 && bob2 !== bob && rt.out.includes('Preferred seat: two'), rt.out);
  r = await messages('old bob', { 'x-api-key': bob }); await r.text();
  check2('the old secret stopped working', r.status === 401);
  started.length = 0;
  r = await messages('new bob', { 'x-api-key': bob2 }); await r.text();
  check2('the new one works and keeps the seat preference (two is parked, so seat one)', r.status === 200 && started[0] === 'one-token', started.join(','));
  bob = bob2;
  const rm = await runCli(['keys', 'remove', 'ghost']);
  check2('dario keys remove forgets a key', rm.code === 0 && !(await readFile(KEYS, 'utf8')).includes('ghost'), rm.out);
  const nope = await runCli(['keys', 'rotate', 'nobody']);
  check2('rotate of an unknown name exits 1', nope.code === 1 && nope.out.includes('No key named'), nope.out);
}

header2('/admin/keys: the same file over HTTP, audited');
{
  let r = await fetch(`${BASE}/admin/keys`);
  check2('no admin token → 401', r.status === 401);
  r = await admin('GET', '/admin/keys');
  let j = await r.json();
  check2('GET lists every key without hashes, with the path', r.status === 200 && j.count === 3 && j.path === KEYS && j.keys.every((k) => !('hash' in k)) && j.keys.find((k) => k.name === 'alice').status === 'revoked', JSON.stringify(j));
  r = await admin('POST', '/admin/keys', { name: 'dave', models: ['claude-sonnet-5'], expires: '2w' });
  j = await r.json();
  const dave = j.secret;
  check2('POST mints a key: 201, the secret once, the public record', r.status === 201 && /^dk_[0-9a-f]{48}$/.test(dave ?? '') && j.key.name === 'dave' && j.key.models[0] === 'claude-sonnet-5' && j.key.expires && !('hash' in j.key), JSON.stringify(j));
  const raw = await readFile(KEYS, 'utf8');
  check2('the file has dave\'s hash, not the secret', raw.includes('"dave"') && !raw.includes(dave));
  r = await messages('dave', { 'x-api-key': dave }); await r.text();
  check2('the key minted over HTTP works on the next request', r.status === 200);
  r = await admin('POST', '/admin/keys', { name: 'dave' });
  check2('duplicate → 409', r.status === 409);
  r = await admin('POST', '/admin/keys', { name: 'bad name' });
  check2('bad name → 400', r.status === 400);
  r = await admin('POST', '/admin/keys', { name: 'erin', expires: 'soon' });
  check2('bad expiry → 400', r.status === 400);
  r = await admin('POST', '/admin/keys/dave/rotate');
  j = await r.json();
  const dave2 = j.secret;
  check2('rotate over HTTP: new secret, same record', r.status === 200 && dave2 && dave2 !== dave && j.key.name === 'dave', JSON.stringify(j));
  r = await messages('old dave', { 'x-api-key': dave }); await r.text();
  check2('the old secret is dead', r.status === 401);
  r = await admin('DELETE', '/admin/keys/dave');
  j = await r.json();
  check2('DELETE revokes', r.status === 200 && j.revoked === true && j.name === 'dave', JSON.stringify(j));
  r = await messages('revoked dave', { 'x-api-key': dave2 }); await r.text();
  check2('the revoked key is refused', r.status === 401);
  r = await admin('DELETE', '/admin/keys/nobody');
  check2('unknown name → 404', r.status === 404);
  r = await admin('POST', '/admin/keys/nobody/rotate');
  check2('rotate unknown → 404', r.status === 404);
  r = await admin('PUT', '/admin/keys');
  check2('PUT /admin/keys → 405', r.status === 405);
  check2('audit lines name the key and never the secret', log.some((l) => l.includes('admin-audit: key_create key=dave ok=true status=201')) && log.some((l) => l.includes('admin-audit: key_rotate key=dave ok=true')) && log.some((l) => l.includes('admin-audit: key_revoke key=dave ok=true')) && !log.some((l) => l.includes(dave) || l.includes(dave2)), log.filter((l) => l.includes('admin-audit')).join('\n'));
}

header2('dario usage --by-key and the log file');
{
  const u = await runCli(['usage', `--port=${PORT}`, '--by-key']);
  check2('usage --by-key prints the split with alice and bob', u.code === 0 && u.out.includes('By key (') && /alice\s+\$8\.00/.test(u.out) && u.out.includes('bob'), u.out);
  const plain = await runCli(['usage', `--port=${PORT}`]);
  check2('plain usage points at --by-key', plain.out.includes('`dario usage --by-key`'), plain.out);
  await sleep(100);
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  check2('request lines carry the key name as consumer', lines.filter((l) => l.consumer === 'alice' && l.status === 200).length === 4 && lines.some((l) => l.consumer === 'bob'), JSON.stringify(lines.map((l) => l.consumer)));
  check2('the model refusal is logged as reject: key-model', lines.filter((l) => l.status === 403 && l.reject === 'key-model').length === 2);
  check2('admin key events are logged with the key name', lines.some((l) => l.event === 'admin.key_rotate' && l.key === 'dave') && lines.some((l) => l.event === 'admin.key_create' && l.key === 'dave'));
  const all = await readFile(logFile, 'utf8');
  check2('no secret in the log file', ![alice, bob, carol].some((s) => all.includes(s)));
}

header2('--no-keys, and a proxy with no root key');
{
  const port2 = await freePort();
  await startProxy({ ...proxyOpts, port: port2, keys: false });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port2}/health`); break; } catch { await sleep(100); } }
  let r = await fetch(`http://127.0.0.1:${port2}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': bob }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }) }); await r.text();
  check2('--no-keys: a named key is just a wrong key (401)', r.status === 401);
  r = await fetch(`http://127.0.0.1:${port2}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ROOT_KEY }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }) }); await r.text();
  check2('--no-keys: the root key works', r.status === 200);
  r = await fetch(`http://127.0.0.1:${port2}/admin/keys`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check2('--no-keys: /admin/keys says the feature is off (404)', r.status === 404);

  delete process.env.DARIO_API_KEY;
  const port3 = await freePort();
  await startProxy({ ...proxyOpts, port: port3 });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port3}/health`); break; } catch { await sleep(100); } }
  const post3 = (headers) => fetch(`http://127.0.0.1:${port3}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }) });
  r = await post3({}); await r.text();
  check2('no root key: an anonymous loopback request is served, as before', r.status === 200);
  r = await post3({ 'x-api-key': bob }); await r.text();
  check2('no root key: a named key is served and attributed', r.status === 200 && (await (await fetch(`http://127.0.0.1:${port3}/analytics`)).json()).perConsumer?.bob?.requests === 1);
  r = await post3({ 'x-api-key': alice }); await r.text();
  check2('no root key: a revoked key is refused, not served anonymously', r.status === 401);
  r = await post3({ 'x-api-key': 'dk_' + '0'.repeat(48) }); await r.text();
  check2('no root key: an unknown dk_ is refused', r.status === 401);
}

header2('passthrough: a named key changes what dario knows, not what upstream sees');
{
  // The reporter's constraint (dario#1318): developers use Claude Code
  // through --passthrough and the requests must not be modified. The key is
  // swapped for the seat's bearer as any inbound key already is; the body
  // reaches upstream byte-identical.
  const port4 = await freePort();
  const seen = [];
  const passFetch = async (url, init) => {
    if (!String(url).includes('/v1/models')) {
      const h = init.headers;
      const pairs = Array.isArray(h) ? h : h instanceof Headers ? [...h.entries()] : Object.entries(h ?? {});
      seen.push({ body: typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf-8'), headers: Object.fromEntries(pairs.map(([k, v]) => [String(k).toLowerCase(), String(v)])) });
    }
    return fetchImpl(url, init);
  };
  await startProxy({ ...proxyOpts, port: port4, passthrough: true, fetchImpl: passFetch });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port4}/health`); break; } catch { await sleep(100); } }
  const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, stream: false, metadata: { user_id: 'user_abc_account_def_session_ghi' }, messages: [{ role: 'user', content: 'byte for byte' }] });
  const r = await fetch(`http://127.0.0.1:${port4}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': bob, 'anthropic-version': '2023-06-01' }, body }); await r.text();
  check2('served through passthrough', r.status === 200 && seen.length === 1, `${r.status} ${seen.length}`);
  check2('the body went upstream unchanged', seen[0]?.body === body, seen[0]?.body);
  check2('upstream saw a seat bearer, never the named key', /^Bearer (one|two)-token$/.test(seen[0]?.headers.authorization ?? '') && !JSON.stringify(seen[0]?.headers).includes(bob), JSON.stringify(seen[0]?.headers));
  const a4 = await (await fetch(`http://127.0.0.1:${port4}/analytics`)).json();
  check2('and the request is still bob\'s in /analytics', a4.perConsumer?.bob?.requests === 1, JSON.stringify(a4.perConsumer));
}

say(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

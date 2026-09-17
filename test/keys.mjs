#!/usr/bin/env node
// Unit tests for src/keys.ts (dario#1318) — named keys: mint, hash, match,
// create / revoke / rotate / delete, expiry, the model allowlist, the file's
// parse tolerance and mode, the KeyStore's reload-on-mtime and debounced
// last-used stamp — and the ledger's per-consumer split that the keys feed.

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEYS_VERSION, KEY_PREFIX, KEYS_FLUSH_DELAY_MS, KeyStore,
  createKey, deleteKey, emptyKeysFile, hashKey, keyAllowsModel, keyIsUsable, keysPathFor, looksLikeNamedKey,
  matchKey, mintSecret, parseExpiry, parseKeysFile, publicKey, readKeysFile, resolveKeysPath, revokeKey, rotateKey, writeKeysFile,
} from '../dist/keys.js';
import { addToLedger, emptyLedger, formatLedgerConsumers, parseLedger, pruneLedger, summarizeLedger, summarizeLedgerConsumers } from '../dist/ledger.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.parse('2026-09-14T12:00:00Z');

header('secrets: shape, hashing, recognition');
{
  const a = mintSecret(), b = mintSecret();
  check('a secret is dk_ + 48 hex', /^dk_[0-9a-f]{48}$/.test(a) && a.startsWith(KEY_PREFIX), a);
  check('two mints differ', a !== b);
  check('hashKey is sha256 hex, deterministic', /^[0-9a-f]{64}$/.test(hashKey(a)) && hashKey(a) === hashKey(a) && hashKey(a) !== hashKey(b));
  check('looksLikeNamedKey: only the dk_ prefix', looksLikeNamedKey(a) && !looksLikeNamedKey('sk-ant-xyz') && !looksLikeNamedKey(undefined) && !looksLikeNamedKey(''));
  check('paths: ~/.dario/keys.json, DARIO_KEYS_PATH wins', keysPathFor('/h').endsWith(join('.dario', 'keys.json')) && resolveKeysPath({ DARIO_KEYS_PATH: '/x/k.json' }) === '/x/k.json' && resolveKeysPath({}) === keysPathFor());
}

header('create: records, validation, options');
{
  const file = emptyKeysFile();
  check('empty file has the version and no keys', file.version === KEYS_VERSION && file.keys.length === 0);
  const { record, secret } = createKey(file, 'alice', { now: NOW });
  check('record: id 8 hex, name, hash of the secret, created at now, nothing else', /^[0-9a-f]{8}$/.test(record.id) && record.name === 'alice' && record.hash === hashKey(secret) && record.created === new Date(NOW).toISOString() && !('seat' in record) && !('models' in record) && !('expires' in record), JSON.stringify(record));
  check('the secret is not in the file', !JSON.stringify(file).includes(secret));
  let threw = null; try { createKey(file, 'alice'); } catch (e) { threw = e.message; }
  check('duplicate name refused', /already exists/.test(threw ?? ''), threw);
  for (const bad of ['', ' ', '-lead', 'has space', 'a'.repeat(65), 'sl/ash']) {
    let t = null; try { createKey(file, bad); } catch (e) { t = e.message; }
    check(`invalid name refused: ${JSON.stringify(bad)}`, /invalid key name/.test(t ?? ''), t);
  }
  const bob = createKey(file, ' bob ', { seat: 'work', models: [' claude-sonnet-5 ', 'claude-haiku*', ''], expiresAt: NOW + 86_400_000, now: NOW });
  check('name trimmed, seat kept, models trimmed and emptied out, expiry ISO', bob.record.name === 'bob' && bob.record.seat === 'work' && JSON.stringify(bob.record.models) === '["claude-sonnet-5","claude-haiku*"]' && bob.record.expires === new Date(NOW + 86_400_000).toISOString(), JSON.stringify(bob.record));
  let t2 = null; try { createKey(file, 'carol', { expiresAt: NOW - 1, now: NOW }); } catch (e) { t2 = e.message; }
  check('expiry in the past refused', /future/.test(t2 ?? ''), t2);
  let t3 = null; try { createKey(file, 'carol', { seat: 'bad alias' }); } catch (e) { t3 = e.message; }
  check('invalid seat alias refused', /invalid seat alias/.test(t3 ?? ''), t3);
  check('ids are unique across the file', new Set(file.keys.map((k) => k.id)).size === file.keys.length);
}

header('match: constant-time over every record; revoked and expired match nothing');
{
  const file = emptyKeysFile();
  const alice = createKey(file, 'alice', { now: NOW });
  const bob = createKey(file, 'bob', { expiresAt: NOW + 1000, now: NOW });
  check('the right secret finds its record', matchKey(file, alice.secret, NOW)?.name === 'alice');
  check('a wrong secret finds nothing', matchKey(file, 'dk_' + '0'.repeat(48), NOW) === null && matchKey(file, '', NOW) === null && matchKey(file, alice.secret.slice(0, -1), NOW) === null);
  check('an expired key matches nothing after its time, and did before', matchKey(file, bob.secret, NOW) ?.name === 'bob' && matchKey(file, bob.secret, NOW + 1000) === null);
  check('keyIsUsable agrees', keyIsUsable(bob.record, NOW) && !keyIsUsable(bob.record, NOW + 1000));
  check('revoke: true for a known name, false for unknown', revokeKey(file, 'alice') && !revokeKey(file, 'nobody'));
  check('a revoked key matches nothing and stays in the file', matchKey(file, alice.secret, NOW) === null && file.keys.some((k) => k.name === 'alice' && k.disabled === true));
  const rotated = rotateKey(file, 'alice', NOW + 5);
  check('rotate: new secret, same id and name, revocation cleared, old secret dead', rotated && rotated.secret !== alice.secret && rotated.record.id === alice.record.id && !rotated.record.disabled && matchKey(file, alice.secret, NOW + 5) === null && matchKey(file, rotated.secret, NOW + 5)?.name === 'alice', JSON.stringify(rotated));
  check('rotate unknown → null', rotateKey(file, 'nobody') === null);
  check('delete: gone from the file; false for unknown', deleteKey(file, 'alice') && !file.keys.some((k) => k.name === 'alice') && !deleteKey(file, 'alice'));
}

header('model allowlist');
{
  const k = { models: ['claude-sonnet-5', 'claude-opus*'] };
  check('exact id allowed', keyAllowsModel(k, 'claude-sonnet-5'));
  check('prefix* allowed', keyAllowsModel(k, 'claude-opus-5') && keyAllowsModel(k, 'claude-opus-4-1-20250805'));
  check('case-insensitive', keyAllowsModel(k, 'Claude-Sonnet-5'));
  check('anything else refused, including nothing', !keyAllowsModel(k, 'claude-haiku-4-5') && !keyAllowsModel(k, '') && !keyAllowsModel(k, null) && !keyAllowsModel(k, undefined));
  check('no list = any model', keyAllowsModel({}, 'whatever') && keyAllowsModel({ models: [] }, 'whatever'));
}

header('expiry parsing');
{
  check('30d / 12h / 2w are relative to now', parseExpiry('30d', NOW) === NOW + 30 * 86_400_000 && parseExpiry('12H', NOW) === NOW + 12 * 3_600_000 && parseExpiry('2w', NOW) === NOW + 14 * 86_400_000);
  check('ISO date is absolute', parseExpiry('2026-12-31', NOW) === Date.parse('2026-12-31') && parseExpiry('2026-12-31T10:00:00Z', NOW) === Date.parse('2026-12-31T10:00:00Z'));
  check('garbage and zero → null', parseExpiry('soon', NOW) === null && parseExpiry('0d', NOW) === null && parseExpiry('', NOW) === null);
}

header('publicKey: everything but the hash');
{
  const file = emptyKeysFile();
  const a = createKey(file, 'a', { seat: 'work', models: ['x'], expiresAt: NOW + 10, now: NOW });
  const p = publicKey(a.record, NOW);
  check('shape', p.id === a.record.id && p.name === 'a' && p.status === 'active' && p.seat === 'work' && JSON.stringify(p.models) === '["x"]' && p.expires === a.record.expires && p.last_used === null && !('hash' in p), JSON.stringify(p));
  check('expired status', publicKey(a.record, NOW + 10).status === 'expired');
  revokeKey(file, 'a');
  check('revoked status wins', publicKey(a.record, NOW + 10).status === 'revoked');
}

header('parse tolerance: bad records skipped, bad files thrown');
{
  const good = createKey(emptyKeysFile(), 'ok', { now: NOW });
  const text = JSON.stringify({ version: KEYS_VERSION, keys: [
    good.record,
    { ...good.record, name: 'ok' },                       // duplicate name
    { ...good.record, name: 'badhash', hash: 'nothex' },
    { ...good.record, name: 'badid', id: 'zz' },
    { ...good.record, name: 'bad name' },
    { ...good.record, name: 'seatbad', seat: 'no way' },  // seat dropped, record kept
    { ...good.record, name: 'dates', created: 'nope', lastUsed: 'nope', expires: 'nope', models: [1, ' m '] },
    null, 'string', 42,
  ] });
  const parsed = parseKeysFile(text);
  check('kept the well-formed ones only', JSON.stringify(parsed.keys.map((k) => k.name)) === '["ok","seatbad","dates"]', JSON.stringify(parsed.keys.map((k) => k.name)));
  const seatbad = parsed.keys.find((k) => k.name === 'seatbad');
  const dates = parsed.keys.find((k) => k.name === 'dates');
  check('bad seat dropped, bad dates dropped, models filtered and trimmed', !('seat' in seatbad) && dates.created === new Date(0).toISOString() && !('lastUsed' in dates) && !('expires' in dates) && JSON.stringify(dates.models) === '["m"]', JSON.stringify([seatbad, dates]));
  for (const bad of ['{}', '[]', '{"version":2,"keys":[]}', '{"version":1}', 'null', 'not json']) {
    let t = null; try { parseKeysFile(bad); } catch (e) { t = e.message; }
    check(`throws on ${bad}`, t !== null, t);
  }
}

header('the file: atomic write, mode, missing vs malformed');
{
  const dir = await mkdtemp(join(tmpdir(), 'dario-keys-'));
  const path = join(dir, 'nested', 'keys.json');
  check('missing file reads as empty', readKeysFile(path).keys.length === 0);
  const file = emptyKeysFile();
  const a = createKey(file, 'a', { now: NOW });
  writeKeysFile(path, file);
  const raw = await readFile(path, 'utf8');
  check('written as JSON with the hash and without the secret', raw.includes(a.record.hash) && !raw.includes(a.secret) && JSON.parse(raw).version === KEYS_VERSION);
  if (process.platform !== 'win32') {
    const st = await stat(path);
    const dst = await stat(join(dir, 'nested'));
    check('file 0600, parent 0700', (st.mode & 0o777) === 0o600 && (dst.mode & 0o777) === 0o700, `${(st.mode & 0o777).toString(8)} ${(dst.mode & 0o777).toString(8)}`);
  }
  check('round-trips', readKeysFile(path).keys[0].hash === a.record.hash);
  await writeFile(path, '{not json');
  let t = null; try { readKeysFile(path); } catch (e) { t = e.message; }
  check('a malformed file throws instead of reading as empty (that would revoke everyone)', t !== null, t);
}

header('KeyStore: reload on mtime, mutate, last-used debounce, malformed keeps last good state');
{
  const dir = await mkdtemp(join(tmpdir(), 'dario-keystore-'));
  const path = join(dir, 'keys.json');
  const store = new KeyStore(path);
  store.load();
  check('no file: empty, no error', store.size() === 0 && store.error === null && store.match('dk_x') === null);
  const made = store.mutate((f) => createKey(f, 'alice'));
  check('mutate wrote the file and adopted it', store.size() === 1 && (await readFile(path, 'utf8')).includes(made.record.hash) && store.match(made.secret)?.name === 'alice');
  // An edit made behind the store's back (the CLI in another process) is seen on the next match.
  await sleep(30);
  const external = readKeysFile(path);
  const bob = createKey(external, 'bob');
  writeKeysFile(path, external);
  check('a key written by another process is matched without a restart', store.match(bob.secret)?.name === 'bob' && store.size() === 2);
  // last-used: pending in memory, flushed after the quiet period, never clobbering a concurrent edit.
  const rec = store.match(made.secret);
  store.touch(rec, NOW);
  check('touch stamps the record in memory at once', rec.lastUsed === new Date(NOW).toISOString());
  await sleep(30);
  const external2 = readKeysFile(path);
  revokeKey(external2, 'bob');
  writeKeysFile(path, external2);
  await sleep(KEYS_FLUSH_DELAY_MS + 300);
  const after = readKeysFile(path);
  check('flush wrote last-used for alice and kept bob\'s concurrent revocation', after.keys.find((k) => k.name === 'alice').lastUsed === new Date(NOW).toISOString() && after.keys.find((k) => k.name === 'bob').disabled === true, JSON.stringify(after.keys));
  check('list shows the stamp and the revocation', store.list(NOW + 1).find((k) => k.name === 'alice').last_used === new Date(NOW).toISOString() && store.list(NOW + 1).find((k) => k.name === 'bob').status === 'revoked');
  // Malformed on disk: reported, last good state kept, so a bad edit does not lock everyone out.
  await sleep(30);
  await writeFile(path, '{"version":1,"keys":');
  check('malformed file: error set, alice still matches from the last good load', store.match(made.secret)?.name === 'alice' && typeof store.error === 'string', store.error);
  await sleep(30);
  writeKeysFile(path, after);
  check('fixed file: error clears', store.match(made.secret)?.name === 'alice' && store.error === null);
  store.close();
}

header('ledger: the per-consumer split');
{
  const rec = (over = {}) => ({
    timestamp: NOW, account: 'main', model: 'claude-opus-5',
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
    claim: 'five_hour', util5h: 0.1, util7d: 0.2, overageUtil: 0, latencyMs: 10, status: 200, isStream: false, isOpenAI: false,
    ...over,
  });
  const file = emptyLedger(NOW);
  addToLedger(file, rec({ consumer: 'alice' }));
  addToLedger(file, rec({ consumer: 'alice', model: 'claude-sonnet-5' }));
  addToLedger(file, rec({ consumer: 'bob', claim: 'api' }));
  addToLedger(file, rec({}));
  addToLedger(file, rec({ consumer: 'alice', status: 500 }));
  const day = new Date(NOW).toISOString().slice(0, 10);
  check('consumer rows: alice on two models, bob on one; the anonymous request and the 5xx are not there', file.consumers?.[day]?.alice?.['claude-opus-5']?.covered?.requests === 1 && file.consumers[day].alice['claude-sonnet-5'].covered.requests === 1 && file.consumers[day].bob['claude-opus-5'].metered.requests === 1 && Object.keys(file.consumers[day]).length === 2, JSON.stringify(file.consumers));
  const split = summarizeLedgerConsumers(file, NOW);
  check('alice: 2 requests, $5 opus + $2 sonnet, models most-used first', split.alice.requests === 2 && split.alice.apiEquivalentCost === 7 && split.alice.meteredCost === 0 && split.alice.models.length === 2 && split.alice.lastDay === day, JSON.stringify(split.alice));
  check('bob: api-keyed request is metered, not saved', split.bob.requests === 1 && split.bob.apiEquivalentCost === 0 && split.bob.meteredCost === 5, JSON.stringify(split.bob));
  check('recent windows carry today', split.alice.recent.today === 7 && split.alice.recent.last7d === 7 && split.alice.recent.last30d === 7);
  const summary = summarizeLedger(file, '/x/ledger.json', NOW);
  check('summarizeLedger carries perConsumer, and the headline still counts everything', JSON.stringify(summary.perConsumer) === JSON.stringify(split) && summary.requests === 4 && summary.apiEquivalentCost === 12, JSON.stringify([summary.requests, summary.apiEquivalentCost]));
  const lines = formatLedgerConsumers(summary);
  check('formatted: two lines per consumer — spend then tokens — alice first, with the numbers', lines[0].includes('By key (2 consumers') && lines[1].includes('alice') && lines[1].includes('$7.00') && /in \d/.test(lines[2]) && lines[2].includes('out ') && lines[3].includes('bob'), lines.join('
'));
  check('formatted: nothing named → says how to start', formatLedgerConsumers(summarizeLedger(emptyLedger(NOW), '/x', NOW))[0].includes('dario keys create'));
  const reparsed = parseLedger(JSON.stringify(file));
  check('parseLedger keeps consumers', JSON.stringify(reparsed.consumers) === JSON.stringify(file.consumers));
  const old = emptyLedger(NOW);
  addToLedger(old, rec({ consumer: 'alice', timestamp: NOW - 800 * 86_400_000 }));
  addToLedger(old, rec({ consumer: 'alice' }));
  pruneLedger(old, 1);
  check('pruneLedger drops old consumer days too', Object.keys(old.consumers).length === 1 && Object.keys(old.consumers)[0] === day, JSON.stringify(Object.keys(old.consumers)));
  const solo = emptyLedger(NOW);
  addToLedger(solo, rec({ consumer: 'x', timestamp: NOW - 800 * 86_400_000 }));
  addToLedger(solo, rec({}));
  pruneLedger(solo, 1);
  check('an empty consumers map is removed, not left as {}', !('consumers' in solo));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

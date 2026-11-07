// DARIO_COMPARE_KEEP_DAYS on a real proxy start: test/compare.mjs covers the function, this covers
// that a started proxy calls it, and only when the setting asks it to.

import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before the modules load: COMPARE_DIR reads the home folder.
const tmpHome = await mkdtemp(join(tmpdir(), 'dario-compare-keep-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const name of ['DARIO_API_KEY', 'DARIO_ADMIN', 'DARIO_ADMIN_TOKEN', 'DARIO_KEYS', 'DARIO_KEYS_PATH', 'DARIO_CODEX_BASE_URL', 'DARIO_TRANSCRIPT_TOKEN']) delete process.env[name];
process.env.DARIO_LEDGER = '0';

const say = (...a) => process.stdout.write(a.join(' ') + '\n');
for (const m of ['log', 'error', 'warn']) console[m] = () => {};
let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { say(`  ok   ${label}`); pass++; } else { say(`  FAIL ${label}`); fail++; }
};

const accountsDir = join(tmpHome, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'one.json'), JSON.stringify({
  alias: 'one', accessToken: 'one-token', refreshToken: 'one-token-refresh',
  expiresAt: Date.now() + 6 * 3_600_000, scopes: ['user:inference'], deviceId: 'dev-one', accountUuid: 'uuid-one',
}));

const { COMPARE_DIR, writeCompareRecord } = await import('../dist/compare.js');
const { startProxy } = await import('../dist/proxy.js');

const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', type: 'model' }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const start = async () => startProxy({
  host: '127.0.0.1', port: await freePort(), verbose: false, noLiveCapture: true, fetchImpl,
  pacingMinMs: 0, pacingJitterMs: 0, overageGuardEnabled: false,
});

const day = 24 * 60 * 60 * 1000;
const record = (age) => writeCompareRecord({ ts: new Date(Date.now() - age).toISOString(), comparedModel: 'gpt-5.6-sol' });
const old = record(30 * day);
const recent = record(1 * day);
check('two records to start from', !!old && !!recent && (await readdir(COMPARE_DIR)).length === 2);

say('the setting unset');
delete process.env.DARIO_COMPARE_KEEP_DAYS;
await start();
check('a start deletes nothing', (await readdir(COMPARE_DIR)).length === 2);

say('the setting at 7 days');
process.env.DARIO_COMPARE_KEEP_DAYS = '7';
await start();
const left = await readdir(COMPARE_DIR);
check('the old record went', left.length === 1);
check('the recent one stayed', recent.endsWith(left[0] ?? '?'));

say(`\n  Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

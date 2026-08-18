// LIVE integration test: two genuinely separate dario processes, each with
// its OWN isolated ~/.dario (nothing shared but the remote lock service),
// both racing to refresh the SAME account's OAuth token at nearly the same
// instant. Real network calls to the REAL deployed Cloudflare Worker
// (dario-refresh-lock) for the lock; a local mock stands in for Anthropic's
// token endpoint ONLY because hammering the real one with production
// credentials for adversarial testing is a real risk (a botched run could
// burn the operator's actual refresh token) — everything else in this test
// is real, not mocked.
//
// This is the test that was missing: prior verification proved the lock's
// API contract (7 live curl cases against the deployed Worker) and dario's
// client code in isolation (16 unit tests, mocked fetch) — but nobody had
// run the actual failure scenario dario#993 describes end-to-end. This does.
//
// Usage: node test/integration/dual-instance-race.mjs [--no-lock]
//   --no-lock proves the test is meaningful by showing the race WITHOUT the
//   fix (DARIO_REFRESH_LOCK_URL unset) — should show exactly the #993 bug.

import { spawn, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const NO_LOCK = process.argv.includes('--no-lock');
const MOCK_PORT = 8912;

const LOCK_URL = process.env.DARIO_REFRESH_LOCK_URL;
const LOCK_TOKEN = process.env.DARIO_REFRESH_LOCK_TOKEN;
if (!NO_LOCK && (!LOCK_URL || !LOCK_TOKEN)) {
  console.error('Set DARIO_REFRESH_LOCK_URL + DARIO_REFRESH_LOCK_TOKEN (or pass --no-lock to test the pre-fix race).');
  process.exit(1);
}

function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://127.0.0.1:${port}/log`).then(() => resolve()).catch(() => {
        if (Date.now() > deadline) reject(new Error('mock oauth server did not come up'));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

async function main() {
  console.log(`\n=== dual-instance refresh race — ${NO_LOCK ? 'WITHOUT the fix (expect the #993 bug)' : 'WITH the distributed lock'} ===\n`);

  // 1. Start the mock Anthropic token endpoint.
  const mockServer = fork(join(__dirname, 'mock-anthropic-oauth.mjs'), {
    env: { ...process.env, MOCK_OAUTH_PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await waitForPort(MOCK_PORT);

  // 2. Seed it — both worker instances start from this SAME refresh token,
  //    simulating two dario pods that shared config at boot (the actual
  //    #993 scenario: "share a folder on a NAS containing the config").
  // Unique alias per run: the DO's credential cache is intentionally
  // persistent (5-minute TTL) across processes — correct in production,
  // but it means a rerun on the SAME alias within that window would adopt
  // the PRIOR run's cached credentials without ever touching the lock or
  // the mock oauth endpoint again, silently testing the cache instead of
  // a fresh race. A unique alias each run sidesteps that entirely.
  const alias = `race-test-account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sharedStartToken = 'shared-start-refresh-token';
  await fetch(`http://127.0.0.1:${MOCK_PORT}/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias, refreshToken: sharedStartToken }),
  });

  // 3. Two genuinely isolated homes — nothing shared between the workers
  //    except the remote lock service (or nothing at all, in --no-lock mode).
  const homeA = mkdtempSync(join(tmpdir(), 'dario-race-a-'));
  const homeB = mkdtempSync(join(tmpdir(), 'dario-race-b-'));

  function launchWorker(label, home) {
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home, // os.homedir() resolution, POSIX + Windows
      WORKER_ALIAS: alias,
      WORKER_REFRESH_TOKEN: sharedStartToken,
      WORKER_LABEL: label,
      DARIO_OAUTH_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/oauth/token`,
      DARIO_OAUTH_CLIENT_ID: 'test-client-id',
    };
    if (!NO_LOCK) {
      env.DARIO_REFRESH_LOCK_URL = LOCK_URL;
      env.DARIO_REFRESH_LOCK_TOKEN = LOCK_TOKEN;
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(__dirname, 'refresh-worker.mjs')], { env });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => process.stderr.write(`[${label} stderr] ${d}`));
      child.on('close', () => {
        try { resolve(JSON.parse(out.trim().split('\n').pop())); }
        catch { resolve({ label, ok: false, error: 'no parseable output: ' + out }); }
      });
    });
  }

  // 4. Fire both AT THE SAME TIME — Promise.all, not sequential awaits.
  const [resultA, resultB] = await Promise.all([
    launchWorker('A', homeA),
    launchWorker('B', homeB),
  ]);

  // 5. Collect the mock server's view of what actually hit "Anthropic".
  const log = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/log`)).json();
  mockServer.kill();
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });

  console.log('Worker A:', JSON.stringify(resultA, null, 2));
  console.log('Worker B:', JSON.stringify(resultB, null, 2));
  console.log('\nMock Anthropic token-endpoint log (ground truth of what really happened):');
  for (const e of log) console.log(`  presented=${e.presented?.slice(0, 24)}...  -> ${e.result}`);

  const bothOk = resultA.ok && resultB.ok;
  const successfulRefreshes = log.filter((e) => e.result?.startsWith('OK')).length;
  const rejections = log.filter((e) => e.result?.startsWith('REJECTED')).length;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RESULT: both workers succeeded = ${bothOk} | real refreshes = ${successfulRefreshes} | rejections = ${rejections}`);
  console.log(`${'='.repeat(70)}\n`);

  if (NO_LOCK) {
    if (!bothOk && rejections >= 1) {
      console.log('✅ Reproduced the #993 bug as expected: one worker got a real invalid_grant rejection.');
      process.exit(0);
    }
    console.log('⚠️  Did not reproduce the bug this run (timing-dependent without the lock) — try again.');
    process.exit(1);
  } else {
    if (bothOk && successfulRefreshes === 1) {
      console.log('✅ THE FIX WORKS: both workers report success, but only ONE real refresh reached "Anthropic" — the other adopted the winner\'s fresh credentials instead of racing it.');
      process.exit(0);
    }
    console.log('❌ FIX DID NOT HOLD — investigate before trusting this for dario#993.');
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

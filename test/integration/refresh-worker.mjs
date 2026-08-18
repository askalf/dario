// One real dario instance's refresh attempt, run as its OWN process with
// its OWN isolated ~/.dario (via a per-process HOME/USERPROFILE override —
// see dual-instance-race.mjs) so nothing is shared except the remote lock
// service. That's the harder, more honest test: two pods with genuinely
// independent local state, not two processes on the same filesystem that
// could converge by accident through a shared account file.
import { refreshAccountToken, saveAccount } from '../../dist/accounts.js';

const alias = process.env.WORKER_ALIAS;
const refreshToken = process.env.WORKER_REFRESH_TOKEN;
const label = process.env.WORKER_LABEL;

const fixture = {
  alias,
  accessToken: 'stale-access',
  refreshToken,
  expiresAt: 1000, // deliberately in the past — matches a real "needs refresh" state
  scopes: [],
  deviceId: 'd-' + label,
  accountUuid: 'u-shared',
};

async function main() {
  await saveAccount(fixture); // isolated per process, mirrors real on-disk state before refresh
  const start = Date.now();
  try {
    const result = await refreshAccountToken(fixture);
    console.log(JSON.stringify({ label, ok: true, ms: Date.now() - start, accessToken: result.accessToken, refreshToken: result.refreshToken }));
  } catch (err) {
    console.log(JSON.stringify({ label, ok: false, ms: Date.now() - start, error: String(err?.message || err) }));
  }
}

main();

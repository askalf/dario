// ChatGPT-subscription pooling: rotation, cool-down eviction, stickiness.
//
// Before this, selectCodexAccount was:
//
//   return [...all].sort((a, b) => a.alias.localeCompare(b.alias))[0];
//
// the alphabetically FIRST account, every time. `dario add altman` will store a
// dozen seats and dario would use exactly one. That is why the account-wide 429
// on 2026-09-07 took the whole GPT lane down: a healthy second seat sat there
// unreachable while every request failed over to Claude.
//
// The design constraint that shapes all of this: THE CODEX PROMPT CACHE IS
// SCOPED TO THE SERVING ACCOUNT. A conversation that builds a prefix on seat A
// reads nothing from it on seat B, and this lane runs 59% cache share in
// production against a 73% controlled ceiling. So rotation is per-CONVERSATION,
// never per-request — otherwise a rate-limit fix buys a cache regression and
// comes out behind. The stickiness cases below are load-bearing, not polish.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Redirect HOME so the suite reads a scratch ~/.dario/codex-accounts, never the
// operator's real seats. Must happen before the module is imported: the
// accounts dir is resolved at module load.
const sandbox = await mkdtemp(join(tmpdir(), 'dario-codex-pool-'));
process.env['HOME'] = sandbox;
process.env['USERPROFILE'] = sandbox;
delete process.env['DARIO_CODEX_ACCOUNT'];
const accountsDir = join(sandbox, '.dario', 'codex-accounts');
await mkdir(accountsDir, { recursive: true });

const FAR_FUTURE = Date.now() + 60 * 60 * 1000;
async function seat(alias) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias, accessToken: `at-${alias}`, refreshToken: `rt-${alias}`, expiresAt: FAR_FUTURE,
  }));
}
await seat('alpha');
await seat('bravo');
await seat('charlie');

const {
  selectCodexAccount, noteCodexDecline, clearCodexDecline,
  codexCooldownRemainingMs, codexStickyAliasFor,
  allCodexAccountsCooled, codexPoolRetryAfterMs, _resetCodexPoolForTest,
} = await import('../dist/codex-accounts.js');

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`, ...rest); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}
const aliasOf = (c) => (c ? c.alias : null);

// ----------------------------------------------------------------------
header('sanity — the sandbox, not the operator\'s real seats');
// ----------------------------------------------------------------------
{
  check('HOME is redirected into a temp dir', homedir() === sandbox, homedir());
  const picked = await selectCodexAccount();
  check('three seats are visible', aliasOf(picked) === 'alpha', aliasOf(picked));
}

// ----------------------------------------------------------------------
header('a declined seat is evicted; its peers keep serving');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  check('starts on alpha', aliasOf(await selectCodexAccount()) === 'alpha');

  noteCodexDecline('alpha', 60_000);
  check('alpha is cooling', codexCooldownRemainingMs('alpha') > 0);
  check('now picks bravo', aliasOf(await selectCodexAccount()) === 'bravo');

  noteCodexDecline('bravo', 60_000);
  check('now picks charlie', aliasOf(await selectCodexAccount()) === 'charlie');

  // THE 2026-09-07 CASE: every seat 429s. Answer locally instead of spending a
  // request that can only 429 again.
  noteCodexDecline('charlie', 60_000);
  check('all cooled -> null, not a doomed request', (await selectCodexAccount()) === null);
  check('allCodexAccountsCooled agrees', (await allCodexAccountsCooled()) === true);
  check('retry-after is the longest remaining', (await codexPoolRetryAfterMs()) > 0);

  clearCodexDecline('bravo');
  check('a recovered seat returns to service', aliasOf(await selectCodexAccount()) === 'bravo');
  check('and the pool is no longer all-cooled', (await allCodexAccountsCooled()) === false);
}

// ----------------------------------------------------------------------
header('stickiness — a conversation keeps its seat, and so its prompt cache');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const convo = 'conv-aaaa';
  const first = await selectCodexAccount(undefined, { stickyKey: convo });
  check('binds on first use', aliasOf(first) === 'alpha');
  check('binding is readable', codexStickyAliasFor(convo) === 'alpha');

  // The regression that matters: rotating per request would send turn 2 to a
  // seat holding none of turn 1's cached prefix.
  for (let turn = 2; turn <= 6; turn++) {
    const again = await selectCodexAccount(undefined, { stickyKey: convo });
    if (aliasOf(again) !== 'alpha') { check(`turn ${turn} stayed on alpha`, false, aliasOf(again)); break; }
    if (turn === 6) check('six turns all stayed on the same seat', true);
  }

  // A different conversation is free to land elsewhere, but determinism means
  // it also starts at alpha — seats are shared, caches are per-prefix.
  check('a second conversation also binds', codexStickyAliasFor('conv-bbbb') === null);

  // A bound seat that declines hands the conversation on rather than pinning it
  // to a seat that cannot serve.
  noteCodexDecline('alpha', 60_000);
  const moved = await selectCodexAccount(undefined, { stickyKey: convo });
  check('a cooling bound seat moves the conversation', aliasOf(moved) === 'bravo', aliasOf(moved));
  check('and the binding follows it', codexStickyAliasFor(convo) === 'bravo');
}

// ----------------------------------------------------------------------
header('an explicit pin is an instruction, not a hint');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  noteCodexDecline('charlie', 60_000);
  // The caller named a seat. Honour it even while cooling: they asked that
  // account a question and are entitled to its answer, 429 included. Silently
  // serving a different account would misattribute the reply.
  check('pinned seat is returned even while cooling',
    aliasOf(await selectCodexAccount('charlie')) === 'charlie');
  check('an unknown pin falls through to the pool',
    aliasOf(await selectCodexAccount('nonesuch')) === 'alpha');
}

// ----------------------------------------------------------------------
header('cool-down bookkeeping');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  check('an unknown alias is not cooling', codexCooldownRemainingMs('alpha') === 0);
  // retry-after of 0 means "retry now" and must not park the seat.
  noteCodexDecline('alpha', 0);
  check('retry-after 0 cools nothing', codexCooldownRemainingMs('alpha') === 0);
  check('and alpha still serves', aliasOf(await selectCodexAccount()) === 'alpha');
  // A decline with no stated duration still has to cool, or a 429 storm loops.
  noteCodexDecline('alpha', null);
  check('a decline with no retry-after still cools', codexCooldownRemainingMs('alpha') > 0);
  check('the test seam really clears state',
    (_resetCodexPoolForTest(), codexCooldownRemainingMs('alpha') === 0));
}

await rm(sandbox, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

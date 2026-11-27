import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = await mkdtemp(join(tmpdir(), 'dario-codex-least-busy-'));
process.env['HOME'] = sandbox;
process.env['USERPROFILE'] = sandbox;
delete process.env['DARIO_CODEX_ACCOUNT'];
delete process.env['DARIO_CODEX_MAX_INFLIGHT_PER_SEAT'];
const accountsDir = join(sandbox, '.dario', 'codex-accounts');
await mkdir(accountsDir, { recursive: true });

const FAR_FUTURE = Date.now() + 60 * 60 * 1000;
for (const alias of ['alpha', 'bravo', 'charlie', 'drained']) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias, accessToken: `at-${alias}`, refreshToken: `rt-${alias}`, expiresAt: FAR_FUTURE,
  }));
}

const accounts = await import('../dist/codex-accounts.js');
const usage = await import('../dist/codex-usage.js');
const backend = await import('../dist/codex-backend.js');
const {
  selectCodexAccount, selectCodexAccountExcluding, claimCodexAccount, claimCodexAccountExcluding, claimCodexSeat,
  codexInFlightStart, codexInFlightEnd, codexInFlightFor, rebindCodexSticky,
  codexStickyAliasFor, noteCodexDecline, noteCodexResponseOwner, codexResponseOwner, _resetCodexPoolForTest,
} = accounts;

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
const serve = (claim) => { claim.release(); codexInFlightStart(claim.account.alias); codexInFlightEnd(claim.account.alias); return claim.account; };
const claimedAlias = (claim) => (claim ? claim.account.alias : null);

const WEEK = 7 * 24 * 60;
function used(alias, percent) {
  usage.recordCodexUsage(alias, {
    primary: { usedPercent: percent, windowMinutes: WEEK, resetAt: Date.now() + 5 * 864e5 },
    secondary: null, limitReached: null, observedAt: Date.now(), source: 'headers',
  });
}
used('alpha', 10);
used('bravo', 40);
used('charlie', 50);
used('drained', 100);

// ----------------------------------------------------------------------
header('a burst of new conversations spreads across the seats above the floor');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const claims = [];
  for (let i = 0; i < 6; i++) claims.push(await claimCodexAccount());
  const picks = claims.map(claimedAlias);
  check('headroom order breaks ties, then each pick counts as busy',
    picks.join(',') === 'alpha,bravo,charlie,alpha,bravo,charlie', picks.join(','));
  check('the drained seat takes nothing while others have room', !picks.includes('drained'));
  for (const claim of claims) serve(claim);
  check('every hold is handed back once its request is forwarded',
    ['alpha', 'bravo', 'charlie'].every((a) => codexInFlightFor(a) === 0));
}

// ----------------------------------------------------------------------
header('a seat with requests in flight is not the next pick');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  codexInFlightStart('alpha');
  codexInFlightStart('alpha');
  codexInFlightStart('bravo');
  check('charlie is least busy', aliasOf(await selectCodexAccount()) === 'charlie');
  codexInFlightEnd('alpha');
  codexInFlightEnd('alpha');
  codexInFlightEnd('bravo');
  check('in-flight returns to zero', codexInFlightFor('alpha') === 0 && codexInFlightFor('bravo') === 0);
}

// ----------------------------------------------------------------------
header('a conversation leaves its seat only while that seat is at the cap');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const convo = { stickyKey: 'conversation-1' };
  check('binds to alpha', aliasOf(serve(await claimCodexAccount(undefined, convo))) === 'alpha');
  for (let i = 0; i < 4; i++) codexInFlightStart('alpha');
  const overflow = await claimCodexAccount(undefined, convo);
  check('at 4 in flight the turn goes elsewhere', claimedAlias(overflow) !== 'alpha', claimedAlias(overflow));
  check('the binding stays on alpha', codexStickyAliasFor('conversation-1') === 'alpha');
  rebindCodexSticky('conversation-1', claimedAlias(overflow), 'charlie');
  check('a decline on the overflow seat leaves the binding on alpha', codexStickyAliasFor('conversation-1') === 'alpha');
  rebindCodexSticky('conversation-1', 'alpha', 'bravo');
  check('a decline on the bound seat moves it', codexStickyAliasFor('conversation-1') === 'bravo');
  rebindCodexSticky('conversation-1', 'bravo', 'alpha');
  serve(overflow);
  for (let i = 0; i < 4; i++) codexInFlightEnd('alpha');
  check('below the cap the conversation is back on alpha',
    aliasOf(serve(await claimCodexAccount(undefined, convo))) === 'alpha');
}

// ----------------------------------------------------------------------
header('DARIO_CODEX_MAX_INFLIGHT_PER_SEAT sets the cap');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  process.env['DARIO_CODEX_MAX_INFLIGHT_PER_SEAT'] = '1';
  const convo = { stickyKey: 'conversation-2' };
  serve(await claimCodexAccount(undefined, convo));
  codexInFlightStart('alpha');
  check('one in flight is already the cap',
    aliasOf(await selectCodexAccount(undefined, convo)) !== 'alpha');
  check('a pick that ignores load keeps the bound seat',
    aliasOf(await selectCodexAccount(undefined, { ...convo, byLoad: false })) === 'alpha');
  codexInFlightEnd('alpha');
  delete process.env['DARIO_CODEX_MAX_INFLIGHT_PER_SEAT'];
}

// ----------------------------------------------------------------------
header('a drained seat is the last resort, not skipped');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const peer = await selectCodexAccountExcluding(new Set(['alpha', 'bravo', 'charlie']));
  check('with every roomy seat tried, the drained one serves', aliasOf(peer) === 'drained', aliasOf(peer));
  check('a failover pick places no hold', codexInFlightFor('drained') === 0);
  noteCodexDecline('alpha', 60_000);
  noteCodexDecline('bravo', 60_000);
  noteCodexDecline('charlie', 60_000);
  check('cooling seats leave the drained one to serve',
    aliasOf(await selectCodexAccount()) === 'drained');
}

// ----------------------------------------------------------------------
header('a seat known to lack the requested model is passed over, floor or not');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const fits = { alpha: 'none', bravo: 'none', charlie: 'exact' };
  check('only charlie lists it', aliasOf(await selectCodexAccount(undefined, { modelFit: (a) => fits[a] })) === 'charlie');
  check('a seat not yet probed stays a candidate',
    aliasOf(await selectCodexAccount(undefined, { modelFit: (a) => (a === 'charlie' ? 'exact' : undefined) })) === 'alpha');
  check('a model no seat is known to list filters nothing',
    aliasOf(await selectCodexAccount(undefined, { modelFit: (a) => (a === 'alpha' ? 'none' : undefined) })) === 'alpha');
  check('the only seat that lists it serves even below the floor',
    aliasOf(await selectCodexAccount(undefined, { modelFit: (a) => (a === 'drained' ? 'exact' : 'none') })) === 'drained');
  codexInFlightStart('alpha');
  check('the name as written beats one read off an effort suffix, busy or not',
    aliasOf(await selectCodexAccount(undefined, { modelFit: (a) => (a === 'alpha' ? 'exact' : 'base') })) === 'alpha');
  codexInFlightEnd('alpha');
  const convo = { stickyKey: 'conversation-fit', modelFit: (a) => (a === 'alpha' ? 'exact' : undefined) };
  serve(await claimCodexAccount(undefined, convo));
  check('a conversation whose seat no longer lists the model moves',
    aliasOf(await selectCodexAccount(undefined, { ...convo, modelFit: (a) => (a === 'alpha' ? 'none' : a === 'bravo' ? 'exact' : undefined) })) === 'bravo');
  check('and is bound to the new seat', codexStickyAliasFor('conversation-fit') === 'bravo');
}

// ----------------------------------------------------------------------
header('a failover peer is filtered before it is ranked');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  codexInFlightStart('bravo');
  check('the least busy peer that accepts', aliasOf(await selectCodexAccountExcluding(new Set(['alpha']), { accepts: (a) => a !== 'charlie' })) === 'bravo');
  const peer = await claimCodexAccountExcluding(new Set(['alpha']));
  check('a claimed peer is held', claimedAlias(peer) === 'charlie' && codexInFlightFor('charlie') === 1);
  peer.release();
  codexInFlightEnd('bravo');
}

// ----------------------------------------------------------------------
header('a hold belongs to the request that placed it');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const first = await claimCodexAccount('alpha');
    clock += 16_000;
    check('an unreleased hold lapses', codexInFlightFor('alpha') === 0);
    const second = await claimCodexAccount('alpha');
    first.release();
    check('a late release leaves a newer hold in place', codexInFlightFor('alpha') === 1, codexInFlightFor('alpha'));
    const third = await claimCodexAccount('alpha');
    second.release();
    second.release();
    check('releasing out of order, twice, drops only that hold', codexInFlightFor('alpha') === 1, codexInFlightFor('alpha'));
    third.release();
    check('and the last release empties the seat', codexInFlightFor('alpha') === 0);
  } finally {
    Date.now = realNow;
  }
  const seat = await selectCodexAccount('bravo');
  check('a plain select places no hold', codexInFlightFor('bravo') === 0);
  const held = claimCodexSeat(seat);
  check('a seat can be claimed directly', codexInFlightFor('bravo') === 1);
  held.release();
}

// ----------------------------------------------------------------------
header('a pinned seat is held like any other pick');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  process.env['DARIO_CODEX_ACCOUNT'] = 'charlie';
  const pinned = await claimCodexAccount();
  delete process.env['DARIO_CODEX_ACCOUNT'];
  check('the pin is honoured and held', claimedAlias(pinned) === 'charlie' && codexInFlightFor('charlie') === 1);
  pinned.release();
  check('released', codexInFlightFor('charlie') === 0);
}

// ----------------------------------------------------------------------
header('the account that issued a response is remembered');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  noteCodexResponseOwner('resp_1', 'bravo');
  check('owner found', codexResponseOwner('resp_1') === 'bravo');
  check('unknown id', codexResponseOwner('resp_2') === null);
  for (let i = 0; i < 2_000; i++) noteCodexResponseOwner(`resp_fill_${i}`, 'alpha');
  check('the oldest entry goes first once the map is full', codexResponseOwner('resp_1') === null);
}

// ----------------------------------------------------------------------
header('a removed seat drops its binding even while it is busy');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  await writeFile(join(accountsDir, 'echo.json'), JSON.stringify({
    alias: 'echo', accessToken: 'at-echo', refreshToken: 'rt-echo', expiresAt: FAR_FUTURE,
  }));
  used('echo', 0);
  const convo = { stickyKey: 'conversation-3' };
  check('binds to echo', aliasOf(serve(await claimCodexAccount(undefined, convo))) === 'echo');
  for (let i = 0; i < 4; i++) codexInFlightStart('echo');
  await unlink(join(accountsDir, 'echo.json'));
  accounts.resetCodexPresenceCache();
  const next = aliasOf(await selectCodexAccount(undefined, convo));
  check('the conversation lands on a live seat', next !== 'echo', next);
  check('and is bound to it', codexStickyAliasFor('conversation-3') === next, codexStickyAliasFor('conversation-3'));
  for (let i = 0; i < 4; i++) codexInFlightEnd('echo');
}

// ----------------------------------------------------------------------
header('the forwarder counts a request in flight until it returns, failure included');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  let seenDuring = -1;
  const failingFetch = async () => { seenDuring = codexInFlightFor('bravo'); throw new Error('network down'); };
  const res = {
    headersSent: false, writableEnded: false, destroyed: false,
    writeHead() { this.headersSent = true; return this; }, setHeader() {}, end() { this.writableEnded = true; },
    on() { return this; }, once() { return this; }, removeListener() { return this; }, write() { return true; },
  };
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }));
  await backend.forwardToCodex(
    { headers: {} }, res, body, { alias: 'bravo', accessToken: 'x', refreshToken: 'y', expiresAt: FAR_FUTURE },
    '*', {}, 5000, false, 'openai', failingFetch,
  ).catch(() => false);
  check('in flight while the upstream call runs', seenDuring === 1, seenDuring);
  check('back to zero after it fails', codexInFlightFor('bravo') === 0);
}

await rm(sandbox, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

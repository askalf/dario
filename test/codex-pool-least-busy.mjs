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
  selectCodexAccount, selectCodexAccountExcluding, releaseCodexSeat,
  codexInFlightStart, codexInFlightEnd, codexInFlightFor,
  codexStickyAliasFor, noteCodexDecline, _resetCodexPoolForTest,
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
const serve = (c) => { releaseCodexSeat(c.alias); codexInFlightStart(c.alias); codexInFlightEnd(c.alias); return c; };

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
  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(aliasOf(await selectCodexAccount()));
  check('headroom order breaks ties, then each pick counts as busy',
    picks.join(',') === 'alpha,bravo,charlie,alpha,bravo,charlie', picks.join(','));
  check('the drained seat takes nothing while others have room', !picks.includes('drained'));
  for (const alias of picks) serve({ alias });
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
  check('charlie is least busy', aliasOf(await selectCodexAccount(undefined, { reserve: false })) === 'charlie');
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
  check('binds to alpha', aliasOf(serve(await selectCodexAccount(undefined, convo))) === 'alpha');
  for (let i = 0; i < 4; i++) codexInFlightStart('alpha');
  const overflow = await selectCodexAccount(undefined, convo);
  check('at 4 in flight the turn goes elsewhere', aliasOf(overflow) !== 'alpha', aliasOf(overflow));
  check('the binding stays on alpha', codexStickyAliasFor('conversation-1') === 'alpha');
  serve(overflow);
  for (let i = 0; i < 4; i++) codexInFlightEnd('alpha');
  check('below the cap the conversation is back on alpha',
    aliasOf(serve(await selectCodexAccount(undefined, convo))) === 'alpha');
}

// ----------------------------------------------------------------------
header('DARIO_CODEX_MAX_INFLIGHT_PER_SEAT sets the cap');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  process.env['DARIO_CODEX_MAX_INFLIGHT_PER_SEAT'] = '1';
  const convo = { stickyKey: 'conversation-2' };
  serve(await selectCodexAccount(undefined, convo));
  codexInFlightStart('alpha');
  check('one in flight is already the cap',
    aliasOf(await selectCodexAccount(undefined, { ...convo, reserve: false })) !== 'alpha');
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
    aliasOf(await selectCodexAccount(undefined, { reserve: false })) === 'drained');
}

// ----------------------------------------------------------------------
header('a seat whose model list lacks the requested model is passed over');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const lists = { alpha: false, bravo: false, charlie: true };
  check('only charlie lists it',
    aliasOf(await selectCodexAccount(undefined, { canServe: (a) => lists[a], reserve: false })) === 'charlie');
  check('a seat not yet probed stays a candidate',
    aliasOf(await selectCodexAccount(undefined, { canServe: (a) => (a === 'charlie' ? true : undefined), reserve: false })) === 'alpha');
  check('a model no seat lists filters nothing',
    aliasOf(await selectCodexAccount(undefined, { canServe: (a) => (a === 'alpha' ? false : undefined), reserve: false })) === 'alpha');
}

// ----------------------------------------------------------------------
header('a hold that is never forwarded can be released');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const picked = await selectCodexAccount();
  check('the pick holds its seat', codexInFlightFor(picked.alias) === 1);
  releaseCodexSeat(picked.alias);
  check('release drops the hold', codexInFlightFor(picked.alias) === 0);
  check('reserve: false places none',
    codexInFlightFor(aliasOf(await selectCodexAccount(undefined, { reserve: false }))) === 0);
}

// ----------------------------------------------------------------------
header('a forward that placed no hold leaves other requests\' holds alone');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  const held = await selectCodexAccountExcluding(new Set(['alpha', 'charlie', 'drained']));
  check('failover picks bravo without a hold', aliasOf(held) === 'bravo' && codexInFlightFor('bravo') === 0);
  noteCodexDecline('alpha', 60_000);
  noteCodexDecline('charlie', 60_000);
  check('a burst pick holds bravo', aliasOf(await selectCodexAccount()) === 'bravo');
  codexInFlightStart('bravo');
  check('the failover forward adds to the hold, not replaces it', codexInFlightFor('bravo') === 2, codexInFlightFor('bravo'));
  codexInFlightEnd('bravo');
  check('the burst pick is still held after it ends', codexInFlightFor('bravo') === 1, codexInFlightFor('bravo'));
}

// ----------------------------------------------------------------------
header('a pinned seat is held like any other pick');
// ----------------------------------------------------------------------
{
  _resetCodexPoolForTest();
  process.env['DARIO_CODEX_ACCOUNT'] = 'charlie';
  check('the pin is honoured', aliasOf(await selectCodexAccount()) === 'charlie');
  delete process.env['DARIO_CODEX_ACCOUNT'];
  check('and holds charlie, so its release takes back its own hold', codexInFlightFor('charlie') === 1);
  releaseCodexSeat('charlie');
  check('released', codexInFlightFor('charlie') === 0);
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
  check('binds to echo', aliasOf(serve(await selectCodexAccount(undefined, convo))) === 'echo');
  for (let i = 0; i < 4; i++) codexInFlightStart('echo');
  await unlink(join(accountsDir, 'echo.json'));
  accounts.resetCodexPresenceCache();
  const next = aliasOf(await selectCodexAccount(undefined, { ...convo, reserve: false }));
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

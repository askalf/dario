#!/usr/bin/env node
// dario#1288 review — a stale all-seats check must not re-cool a recovered pool.
//
// THE RACE. A 429 cools the seat, then the provider is cooled only if EVERY
// seat is cooling. That second question was asked across an await:
//
//     noteCodexDecline(alias, ms);
//     void allCodexAccountsCooled().then((all) => {
//       if (all) providerCooldowns.note('codex', ms);   // <- a tick later
//     });
//
// Between the answer and the write, another in-flight request can succeed on a
// just-recovered seat and call clearCodexDecline. The delayed continuation then
// cools the WHOLE codex provider against a pool that is healthy again,
// canAttempt('codex') short-circuits, and the healthy seat is skipped until the
// stale window expires — the single-seat outage this pool exists to prevent,
// reintroduced by the bookkeeping meant to prevent it.
//
// Re-checking inside the continuation narrows the window and does not close it:
// the re-check is itself another await, with the same gap behind it.
//
// THE FIX. Take the alias list first, then decide and write with no suspension
// point between them. `allAliasesCooled` is synchronous, so the callback runs
// as one unit and nothing can interleave.
//
// This file proves both halves: that the same-tick shape survives an
// interleaved recovery, and that the awaited shape does NOT — a test that
// passes against the bug it describes has proven nothing.
//
// Hermetic: sandboxed HOME, in-memory cool-downs, no network.
//
// Run with:
//   node test/codex-pool-cooldown-race.mjs

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const sandbox = await mkdtemp(join(tmpdir(), 'dario-codex-race-'));
process.env['HOME'] = sandbox;
process.env['USERPROFILE'] = sandbox;

const {
  listCodexAccountAliases, allAliasesCooled, allCodexAccountsCooled,
  noteCodexDecline, clearCodexDecline, codexCooldownRemainingMs,
  _resetCodexPoolForTest, _resetCodexPresenceCacheForTest,
} = await import('../dist/codex-accounts.js');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};

// Two seats on disk, the shape the pool reads.
const dir = join(sandbox, '.dario', 'codex-accounts');
await mkdir(dir, { recursive: true });
for (const alias of ['alpha', 'bravo']) {
  await writeFile(join(dir, `${alias}.json`), JSON.stringify({
    alias, accessToken: `tok-${alias}`, refreshToken: `ref-${alias}`,
    accountId: `acct-${alias}`, expiresAt: Date.now() + 3_600_000,
  }));
}
_resetCodexPresenceCacheForTest();

console.log('\n=== setup ===');
check('HOME is redirected into a temp dir', homedir() === sandbox, homedir());
const aliases = await listCodexAccountAliases();
check('two seats visible', aliases.length === 2, aliases.join(','));

console.log('\n=== allAliasesCooled is synchronous and exact ===');
_resetCodexPoolForTest();
check('nothing cooling -> false', allAliasesCooled(aliases) === false);
noteCodexDecline('alpha', 60_000);
check('one of two cooling -> false', allAliasesCooled(aliases) === false);
noteCodexDecline('bravo', 60_000);
check('both cooling -> true', allAliasesCooled(aliases) === true);
clearCodexDecline('bravo');
check('a recovery flips it back immediately', allAliasesCooled(aliases) === false);
check('empty pool is never "all cooled"', allAliasesCooled([]) === false);

console.log('\n=== THE RACE: a recovery lands while the check is in flight ===');
// The interleaving, staged deterministically. `provider` stands in for
// providerCooldowns; what matters is whether it gets written.
{
  // --- the shape that shipped: decide, await, then write ---
  //
  // The interleaving is staged with promise ordering rather than timers, so it
  // is deterministic. Continuations on one promise run in registration order,
  // so registering the recovery FIRST places it exactly in the gap the bug
  // lives in: after `every(isCooled)` has decided, before the write runs.
  // This is the shipped call verbatim — nothing about the decision is faked.
  _resetCodexPoolForTest();
  noteCodexDecline('alpha', 60_000);
  noteCodexDecline('bravo', 60_000);
  let providerCooledAwaited = false;
  const decided = allCodexAccountsCooled();          // decides: both cooling
  const peer = decided.then(() => clearCodexDecline('bravo')); // a peer succeeds
  const awaited = decided.then((all) => {            // the shipped continuation
    if (all) providerCooledAwaited = true;           // writes from a stale answer
  });
  await Promise.all([peer, awaited]);
  check('AWAITED shape re-cools a recovered pool (the bug)',
    providerCooledAwaited === true, providerCooledAwaited);
  check('  …while bravo is provably healthy',
    codexCooldownRemainingMs('bravo') === 0, codexCooldownRemainingMs('bravo'));
  // --- the shape now shipped: fetch list, then decide AND write in one tick ---
  // Same staging, same recovery, same ordering — the only difference is WHERE
  // the decision is made: inside the continuation, with the write.
  _resetCodexPoolForTest();
  noteCodexDecline('alpha', 60_000);
  noteCodexDecline('bravo', 60_000);
  let providerCooledAtomic = false;
  const listed = listCodexAccountAliases();
  const peer2 = listed.then(() => clearCodexDecline('bravo'));
  const atomic = listed.then((list) => {
    if (allAliasesCooled(list)) providerCooledAtomic = true;
  });
  await Promise.all([peer2, atomic]);
  check('SAME-TICK shape does not (the fix)',
    providerCooledAtomic === false, providerCooledAtomic);
  // The whole point: the two shapes must DISAGREE on this interleaving. If they
  // ever agree, this test has stopped discriminating and is worthless.
  check('the two shapes disagree — the test discriminates',
    providerCooledAwaited !== providerCooledAtomic,
    `${providerCooledAwaited} vs ${providerCooledAtomic}`);
}

console.log('\n=== and it still cools the provider when the pool really IS spent ===');
{
  _resetCodexPoolForTest();
  noteCodexDecline('alpha', 60_000);
  noteCodexDecline('bravo', 60_000);
  let providerCooled = false;
  await listCodexAccountAliases().then((list) => {
    if (allAliasesCooled(list)) providerCooled = true;
  });
  check('no recovery, every seat cooling -> provider cooled', providerCooled === true);
  // Fail-fast on a single-seat deployment is the behaviour the review's
  // suggested "just delete the provider cooldown" would have removed.
  _resetCodexPoolForTest();
  noteCodexDecline('alpha', 60_000);
  check('single cooled seat of two is still not "all"', allAliasesCooled(aliases) === false);
  check('single-seat pool cooling IS "all"', allAliasesCooled(['alpha']) === true);
}

console.log('\n=== every codex forward shares the safe decline handler ===');
// The sections above prove the two SHAPES differ. This one proves the proxy
// actually uses the safe one, at every site. Without it the bug could be
// reintroduced at a call site and every assertion above would still pass.
//
// The handler used to be hand-copied per call site, and that is exactly how
// the native Responses path ended up cooling nothing while the translated
// path cooled correctly (caught in review of #1288). So the invariant is not
// "each site does the right thing" but "there is ONE handler and every site
// passes it" — which is what makes a fourth call site correct by default.
{
  const proxySrc = await readFile(new URL('../dist/proxy.js', import.meta.url), 'utf8');
  const count = (hay, needle) => hay.split(needle).length - 1;

  check('no call site decides across an await',
    count(proxySrc, 'allCodexAccountsCooled().then') === 0,
    count(proxySrc, 'allCodexAccountsCooled().then') + ' found');

  // Exactly one same-tick decision, because there is exactly one handler.
  const decisions = count(proxySrc, 'listCodexAccountAliases().then((aliases)');
  check('the decision is made in exactly one place', decisions === 1, decisions + ' found');

  const defined = count(proxySrc, 'const codexOnDecline =');
  check('the shared handler is defined once', defined === 1, defined + ' found');

  // Three forwards can decline: the Claude-to-Codex fallback, the translated
  // Messages path, and the native Responses passthrough. Each must pass it.
  const passed = count(proxySrc, 'codexOnDecline') - defined;
  check('every codex forward passes it', passed === 3, passed + ' call sites');

  // And the Responses passthrough must be able to decline at all — it took a
  // decline contract to put it in the loop.
  const backendSrc = await readFile(new URL('../dist/codex-backend.js', import.meta.url), 'utf8');
  const fn = backendSrc.slice(backendSrc.indexOf('async function forwardResponsesToCodex'));
  check('forwardResponsesToCodex reports declines',
    fn.indexOf('onDecline') !== -1 && fn.indexOf('deferOnUnavailable') !== -1,
    'onDecline/deferOnUnavailable not found in it');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

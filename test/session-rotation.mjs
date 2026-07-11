// Unit tests for src/session-rotation.ts (v3.28, direction #1 — interactive
// session-id lifecycle). Pure function + stateful registry; no timers,
// no network, no uuid generation except via injected factory so every
// assertion is deterministic.

import {
  decideSessionRotation,
  SessionRegistry,
  resolveSessionRotationConfig,
} from '../dist/session-rotation.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

/** 1-second convenience — keeps test arithmetic readable. */
const SEC = 1000;
const MIN = 60 * SEC;

/** Deterministic id factory: returns 'id-1', 'id-2', ... in call order. */
function idFactory() {
  let n = 0;
  return () => `id-${++n}`;
}

/** Deterministic rng: returns a fixed sequence, wrapping. */
function rngFactory(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

/** A default-equivalent config for tests that don't care about the knobs. */
function defaultCfg(overrides = {}) {
  return {
    idleRotateMs: 15 * MIN,
    jitterMs: 0,
    maxAgeMs: undefined,
    perClient: false,
    ...overrides,
  };
}

// ======================================================================
//  decideSessionRotation — pure decision
// ======================================================================
header('decideSessionRotation — no entry → rotate-new');
{
  const d = decideSessionRotation(undefined, 1000, defaultCfg());
  check("returns 'rotate-new' when entry missing", d === 'rotate-new');
}

header('decideSessionRotation — fresh entry within idle window → keep');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 1000, idleJitterOffsetMs: 0 };
  const d = decideSessionRotation(entry, 1000 + 5 * MIN, defaultCfg());
  check("returns 'keep' for 5-min gap vs 15-min threshold", d === 'keep');
}

header('decideSessionRotation — idle exceeds threshold → rotate-idle');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 1000, idleJitterOffsetMs: 0 };
  const d = decideSessionRotation(entry, 1000 + 15 * MIN + 1, defaultCfg());
  check("returns 'rotate-idle' at threshold + 1ms", d === 'rotate-idle');
}

header('decideSessionRotation — exactly at threshold → keep (strict >)');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 1000, idleJitterOffsetMs: 0 };
  const d = decideSessionRotation(entry, 1000 + 15 * MIN, defaultCfg());
  check("keep when gap equals threshold", d === 'keep');
}

header('decideSessionRotation — jitter offset extends effective threshold');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 1000, idleJitterOffsetMs: 5 * MIN };
  // 15min base + 5min jitter = 20min threshold. At 19min gap, still keep.
  const keep = decideSessionRotation(entry, 1000 + 19 * MIN, defaultCfg());
  check('keep at 19min with 5min jitter offset', keep === 'keep');
  const rot = decideSessionRotation(entry, 1000 + 20 * MIN + 1, defaultCfg());
  check('rotate-idle just past 20min threshold', rot === 'rotate-idle');
}

header('decideSessionRotation — max-age triggers rotate-age');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 0, idleJitterOffsetMs: 0 };
  const cfg = defaultCfg({ maxAgeMs: 60 * MIN });
  // lastUsedAt=0 so idle would also fire eventually, but at createdAt + 61min
  // the idle check (now - lastUsed > 15min) also trips — need a recent
  // lastUsedAt to isolate the age branch.
  const fresh = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 60 * MIN + 1, idleJitterOffsetMs: 0 };
  const d = decideSessionRotation(fresh, 60 * MIN + 2, cfg);
  check('active session but past max-age → rotate-age', d === 'rotate-age');
}

header('decideSessionRotation — idle check wins over age check when both trip');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 0, idleJitterOffsetMs: 0 };
  const cfg = defaultCfg({ maxAgeMs: 1 * MIN });
  // now = 20min. Age exceeded (20min > 1min cap) AND idle exceeded (20min > 15min).
  // Idle is evaluated first → 'rotate-idle'. This is the documented order.
  const d = decideSessionRotation(entry, 20 * MIN, cfg);
  check("idle wins over age when both trigger", d === 'rotate-idle');
}

header('decideSessionRotation — max-age=0 or undefined disables age check');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 1000 * MIN, idleJitterOffsetMs: 0 };
  const cfgZero = defaultCfg({ maxAgeMs: 0 });
  const cfgUndef = defaultCfg({ maxAgeMs: undefined });
  // lastUsedAt is recent relative to 'now' so idle won't fire
  check('maxAgeMs=0 behaves like off', decideSessionRotation(entry, 1000 * MIN + 100, cfgZero) === 'keep');
  check('maxAgeMs=undefined behaves like off', decideSessionRotation(entry, 1000 * MIN + 100, cfgUndef) === 'keep');
}

header('decideSessionRotation — negative idleRotateMs clamps to 0 (always rotate)');
{
  const entry = { upstreamSessionId: 'a', createdAt: 0, lastUsedAt: 1000, idleJitterOffsetMs: 0 };
  const cfg = defaultCfg({ idleRotateMs: -100 });
  check('rotates on any forward time progression', decideSessionRotation(entry, 1001, cfg) === 'rotate-idle');
  check('stays keep at exactly lastUsedAt (gap=0)', decideSessionRotation(entry, 1000, cfg) === 'keep');
}

// ======================================================================
//  SessionRegistry — stateful behaviour
//  v5.0: getOrCreate(accountKey, clientKey, now, seedId?). The accountKey
//  partitions sessions by the selected pool account; clientKey sub-partitions
//  only when perClient is on. Tests that don't exercise the account dimension
//  pass a fixed 'acct' and vary clientKey, exactly as the pre-v5 tests varied
//  the (then-first) clientKey argument.
// ======================================================================
header('SessionRegistry — first call mints fresh id with rotated=true reason=rotate-new');
{
  const reg = new SessionRegistry(defaultCfg(), idFactory());
  const r = reg.getOrCreate('acct', undefined, 0);
  check('sessionId=id-1', r.sessionId === 'id-1');
  check('rotated=true', r.rotated === true);
  check("reason='rotate-new'", r.reason === 'rotate-new');
  check('registry size=1 after first call', reg.size() === 1);
}

header('SessionRegistry — second call within window keeps same id');
{
  const reg = new SessionRegistry(defaultCfg(), idFactory());
  reg.getOrCreate('acct', undefined, 0);
  const r = reg.getOrCreate('acct', undefined, 5 * MIN);
  check('same id returned', r.sessionId === 'id-1');
  check('rotated=false on keep', r.rotated === false);
  check("reason='keep'", r.reason === 'keep');
}

header('SessionRegistry — idle rotation mints a new id after threshold');
{
  const reg = new SessionRegistry(defaultCfg(), idFactory());
  reg.getOrCreate('acct', undefined, 0);
  const r = reg.getOrCreate('acct', undefined, 15 * MIN + 1);
  check('new id minted', r.sessionId === 'id-2');
  check('rotated=true', r.rotated === true);
  check("reason='rotate-idle'", r.reason === 'rotate-idle');
  check('registry still size=1 (replacement, not growth)', reg.size() === 1);
}

header('SessionRegistry — lastUsedAt refreshed on keep so threshold slides');
{
  const reg = new SessionRegistry(defaultCfg(), idFactory());
  reg.getOrCreate('acct', undefined, 0);          // lastUsed=0
  reg.getOrCreate('acct', undefined, 10 * MIN);   // lastUsed=10min, keep
  reg.getOrCreate('acct', undefined, 20 * MIN);   // lastUsed=20min (gap 10 < 15), keep
  const r = reg.getOrCreate('acct', undefined, 30 * MIN);  // gap 10 < 15, keep
  check('still id-1 after continuous activity', r.sessionId === 'id-1');
  check("reason='keep' on the final call", r.reason === 'keep');
}

header('SessionRegistry — jitter sampled once per session, sticks until rotation');
{
  // rng returns 0.5 → Math.floor(0.5 * jitter) = 0.5*jitter rounded down
  const reg = new SessionRegistry(
    defaultCfg({ jitterMs: 10 * MIN }),
    idFactory(),
    rngFactory([0.5]),
  );
  reg.getOrCreate('acct', undefined, 0);
  // idle threshold = 15min base + 5min jitter = 20min
  const k1 = reg.getOrCreate('acct', undefined, 19 * MIN);
  check('still id-1 at 19min (under 20min effective)', k1.sessionId === 'id-1' && k1.reason === 'keep');
  const r1 = reg.getOrCreate('acct', undefined, 19 * MIN + 20 * MIN + 1);
  check("rotates once gap exceeds effective threshold", r1.reason === 'rotate-idle');
}

header('SessionRegistry — max-age rotates even under constant activity');
{
  const reg = new SessionRegistry(
    defaultCfg({ maxAgeMs: 60 * MIN }),
    idFactory(),
  );
  reg.getOrCreate('acct', undefined, 0);
  // Bump lastUsedAt under the 15-min idle threshold each step so idle never
  // fires — only max-age is the remaining rotation trigger.
  reg.getOrCreate('acct', undefined, 10 * MIN);
  reg.getOrCreate('acct', undefined, 20 * MIN);
  reg.getOrCreate('acct', undefined, 30 * MIN);
  reg.getOrCreate('acct', undefined, 40 * MIN);
  reg.getOrCreate('acct', undefined, 50 * MIN);
  const r = reg.getOrCreate('acct', undefined, 60 * MIN + 1);
  check("rotate-age reason reported", r.reason === 'rotate-age');
  check('new id minted', r.sessionId === 'id-2');
}

header('SessionRegistry — accountKey partitions sessions even with perClient=false');
{
  // The v5.0 dimension: two pool accounts each get their own session under the
  // default (perClient=false) config, without any client header in play. This
  // is what lets a multi-account pool keep per-account session ids.
  const reg = new SessionRegistry(defaultCfg({ perClient: false }), idFactory());
  const a = reg.getOrCreate('login', undefined, 0);
  const b = reg.getOrCreate('work', undefined, 1 * MIN);
  const aAgain = reg.getOrCreate('login', undefined, 2 * MIN);
  check('account "login" gets id-1', a.sessionId === 'id-1');
  check('account "work" gets a distinct id-2', b.sessionId === 'id-2');
  check('account "login" kept on repeat', aAgain.sessionId === 'id-1' && aAgain.reason === 'keep');
  check('registry size=2 (one session per account)', reg.size() === 2);
}

header('SessionRegistry — seedId used only on first creation, ignored on rotation');
{
  // A pool account carries a minted identity.sessionId passed as the seed so
  // the account's FIRST request is byte-identical to the pre-v5 stable id;
  // idle/age rotation then mints fresh via the id factory.
  const reg = new SessionRegistry(defaultCfg(), idFactory());
  const first = reg.getOrCreate('acct', undefined, 0, 'seed-abc');
  check('first request uses the seed id verbatim', first.sessionId === 'seed-abc');
  check("first request reason='rotate-new'", first.reason === 'rotate-new');
  const kept = reg.getOrCreate('acct', undefined, 5 * MIN, 'seed-abc');
  check('kept within window still the seed', kept.sessionId === 'seed-abc' && kept.reason === 'keep');
  // lastUsedAt is now 5min; idle by 15min+1 past that (20min+1) forces rotation.
  const rotated = reg.getOrCreate('acct', undefined, 20 * MIN + 1, 'seed-abc');
  check('idle rotation ignores the seed and mints fresh', rotated.sessionId === 'id-1');
  check("rotation reason='rotate-idle'", rotated.reason === 'rotate-idle');
}

header('SessionRegistry — perClient=false collapses distinct clientKeys onto one session');
{
  const reg = new SessionRegistry(defaultCfg({ perClient: false }), idFactory());
  const a = reg.getOrCreate('acct', 'client-a', 0);
  const b = reg.getOrCreate('acct', 'client-b', 1 * MIN);
  check('client-a gets id-1', a.sessionId === 'id-1');
  check('client-b reuses id-1 (not per-client)', b.sessionId === 'id-1');
  check('registry size=1', reg.size() === 1);
}

header('SessionRegistry — perClient=true separates by header (within one account)');
{
  const reg = new SessionRegistry(defaultCfg({ perClient: true }), idFactory());
  const a = reg.getOrCreate('acct', 'client-a', 0);
  const b = reg.getOrCreate('acct', 'client-b', 1 * MIN);
  const aAgain = reg.getOrCreate('acct', 'client-a', 2 * MIN);
  check('client-a gets id-1', a.sessionId === 'id-1');
  check('client-b gets id-2 (distinct)', b.sessionId === 'id-2');
  check('client-a kept on repeat', aAgain.sessionId === 'id-1' && aAgain.reason === 'keep');
  check('registry size=2', reg.size() === 2);
}

header('SessionRegistry — perClient=true with empty/undefined key falls back to default bucket');
{
  const reg = new SessionRegistry(defaultCfg({ perClient: true }), idFactory());
  const a = reg.getOrCreate('acct', undefined, 0);
  const b = reg.getOrCreate('acct', '', 1 * MIN);
  check('undefined and empty-string keys both bucket as "default"', a.sessionId === 'id-1' && b.sessionId === 'id-1');
  check('registry size=1 (one default bucket)', reg.size() === 1);
}

header('SessionRegistry — LRU eviction when over maxEntries cap');
{
  const reg = new SessionRegistry(defaultCfg({ perClient: true }), idFactory(), Math.random, 2);
  reg.getOrCreate('acct', 'a', 0);  // evict target after 3rd client
  reg.getOrCreate('acct', 'b', 1);
  reg.getOrCreate('acct', 'c', 2);
  check('size capped at 2', reg.size() === 2);
  // 'a' should be evicted; next getOrCreate for 'a' mints a fresh id
  const aAgain = reg.getOrCreate('acct', 'a', 3);
  check('evicted client gets fresh id', aAgain.reason === 'rotate-new' && aAgain.sessionId === 'id-4');
}

header('SessionRegistry — accessing a session refreshes its LRU position');
{
  const reg = new SessionRegistry(defaultCfg({ perClient: true }), idFactory(), Math.random, 2);
  reg.getOrCreate('acct', 'a', 0);
  reg.getOrCreate('acct', 'b', 1);
  reg.getOrCreate('acct', 'a', 2);        // refresh 'a' to MRU
  reg.getOrCreate('acct', 'c', 3);        // evict 'b' (least recently used), not 'a'
  check('a still alive (id-1)', reg.peek('acct', 'a') === 'id-1');
  check('b evicted', reg.peek('acct', 'b') === undefined);
  check('c present (id-3)', reg.peek('acct', 'c') === 'id-3');
}

header('SessionRegistry — peek does not touch lastUsedAt');
{
  const reg = new SessionRegistry(defaultCfg(), idFactory());
  reg.getOrCreate('acct', undefined, 0);
  reg.peek('acct', undefined);
  reg.peek('acct', undefined);
  reg.peek('acct', undefined);
  // Peek ×3 does not count as activity; 15min + 1 should still rotate
  const r = reg.getOrCreate('acct', undefined, 15 * MIN + 1);
  check('idle rotation still fires — peek did not bump lastUsedAt', r.reason === 'rotate-idle');
}

header('SessionRegistry — clear() empties the registry');
{
  const reg = new SessionRegistry(defaultCfg({ perClient: true }), idFactory());
  reg.getOrCreate('acct', 'a', 0);
  reg.getOrCreate('acct', 'b', 0);
  check('size=2 before clear', reg.size() === 2);
  reg.clear();
  check('size=0 after clear', reg.size() === 0);
  const r = reg.getOrCreate('acct', 'a', 0);
  check("post-clear call reports 'rotate-new'", r.reason === 'rotate-new');
}

// ======================================================================
//  resolveSessionRotationConfig — precedence and parsing
// ======================================================================
header('resolveSessionRotationConfig — defaults match v3.27 behaviour');
{
  const cfg = resolveSessionRotationConfig({}, {});
  check('idleRotateMs defaults to 15min', cfg.idleRotateMs === 15 * MIN);
  check('jitterMs defaults to 0', cfg.jitterMs === 0);
  check('maxAgeMs defaults to undefined', cfg.maxAgeMs === undefined);
  check('perClient defaults to false', cfg.perClient === false);
}

header('resolveSessionRotationConfig — env vars override defaults');
{
  const cfg = resolveSessionRotationConfig({}, {
    DARIO_SESSION_IDLE_ROTATE_MS: '600000',
    DARIO_SESSION_JITTER_MS: '90000',
    DARIO_SESSION_MAX_AGE_MS: '3600000',
    DARIO_SESSION_PER_CLIENT: '1',
  });
  check('idleRotateMs from env', cfg.idleRotateMs === 600000);
  check('jitterMs from env', cfg.jitterMs === 90000);
  check('maxAgeMs from env', cfg.maxAgeMs === 3600000);
  check('perClient=true from env value "1"', cfg.perClient === true);
}

header('resolveSessionRotationConfig — explicit wins over env');
{
  const cfg = resolveSessionRotationConfig(
    { idleRotateMs: 111, jitterMs: 222, maxAgeMs: 333, perClient: false },
    {
      DARIO_SESSION_IDLE_ROTATE_MS: '999',
      DARIO_SESSION_JITTER_MS: '999',
      DARIO_SESSION_MAX_AGE_MS: '999',
      DARIO_SESSION_PER_CLIENT: '1',
    },
  );
  check('explicit idleRotateMs wins', cfg.idleRotateMs === 111);
  check('explicit jitterMs wins', cfg.jitterMs === 222);
  check('explicit maxAgeMs wins', cfg.maxAgeMs === 333);
  check('explicit perClient=false wins over env=true', cfg.perClient === false);
}

header('resolveSessionRotationConfig — invalid numeric env falls through to default');
{
  const cfg = resolveSessionRotationConfig({}, {
    DARIO_SESSION_IDLE_ROTATE_MS: 'not-a-number',
    DARIO_SESSION_JITTER_MS: '-5',
    DARIO_SESSION_MAX_AGE_MS: '0',
  });
  check('garbage env → default idle', cfg.idleRotateMs === 15 * MIN);
  check('negative env → default jitter', cfg.jitterMs === 0);
  check('0 env (not positive) → undefined max-age', cfg.maxAgeMs === undefined);
}

header('resolveSessionRotationConfig — boolean env string parsing');
{
  const truthy = ['1', 'true', 'TRUE', 'yes', 'on', 'On'];
  for (const v of truthy) {
    const cfg = resolveSessionRotationConfig({}, { DARIO_SESSION_PER_CLIENT: v });
    check(`"${v}" → true`, cfg.perClient === true);
  }
  const falsy = ['0', 'false', 'no', 'off'];
  for (const v of falsy) {
    const cfg = resolveSessionRotationConfig({}, { DARIO_SESSION_PER_CLIENT: v });
    check(`"${v}" → false`, cfg.perClient === false);
  }
  const garbage = resolveSessionRotationConfig({}, { DARIO_SESSION_PER_CLIENT: 'maybe' });
  check('unrecognised string → default false', garbage.perClient === false);
}

header('resolveSessionRotationConfig — floats get truncated to integer ms');
{
  const cfg = resolveSessionRotationConfig({}, {
    DARIO_SESSION_IDLE_ROTATE_MS: '900000.7',
    DARIO_SESSION_JITTER_MS: '50.9',
  });
  check('idleRotateMs floored', cfg.idleRotateMs === 900000);
  check('jitterMs floored', cfg.jitterMs === 50);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

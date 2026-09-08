#!/usr/bin/env node
// dario#1244 / #1263 — seats know who they are, and present their own client
// identity.
//
// Two facts a seat record now carries:
//   - who the token IS: the OAuth profile's account uuid (+ masked email, org
//     tier fields), fetched once at grant time — the fact that says whether
//     two aliases are one subscription, replacing the reset-second inference.
//   - what the seat PRESENTS as: `deviceId`/`accountUuid` in metadata.user_id.
//     Every add path used to copy the machine's Claude Code identity into every
//     alias, so a pool of colleagues' tokens presented ONE identity across all
//     of them. The policy: the local identity belongs to the account it was
//     granted to; a new alias takes it only when nobody else holds it, or the
//     holder is proven (same account uuid) the same account.
//
// Hermetic: HOME is a mkdtemp'd dir; the profile endpoint is an injected fetch.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-identity-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  fetchOAuthProfile, profileFields, chooseClientIdentity, regenerateClientIdentity,
  saveAccount, loadAccount, OAUTH_PROFILE_URL,
} = await import('../dist/accounts.js');
const { maskEmail } = await import('../dist/pool.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log(`  OK ${n}`); pass++; } else { console.log(`  FAIL ${n}${d !== undefined ? ' :: ' + JSON.stringify(d) : ''}`); fail++; } };
const header = (n) => console.log(`\n=== ${n} ===`);

// The live shape, probed 2026-09-08 (values changed).
const LIVE_PROFILE = {
  account: { uuid: '09172340-9d85-4f24-bb2d-000000000001', full_name: 'M', display_name: 'M', email: 'matteo@example.com', has_claude_max: true, has_claude_pro: false },
  organization: { uuid: '92084194-b362-4651-b862-000000000002', name: 'Team', organization_type: 'claude_team', billing_type: 'stripe_subscription', rate_limit_tier: 'default_claude_ai', seat_tier: 'standard' },
  application: { uuid: 'x', name: 'Claude Code', slug: 'claude-code' },
};
const fetchWith = (status, body, seen = {}) => async (url, init) => {
  seen.url = String(url); seen.init = init;
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

header('fetchOAuthProfile — the token says who it is');
{
  const seen = {};
  const p = await fetchOAuthProfile('tok-1', fetchWith(200, LIVE_PROFILE, seen));
  check('hits the profile endpoint with the bearer', seen.url === OAUTH_PROFILE_URL && /Bearer tok-1/.test(String(seen.init?.headers?.Authorization ?? seen.init?.headers?.authorization)), seen);
  check('account uuid', p?.accountId === LIVE_PROFILE.account.uuid, p);
  check('email, organization, tier fields', p?.accountEmail === 'matteo@example.com' && p?.organizationId === LIVE_PROFILE.organization.uuid && p?.organizationType === 'claude_team' && p?.rateLimitTier === 'default_claude_ai' && p?.seatTier === 'standard', p);
  check('a null seat_tier is omitted, not stringified', (await fetchOAuthProfile('t', fetchWith(200, { ...LIVE_PROFILE, organization: { ...LIVE_PROFILE.organization, seat_tier: null } })))?.seatTier === undefined);
  check('401 → null (never fatal)', await fetchOAuthProfile('t', fetchWith(401, { error: 'x' })) === null);
  check('no account uuid → null', await fetchOAuthProfile('t', fetchWith(200, { account: {} })) === null);
  check('unparseable body → null', await fetchOAuthProfile('t', fetchWith(200, 'not json')) === null);
  check('a throwing fetch → null', await fetchOAuthProfile('t', async () => { throw new Error('boom'); }) === null);
}

header('profileFields — what lands on the record');
{
  const f = profileFields({ accountId: 'a1', accountEmail: 'e@x.y', organizationId: 'o1', rateLimitTier: 't' });
  check('maps every stated field', f.accountId === 'a1' && f.accountEmail === 'e@x.y' && f.organizationId === 'o1' && f.rateLimitTier === 't' && !('seatTier' in f), f);
  check('no profile → nothing', Object.keys(profileFields(null)).length === 0);
}

header('maskEmail — enough to recognise, never the whole address');
{
  check('th***@gmail.com', maskEmail('thomas@gmail.com') === 'th***@gmail.com');
  check('short user part', maskEmail('a@b.c') === 'a***@b.c');
  check('not an email → null', maskEmail('nope') === null && maskEmail(undefined) === null && maskEmail(null) === null);
}

header('chooseClientIdentity — the local Claude Code identity belongs to its own account');
{
  const LOCAL = { deviceId: 'dev-local', accountUuid: 'uuid-local' };
  const rec = (alias, o = {}) => ({ alias, accessToken: 't', refreshToken: 'r', expiresAt: 0, scopes: [], deviceId: `d-${alias}`, accountUuid: `u-${alias}`, ...o });
  const gen = await chooseClientIdentity([], null, null);
  check('no Claude Code → generated', gen.identityFrom === 'generated' && gen.deviceId.length > 0 && gen.deviceId !== gen.accountUuid);
  const first = await chooseClientIdentity([rec('other')], { accountId: 'acct-1' }, LOCAL);
  check('local identity unused by any alias → taken', first.identityFrom === 'claude-code' && first.deviceId === 'dev-local');
  const holder = rec('login', { deviceId: 'dev-local', accountUuid: 'uuid-local', accountId: 'acct-1' });
  const same = await chooseClientIdentity([holder], { accountId: 'acct-1' }, LOCAL);
  check('holder is the SAME account (same uuid) → shared, correctly', same.identityFrom === 'claude-code' && same.deviceId === 'dev-local');
  const other = await chooseClientIdentity([holder], { accountId: 'acct-2' }, LOCAL);
  check('holder is a DIFFERENT account → this alias gets its own', other.identityFrom === 'generated' && other.deviceId !== 'dev-local');
  const unknownHolder = rec('login', { deviceId: 'dev-local', accountUuid: 'uuid-local' });
  const cautious = await chooseClientIdentity([unknownHolder], { accountId: 'acct-1' }, LOCAL);
  check('holder not yet identified → not proven the same → own identity', cautious.identityFrom === 'generated');
  const noProfile = await chooseClientIdentity([holder], null, LOCAL);
  check('no profile for the new token → cannot prove same → own identity', noProfile.identityFrom === 'generated');
  const two = await Promise.all([chooseClientIdentity([holder], { accountId: 'x' }, LOCAL), chooseClientIdentity([holder], { accountId: 'x' }, LOCAL)]);
  check('generated identities are distinct per alias', two[0].deviceId !== two[1].deviceId);
}

header('regenerateClientIdentity — a seat gets its own, everything else untouched');
{
  await saveAccount({ alias: 'shared-a', accessToken: 'tA', refreshToken: 'rA', expiresAt: 5, scopes: ['s'], deviceId: 'dev-shared', accountUuid: 'uuid-shared', accountId: 'acct-A', accountEmail: 'a@x.y', organizationId: 'org', grantedAt: 42, identityFrom: 'claude-code' });
  await saveAccount({ alias: 'shared-b', accessToken: 'tB', refreshToken: 'rB', expiresAt: 5, scopes: ['s'], deviceId: 'dev-shared', accountUuid: 'uuid-shared', accountId: 'acct-B', identityFrom: 'claude-code' });
  const done = await regenerateClientIdentity(['shared-b', 'nope']);
  check('rewrites the named seat, skips the unknown one', JSON.stringify(done) === '["shared-b"]', done);
  const b = await loadAccount('shared-b');
  const a = await loadAccount('shared-a');
  check('shared-b presents its own identity now', b.deviceId !== 'dev-shared' && b.accountUuid !== 'uuid-shared' && b.identityFrom === 'generated', b);
  check('tokens, account identity and grant untouched', b.accessToken === 'tB' && b.refreshToken === 'rB' && b.accountId === 'acct-B' && b.expiresAt === 5);
  check('shared-a not touched', a.deviceId === 'dev-shared' && a.identityFrom === 'claude-code' && a.accountEmail === 'a@x.y' && a.grantedAt === 42);
}

console.log(`\naccounts-identity-policy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// dario#1244 / #1263 — the `Accounts` and `Client identity` doctor rows. Pure.
//
// Accounts: how many distinct Anthropic accounts the seats are, from the
// OAuth account uuid on each record — the fact, not the reset-second inference
// this replaced. Client identity: which seats present ONE `metadata.user_id`
// identity across DIFFERENT accounts, the shape every `accounts add` on a
// machine with Claude Code installed used to produce.

import { checkAccountIdentity, checkSharedClientIdentity } from '../dist/doctor-core.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { console.log(`  OK ${label}`); pass++; } else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; } };
const header = (l) => console.log(`\n=== ${l} ===`);

header('Accounts — fewer than two seats → nothing to say');
{
  check('empty', checkAccountIdentity({ accounts: [] }).length === 0);
  check('one seat', checkAccountIdentity({ accounts: [{ alias: 'a', accountId: 'A' }] }).length === 0);
}

header('Accounts — every seat its own account → ok');
{
  const rows = checkAccountIdentity({ accounts: [{ alias: 'a', accountId: 'A' }, { alias: 'b', accountId: 'B' }, { alias: 'c' }] });
  check('one row, ok', rows.length === 1 && rows[0].label === 'Accounts' && rows[0].status === 'ok', JSON.stringify(rows));
  check('counts distinct accounts, treating the unidentified seat as its own', /3 seats, 3 distinct accounts \(1 not yet identified — filled in by the next token refresh\)/.test(rows[0].detail), rows[0].detail);
  check('says no duplicates', /no alias is a duplicate/.test(rows[0].detail));
}

header('Accounts — the same uuid under two aliases → info, naming them with a masked email');
{
  const rows = checkAccountIdentity({ accounts: [
    { alias: 'busy', accountId: 'A', accountEmail: 'matteo@example.com' }, { alias: 'twin', accountId: 'A' }, { alias: 'spare', accountId: 'B' },
  ] });
  check('status info', rows[0].status === 'info');
  check('3 seats, 2 distinct accounts', /3 seats, 2 distinct accounts/.test(rows[0].detail), rows[0].detail);
  check('names the pair and masks the email', /busy \+ twin are the same account \(ma\*\*\*@example\.com\)/.test(rows[0].detail), rows[0].detail);
  check('never prints the whole address', !rows[0].detail.includes('matteo@'));
  check('explains the consequence', /counts them once/.test(rows[0].detail));
}

header('Accounts — seven aliases of one account (the #1244 shape, had they been one)');
{
  const rows = checkAccountIdentity({ accounts: Array.from({ length: 7 }, (_, i) => ({ alias: `s${i}`, accountId: 'ONE' })) });
  check('7 seats, 1 distinct account', /7 seats, 1 distinct account —/.test(rows[0].detail), rows[0].detail);
}

header('Client identity — every seat its own → ok');
{
  const rows = checkSharedClientIdentity({ accounts: [
    { alias: 'a', deviceId: 'd1', accountUuid: 'u1', accountId: 'A' }, { alias: 'b', deviceId: 'd2', accountUuid: 'u2', accountId: 'B' },
  ] });
  check('ok', rows.length === 1 && rows[0].label === 'Client identity' && rows[0].status === 'ok', JSON.stringify(rows));
}

header('Client identity — one identity shared by the SAME account → ok');
{
  const rows = checkSharedClientIdentity({ accounts: [
    { alias: 'login', deviceId: 'd', accountUuid: 'u', accountId: 'A' }, { alias: 'again', deviceId: 'd', accountUuid: 'u', accountId: 'A' },
  ] });
  check('same account may share its identity', rows[0].status === 'ok', rows[0].detail);
}

header('Client identity — one identity across DIFFERENT accounts → warn, with the fix');
{
  const rows = checkSharedClientIdentity({ accounts: [
    { alias: 'matteo', deviceId: 'd-cc', accountUuid: 'u-cc', accountId: 'M' },
    { alias: 'marco', deviceId: 'd-cc', accountUuid: 'u-cc', accountId: 'R' },
    { alias: 'luca', deviceId: 'd-cc', accountUuid: 'u-cc' },
    { alias: 'solo', deviceId: 'd-own', accountUuid: 'u-own', accountId: 'S' },
  ] });
  check('warn', rows[0].status === 'warn', rows[0].status);
  check('counts seats and accounts on the shared identity', /3 seats present ONE client identity \(device d-cc…\) across 3 accounts: matteo, marco, luca/.test(rows[0].detail), rows[0].detail);
  check('explains and names the command', /Claude Code installed/.test(rows[0].detail) && /dario accounts identity --fresh <alias>/.test(rows[0].detail));
  check('the seat with its own identity is not named', !/solo/.test(rows[0].detail));
}

header('Client identity — unidentified seats sharing an identity are not assumed the same account');
{
  const rows = checkSharedClientIdentity({ accounts: [
    { alias: 'a', deviceId: 'd', accountUuid: 'u' }, { alias: 'b', deviceId: 'd', accountUuid: 'u' },
  ] });
  check('warn (cannot prove they are one account)', rows[0].status === 'warn', rows[0].detail);
}

header('Client identity — fewer than two seats, or seats with no identity at all');
{
  check('one seat → nothing', checkSharedClientIdentity({ accounts: [{ alias: 'a', deviceId: 'd', accountUuid: 'u' }] }).length === 0);
  check('empty identities are ignored', checkSharedClientIdentity({ accounts: [{ alias: 'a', deviceId: '', accountUuid: '' }, { alias: 'b', deviceId: '', accountUuid: '' }] })[0].status === 'ok');
}

console.log(`\ndoctor-account-identity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

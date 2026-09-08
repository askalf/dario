#!/usr/bin/env node
// `dario accounts list --live` against a PRE-UPGRADE proxy (ticket
// 00MTRGHYIREA78C17D935F8CD8, review fix stranded when #1248 closed and the
// feature re-landed as #1250).
//
// The /accounts payload is accepted on `mode === 'pool'` plus `accounts` being
// an array — nothing checks the seat fields. So a newly installed CLI querying
// a proxy from the previous release met seats with no `sharesWindowWith`, and
// `.length` on undefined threw a TypeError: the command neither rendered live
// data nor took the on-disk fallback it advertises. Every field the team-gateway
// feature added is exercised here by its absence.

import { formatLiveAccountsListing } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const NOW = 1_757_260_000_000;

// A seat as a v6.0.33-and-earlier proxy serialized it: no sharesWindowWith,
// no organizationId, no grantedAt, no action.
const LEGACY_SEAT = {
  alias: 'seat-a', status: 'ok', util5h: 0.25, util7d: 0.1,
  utilAgeMs: 30_000, resetInMs: null, requestCount: 12, rejectedCount: 0,
};

// ─────────────────────────────────────────────────────────────
header('legacy payload — renders instead of throwing');
{
  let lines = null, threw = null;
  try {
    lines = formatLiveAccountsListing({ mode: 'pool', accounts: [LEGACY_SEAT] }, 3456, NOW);
  } catch (err) { threw = err; }

  check('does not throw on a seat with no sharesWindowWith', threw === null);
  check('returned lines', Array.isArray(lines) && lines.length > 0);

  const text = (lines ?? []).join('\n');
  check('still names the seat', text.includes('seat-a'));
  check('still reports the counts', text.includes('served 12') && text.includes('429s 0'));
  check('omits the shared-window fact rather than inventing one', !text.includes('same account as'));
  check('degrades the absent organization', text.includes('org not yet observed'));
}

// ─────────────────────────────────────────────────────────────
header('current payload — the feature fields still render');
{
  const modern = {
    ...LEGACY_SEAT, action: 'wait',
    organizationId: 'org_abcdef1234567890',
    sharesWindowWith: ['seat-b', 'seat-c'],
    grantedAt: NOW - 86_400_000,
  };
  const text = formatLiveAccountsListing({ mode: 'pool', accounts: [modern], distinctWindows: 2 }, 3456, NOW).join('\n');
  check('renders the shared window', text.includes('same account as seat-b, seat-c'));
  check('renders the organization', text.includes('org org_abcd'));
  check('renders the next step', text.includes('nothing, it comes back on its own'));
  check('honours distinctWindows', text.includes('on 2 distinct accounts'));
}

// ─────────────────────────────────────────────────────────────
header('a seat missing EVERY optional field');
{
  // The degenerate end of the same class: an older proxy, or one mid-restart,
  // that hands back a seat carrying only an alias.
  let threw = null, text = '';
  try {
    text = formatLiveAccountsListing({ mode: 'pool', accounts: [{ alias: 'bare' }] }, 3456, NOW).join('\n');
  } catch (err) { threw = err; }
  check('does not throw', threw === null);
  check('names the seat', text.includes('bare'));
  check('zeroes the missing counters', text.includes('served 0') && text.includes('429s 0'));
  check('reports an unmeasured reading rather than NaN', text.includes('never measured') && !text.includes('NaN'));
}

// ─────────────────────────────────────────────────────────────
header('an empty pool');
{
  let threw = null, text = '';
  try {
    text = formatLiveAccountsListing({ mode: 'pool', accounts: [] }, 3456, NOW).join('\n');
  } catch (err) { threw = err; }
  check('does not throw', threw === null);
  check('reports a pool of 0', text.includes('Pool of 0'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

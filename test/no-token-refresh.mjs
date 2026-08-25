#!/usr/bin/env node
/**
 * Borrow-don't-rotate mode — `DARIO_NO_TOKEN_REFRESH=1`.
 *
 * THE INCIDENT THIS PINS. Anthropic invalidates the previous refresh_token on
 * every refresh. On 2026-08-25 a CI job on the self-hosted runner started a
 * proxy against the SHARED credential store, that proxy refreshed, and every
 * other holder of the token — production — started getting `invalid_grant`.
 * The fleet was down about three hours.
 *
 * "Point HOME at a temp dir" fixes the jobs that need no real auth (that is
 * what compat-test-self-hosted.yml does). It does NOT fix a job that needs
 * genuine subscription OAuth, and the billing-classifier canary is exactly
 * that: an API key IS the other billing bucket, so a key would test the wrong
 * thing. Copying the credential file first does not help either — the
 * rotation happens UPSTREAM, so refreshing the copy invalidates the original.
 *
 * Hence a read-only borrow: use the access token while it is valid, and fail
 * LOUDLY the moment a renewal would be needed.
 *
 * Both refresh paths must be guarded. dario has two credential stores (the
 * legacy single-account `credentials.json` via oauth.ts, and the account pool
 * via accounts.ts), and which one a process loads depends on machine state.
 * Guarding one and not the other would leave the hole open exactly half the
 * time — which is worse than no guard, because it reads as protected.
 */
import { tokenRefreshDisabled, refreshDisabledError, refreshTokens } from '../dist/oauth.js';
import { refreshAccountToken } from '../dist/accounts.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

header('the switch reads exactly DARIO_NO_TOKEN_REFRESH=1');
{
  check('1 enables it', tokenRefreshDisabled({ DARIO_NO_TOKEN_REFRESH: '1' }) === true);
  check('unset leaves refresh ON (default must not change)', tokenRefreshDisabled({}) === false);
  // Deliberately strict. A half-on state here silently rotates a shared token,
  // so anything other than the documented value means OFF rather than "close
  // enough" — an operator who typo'd gets normal behaviour, not a surprise.
  check('"true" does NOT enable it', tokenRefreshDisabled({ DARIO_NO_TOKEN_REFRESH: 'true' }) === false);
  check('"0" does NOT enable it', tokenRefreshDisabled({ DARIO_NO_TOKEN_REFRESH: '0' }) === false);
  check('empty does NOT enable it', tokenRefreshDisabled({ DARIO_NO_TOKEN_REFRESH: '' }) === false);
}

header('the error explains itself to whoever finds it in a CI log');
{
  const m = refreshDisabledError().message;
  check('names the variable', /DARIO_NO_TOKEN_REFRESH/.test(m), m);
  check('says WHY refusing is safer than refreshing', /rotate/i.test(m), m);
  check('tells the reader how to proceed', /unset|Re-run/i.test(m), m);
}

header('BOTH refresh paths actually refuse');
{
  const prev = process.env.DARIO_NO_TOKEN_REFRESH;
  process.env.DARIO_NO_TOKEN_REFRESH = '1';
  try {
    // Legacy single-account store (oauth.ts).
    let legacyErr = null;
    try { await refreshTokens(); } catch (e) { legacyErr = e; }
    check('refreshTokens() throws', legacyErr !== null);
    check('refreshTokens() throws the DISABLED error, not "no token"',
      legacyErr && /DARIO_NO_TOKEN_REFRESH/.test(legacyErr.message), legacyErr?.message);

    // Account pool (accounts.ts). Guarded BEFORE the single-flight map, so a
    // refusal must not leave a poisoned in-flight promise behind either.
    let poolErr = null;
    try {
      await refreshAccountToken({ alias: 'test', refreshToken: 'rt', accessToken: 'at', expiresAt: 0 });
    } catch (e) { poolErr = e; }
    check('refreshAccountToken() throws', poolErr !== null);
    check('refreshAccountToken() throws the DISABLED error',
      poolErr && /DARIO_NO_TOKEN_REFRESH/.test(poolErr.message), poolErr?.message);

    // The whole point: refusing must not perform the network rotation. If the
    // guard sat after the token exchange it would still "throw" while having
    // already invalidated production's token — the exact failure, with an
    // error message on top.
    check('the pool guard runs before any single-flight bookkeeping',
      poolErr && !/fetch|ENOTFOUND|network|ECONN/i.test(poolErr.message), poolErr?.message);
  } finally {
    if (prev === undefined) delete process.env.DARIO_NO_TOKEN_REFRESH;
    else process.env.DARIO_NO_TOKEN_REFRESH = prev;
  }
}

header('default is unchanged when the flag is absent');
{
  // NEVER call refreshTokens() here with the flag unset.
  //
  // An earlier version of this file did exactly that, "to prove the guard is
  // inert." With the flag unset the guard IS inert — so the call proceeded
  // into a REAL token refresh against whatever store loadCredentials finds,
  // which on a developer box is `~/.claude/.credentials.json`: the operator's
  // own Claude Code credential. Anthropic invalidates the previous
  // refresh_token on every refresh, so every `npm test` run logged the
  // operator out of their editor. Observed, repeatedly, before it was caught.
  //
  // That is this very file's own subject matter turned on its author, and it
  // is worth stating plainly: a test that exercises a credential-mutating code
  // path IS a credential mutation. There is no "just checking" version of it.
  //
  // The flag's inertness is fully observable from the pure predicate, which is
  // the only thing the guard consults. Asserting that costs nothing and
  // touches no credential. Anything beyond it needs an injected fake, not a
  // live store.
  delete process.env.DARIO_NO_TOKEN_REFRESH;
  check('flag reads OFF', tokenRefreshDisabled() === false);
  check('the guard cannot fire, so the default path is untouched',
    tokenRefreshDisabled({}) === false && tokenRefreshDisabled({ DARIO_NO_TOKEN_REFRESH: '0' }) === false);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * loadCredentials freshness fall-through.
 *
 * Regression guard: a stale `~/.dario/credentials.json` whose
 * `refresh_token` has been invalidated by Anthropic must NOT shadow
 * a fresh `~/.claude/.credentials.json` indefinitely. Before this
 * fix, loadCredentials returned the first source with the right
 * shape regardless of expiry, so dario lost its auto-detection
 * fall-through once any prior `dario login` had created a file
 * that subsequently went stale.
 *
 * pickFreshestCredentials is the helper that contains the new
 * "pick freshest by expiresAt, tie goes to first" logic; tests
 * exercise it with synthetic candidates so we don't need real
 * credentials on disk.
 */

import { pickFreshestCredentials } from '../dist/oauth.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const cred = (label, expiresAt, accessToken = `ak-${label}`, refreshToken = `rt-${label}`) => ({
  claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: [] },
});

const NOW = Date.now();
const HOUR = 3_600_000;

// ────────────────────────────────────────────────────────────────────
header('1. empty / null cases');

check('empty array → null', pickFreshestCredentials([]) === null);

// ────────────────────────────────────────────────────────────────────
header('2. single candidate always wins');

const onlyOne = cred('a', NOW + HOUR);
check('single fresh → that one', pickFreshestCredentials([onlyOne]) === onlyOne);

const onlyOneStale = cred('b', NOW - 7 * 24 * HOUR);
check('single stale → that one (caller decides if usable)', pickFreshestCredentials([onlyOneStale]) === onlyOneStale);

// ────────────────────────────────────────────────────────────────────
header('3. freshness wins across multiple candidates');

// The real-world bug: dario-file is stale, CC-file is fresh. Stale
// must NOT win.
const darioStale = cred('dario-stale', NOW - 3 * 24 * HOUR);
const ccFresh = cred('cc-fresh', NOW + 8 * HOUR);
const result1 = pickFreshestCredentials([darioStale, ccFresh]);
check('stale dario + fresh CC → CC wins', result1 === ccFresh);
check('stale dario + fresh CC → access token from CC source', result1?.claudeAiOauth.accessToken === 'ak-cc-fresh');

// And the inverse: dario fresh, CC older. Dario should win.
const darioFresh = cred('dario-fresh', NOW + 8 * HOUR);
const ccStale = cred('cc-stale', NOW - HOUR);
const result2 = pickFreshestCredentials([darioFresh, ccStale]);
check('fresh dario + stale CC → dario wins', result2 === darioFresh);

// All three sources, freshest wins regardless of position.
const keychainNewest = cred('keychain-newest', NOW + 24 * HOUR);
const result3 = pickFreshestCredentials([darioStale, ccFresh, keychainNewest]);
check('three sources, last is freshest → last wins', result3 === keychainNewest);

// ────────────────────────────────────────────────────────────────────
header('4. tie-breaking — first wins on equal expiresAt');

// When dario-file and CC-file have the same expiresAt (e.g. both refer
// to the same OAuth session — they often do), the first-pushed
// candidate wins. Canonical call order is [darioFile, ccFile,
// keychain], so this keeps dario-file as the preferred source on
// ties — preserves prior behavior for the equal-freshness case.
const tied1 = cred('first', NOW + HOUR);
const tied2 = cred('second', NOW + HOUR);
check('equal expiresAt → first one wins', pickFreshestCredentials([tied1, tied2]) === tied1);

// ────────────────────────────────────────────────────────────────────
header('5. missing / malformed expiresAt sorts last');

const fresh = cred('fresh', NOW + HOUR);
const noExpiresAt = { claudeAiOauth: { accessToken: 'ak', refreshToken: 'rt', scopes: [] } };
const result4 = pickFreshestCredentials([noExpiresAt, fresh]);
check('candidate with no expiresAt loses to a fresh one', result4 === fresh);

const onlyNoExpires = pickFreshestCredentials([noExpiresAt]);
check('only candidate has no expiresAt → still returned (caller decides)', onlyNoExpires === noExpiresAt);

// ────────────────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

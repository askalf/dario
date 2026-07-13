#!/usr/bin/env node
// Unit tests for isTerminalRefreshFailure — the dead-refresh-token classifier.
// A terminal failure (invalid_grant / 401 / 403) means the refresh token is
// revoked/rotated-out and retrying can't recover it: dario must fail fast with
// a `dario login` prompt and surface `broken` immediately instead of burning
// 3 doomed retries while masking as healthy (the dead-token trap that made
// dario#737 a multi-hour mystery).

import { isTerminalRefreshFailure } from '../dist/oauth.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// The exact body dario#737 logged.
const REAL_BODY = '{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}';

header('terminal — dead/revoked/rotated-out refresh token');
{
  check('400 + invalid_grant body (the #737 case)', isTerminalRefreshFailure(400, REAL_BODY) === true);
  check('invalid_grant, minimal body', isTerminalRefreshFailure(400, '{"error":"invalid_grant"}') === true);
  check('case-insensitive INVALID_GRANT', isTerminalRefreshFailure(400, 'error=INVALID_GRANT') === true);
  check('401 (any body)', isTerminalRefreshFailure(401, '') === true);
  check('403 (any body)', isTerminalRefreshFailure(403, 'forbidden') === true);
  check('401 even without invalid_grant text', isTerminalRefreshFailure(401, 'unauthorized') === true);
}

header('NOT terminal — transient, retry is worth it');
{
  check('500 server error', isTerminalRefreshFailure(500, 'internal error') === false);
  check('502 bad gateway', isTerminalRefreshFailure(502, '') === false);
  check('503 unavailable', isTerminalRefreshFailure(503, 'overloaded') === false);
  check('429 rate limit', isTerminalRefreshFailure(429, 'too many requests') === false);
  check('400 WITHOUT invalid_grant (e.g. transient bad body)', isTerminalRefreshFailure(400, '{"error":"temporarily_unavailable"}') === false);
  check('empty body, non-terminal status', isTerminalRefreshFailure(500, '') === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

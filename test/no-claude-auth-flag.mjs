#!/usr/bin/env node
// Unit tests for --no-claude-auth via the requiresClaudeLogin startup gate.
// The flag lets an OpenAI-only proxy start WITHOUT a Claude login, so it never
// loads or rotates the shared Claude refresh token (which otherwise logs out an
// interactive Claude Code on the same machine — dario#737 class, locally).
// requiresClaudeLogin === false means "an empty pool is fine, don't fatally
// demand `dario login`". It must be false for --no-claude-auth exactly like the
// existing admin-bootstrap and upstream-api-key empty-pool modes.

import { requiresClaudeLogin } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

header('default (no flags, empty pool) — must demand login');
{
  // poolSize, adminEnabled, hasUpstreamApiKey, noClaudeAuth
  check('empty pool, nothing set → requires login',
    requiresClaudeLogin(0, false, false, false) === true);
}

header('--no-claude-auth — empty pool is expected, do NOT demand login');
{
  check('empty pool + noClaudeAuth → no login required',
    requiresClaudeLogin(0, false, false, true) === false);
}

header('existing empty-pool modes still bypass the login demand');
{
  check('admin-bootstrap → no login required',
    requiresClaudeLogin(0, true, false, false) === false);
  check('upstream-api-key → no login required',
    requiresClaudeLogin(0, false, true, false) === false);
}

header('a stored codex account is itself a credential (dario#1137)');
{
  // A ChatGPT-subscription-only user has stored an account and has real
  // capacity to serve requests. Demanding `dario login` — or a
  // --no-claude-auth flag they have no reason to know about — is dario
  // refusing to start over a credential it will never use.
  // poolSize, adminEnabled, hasUpstreamApiKey, noClaudeAuth, hasCodexAccount
  check('empty pool + codex account → no login required',
    requiresClaudeLogin(0, false, false, false, true) === false);
  check('empty pool + NO codex account → still requires login',
    requiresClaudeLogin(0, false, false, false, false) === true);
  check('omitting the argument keeps the pre-#1137 answer',
    requiresClaudeLogin(0, false, false, false) === true);
}

header('a populated pool never demands login (any flags)');
{
  check('pool has an account, default',
    requiresClaudeLogin(1, false, false, false) === false);
  check('pool has an account + noClaudeAuth',
    requiresClaudeLogin(2, false, false, true) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

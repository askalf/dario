// Tests for normalizeAuthorizeUrl (dario#71).
//
// The CC binary ships `CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize"`
// as a literal, but CC at runtime opens `https://claude.ai/oauth/authorize`
// directly. Anthropic's edge started returning "Invalid request format" for
// requests arriving via the 307 hop, while accepting direct requests. The
// normalizer rewrites the legacy URL to match CC's runtime behaviour.
//
// These tests pin the rewrite behaviour AND the deliberate narrowness of it:
// any other URL (including operator-supplied overrides pointing elsewhere)
// must pass through untouched.

import { normalizeAuthorizeUrl, FALLBACK_FOR_DRIFT_CHECK } from '../dist/cc-oauth-detect.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('normalizeAuthorizeUrl — legacy URL gets rewritten');
{
  check('legacy claude.com URL → claude.ai',
    normalizeAuthorizeUrl('https://claude.com/cai/oauth/authorize') ===
      'https://claude.ai/oauth/authorize');
}

header('normalizeAuthorizeUrl — anything else passes through');
{
  check('already-normalized URL unchanged',
    normalizeAuthorizeUrl('https://claude.ai/oauth/authorize') ===
      'https://claude.ai/oauth/authorize');

  // Operator-supplied staging / override URLs must pass through unchanged.
  // The normalizer is deliberately narrow — it rewrites exactly one URL.
  check('operator staging override passes through',
    normalizeAuthorizeUrl('https://staging.claude.ai/oauth/authorize') ===
      'https://staging.claude.ai/oauth/authorize');
  check('self-hosted IDP passes through',
    normalizeAuthorizeUrl('https://idp.example.com/oauth/authorize') ===
      'https://idp.example.com/oauth/authorize');

  // No substring / prefix match — only exact string. A URL that *contains*
  // the legacy path must not trigger the rewrite.
  check('trailing-slash variant does NOT match',
    normalizeAuthorizeUrl('https://claude.com/cai/oauth/authorize/') ===
      'https://claude.com/cai/oauth/authorize/');
  check('query-string variant does NOT match',
    normalizeAuthorizeUrl('https://claude.com/cai/oauth/authorize?foo=bar') ===
      'https://claude.com/cai/oauth/authorize?foo=bar');
  check('different casing does NOT match',
    normalizeAuthorizeUrl('https://claude.com/CAI/oauth/authorize') ===
      'https://claude.com/CAI/oauth/authorize');
  check('http (non-https) variant does NOT match',
    normalizeAuthorizeUrl('http://claude.com/cai/oauth/authorize') ===
      'http://claude.com/cai/oauth/authorize');
}

header('normalizeAuthorizeUrl — edge inputs');
{
  check('empty string passes through',
    normalizeAuthorizeUrl('') === '');
  check('unrelated URL passes through',
    normalizeAuthorizeUrl('https://example.com/oauth') ===
      'https://example.com/oauth');
}

// ─────────────────────────────────────────────────────────────
header('FALLBACK — pinned to the normalized URL');
{
  // The last-resort fallback that ships when binary scanning fails must
  // already be normalized — users who hit the fallback path (no CC installed,
  // or scan failure) shouldn't be broken by the legacy URL regression.
  check('FALLBACK.authorizeUrl is the claude.ai URL',
    FALLBACK_FOR_DRIFT_CHECK.authorizeUrl === 'https://claude.ai/oauth/authorize');
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

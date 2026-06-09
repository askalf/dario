#!/usr/bin/env node
// resolveProxyTarget — the proxy path allowlist (SSRF guard) + per-route
// forwarding mode. Added when /v1/messages/count_tokens joined the
// allowlist (it 403'd before — surfaced by the 2026-06-09 fable battery):
// count_tokens forwards THIN (no template injection — the endpoint counts
// the CLIENT's own prompt; CC system/tools/effort would distort it, and
// `output_config` is not a count_tokens request field).

import { resolveProxyTarget } from '../dist/proxy.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\n=== resolveProxyTarget — allowlisted routes ===');
{
  const messages = resolveProxyTarget('/v1/messages', false);
  check('/v1/messages → messages?beta=true', messages?.target === 'https://api.anthropic.com/v1/messages?beta=true');
  check('/v1/messages → full pipeline (not thin)', messages?.thin === false);

  const count = resolveProxyTarget('/v1/messages/count_tokens', false);
  check('count_tokens → allowlisted', count !== null);
  check('count_tokens → upstream count_tokens path', count?.target === 'https://api.anthropic.com/v1/messages/count_tokens');
  check('count_tokens → NO ?beta=true (messages-only affordance)', !count?.target.includes('beta=true'));
  check('count_tokens → thin forward', count?.thin === true);

  const complete = resolveProxyTarget('/v1/complete', false);
  check('/v1/complete → allowlisted, not thin', complete?.target === 'https://api.anthropic.com/v1/complete' && complete?.thin === false);

  const openai = resolveProxyTarget('/v1/chat/completions', true);
  check('openai route → messages?beta=true, not thin', openai?.target === 'https://api.anthropic.com/v1/messages?beta=true' && openai?.thin === false);
}

console.log('\n=== resolveProxyTarget — everything else stays 403 (SSRF guard) ===');
{
  check('unknown path → null', resolveProxyTarget('/v1/embeddings', false) === null);
  check('traversal-ish path → null', resolveProxyTarget('/v1/messages/../admin', false) === null);
  check('count_tokens subpath → null', resolveProxyTarget('/v1/messages/count_tokens/x', false) === null);
  check('empty path → null', resolveProxyTarget('', false) === null);
  check('root → null', resolveProxyTarget('/', false) === null);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

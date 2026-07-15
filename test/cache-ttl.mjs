#!/usr/bin/env node
// Client cache-TTL mirroring — dario#678 round 3.
//
// Ground truth (loopback capture, CC v2.1.209 under subscription OAuth,
// 2026-07-14): real CC sends `ttl:'1h'` on every breakpoint plus
// `extended-cache-ttl-2025-04-11` in anthropic-beta on included subscription
// usage, and decides the overage/API fallback (bare 5m stamps) itself.
// dario used to DELETE those stamps and re-place bare 5m ones, forcing every
// proxied subscription session onto a 5m cache. These tests pin the mirror:
// the client's ttl survives the rebuild, on exactly the client's terms.
import { buildCCRequest, applyCcPromptCaching, effectiveCacheControl, CC_CACHE_CONTROL, isGenuineCCClient } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}

const BETA_1H = 'claude-code-20250219,oauth-2025-04-20,extended-cache-ttl-2025-04-11';
const BETA_NO_TTL = 'claude-code-20250219,oauth-2025-04-20';

/** A minimal genuine-CC-shaped request, mirroring the captured wire shape. */
function ccBody(cacheControl) {
  const cc = cacheControl ? { cache_control: cacheControl } : {};
  return {
    model: 'claude-sonnet-5',
    stream: true,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc-version=2.1.209' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", ...cc },
      { type: 'text', text: 'Long system prompt '.repeat(50), ...cc },
    ],
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'context' },
        { type: 'text', text: 'hi', ...cc },
      ] },
    ],
    metadata: { user_id: 'u' },
    max_tokens: 32000,
  };
}

const TTL_1H = { type: 'ephemeral', ttl: '1h' };

// ── effectiveCacheControl derivation ──────────────────────────────────
{
  const got = effectiveCacheControl(ccBody(TTL_1H), BETA_1H);
  check('1h stamps + extended-cache-ttl beta -> mirrored 1h', got.ttl === '1h');
}
{
  const got = effectiveCacheControl(ccBody(TTL_1H), BETA_NO_TTL);
  check('1h stamps WITHOUT the enabling beta -> bare 5m (never forward half the pair)', got.ttl === undefined);
}
{
  const got = effectiveCacheControl(ccBody({ type: 'ephemeral' }), BETA_1H);
  check('bare client stamps (CC in overage) -> bare 5m', got.ttl === undefined);
}
{
  const got = effectiveCacheControl(ccBody(null), BETA_1H);
  check('no client stamps at all -> bare 5m', got.ttl === undefined);
}
{
  const got = effectiveCacheControl(ccBody(TTL_1H), undefined);
  check('no client beta header -> bare 5m', got.ttl === undefined);
}
{
  process.env.DARIO_CACHE_TTL_5M = '1';
  const got = effectiveCacheControl(ccBody(TTL_1H), BETA_1H);
  delete process.env.DARIO_CACHE_TTL_5M;
  check('DARIO_CACHE_TTL_5M=1 escape hatch -> bare 5m despite client 1h', got.ttl === undefined);
}
{
  // conversation-only stamps (no system stamps) still count
  const body = ccBody(null);
  body.messages[0].content[1].cache_control = TTL_1H;
  const got = effectiveCacheControl(body, BETA_1H);
  check('ttl found on a conversation breakpoint alone -> mirrored', got.ttl === '1h');
}

// ── end-to-end through the real rebuild ───────────────────────────────
function collectCC(body) {
  const out = [];
  for (const b of body.system ?? []) if (b.cache_control) out.push(b.cache_control);
  for (const m of body.messages ?? [])
    if (Array.isArray(m.content))
      for (const b of m.content) if (b && b.cache_control) out.push(b.cache_control);
  return out;
}

{
  const client = ccBody(TTL_1H);
  check('fixture is detected as genuine CC', isGenuineCCClient(client) === true);
  const control = effectiveCacheControl(client, BETA_1H);
  const { body, genuineCC } = buildCCRequest(client, 'x-anthropic-billing-header: tag', control,
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' });
  applyCcPromptCaching(body, control);
  const stamps = collectCC(body);
  check('passthrough took the genuine-CC path', genuineCC === true);
  check('outbound has breakpoints', stamps.length > 0);
  check('EVERY outbound breakpoint carries the client 1h ttl',
    stamps.length > 0 && stamps.every((s) => s.ttl === '1h'));
}
{
  // client in overage (bare stamps): outbound must stay bare — no invented 1h
  const client = ccBody({ type: 'ephemeral' });
  const control = effectiveCacheControl(client, BETA_1H);
  const { body } = buildCCRequest(client, 'x-anthropic-billing-header: tag', control,
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' });
  applyCcPromptCaching(body, control);
  const stamps = collectCC(body);
  check('overage-shaped client -> outbound breakpoints stay ttl-less',
    stamps.length > 0 && stamps.every((s) => s.ttl === undefined));
}
{
  // default export unchanged: CC_CACHE_CONTROL itself is still bare
  check('CC_CACHE_CONTROL stays bare (non-CC clients unchanged)', CC_CACHE_CONTROL.ttl === undefined);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

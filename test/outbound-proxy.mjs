// Unit tests for src/outbound-proxy.ts (v3.35.0). Pure decision functions
// only — no fetch wrapping, no live proxy. Validates parseOutboundProxy
// + isLocalhostUrl behavior against the documented contract.

import { parseOutboundProxy, isLocalhostUrl } from '../dist/outbound-proxy.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}
function expectThrows(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ======================================================================
//  parseOutboundProxy — empty / undefined returns null (no proxy)
// ======================================================================
header('parseOutboundProxy — null / empty');
{
  check('undefined returns null', parseOutboundProxy(undefined) === null);
  check('empty string returns null', parseOutboundProxy('') === null);
  check('whitespace-only returns null', parseOutboundProxy('   ') === null);
}

// ======================================================================
//  parseOutboundProxy — happy path http / https
// ======================================================================
header('parseOutboundProxy — http / https accepted');
{
  const httpResult = parseOutboundProxy('http://127.0.0.1:8080');
  check('http://... parses', httpResult !== null);
  check('http scheme detected', httpResult?.scheme === 'http');
  check('display matches input', httpResult?.display === 'http://127.0.0.1:8080/');

  const httpsResult = parseOutboundProxy('https://proxy.example.com:443');
  check('https://... parses', httpsResult !== null);
  check('https scheme detected', httpsResult?.scheme === 'https');
}

// ======================================================================
//  parseOutboundProxy — credentials in URL get masked in display
// ======================================================================
header('parseOutboundProxy — credentials masked in display');
{
  const r = parseOutboundProxy('http://user:secret@proxy.host:8080');
  check('parses successfully', r !== null);
  check('display masks username', r?.display.includes('***') ?? false);
  check('display does NOT contain real password', !(r?.display.includes('secret') ?? true));
  check('url field preserves real value (passed to fetch)', r?.url.includes('secret') ?? false);
}

// ======================================================================
//  parseOutboundProxy — SOCKS rejected with clear message
// ======================================================================
header('parseOutboundProxy — SOCKS rejected');
{
  for (const scheme of ['socks5', 'socks5h', 'socks4', 'socks4a', 'socks']) {
    const msg = expectThrows(() => parseOutboundProxy(`${scheme}://127.0.0.1:1080`));
    check(`${scheme} is rejected`, msg !== null);
    check(`${scheme} error mentions HTTP fallback`, msg?.includes('HTTP proxy') ?? false);
    check(`${scheme} error mentions privoxy bridge option`, msg?.toLowerCase().includes('privoxy') ?? false);
  }
}

// ======================================================================
//  parseOutboundProxy — other schemes rejected
// ======================================================================
header('parseOutboundProxy — non-http schemes rejected');
{
  const msg1 = expectThrows(() => parseOutboundProxy('ftp://example.com'));
  check('ftp:// rejected', msg1 !== null);
  check('error mentions http/https expected', msg1?.includes('http://') ?? false);

  const msg2 = expectThrows(() => parseOutboundProxy('file:///etc/passwd'));
  check('file:// rejected', msg2 !== null);
}

// ======================================================================
//  parseOutboundProxy — invalid URL rejected with parse error
// ======================================================================
header('parseOutboundProxy — invalid URL');
{
  const msg = expectThrows(() => parseOutboundProxy('not a url'));
  check('garbage rejected', msg !== null);
  check('error explains expected format', msg?.includes('valid URL') ?? false);
}

// ======================================================================
//  isLocalhostUrl — loopback detection
// ======================================================================
header('isLocalhostUrl — loopback / non-loopback');
{
  // Loopback
  check('http://localhost:3456', isLocalhostUrl('http://localhost:3456'));
  check('http://127.0.0.1:3456', isLocalhostUrl('http://127.0.0.1:3456'));
  check('http://[::1]:3456 (IPv6 loopback)', isLocalhostUrl('http://[::1]:3456'));
  check('https://localhost', isLocalhostUrl('https://localhost'));
  check('foo.localhost subdomain', isLocalhostUrl('http://foo.localhost'));

  // Non-loopback
  check('https://api.anthropic.com is NOT localhost', !isLocalhostUrl('https://api.anthropic.com'));
  check('https://api.openai.com is NOT localhost', !isLocalhostUrl('https://api.openai.com'));
  check('http://192.168.1.1 is NOT localhost', !isLocalhostUrl('http://192.168.1.1'));
  check('http://10.0.0.1 is NOT localhost', !isLocalhostUrl('http://10.0.0.1'));

  // Object input shapes
  check('URL object with localhost', isLocalhostUrl(new URL('http://localhost:3456')));
  check('Request-shaped object with .url localhost', isLocalhostUrl({ url: 'http://localhost:3456' }));

  // Edge cases
  check('null returns false (not loopback)', isLocalhostUrl(null) === false);
  check('undefined returns false', isLocalhostUrl(undefined) === false);
  check('empty string returns false', isLocalhostUrl('') === false);
  check('garbage string returns false', isLocalhostUrl('not a url') === false);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`======================================================================`);
process.exit(fail === 0 ? 0 : 1);

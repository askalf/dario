// Tests for src/redact.ts — secret redaction patterns shared between
// proxy.ts:sanitizeError and the OAuth call sites in oauth.ts and
// accounts.ts that thread upstream response bodies into Error messages.

import { redactSecrets, SECRET_PATTERNS } from '../dist/redact.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`, ...rest); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

header('redactSecrets — redacts sk-ant-* API keys');
{
  const out = redactSecrets('error: sk-ant-api03-abc_123-DEFxyz reached rate limit');
  check('sk-ant- prefix redacted', !out.includes('sk-ant-api03-abc_123'));
  check('replacement marker present', out.includes('[REDACTED]'));
  check('surrounding context preserved', out.startsWith('error: ') && out.endsWith(' reached rate limit'));
}

header('redactSecrets — redacts JWT tokens (eyJ.eyJ.sig triple)');
{
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_here';
  const out = redactSecrets(`got ${jwt} from upstream`);
  check('JWT redacted', !out.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'));
  check('JWT marker present', out.includes('[REDACTED_JWT]'));
}

header('redactSecrets — redacts Bearer tokens');
{
  const out = redactSecrets('Authorization: Bearer abc123def456ghi789 was rejected');
  check('Bearer value redacted', !out.includes('Bearer abc123def456ghi789'));
  check('Bearer prefix preserved with marker', out.includes('Bearer [REDACTED]'));
}

header('redactSecrets — multiple secrets on one line');
{
  const input = 'sk-ant-foo and Bearer xyz123 simultaneously';
  const out = redactSecrets(input);
  check('sk-ant redacted', !out.includes('sk-ant-foo'));
  check('Bearer redacted', !out.includes('Bearer xyz123'));
}

header('redactSecrets — idempotent (redacted string redacts to itself)');
{
  const once  = redactSecrets('sk-ant-foo and Bearer xyz123');
  const twice = redactSecrets(once);
  check('second pass is a no-op', once === twice, once, twice);
}

header('redactSecrets — leaves non-secret content untouched');
{
  const inputs = [
    '',
    'plain error message',
    'sk-other-foo (not anthropic)',
    'eyJ-truncated (not a full JWT)',
    'BearerTypoNoSpace abc',
  ];
  for (const s of inputs) {
    const out = redactSecrets(s);
    check(`untouched: "${s.slice(0, 30)}…"`, out === s);
  }
}

header('SECRET_PATTERNS export — frozen regex set, sane shape');
{
  check('exposes at least 3 patterns', SECRET_PATTERNS.length >= 3);
  for (const tup of SECRET_PATTERNS) {
    check('each entry is [RegExp, string]', tup[0] instanceof RegExp && typeof tup[1] === 'string');
  }
}

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

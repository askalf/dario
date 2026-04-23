// Tests for runAuthCheck + redactSecret + classifyAuthHeaders
// (`dario doctor --auth-check`).
//
// The HTTP-integration subset binds to an ephemeral loopback port and
// sends synthetic requests from within the same process. No outbound
// traffic, no secrets, sub-second runtime.

import { redactSecret, classifyAuthHeaders, runAuthCheck } from '../dist/doctor.js';
import http from 'node:http';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('redactSecret');
{
  check('short string → length tag', redactSecret('abc') === '<3 chars>');
  check('exactly 8 chars → length tag (not excerpt)', redactSecret('12345678') === '<8 chars>');
  check('9 chars → first 4 + last 4', redactSecret('abcdefghi') === 'abcd…fghi (length 9)');
  check('long key → first 4 + last 4', redactSecret('sk-ant-api03-abcdef1234567890') === 'sk-a…7890 (length 29)');
  check('empty → length 0', redactSecret('') === '<0 chars>');
}

// ─────────────────────────────────────────────────────────────
header('classifyAuthHeaders — no headers → no-auth-header');
{
  const r = classifyAuthHeaders({}, 'dario');
  check('verdict=no-auth-header', r.verdict === 'no-auth-header');
  check('xApiKey.present=false', r.xApiKey.present === false);
  check('authorization.present=false', r.authorization.present === false);
}

header('classifyAuthHeaders — x-api-key matches');
{
  const r = classifyAuthHeaders({ 'x-api-key': 'dario' }, 'dario');
  check('verdict=match', r.verdict === 'match');
  check('xApiKey.matches=true', r.xApiKey.matches === true);
  check('redacted is length tag for 5-char key', r.xApiKey.redacted === '<5 chars>');
}

header('classifyAuthHeaders — x-api-key mismatch');
{
  const r = classifyAuthHeaders({ 'x-api-key': 'wrong-key-value-here' }, 'dario');
  check('verdict=mismatch', r.verdict === 'mismatch');
  check('xApiKey.matches=false', r.xApiKey.matches === false);
  check('xApiKey.length present', typeof r.xApiKey.length === 'number' && r.xApiKey.length === 20);
}

header('classifyAuthHeaders — Authorization with Bearer prefix matches');
{
  const r = classifyAuthHeaders({ authorization: 'Bearer dario' }, 'dario');
  check('verdict=match', r.verdict === 'match');
  check('authorization.bearerPrefix=true', r.authorization.bearerPrefix === true);
  check('authorization.matches=true (value post-Bearer-strip)', r.authorization.matches === true);
}

header('classifyAuthHeaders — Authorization without Bearer prefix');
{
  // Some clients set the value raw, no "Bearer " prefix. This counts
  // as a mismatch even though the underlying value is correct —
  // dario's auth code strips "Bearer " before comparing.
  const r = classifyAuthHeaders({ authorization: 'dario' }, 'dario');
  check('verdict=match (raw value still matches after no-op strip)', r.verdict === 'match');
  check('authorization.bearerPrefix=false', r.authorization.bearerPrefix === false);
}

header('classifyAuthHeaders — Authorization looks like real sk-ant key');
{
  const r = classifyAuthHeaders(
    { authorization: 'Bearer sk-ant-api03-long-real-key-abc123' },
    'dario',
  );
  check('verdict=mismatch', r.verdict === 'mismatch');
  check('redacted starts with sk-a', r.authorization.redacted?.startsWith('sk-a'));
  check('bearerPrefix=true', r.authorization.bearerPrefix === true);
}

header('classifyAuthHeaders — both headers, one matches → match wins');
{
  const r = classifyAuthHeaders(
    { 'x-api-key': 'dario', authorization: 'Bearer some-other-value' },
    'dario',
  );
  check('verdict=match', r.verdict === 'match');
  check('xApiKey.matches=true', r.xApiKey.matches === true);
  check('authorization.matches=false', r.authorization.matches === false);
}

header('classifyAuthHeaders — array-valued header (http allows this)');
{
  const r = classifyAuthHeaders({ 'x-api-key': ['dario', 'unused'] }, 'dario');
  check('first value used, verdict=match', r.verdict === 'match');
}

// ─────────────────────────────────────────────────────────────
header('runAuthCheck — no DARIO_API_KEY → no-enforcement, no listen');
{
  const r = await runAuthCheck({ expectedKey: '', timeoutMs: 100 });
  check('verdict=no-enforcement', r.verdict === 'no-enforcement');
  check('received=false', r.received === false);
  check('diagnosis mentions DARIO_API_KEY', r.diagnosis.includes('DARIO_API_KEY'));
}

header('runAuthCheck — inbound matching request → match');
{
  const r = await runAuthCheck({
    expectedKey: 'dario',
    timeoutMs: 2000,
    onListening: (port) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { 'x-api-key': 'dario' } }, (res) => {
        res.resume();
      });
    },
  });
  check('verdict=match', r.verdict === 'match');
  check('received=true', r.received === true);
  check('port is set', typeof r.port === 'number' && r.port > 0);
  check('xApiKey.matches=true', r.xApiKey?.matches === true);
}

header('runAuthCheck — inbound mismatch request → mismatch + sk-ant hint');
{
  const r = await runAuthCheck({
    expectedKey: 'dario',
    timeoutMs: 2000,
    onListening: (port) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { authorization: 'Bearer sk-ant-api03-real-key' } }, (res) => {
        res.resume();
      });
    },
  });
  check('verdict=mismatch', r.verdict === 'mismatch');
  check('diagnosis names sk-a pattern', r.diagnosis.includes('sk-a'));
  check('diagnosis mentions auth-profiles.json', r.diagnosis.includes('auth-profiles'));
}

header('runAuthCheck — inbound request with no auth headers → no-auth-header');
{
  const r = await runAuthCheck({
    expectedKey: 'dario',
    timeoutMs: 2000,
    onListening: (port) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); });
    },
  });
  check('verdict=no-auth-header', r.verdict === 'no-auth-header');
  check('diagnosis mentions ANTHROPIC_API_KEY', r.diagnosis.includes('ANTHROPIC_API_KEY'));
}

header('runAuthCheck — no request within timeout → timeout');
{
  const r = await runAuthCheck({
    expectedKey: 'dario',
    timeoutMs: 200, // very short so the test doesn't drag
  });
  check('verdict=timeout', r.verdict === 'timeout');
  check('received=false', r.received === false);
  check('diagnosis names timeout', /timeout|received/i.test(r.diagnosis));
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

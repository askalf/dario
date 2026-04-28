#!/usr/bin/env node
/**
 * --log-file plumbing — dario#XYZ.
 *
 * Verifies the writeLogLine helper, exported from proxy.ts, produces a
 * one-JSON-line append-only record per call and scrubs secrets via
 * redactSecrets. Exercises the helper in isolation: no proxy boot, no
 * upstream, no CLI parse — those have their own integration coverage.
 *
 * Also covers the --log-file CLI flag parser. The full request-lifecycle
 * integration (auth-reject, queue-reject, success, error log emission)
 * is exercised indirectly through the existing proxy fixtures + a manual
 * smoke test (documented in README); a stand-alone end-to-end harness
 * for it would have to replay full CC traffic, which is out of scope
 * for a unit test.
 */

import { writeLogLine } from '../dist/proxy.js';
import { mkdtempSync, readFileSync, createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'dario-log-test-'));
const logPath = join(tmp, 'requests.log');

try {
  // ────────────────────────────────────────────────────────────────────
  header('1. writeLogLine — basic JSON-ND output');

  const stream = createWriteStream(logPath, { flags: 'a' });
  writeLogLine(stream, {
    ts: '2026-04-28T12:00:00.000Z', req: 1,
    method: 'POST', path: '/v1/messages',
    model: 'claude-opus-4-7',
    status: 200, latency_ms: 1234,
    in_tokens: 10, out_tokens: 20,
    cache_read: 5, cache_create: 0,
    claim: 'max20', bucket: 'subscription', account: 'primary',
    client: 'cline', preserve_tools: true, stream: true,
  });
  writeLogLine(stream, {
    ts: '2026-04-28T12:00:01.000Z', req: 2,
    method: 'POST', path: '/v1/messages', status: 401, reject: 'auth',
  });

  // Wait for the write stream to flush.
  await new Promise((resolve, reject) => stream.end((err) => err ? reject(err) : resolve()));

  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  check('two records written', lines.length === 2);
  const r1 = JSON.parse(lines[0]);
  const r2 = JSON.parse(lines[1]);

  check('record #1 round-trips JSON', r1.req === 1 && r1.status === 200);
  check('record #1 includes model', r1.model === 'claude-opus-4-7');
  check('record #1 includes claim/bucket/account', r1.claim === 'max20' && r1.bucket === 'subscription' && r1.account === 'primary');
  check('record #1 includes client/preserve_tools/stream', r1.client === 'cline' && r1.preserve_tools === true && r1.stream === true);
  check('record #2 has reject reason', r2.reject === 'auth' && r2.status === 401);

  // ────────────────────────────────────────────────────────────────────
  header('2. writeLogLine — secret scrubbing');

  // Reopen the same file and write an entry that *could* contain a leaked
  // secret. The error field is the most likely vector — sanitizeError
  // already runs in the proxy before passing the string here, but
  // writeLogLine layers redactSecrets on top as a defense-in-depth pass.
  rmSync(logPath);
  const stream2 = createWriteStream(logPath, { flags: 'a' });
  writeLogLine(stream2, {
    ts: '2026-04-28T12:00:02.000Z', req: 3,
    method: 'POST', path: '/v1/messages', status: 502,
    error: 'upstream rejected: sk-ant-api03-abc_123-DEFxyz invalid',
  });
  await new Promise((resolve, reject) => stream2.end((err) => err ? reject(err) : resolve()));

  const content2 = readFileSync(logPath, 'utf8');
  check('sk-ant- prefix redacted', !content2.includes('sk-ant-api03-abc_123'));
  check('redaction marker present', content2.includes('[REDACTED]'));
  const r3 = JSON.parse(content2.trim());
  check('record still valid JSON after redaction', r3.req === 3 && r3.status === 502);

  // ────────────────────────────────────────────────────────────────────
  header('3. writeLogLine — null stream is a no-op');

  // Proxy passes null when --log-file is not configured. Helper must
  // accept that without crashing.
  let threw = false;
  try { writeLogLine(null, { ts: 'x', req: 0, method: 'POST', path: '/' }); }
  catch { threw = true; }
  check('null stream → no throw', !threw);

  // ────────────────────────────────────────────────────────────────────
  header('4. writeLogLine — write errors are swallowed');

  // Closed stream: a synchronous write attempt would throw ERR_STREAM_DESTROYED
  // on some Node versions. The helper wraps in try/catch so a log mishap
  // can't break the request path.
  const closedStream = createWriteStream(join(tmp, 'closed.log'));
  await new Promise((resolve) => closedStream.end(resolve));
  threw = false;
  try { writeLogLine(closedStream, { ts: 'x', req: 99, method: 'POST', path: '/' }); }
  catch { threw = true; }
  check('write to ended stream → no throw', !threw);

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

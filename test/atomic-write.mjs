// Unit tests for the atomic cache-write primitive (v3.17).
//
// The live fingerprint cache at ~/.dario/cc-template.live.json was
// previously written via plain writeFileSync. A crash or Ctrl+C between
// the first byte and the last byte would leave a truncated file that
// readLiveCache() couldn't parse — silently dropping users back to the
// bundled snapshot. This test exercises the temp-file + rename path
// that replaces it.

import {
  _atomicWriteJsonForTest as atomicWriteJson,
} from '../dist/live-fingerprint.js';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

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

// Unique per-run workspace so repeated local runs don't stomp.
const WORKSPACE = join(tmpdir(), `dario-atomic-write-${randomBytes(6).toString('hex')}`);
mkdirSync(WORKSPACE, { recursive: true });
const targetName = 'cc-template.live.json';

function cleanWorkspace() {
  for (const entry of readdirSync(WORKSPACE)) rmSync(join(WORKSPACE, entry), { force: true, recursive: true });
}

// ======================================================================
//  Happy path — write, then read back
// ======================================================================
header('atomicWriteJson — basic round-trip');
{
  cleanWorkspace();
  const target = join(WORKSPACE, targetName);
  const payload = { _version: '2.1.104', _schemaVersion: 1, hello: 'world' };
  atomicWriteJson(target, payload);
  check('target file exists', existsSync(target));
  const roundTrip = JSON.parse(readFileSync(target, 'utf-8'));
  check('content round-trips', roundTrip.hello === 'world' && roundTrip._version === '2.1.104');
  check('pretty-printed (contains newline)', readFileSync(target, 'utf-8').includes('\n'));
}

// ======================================================================
//  Parent directory created on demand
// ======================================================================
header('atomicWriteJson — creates missing parent directories');
{
  cleanWorkspace();
  const nested = join(WORKSPACE, 'nested', 'deeper', targetName);
  atomicWriteJson(nested, { ok: true });
  check('nested target created', existsSync(nested));
}

// ======================================================================
//  Tmp file cleaned up on success
// ======================================================================
header('atomicWriteJson — tmp artifact removed after successful rename');
{
  cleanWorkspace();
  const target = join(WORKSPACE, targetName);
  atomicWriteJson(target, { a: 1 });
  const stragglers = readdirSync(WORKSPACE).filter((f) => f.includes('.tmp'));
  check('no *.tmp files left in workspace', stragglers.length === 0);
}

// ======================================================================
//  Overwrites existing target content
// ======================================================================
header('atomicWriteJson — overwrites existing target atomically');
{
  cleanWorkspace();
  const target = join(WORKSPACE, targetName);
  // Pre-populate with something
  writeFileSync(target, JSON.stringify({ version: 'old' }));
  atomicWriteJson(target, { version: 'new' });
  const final = JSON.parse(readFileSync(target, 'utf-8'));
  check('old content replaced', final.version === 'new');
}

// ======================================================================
//  Concurrent-process isolation (simulated via foreign-pid tmp file)
// ======================================================================
header('atomicWriteJson — pid-qualified tmp does not disturb foreign tmp files');
{
  cleanWorkspace();
  const target = join(WORKSPACE, targetName);
  // Simulate a different process mid-write by leaving a stray tmp with a
  // different pid suffix. Our write must not delete or touch it.
  const foreignPid = process.pid === 1 ? 2 : 1; // any pid != ours
  const foreignTmp = `${target}.${foreignPid}.tmp`;
  writeFileSync(foreignTmp, '{"partial": true');
  atomicWriteJson(target, { done: true });
  check('target written', JSON.parse(readFileSync(target, 'utf-8')).done === true);
  check('foreign-pid tmp left alone', existsSync(foreignTmp));
  check('foreign-pid tmp content unchanged', readFileSync(foreignTmp, 'utf-8') === '{"partial": true');
  // Clean the foreign stray so the workspace-removal at the end is clean.
  rmSync(foreignTmp, { force: true });
}

// ======================================================================
//  Cleanup + summary
// ======================================================================
rmSync(WORKSPACE, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);

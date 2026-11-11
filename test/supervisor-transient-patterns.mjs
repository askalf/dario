#!/usr/bin/env node
/**
 * Tests for the pattern set in .github/workflows/self-healing-supervisor.yml.
 *
 * The supervisor re-runs a failed workflow run when its failed-step log
 * matches one of those patterns, and leaves every other failure for a person
 * to read. So a pattern that is too wide re-runs real failures, and a blank
 * one would match every log there is. The set is read out of the workflow
 * and joined the way its step joins it, then held against saved logs: a
 * failure that was the network's is matched, a failing test is not.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(REPO, '.github', 'workflows', 'self-healing-supervisor.yml'), 'utf-8');

header('the pattern set');
const block = workflow.match(/TRANSIENT_PATTERNS='([^']*)'/);
// The step strips each line's indent and joins the lines with `|` for grep -E. The same is done here.
const patterns = (block ? block[1] : '').split('\n').map((line) => line.replace(/^\s+/, ''));
check('it is read from the workflow', block !== null && patterns.length >= 11, patterns.length);
check('the step still joins it one pattern per line',
  workflow.includes(`PATTERNS_RE="$(printf '%s' "$TRANSIENT_PATTERNS" | sed -E 's/^[[:space:]]+//' | tr '\\n' '|' | sed 's/|$//')"`));
check('no pattern is blank, and none is listed twice', patterns.every((p) => p.length > 0) && new Set(patterns).size === patterns.length);
const compiles = (p) => { try { new RegExp(p); return true; } catch { return false; } };
check('every pattern is an expression on its own', patterns.every(compiles), patterns.filter((p) => !compiles(p)).join(' | '));
const joined = new RegExp(patterns.join('|'));
// grep -E -m1 in the step: the first matching line is what the summary shows.
const firstMatch = (log) => log.split('\n').find((line) => joined.test(line)) ?? '';

header('a failure that is the network\'s');
// test/fixtures/supervisor-apt-dns.log: the failed step of ci.yml's redis-backend job on a GitHub-hosted runner
// (run 43049286964, 2026-11-11), when apt could not resolve the Ubuntu archive hosts. The job never reached
// this repository's code.
const aptDns = readFileSync(join(REPO, 'test', 'fixtures', 'supervisor-apt-dns.log'), 'utf-8');
check('the saved log is the apt one', aptDns.includes("Temporary failure resolving 'archive.ubuntu.com'") && aptDns.includes('Process completed with exit code 100'));
check('apt failing to resolve its archive hosts is matched, on the resolver\'s line', /Temporary failure resolving '[a-z.]+'$/.test(firstMatch(aptDns)), firstMatch(aptDns));
check('without that pattern the same log is not matched',
  !new RegExp(patterns.filter((p) => p !== 'Temporary failure resolving').join('|')).test(aptDns));

header('a failure that is ours');
const failingTest = [
  'test\tRun npm test\t2026-11-11T15:55:42.4159480Z     not ok 174 - opus-alias-fallback.mjs',
  "test\tRun npm test\t2026-11-11T15:55:42.4163160Z       failureType: 'testCodeFailure'",
  'test\tRun npm test\t2026-11-11T15:55:42.4180648Z           FAIL the opus row is ok',
  'test\tRun npm test\t2026-11-11T15:55:42.4189905Z         19 pass, 2 fail',
  'test\tRun npm test\t2026-11-11T15:56:34.8311066Z # tests 306',
  'test\tRun npm test\t2026-11-11T15:56:35.2729455Z ##[error]Process completed with exit code 1.',
].join('\n');
check('a failing test is not matched', firstMatch(failingTest) === '', firstMatch(failingTest));
check('an empty log line is not matched', !joined.test(''));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

// fuzz/run.mjs scheduling: FUZZ_JOBS concurrency and its normalisation, the serial default, no new
// target after a failure while running ones finish, the exit status of the first failure, and a
// held output block that reaches a piped stdout in full when the run fails.
//
// Each case copies run.mjs into a scratch tree with a stand-in for Jazzer's CLI. The stand-in reads
// its behaviour from the target name, split on '_': `s<ms>` sleeps that long (default 200),
// `x<code>` exits with that code, `big` prints 4 MiB before its end marker. It logs its start and
// end to FUZZ_TEST_LOG.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runMjs = join(dirname(fileURLToPath(import.meta.url)), '..', 'fuzz', 'run.mjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else      { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++; }
}

const STAND_IN = `
import { appendFileSync } from 'node:fs';
const name = process.argv[2].replace(/^fuzz\\//, '').replace(/\\.fuzz$/, '');
const parts = name.split('_');
const opt = (p) => parts.find((s) => s.startsWith(p) && /^\\d+$/.test(s.slice(1)));
const ms = Number(opt('s')?.slice(1) ?? 200);
const code = Number(opt('x')?.slice(1) ?? 0);
const log = (ev) => appendFileSync(process.env.FUZZ_TEST_LOG, JSON.stringify({ ev, name, t: Date.now() }) + '\\n');
log('start');
setTimeout(() => {
  if (parts.includes('big')) process.stdout.write('d'.repeat(4 * 1024 * 1024));
  process.stdout.write('END-OF-' + name + '\\n');
  log('end');
  process.exitCode = code;
}, ms);
`;

function sandbox(names) {
  const root = mkdtempSync(join(tmpdir(), 'dario-fuzz-run-'));
  mkdirSync(join(root, 'fuzz'));
  copyFileSync(runMjs, join(root, 'fuzz', 'run.mjs'));
  for (const n of names) writeFileSync(join(root, 'fuzz', `${n}.fuzz.js`), '');
  const core = join(root, '.clusterfuzzlite', 'node_modules', '@jazzer.js', 'core');
  mkdirSync(join(core, 'dist'), { recursive: true });
  writeFileSync(join(root, '.clusterfuzzlite', 'package.json'), '{"private":true}');
  writeFileSync(join(core, 'package.json'), '{"name":"@jazzer.js/core","version":"0.0.0"}');
  writeFileSync(join(core, 'dist', 'cli.js'), STAND_IN);
  writeFileSync(join(core, 'dist', 'package.json'), '{"type":"module"}');
  return root;
}

function run(names, jobs) {
  const root = sandbox(names);
  const logPath = join(root, 'events.log');
  const env = { ...process.env, FUZZ_SECONDS: '1', FUZZ_TEST_LOG: logPath };
  delete env.FUZZ_JOBS;
  delete env.FUZZ_CORPUS_DIR;
  delete env.FUZZ_ARTIFACT_DIR;
  if (jobs !== undefined) env.FUZZ_JOBS = jobs;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(root, 'fuzz', 'run.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      const events = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        : [];
      const started = events.filter((e) => e.ev === 'start').map((e) => e.name);
      const ended = events.filter((e) => e.ev === 'end').map((e) => e.name);
      // At equal timestamps an end counts before a start, so touching runs are not an overlap.
      const sorted = [...events].sort((a, b) => a.t - b.t || (a.ev === 'end' ? -1 : 1) - (b.ev === 'end' ? -1 : 1));
      let live = 0, peak = 0;
      for (const e of sorted) { live += e.ev === 'start' ? 1 : -1; peak = Math.max(peak, live); }
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), started, ended, peak });
    });
  });
}

console.log('\n  fuzz/run.mjs scheduling');

{
  const r = await run(['a', 'b', 'c']);
  check('no FUZZ_JOBS: one target at a time', r.peak === 1, `peak ${r.peak}`);
  check('no FUZZ_JOBS: every target, in order', r.started.join() === 'a,b,c', r.started.join());
  check('no FUZZ_JOBS: exit 0', r.code === 0, `exit ${r.code}`);
}
{
  const r = await run(['a_s400', 'b_s400', 'c_s400', 'd_s400'], '2');
  check('FUZZ_JOBS=2: at most two at once, and two do overlap', r.peak === 2, `peak ${r.peak}`);
  check('FUZZ_JOBS=2: all four targets run', r.ended.length === 4, r.ended.join());
  check('FUZZ_JOBS=2: one block per target', ['a_s400', 'b_s400', 'c_s400', 'd_s400'].every((n) => r.stdout.includes(`=== fuzzing ${n} (1s) ===\nEND-OF-${n}`)), r.stdout);
}
for (const jobs of ['abc', '0', '-2']) {
  const r = await run(['a', 'b', 'c'], jobs);
  check(`FUZZ_JOBS=${jobs}: counts as 1`, r.peak === 1 && r.ended.length === 3, `peak ${r.peak}, ended ${r.ended.join()}`);
}
{
  const r = await run(['a_s400', 'b_s400', 'c_s400'], '9');
  check('FUZZ_JOBS=9 with three targets: all three at once', r.peak === 3 && r.ended.length === 3, `peak ${r.peak}`);
  check('FUZZ_JOBS=9: exit 0', r.code === 0, `exit ${r.code}`);
}
{
  const r = await run(['a', 'b_x3', 'c']);
  check('one job, second target fails: third never starts', r.started.join() === 'a,b_x3', r.started.join());
  check('one job, second target fails: exit 3', r.code === 3, `exit ${r.code}`);
  check('one job: the failure names the target', r.stderr.includes('b_x3: jazzer exited with 3'), r.stderr);
}
{
  const r = await run(['a_s800', 'b_x3_s50', 'c', 'd'], '2');
  check('two jobs, a failure: no queued target starts', !r.started.includes('c') && !r.started.includes('d'), r.started.join());
  check('two jobs, a failure: the running target finishes', r.ended.includes('a_s800') && r.stdout.includes('END-OF-a_s800'), r.ended.join());
  check('two jobs, a failure: exit 3', r.code === 3, `exit ${r.code}`);
}
{
  const r = await run(['a_x7_s500', 'b_x3_s50'], '2');
  check('two failures: exit status of the first to fail', r.code === 3, `exit ${r.code}`);
  check('two failures: both are named', r.stderr.includes('a_x7_s500: jazzer exited with 7') && r.stderr.includes('b_x3_s50: jazzer exited with 3'), r.stderr);
}
{
  const r = await run(['a_s50', 'b_big_x5_s300'], '2');
  check('failing target with a large held block: exit 5', r.code === 5, `exit ${r.code}`);
  check('failing target with a large held block: the whole block reaches the pipe',
    r.stdout.includes('d'.repeat(4 * 1024 * 1024) + 'END-OF-b_big_x5_s300'), `stdout ${r.stdout.length} bytes`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

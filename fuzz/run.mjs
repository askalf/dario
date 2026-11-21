// `node fuzz/run.mjs` runs every Jazzer.js target in ./fuzz. This is the fuzzer CI runs
// (.github/workflows/fuzz.yml) and the local repro loop. The targets import compiled output from
// dist/, so `npm run build` first. Environment:
//   FUZZ_SECONDS       per-target budget in seconds (default 30)
//   FUZZ_JOBS          how many targets fuzz at once (default 1, one after another); each still
//                      gets its whole FUZZ_SECONDS, so CI sets it to the runner's CPU count
//   FUZZ_CORPUS_DIR    root of per-target corpus dirs, created on demand; libFuzzer reads its
//                      seeds from <dir>/<target> and saves every interesting input there, so a
//                      corpus that persists between runs keeps getting deeper. Unset: no corpus.
//   FUZZ_ARTIFACT_DIR  where a crashing input is written, created on demand. Unset: the cwd.
// Jazzer comes from .clusterfuzzlite/package.json (`npm ci --prefix .clusterfuzzlite`), kept out of
// dario's own package.json so the published dependency tree stays exactly as committed.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const targets = readdirSync(dir).filter((f) => f.endsWith('.fuzz.js')).sort();
const secs = process.env.FUZZ_SECONDS || '30';
const corpusRoot = process.env.FUZZ_CORPUS_DIR || '';
const artifactDir = process.env.FUZZ_ARTIFACT_DIR || '';
// Run Jazzer's JS CLI directly under `node`: no .cmd wrapper, no shell, so a space in the repo
// path cannot break the invocation.
const jazzerCli = createRequire(new URL('../.clusterfuzzlite/package.json', import.meta.url)).resolve('@jazzer.js/core/dist/cli.js');
if (artifactDir) mkdirSync(artifactDir, { recursive: true });

const jobs = Math.min(targets.length, Math.max(1, Number.parseInt(process.env.FUZZ_JOBS ?? '', 10) || 1));

// Fuzzes one target and resolves with how it ended. With one job its output streams as it comes;
// with more, each target's output is held and printed as one block when it ends, so the logs of
// targets running side by side never interleave.
function fuzz(t) {
  const name = t.replace(/\.fuzz\.js$/, '');
  // The targets are synchronous (they never return a promise), so Jazzer runs in --sync mode.
  const args = [jazzerCli, `fuzz/${name}.fuzz`, '--sync'];
  if (corpusRoot) {
    const corpus = path.join(corpusRoot, name);
    mkdirSync(corpus, { recursive: true });
    args.push(corpus);
  }
  args.push('--', `-max_total_time=${secs}`, '-print_final_stats=1');
  if (artifactDir) args.push(`-artifact_prefix=${artifactDir}${path.sep}`);
  const header = `\n=== fuzzing ${name} (${secs}s) ===`;
  return new Promise((resolve) => {
    if (jobs === 1) console.log(header);
    const child = spawn(process.execPath, args, { stdio: jobs === 1 ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => out.push(d));
    child.on('error', (err) => resolve({ name, status: null, signal: null, err }));
    child.on('close', (status, signal) => {
      if (jobs > 1) process.stdout.write(`${header}\n${Buffer.concat(out)}`);
      resolve({ name, status, signal });
    });
  });
}

// After a failure no further target starts; the ones already running finish their budget. With
// one job that is the first failing target, as before.
const failures = [];
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (!failures.length && next < targets.length) {
    const r = await fuzz(targets[next++]);
    if (r.status !== 0) failures.push(r);
  }
}));
for (const r of failures) {
  console.error(`\n${r.name}: jazzer exited with ${r.err?.message ?? r.status ?? r.signal}; a reproducing input is in ${artifactDir || 'the working directory'}`);
}
if (failures.length) process.exit(failures[0].status || 1);

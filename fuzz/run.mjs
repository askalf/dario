// `node fuzz/run.mjs` (also `npm run fuzz`) runs every Jazzer.js target in ./fuzz. This is the
// fuzzer CI runs (.github/workflows/fuzz.yml) and the local repro loop. Environment:
//   FUZZ_SECONDS       per-target budget in seconds (default 30)
//   FUZZ_CORPUS_DIR    root of per-target corpus dirs, created on demand; libFuzzer reads its
//                      seeds from <dir>/<target> and saves every interesting input there, so a
//                      corpus that persists between runs keeps getting deeper. Unset: no corpus.
//   FUZZ_ARTIFACT_DIR  where a crashing input is written, created on demand. Unset: the cwd.
// Jazzer comes from .clusterfuzzlite/package.json (`npm ci --prefix .clusterfuzzlite`), kept out of
// dario's own package.json so the published dependency tree stays exactly as committed.
import { spawnSync } from 'node:child_process';
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

for (const t of targets) {
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
  console.log(`\n=== fuzzing ${name} (${secs}s) ===`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${name}: jazzer exited with ${r.status ?? r.signal}; a reproducing input is in ${artifactDir || 'the working directory'}`);
    process.exit(r.status || 1);
  }
}

#!/usr/bin/env node
// Top-level parallel test runner — dario#79 (Claude review push-back).
//
// Previous shape: `npm test` was a single `node test/a.mjs && node test/b.mjs
// && …` chain of 34 serial invocations. Problems:
//   1. No parallelism — total time = sum of all files; most are independent.
//   2. First-failure exits — if file #1 fails, files #2-34 never run, so you
//      can't see whether a second unrelated failure also exists without first
//      fixing the first one.
//   3. No unified reporter — each file prints its own ad-hoc "N pass, M fail"
//      tally; CI log has 34 separate summary lines to scan.
//
// This driver wraps every existing `*.mjs` in `test/` (except opt-out E2E /
// compat files that expect live proxy state) as a `node:test` subtest,
// spawning the existing file as a subprocess. The existing files stay
// untouched — their own `check(name, cond)` assertion style and
// `process.exit(fail === 0 ? 0 : 1)` semantics work as-is. `node --test` on
// this driver gives us:
//
//   - parallelism (default `--test-concurrency=8`)
//   - every file's failure surfaces in the same run, not just the first
//   - TAP / spec reporter (structured, tool-parseable)
//
// Run: `node --test --test-concurrency=8 test/all.test.mjs`
//
// Zero runtime dependencies. Stays true to the package's dep-hygiene invariant.

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Files the driver itself should skip:
//   - all.test.mjs — self-reference would recurse
//   - e2e.mjs, compat.mjs, stealth-test.mjs — live-integration tests that
//     expect a running proxy / real Anthropic key / real subscription; they
//     have their own `npm run e2e`, `npm run compat` entry points and are
//     intentionally excluded from the default test script
const EXCLUDED = new Set([
  'all.test.mjs',
  'e2e.mjs',
  'stress.mjs',
  'infra-probe.mjs',
  'compat.mjs',
  'stealth-test.mjs',
  // Live in-process e2e — patches global fetch and starts a real proxy.
  // Run manually with: node test/overage-guard-e2e-live.mjs (dario#288).
  'overage-guard-e2e-live.mjs',
]);

const files = readdirSync(__dirname)
  .filter(f => f.endsWith('.mjs') && !EXCLUDED.has(f))
  .sort();

// Every child gets the live-template cache pointed at a path that does not
// exist, so loadTemplate falls back to the BUNDLED snapshot and the suite is
// independent of local machine state.
//
// Without this, running the proxy (or the bench, or a bake) refreshes
// ~/.dario/cc-template.live.json with a HEADLESS capture, which omits the
// interactive-only tools CC never sends from `--print`. Three suites then fail
// on a machine where dario has recently run and pass everywhere else:
// tool-advertise-respects-client, template-interactive-tools and
// issue-29-tool-translation. Observed for real, not hypothesised.
//
// dario#867 closed the write half of this — the tests no longer POISON the
// operator's cache. This is the read half: they must not DEPEND on it either.
// A test whose result changes because you happened to start the proxy an hour
// ago is not measuring the code.
//
// Files that genuinely exercise the live-cache path (test/live-fingerprint.mjs)
// assign their own override in-process, which wins over this inherited value.
const suiteTemplateCache = join(
  mkdtempSync(join(tmpdir(), 'dario-suite-template-')), 'cc-template.live.json',
);
const childEnv = { ...process.env, DARIO_LIVE_TEMPLATE_CACHE: suiteTemplateCache };

for (const f of files) {
  test(f, { concurrency: true }, async () => {
    await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [join(__dirname, f)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Inherited env plus the pinned template cache (see above).
        env: childEnv,
      });
      let out = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { out += d; });
      proc.on('close', code => {
        if (code === 0) return resolve();
        reject(new Error(`\n--- ${f} exited with code ${code} ---\n${out}`));
      });
      proc.on('error', err => reject(err));
    });
  });
}

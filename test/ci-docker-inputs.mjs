#!/usr/bin/env node
// ci.yml's docker-cap-drop-smoke runs the image smoke on GitHub's runners only when a PR changes
// what the entrypoint's privilege flow depends on, and the required check passes only when that
// smoke passed or was not owed. This runs the workflow's own two scripts: the input selector in
// scratch git repositories, and the final gate against every outcome of the jobs it reads.

import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { out(`  OK ${name}`); pass++; }
  else { out(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};

const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
// The `run: |` block of the step or job whose line contains `marker`, dedented.
function runBlock(marker) {
  const lines = ci.split('\n');
  const at = lines.findIndex((l) => l.includes(marker));
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = /^ */.exec(lines[runAt + 1])[0].length;
  const body = [];
  for (const l of lines.slice(runAt + 1)) { if (l.trim() && /^ */.exec(l)[0].length < indent) break; body.push(l.slice(indent)); }
  return body.join('\n');
}
const selector = runBlock("name: does the image's start-up depend on a changed file");
const gate = runBlock('name: the image smoke passed, or no change owed one');
check('both scripts are found in ci.yml', selector.includes('git diff') && gate.includes('test "$INPUTS" = success'));

const bash = (script, cwd, env) => spawnSync('bash', ['-e', '-c', script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
if (process.platform === 'win32' || spawnSync('bash', ['-c', 'git --version']).status !== 0) {
  out('  skip: the workflow scripts need a POSIX bash and git');
} else {
  const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...id } });
  const put = (root, f, text) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
  // A base repository with every image input, cloned as the PR checkout; `change` edits the clone
  // and commits. Returns what the selector wrote to GITHUB_OUTPUT and its exit status.
  const select = (change, { event = 'pull_request', baseSha } = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'docker-inputs-'));
    const base = join(d, 'base');
    mkdirSync(base);
    git(base, 'init', '-q', '-b', 'master');
    for (const f of ['Dockerfile', 'docker-entrypoint.sh', '.dockerignore', 'package-lock.json', 'src/cli.ts', 'README.md']) put(base, f, `${f}\n`);
    git(base, 'add', '-A');
    git(base, 'commit', '-qm', 'base');
    const sha = git(base, 'rev-parse', 'HEAD').stdout.trim();
    const pr = join(d, 'pr');
    git(d, 'clone', '-q', base, pr);
    change(pr);
    git(pr, 'add', '-A');
    git(pr, 'commit', '-qm', 'change', '--allow-empty');
    const output = join(d, 'output');
    writeFileSync(output, '');
    const r = bash(selector, pr, { EVENT: event, BASE_SHA: baseSha ?? sha, GITHUB_OUTPUT: output });
    const changed = /changed=(\w+)/.exec(readFileSync(output, 'utf8'))?.[1] ?? null;
    rmSync(d, { recursive: true, force: true });
    return { changed, status: r.status, log: r.stdout + r.stderr };
  };

  const owed = (name, change) => { const r = select(change); check(name, r.status === 0 && r.changed === 'true', JSON.stringify(r)); };
  owed('a changed Dockerfile owes the smoke', (p) => put(p, 'Dockerfile', 'FROM x\n'));
  owed('a changed entrypoint owes the smoke', (p) => put(p, 'docker-entrypoint.sh', 'exec "$@"\n'));
  owed('an added Dockerfile.dockerignore owes the smoke', (p) => put(p, 'Dockerfile.dockerignore', 'dist\n'));
  owed('a deleted .dockerignore owes the smoke', (p) => unlinkSync(join(p, '.dockerignore')));
  owed('a renamed entrypoint owes the smoke', (p) => { mkdirSync(join(p, 'scripts')); renameSync(join(p, 'docker-entrypoint.sh'), join(p, 'scripts', 'entry.sh')); });
  owed('a changed lockfile owes the smoke', (p) => put(p, 'package-lock.json', '{"lockfileVersion":3}\n'));
  owed('a change to ci.yml owes the smoke', (p) => put(p, '.github/workflows/ci.yml', 'name: CI\n'));
  {
    const r = select((p) => { put(p, 'src/cli.ts', 'export {};\n'); put(p, 'README.md', 'docs\n'); });
    check('source and docs changes alone owe no smoke', r.status === 0 && r.changed === 'false', JSON.stringify(r));
  }
  {
    const r = select(() => {}, { event: 'push' });
    check('a push always owes the smoke', r.status === 0 && r.changed === 'true', JSON.stringify(r));
  }
  {
    const r = select((p) => put(p, 'src/cli.ts', 'x\n'), { baseSha: 'f'.repeat(40) });
    check('a base the selector cannot fetch fails the step, deciding nothing', r.status !== 0 && r.changed === null, JSON.stringify(r));
  }

  // The gate, against each outcome of docker-inputs and docker-image-smoke.
  const passes = (inputs, changed, smoke) => bash(gate, tmpdir(), { INPUTS: inputs, CHANGED: changed, SMOKE: smoke }).status === 0;
  check('no smoke owed and none run: passes', passes('success', 'false', 'skipped'));
  check('smoke owed and passed: passes', passes('success', 'true', 'success'));
  for (const smoke of ['failure', 'cancelled', 'skipped']) check(`smoke owed and ${smoke}: fails`, !passes('success', 'true', smoke));
  for (const inputs of ['failure', 'cancelled', 'skipped']) check(`input detection ${inputs}: fails`, !passes(inputs, '', 'skipped'));
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

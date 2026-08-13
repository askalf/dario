#!/usr/bin/env node
// Tests for scripts/version-advances.sh — the rule deciding whether a bot PR
// may be armed for auto-merge.
//
// Worth testing rather than living in a YAML `run:` block for the same reason
// health-verdict.sh was extracted: both failure directions are quiet. Too
// permissive and it silently re-admits the #954/#955 collision, whose visible
// symptom is a release that fast-exits GREEN having shipped nothing. Too
// strict and every routine drift PR stops arming, which looks like the bots
// went idle rather than like a gate misfiring. Neither shows up as a red run.
//
// The gate's permissive direction was confirmed live on #960 (5.5.11 ->
// 5.5.12, armed). The blocking direction needs two bot PRs colliding on a
// version, which the gate now prevents from happening — so it is only ever
// exercised here.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'version-advances.sh');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

/** Run the gate over three versions, return { safe, reason }. */
function gate(base, head, tip) {
  const r = spawnSync('sh', [SCRIPT, base, head, tip], { encoding: 'utf8' });
  if (r.error) {
    console.log(`  SKIP — no POSIX sh available: ${r.error.message}`);
    process.exit(0);
  }
  const [safe, reason] = (r.stdout ?? '').split('\n');
  return { safe, reason, status: r.status };
}

header('version unchanged by the PR');
{
  // The common Dependabot action bump: package.json is untouched, so the
  // ordering hazard does not exist and the gate must not block it.
  const g = gate('5.5.11', '5.5.11', '5.5.11');
  check('arms when head == base', g.safe === 'true', g.reason);
  check('says why', /does not change the version/.test(g.reason), g.reason);

  // Untouched version while the tip has moved on is still safe: the PR is
  // behind, but merging it cannot move the version anywhere.
  const behind = gate('5.5.9', '5.5.9', '5.5.12');
  check('arms when head == base even if tip advanced', behind.safe === 'true', behind.reason);
}

header('version bumped by the PR');
{
  const ok = gate('5.5.11', '5.5.12', '5.5.11');
  check('arms when it advances past the tip', ok.safe === 'true', ok.reason);
  check('names both versions', /5\.5\.11 -> 5\.5\.12/.test(ok.reason), ok.reason);

  // The #954/#955 shape: another PR already claimed this version. Merging
  // would hit the duplicate-tag guard and ship nothing.
  const dup = gate('5.5.9', '5.5.10', '5.5.10');
  check('blocks when equal to the tip', dup.safe === 'false', dup.reason);
  check('explains the collision', /already at 5\.5\.10/.test(dup.reason), dup.reason);

  // Would move the base branch below an already-published tag.
  const back = gate('5.5.9', '5.5.10', '5.5.11');
  check('blocks when below the tip', back.safe === 'false', back.reason);
}

header('semver ordering, not string ordering');
{
  // The case a lexical compare gets backwards: "5.5.99" > "5.6.0" as strings.
  const lex = gate('5.5.98', '5.5.99', '5.6.0');
  check('blocks 5.5.99 against a 5.6.0 tip', lex.safe === 'false', lex.reason);

  const minor = gate('5.5.12', '5.6.0', '5.5.12');
  check('arms a minor bump past a patch tip', minor.safe === 'true', minor.reason);

  // Double-digit patch vs single-digit: 5.5.9 -> 5.5.10 is an advance.
  const twoDigit = gate('5.5.8', '5.5.10', '5.5.9');
  check('arms 5.5.10 against a 5.5.9 tip', twoDigit.safe === 'true', twoDigit.reason);
}

header('fails closed on unreadable input');
{
  for (const [label, args] of [
    ['missing tip', ['5.5.11', '5.5.12', '']],
    ['missing head', ['5.5.11', '', '5.5.11']],
    ['missing base', ['', '5.5.12', '5.5.11']],
    ['all missing', ['', '', '']],
  ]) {
    const g = gate(...args);
    check(`blocks on ${label}`, g.safe === 'false', g.reason);
  }
  const g = gate('', '', '');
  check('exits 0 so the caller reads the verdict', g.status === 0, `status=${g.status}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

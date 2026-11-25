#!/usr/bin/env node
// Two decisions drift-pr-heal.yml takes from data, kept here so they can be tested.
//
//   busy   Is Redline at work on this PR's head? A heal pushes a new head. A review queued or
//          running for the old one is thrown away (Redline drops a review whose head moved), and a
//          fix run pushes onto a branch that moved under it. So the heal skips the PR, and the next
//          run tries again.
//   floor  The floor to pass renumber-release-version.mjs so that the version it leaves is held
//          by no other open drift PR. Every open drift PR holds the version on its branch whatever
//          its state (up to date, a draft, waiting on Redline), so a renumber steps over all of
//          them, not only over the PRs healed earlier in the same run.
//
// CLI. The workflow copies this file and _drift-patch-helpers.mjs out of the checkout before its
// loop, since each candidate branch is checked out in turn and may predate them.
//
//   node drift-heal-plan.mjs busy <owner/repo> <pr> <head-sha> <runs.json>
//        Prints why Redline is at work on that head, or nothing. runs.json is the list of
//        Redline's queued and running runs (see busyReason), or null when it could not be read.
//   node drift-heal-plan.mjs floor <floor> <own-version> <held.json>
//        Prints the floor to pass renumber-release-version.mjs. held.json is the list of the
//        versions the other open drift PRs hold.
//
// Exit 0 with the answer on stdout; exit 2 on bad arguments or unreadable input, which the
// workflow's `set -e` turns into a failed run rather than a guess.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bumpPatch } from './_drift-patch-helpers.mjs';

/** The workflows whose queued or running runs hold a PR's head. */
export const REDLINE_WORKFLOWS = ['redline.yml', 'redline-fix.yml', 'redline-post.yml'];

const VERSION = /^\d+\.\d+\.\d+$/;

/** -1, 0 or 1 for two x.y.z versions, by number. Throws on anything else. */
export function compareVersions(a, b) {
  for (const v of [a, b]) if (!VERSION.test(String(v))) throw new Error(`not an x.y.z version: ${v}`);
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Why Redline is at work on `headSha`, the head of PR `pr` in `repo` (owner/name), or '' when it
 * is not. `runs` are the queued and running runs of REDLINE_WORKFLOWS, each
 * { workflow, id, event, status, display_title, head_sha }. null (the runs could not be listed)
 * counts as busy.
 *
 *   - A verdict post (redline-post.yml) runs on workflow_run, at the default branch's head, so
 *     nothing in it names a PR. Any one queued or running holds every PR.
 *   - A dispatched review or fix (workflow_dispatch) names its PR and head in the run-name its
 *     workflow sets: `Redline review <repo>#<pr> @ <head>`, with ` (re-read)` on a re-read, and
 *     `Redline fix <repo>#<pr> @ <head>`. It holds the PR when it names this PR and this head
 *     (a short head names it by prefix).
 *   - A review on pull_request carries the PR's own title as its name, which any author writes,
 *     so its title says nothing. It holds the PR when its head commit is this head.
 * A run for an older head of the PR does not hold it: Redline drops that review either way.
 */
export function busyReason(repo, pr, headSha, runs) {
  if (!Array.isArray(runs)) return 'the Redline runs could not be listed';
  const head = String(headSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return `the head ${head} is not a commit id`;
  const named = new RegExp(`^Redline (review|fix) ${escapeRegExp(String(repo))}#${Number(pr)} @ ([0-9a-f]{7,40})( \\(re-read\\))?$`);
  for (const r of runs) {
    if (!r || r.status === 'completed') continue;
    const what = `${r.workflow} run ${r.id} (${r.status})`;
    if (r.workflow === 'redline-post.yml') return `${what} is posting a verdict`;
    if (r.event === 'workflow_dispatch') {
      const m = named.exec(String(r.display_title ?? ''));
      if (!m) continue;
      const kind = m[1];
      const fits = (r.workflow === 'redline.yml' && kind === 'review') || (r.workflow === 'redline-fix.yml' && kind === 'fix' && !m[3]);
      if (fits && head.startsWith(m[2])) return `${what} is ${kind === 'fix' ? 'fixing' : 'reviewing'} this head`;
      continue;
    }
    if (r.event === 'pull_request' && r.workflow === 'redline.yml' && String(r.head_sha ?? '').toLowerCase() === head) {
      return `${what} is reviewing this head`;
    }
  }
  return '';
}

/**
 * The floor to pass renumber-release-version.mjs for a PR whose branch holds `own`, so that the
 * version it leaves is above `floor` and is none of `held` (the versions the other open drift PRs
 * hold). renumber keeps a version above its floor and sets any other to bumpPatch(floor), so:
 * a version above the floor that no other PR holds keeps the floor as it is; otherwise the floor
 * rises (to `own` when `own` is above it but taken) until bumpPatch of it is free.
 */
export function pickFloor(floor, own, held) {
  for (const v of [floor, own, ...held]) if (!VERSION.test(String(v))) throw new Error(`not an x.y.z version: ${v}`);
  const taken = new Set(held);
  const above = compareVersions(own, floor) > 0;
  if (above && !taken.has(own)) return floor;
  let f = above ? own : floor;
  while (taken.has(bumpPatch(f))) f = bumpPatch(f);
  return f;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function main(argv, out = (s) => process.stdout.write(s)) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'busy' && args.length === 4) {
      const [repo, pr, head, runsPath] = args;
      if (!/^[1-9]\d*$/.test(pr)) throw new Error(`not a PR number: ${pr}`);
      const reason = busyReason(repo, Number(pr), head, readJson(runsPath));
      if (reason) out(`${reason}\n`);
      return 0;
    }
    if (cmd === 'floor' && args.length === 3) {
      const [floor, own, heldPath] = args;
      const held = readJson(heldPath);
      if (!Array.isArray(held)) throw new Error('held.json is not a list');
      out(`${pickFloor(floor, own, held)}\n`);
      return 0;
    }
    process.stderr.write('usage: drift-heal-plan.mjs busy <owner/repo> <pr> <head-sha> <runs.json> | floor <floor> <own-version> <held.json>\n');
    return 2;
  } catch (err) {
    process.stderr.write(`drift-heal-plan: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main(process.argv.slice(2)));

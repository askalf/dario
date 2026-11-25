#!/usr/bin/env node
// Decisions drift-pr-heal.yml takes from data, kept here so they can be tested.
//
//   busy     Is Redline at work on this PR's head? A heal pushes a new head. A review queued or
//            running for the old one is thrown away (Redline drops a review whose head moved), and
//            a finished fix run's commits are dropped too: the platform's fix dispatcher applies
//            them onto the head the run read, after the run, and refuses when the branch moved. So
//            the heal skips the PR, and the next run tries again.
//   floor    The floor to pass renumber-release-version.mjs so that the version it leaves is held
//            by no other open drift PR. Every open drift PR holds the version on its branch whatever
//            its state (up to date, a draft, waiting on Redline), so a renumber avoids all of them,
//            not only the PRs healed earlier in the same run. It takes the lowest free version above
//            the floor, not one above the highest held.
//   changed  Has the set of open drift PRs, or a head among them, changed since the plan? The
//            versions the floor steps over were read from that set, so a push waits for a new plan.
//
// What this cannot see: a review that starts, or a sibling branch that moves, in the moments
// between the workflow's last check and its push. Redline then drops that review and reads the
// new head, one round later. A sibling that moved onto the pushed version keeps it until one of
// the two becomes a candidate again (conflicting or behind its base), when a later run
// renumbers it; while both stay up to date, the version gate refuses the second to merge.
//
// CLI. The workflow copies this file and _drift-patch-helpers.mjs out of the checkout before its
// loop, since each candidate branch is checked out in turn and may predate them.
//
//   node drift-heal-plan.mjs busy <owner/repo> <pr> <head-sha> <runs.json> <comments.json>
//        Prints why Redline is at work on that head, or nothing. runs.json is Redline's runs (see
//        busyReason), or null when they could not be listed; comments.json askalf's comments on
//        the PR as { line, at } (first line, created_at), or null when they could not be read.
//   node drift-heal-plan.mjs floor <floor> <own-version> <held.json>
//        Prints the floor to pass renumber-release-version.mjs. held.json is the list of the
//        versions the other open drift PRs hold.
//   node drift-heal-plan.mjs changed <expected.json> <drift.json>
//        Prints what changed, or nothing. expected.json maps each planned PR number to the heads
//        it may show now; drift.json is the open drift PRs as listed now.
//
// Exit 0 with the answer on stdout; exit 2 on bad arguments or unreadable input, which the
// workflow's `set -e` turns into a failed run rather than a guess.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bumpPatch } from './_drift-patch-helpers.mjs';

/** The workflows whose runs hold a PR's head. */
export const REDLINE_WORKFLOWS = ['redline.yml', 'redline-fix.yml', 'redline-post.yml'];
/** The run statuses GitHub gives a run that has not finished. */
export const ACTIVE_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
/**
 * How long after a fix run finishes its result is waited for: the platform's fix dispatcher
 * applies or refuses the fix on a later pass, minutes after the run. Past this the head is free
 * again, so a dispatcher that never answers does not hold a PR for good.
 */
export const FIX_RESULT_WAIT_MS = 6 * 3_600_000;
/** The comment headings the platform's fix dispatcher posts when it answers a fix run without moving the head. */
const FIX_RESULT_AT_HEAD = /^## (?:Fix not applied at|Fix refused at|Description updated at) ([0-9a-f]{40})\b/;

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
 * is not. `runs` are runs of REDLINE_WORKFLOWS, each
 * { workflow, id, event, status, conclusion, display_title, head_sha, updated_at }: every one not
 * finished, and every fix run at this head. null (they could not be listed) counts as busy.
 * `comments` are askalf's comments on the PR as { line, at }: the first line and when it was
 * posted (null: they could not be read).
 *
 *   - A verdict post (redline-post.yml) runs on workflow_run, at the default branch's head, so
 *     nothing in it names a PR. Any one not finished holds every PR.
 *   - A dispatched review or fix (workflow_dispatch) names its PR and head in the run-name its
 *     workflow sets: `Redline review <repo>#<pr> @ <head>`, with ` (re-read)` on a re-read, and
 *     `Redline fix <repo>#<pr> @ <head>`. One not finished holds the PR when it names this PR and
 *     this head (a short head names it by prefix).
 *   - A fix run that finished at this head (its own head commit is this head: the platform's fix
 *     dispatcher applies only such runs, listing them by head_sha, so a run dispatched from
 *     another ref has nothing it will apply here) still holds it until the platform answers it without
 *     moving the head: a comment `## Fix not applied at <head>`, `## Fix refused at <head>` or
 *     `## Description updated at <head>` posted after the run's latest attempt finished, so the
 *     answer to an earlier run at the same head does not release a retry there, and each finished
 *     run needs an answer of its own: one comment does not answer two runs. (The platform posts
 *     one comment per heading, so a retry refused the same way gets no new one, and holds the head
 *     until the wait ends.) A fix that was applied moved the head, so its run names an
 *     older one. A cancelled or skipped run has nothing to apply, and past FIX_RESULT_WAIT_MS from
 *     the latest attempt's finish the head is free again.
 *   - A review on pull_request carries the PR's own title as its name, which any author writes,
 *     so its title says nothing. One not finished holds the PR when its head commit is this head.
 * A run for an older head of the PR does not hold it: Redline drops that review either way.
 */
export function busyReason(repo, pr, headSha, runs, comments = [], now = Date.now()) {
  if (!Array.isArray(runs)) return 'the Redline runs could not be listed';
  const head = String(headSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return `the head ${head} is not a commit id`;
  const named = new RegExp(`^Redline (review|fix) ${escapeRegExp(String(repo))}#${Number(pr)} @ ([0-9a-f]{7,40})( \\(re-read\\))?$`);
  const namesThisHead = (r, kind) => {
    const m = named.exec(String(r.display_title ?? ''));
    return m !== null && m[1] === kind && !(kind === 'fix' && m[3]) && head.startsWith(m[2]);
  };
  const finished = [];
  for (const r of runs) {
    if (!r) continue;
    const what = `${r.workflow} run ${r.id} (${r.status})`;
    if (r.status === 'completed') {
      if (r.workflow !== 'redline-fix.yml' || r.event !== 'workflow_dispatch' || !namesThisHead(r, 'fix')) continue;
      if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
      if (String(r.head_sha ?? '').toLowerCase() !== head) continue;
      const at = Date.parse(String(r.updated_at ?? ''));
      if (Number.isFinite(at) && now - at >= FIX_RESULT_WAIT_MS) continue;
      finished.push({ what, at });
      continue;
    }
    if (r.workflow === 'redline-post.yml') return `${what} is posting a verdict`;
    if (r.event === 'workflow_dispatch') {
      if (r.workflow === 'redline.yml' && namesThisHead(r, 'review')) return `${what} is reviewing this head`;
      if (r.workflow === 'redline-fix.yml' && namesThisHead(r, 'fix')) return `${what} is fixing this head`;
      continue;
    }
    if (r.event === 'pull_request' && r.workflow === 'redline.yml' && String(r.head_sha ?? '').toLowerCase() === head) {
      return `${what} is reviewing this head`;
    }
  }
  if (finished.length === 0) return '';
  if (!Array.isArray(comments)) return `${finished[0].what} finished, and the PR's comments could not be read to see whether its fix was answered`;
  const unreadable = finished.find((f) => !Number.isFinite(f.at));
  if (unreadable) return `${unreadable.what} finished, and when it finished cannot be read`;
  // Each finished run, earliest first, takes the earliest answer posted after it finished that no
  // earlier run took. A run left without one is not answered yet.
  const answers = comments
    .filter((c) => FIX_RESULT_AT_HEAD.exec(String(c?.line ?? ''))?.[1] === head)
    .map((c) => Date.parse(String(c?.at ?? '')))
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  let next = 0;
  for (const f of [...finished].sort((x, y) => x.at - y.at)) {
    while (next < answers.length && answers[next] < f.at) next++;
    if (next >= answers.length) return `${f.what} finished, and its fix is not yet applied or refused at this head`;
    next++;
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

/**
 * What changed between the plan and the open drift PRs as listed now, or '' when nothing did.
 * `expected` maps each planned PR number to the heads it may show now (its planned head, and for a
 * PR this run pushed, the pushed head too: the list can lag a push); `drift` is the list, each
 * { number, headRefOid }. A PR opened or closed since, or a head that is none of its expected ones,
 * is a change.
 */
export function planChange(expected, drift) {
  const now = new Map();
  for (const p of drift) now.set(String(p.number), String(p.headRefOid ?? ''));
  for (const [n, heads] of Object.entries(expected)) {
    if (!now.has(n)) return `#${n} is no longer open`;
    if (!heads.includes(now.get(n))) return `#${n} moved to ${now.get(n).slice(0, 7)}`;
  }
  for (const n of now.keys()) if (!(n in expected)) return `#${n} was opened`;
  return '';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function main(argv, out = (s) => process.stdout.write(s), now = Date.now()) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'busy' && args.length === 5) {
      const [repo, pr, head, runsPath, commentsPath] = args;
      if (!/^[1-9]\d*$/.test(pr)) throw new Error(`not a PR number: ${pr}`);
      const reason = busyReason(repo, Number(pr), head, readJson(runsPath), readJson(commentsPath), now);
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
    if (cmd === 'changed' && args.length === 2) {
      const expected = readJson(args[0]);
      const drift = readJson(args[1]);
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !Array.isArray(drift)) throw new Error('expected.json is not a map or drift.json is not a list');
      for (const heads of Object.values(expected)) if (!Array.isArray(heads)) throw new Error('expected.json maps a PR to something other than a list of heads');
      const change = planChange(expected, drift);
      if (change) out(`${change}\n`);
      return 0;
    }
    process.stderr.write('usage: drift-heal-plan.mjs busy <owner/repo> <pr> <head-sha> <runs.json> <comments.json> | floor <floor> <own-version> <held.json> | changed <expected.json> <drift.json>\n');
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

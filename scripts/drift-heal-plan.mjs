#!/usr/bin/env node
// Decisions drift-pr-heal.yml takes from data, kept here so they can be tested.
//
//   check    Is Redline at work on this PR's head? A heal pushes a new head. A review queued or
//            running for the old one is thrown away (Redline drops a review whose head moved), and
//            a finished fix run's commits are dropped too: the platform's fix dispatcher applies
//            them onto the head the run read, after the run, and refuses when the branch moved. So
//            the heal skips the PR, and the next run tries again. This reads Redline's runs itself
//            (gh api, with the job's own token), so no list passes through the shell.
//   floor    The floor to pass renumber-release-version.mjs so that the version it leaves is held
//            by no other open drift PR. Every open drift PR holds the version on its branch whatever
//            its state (up to date, a draft, waiting on Redline), so a renumber avoids all of them,
//            not only the PRs healed earlier in the same run. It takes the first free version above
//            the floor, or, when the PR's own version is above the floor but held by another, the
//            first free one above that version.
//   changed  Has the set of open drift PRs, or a head among them, changed since the plan, or has the
//            PR about to be pushed become a draft or moved to another base? The versions the floor
//            avoids were read from that set, so a push waits for a new plan.
//
// What this cannot see: a review or fix that starts after the query that would have listed it, and
// a sibling branch that moves after the workflow's last read of origin, in the moments before the
// push. Redline then drops that review and reads the new head, one round later. A sibling that
// moved onto the pushed version keeps it until one of the two becomes a candidate again
// (conflicting or behind its base), when a later run renumbers it; while both stay up to date, the
// version gate refuses to arm the second.
//
// CLI. The workflow copies this file and _drift-patch-helpers.mjs out of the checkout before its
// loop, since each candidate branch is checked out in turn and may predate them.
//
//   node drift-heal-plan.mjs check <owner/repo> <pr> <head-sha>
//        Reads Redline's runs (as RUNS_TOKEN when set) and prints why Redline is at work on that
//        head, or nothing.
//   node drift-heal-plan.mjs busy <owner/repo> <pr> <head-sha> <runs.json>
//        The same decision from a list of runs already read (null: they could not be read).
//   node drift-heal-plan.mjs floor <floor> <own-version> <held.json>
//        Prints the floor to pass renumber-release-version.mjs. held.json is the list of the
//        versions the other open drift PRs hold.
//   node drift-heal-plan.mjs changed <expected.json> <drift.json> [<pr> <base>]
//        Prints what changed, or nothing. expected.json maps each planned PR number to the heads
//        it may show now; drift.json is the open drift PRs as listed now; <pr> and <base> name the
//        PR about to be pushed and the base it was healed onto.
//
// Exit 0 with the answer on stdout; exit 2 on bad arguments or unreadable input, which the
// workflow's `set -e` turns into a failed run rather than a guess.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bumpPatch } from './_drift-patch-helpers.mjs';

/** The workflows whose runs hold a PR's head. */
export const REDLINE_WORKFLOWS = ['redline.yml', 'redline-fix.yml', 'redline-post.yml'];
/** The run statuses GitHub gives a run that has not finished, in the order a run passes them. */
export const ACTIVE_STATUSES = ['requested', 'pending', 'waiting', 'queued', 'in_progress'];
/**
 * How long a fix run that finished at a head holds it, from its latest attempt's finish. The
 * platform's fix dispatcher applies or refuses the fix on a later pass, minutes after the run; an
 * applied fix moves the head, so only a fix it refused, or has not reached yet, leaves a finished run
 * at the head. The hold does not read the dispatcher's answer: it lasts the whole wait, so a refused
 * fix delays that PR's heal by up to this long, and a dispatcher that never answers does not hold a
 * PR for good.
 */
export const FIX_RESULT_WAIT_MS = 6 * 3_600_000;
/** The most pages of 100 one list is read to; a list that does not end within them counts as unread. */
export const MAX_PAGES = 10;

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
 * One list of a workflow's runs, every page, as { workflow, id, event, status, conclusion,
 * display_title, head_sha, updated_at } each, or null when it could not be read in full: a page
 * that failed or was not a run list, a list that does not end within MAX_PAGES pages, pages that
 * do not add up to the total the first page gave, or a run id twice. `get(path)` answers the
 * parsed JSON of one GitHub API path, or throws; a throw is noted on stderr for the run's log.
 */
export function readRunList(get, repo, workflow, query) {
  const rows = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try {
      data = get(`repos/${repo}/actions/workflows/${workflow}/runs?${query}&per_page=100&page=${page}`);
    } catch (err) {
      const why = String(err?.stderr || err?.message || err).trim().split('\n')[0];
      process.stderr.write(`drift-heal-plan: ${workflow} runs (${query}) page ${page} could not be read: ${why}\n`);
      return null;
    }
    if (page === 1) {
      total = data?.total_count;
      if (!Number.isInteger(total) || total < 0) return null;
    }
    const list = data?.workflow_runs;
    if (!Array.isArray(list)) return null;
    for (const r of list) {
      rows.push({
        workflow, id: r?.id, event: r?.event, status: r?.status, conclusion: r?.conclusion ?? null,
        display_title: r?.display_title ?? '', head_sha: r?.head_sha ?? '', updated_at: r?.updated_at ?? null,
      });
    }
    if (list.length < 100) {
      if (rows.length !== total || new Set(rows.map((r) => r.id)).size !== rows.length) return null;
      return rows;
    }
  }
  return null;
}

/** Every run of REDLINE_WORKFLOWS that has not finished, by each ACTIVE_STATUSES status: one complete scan, or null. */
export function scanActive(get, repo) {
  const out = [];
  for (const workflow of REDLINE_WORKFLOWS) {
    for (const status of ACTIVE_STATUSES) {
      const rows = readRunList(get, repo, workflow, `status=${status}`);
      if (rows === null) return null;
      out.push(...rows);
    }
  }
  return out;
}

const shape = (rows) => JSON.stringify(rows.map((r) => JSON.stringify([r.workflow, r.id, r.status, r.status === 'completed' ? r.updated_at : null])).sort());

/**
 * `read()` twice, each a complete read: the first answer when both hold the same runs with the same
 * status (and, for a finished run, the same finish), else null. A run that changed status, left or
 * joined a list between two queries of the first read shows as a difference in the second.
 */
export function readTwice(read) {
  const first = read();
  if (first === null) return null;
  const second = read();
  if (second === null || shape(first) !== shape(second)) return null;
  return first;
}

/**
 * Redline's runs for one head: every unfinished run of the three workflows, and every fix run
 * dispatched at `head` (the list the platform's fix dispatcher itself reads: event workflow_dispatch,
 * head_sha the PR head, so a run it would apply is here however old, and one dispatched from another
 * ref is one it never applies). Each read twice in full; null when either could not be.
 */
export function redlineRuns(get, repo, head) {
  const active = readTwice(() => scanActive(get, repo));
  if (active === null) return null;
  const fixes = readTwice(() => readRunList(get, repo, 'redline-fix.yml', `event=workflow_dispatch&head_sha=${head}`));
  if (fixes === null) return null;
  return [...active, ...fixes];
}

/**
 * Why Redline is at work on `headSha`, the head of PR `pr` in `repo` (owner/name), or '' when it
 * is not. `runs` is redlineRuns' answer; null (they could not be read) counts as busy.
 *
 *   - A verdict post (redline-post.yml) runs on workflow_run, at the default branch's head, so
 *     nothing in it names a PR. Any one not finished holds every PR.
 *   - A dispatched review or fix (workflow_dispatch) names its PR and head in the run-name its
 *     workflow sets: `Redline review <repo>#<pr> @ <head>`, with ` (re-read)` on a re-read, and
 *     `Redline fix <repo>#<pr> @ <head>`. One not finished holds the PR when it names this PR and
 *     this head (a short head names it by prefix).
 *   - A fix run that finished, names this PR and head, and was dispatched at this head holds it for
 *     FIX_RESULT_WAIT_MS after its latest attempt finished, whatever its conclusion but cancelled
 *     or skipped (nothing to apply). A finish time that cannot be read holds it.
 *   - A review on pull_request carries the PR's own title as its name, which any author writes,
 *     so its title says nothing. One not finished holds the PR when its head commit is this head.
 * A run for an older head of the PR does not hold it: Redline drops that review either way.
 */
export function busyReason(repo, pr, headSha, runs, now = Date.now()) {
  if (!Array.isArray(runs)) return 'the Redline runs could not be listed';
  const head = String(headSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return `the head ${head} is not a commit id`;
  const named = new RegExp(`^Redline (review|fix) ${escapeRegExp(String(repo))}#${Number(pr)} @ ([0-9a-f]{7,40})( \\(re-read\\))?$`);
  const namesThisHead = (r, kind) => {
    const m = named.exec(String(r.display_title ?? ''));
    return m !== null && m[1] === kind && !(kind === 'fix' && m[3]) && head.startsWith(m[2]);
  };
  for (const r of runs) {
    if (!r) continue;
    const what = `${r.workflow} run ${r.id} (${r.status})`;
    if (r.status === 'completed') {
      if (r.workflow !== 'redline-fix.yml' || r.event !== 'workflow_dispatch' || !namesThisHead(r, 'fix')) continue;
      if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
      if (String(r.head_sha ?? '').toLowerCase() !== head) continue;
      const finished = Date.parse(String(r.updated_at ?? ''));
      if (!Number.isFinite(finished)) return `${what} finished at a time that cannot be read`;
      if (now - finished < FIX_RESULT_WAIT_MS) {
        return `${what} finished at ${new Date(finished).toISOString()}; its fix is waited for until ${new Date(finished + FIX_RESULT_WAIT_MS).toISOString()}`;
      }
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
 * { number, headRefOid, isDraft, baseRefName }. A PR opened or closed since, or a head that is none
 * of its expected ones, is a change. So is `candidate` ({ number, base }, the PR about to be pushed)
 * now listed as a draft, or with another base: neither moves its branch.
 */
export function planChange(expected, drift, candidate = null) {
  const now = new Map();
  for (const p of drift) now.set(String(p.number), p);
  for (const [n, heads] of Object.entries(expected)) {
    if (!now.has(n)) return `#${n} is no longer open`;
    const oid = String(now.get(n).headRefOid ?? '');
    if (!heads.includes(oid)) return `#${n} moved to ${oid.slice(0, 7)}`;
  }
  for (const n of now.keys()) if (!(n in expected)) return `#${n} was opened`;
  if (candidate) {
    const p = now.get(String(candidate.number));
    if (!p) return `#${candidate.number} is no longer open`;
    if (p.isDraft !== false) return `#${candidate.number} is now a draft`;
    if (String(p.baseRefName ?? '') !== String(candidate.base)) return `#${candidate.number} now targets ${p.baseRefName}`;
  }
  return '';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** One GitHub API path through gh, as RUNS_TOKEN when it is set: the parsed answer, or a throw. */
export function ghGet(path) {
  const env = { ...process.env };
  if (process.env.RUNS_TOKEN) env.GH_TOKEN = process.env.RUNS_TOKEN;
  const out = execFileSync('gh', ['api', path], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

export function main(argv, out = (s) => process.stdout.write(s), now = Date.now(), get = ghGet) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'check' && args.length === 3) {
      const [repo, pr, head] = args;
      if (!/^[1-9]\d*$/.test(pr)) throw new Error(`not a PR number: ${pr}`);
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`not owner/repo: ${repo}`);
      const reason = busyReason(repo, Number(pr), head, /^[0-9a-f]{40}$/i.test(head) ? redlineRuns(get, repo, head.toLowerCase()) : [], now);
      if (reason) out(`${reason}\n`);
      return 0;
    }
    if (cmd === 'busy' && args.length === 4) {
      const [repo, pr, head, runsPath] = args;
      if (!/^[1-9]\d*$/.test(pr)) throw new Error(`not a PR number: ${pr}`);
      const reason = busyReason(repo, Number(pr), head, readJson(runsPath), now);
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
    if (cmd === 'changed' && (args.length === 2 || args.length === 4)) {
      const expected = readJson(args[0]);
      const drift = readJson(args[1]);
      if (args.length === 4 && !/^[1-9]\d*$/.test(args[2])) throw new Error(`not a PR number: ${args[2]}`);
      const candidate = args.length === 4 ? { number: Number(args[2]), base: args[3] } : null;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !Array.isArray(drift)) throw new Error('expected.json is not a map or drift.json is not a list');
      for (const heads of Object.values(expected)) if (!Array.isArray(heads)) throw new Error('expected.json maps a PR to something other than a list of heads');
      const change = planChange(expected, drift, candidate);
      if (change) out(`${change}\n`);
      return 0;
    }
    process.stderr.write('usage: drift-heal-plan.mjs check <owner/repo> <pr> <head-sha> | busy <owner/repo> <pr> <head-sha> <runs.json> | floor <floor> <own-version> <held.json> | changed <expected.json> <drift.json> [<pr> <base>]\n');
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

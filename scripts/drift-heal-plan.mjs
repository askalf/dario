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
//   refs     Has any drift branch on origin changed since the plan: moved, appeared or gone? A new
//            branch is a drift PR about to open, at a version the plan did not see.
//
// What this cannot see: a review or fix that starts after the last query that would have listed it,
// a drift PR opened after the workflow's last read of the PR list, and a drift branch pushed or
// moved after its last read of origin, in the moments before the push. Redline then drops that
// review and reads the new head, one round later. A sibling that took the pushed version keeps it
// until one of the two becomes a candidate again (conflicting or behind its base), when a later run
// renumbers it; while both stay up to date, the version gate refuses to arm the second.
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
//   node drift-heal-plan.mjs refs <baseline.txt> <now.txt> <planned.json>
//        Prints the first drift branch that changed, or nothing. The two .txt files are
//        `git ls-remote --heads origin` as the plan read it and as it reads now; planned.json
//        maps each planned PR's branch to the head origin must show for it now.
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
/** The branch names of the drift bots' PRs, the filter drift-pr-heal.yml lists them by. */
export const DRIFT_PREFIXES = ['bot/cc-drift-', 'bot/template-label-', 'bot/template-rebake-'];
const RUN_STATUSES = [...ACTIVE_STATUSES, 'completed'];

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
 * One run as a list gives it, with what classifying it needs: a positive integer id, an event, a
 * known status, a run-name and a 40-hex head commit, and a conclusion that is a string or null.
 * Null for anything else, so a malformed row never reads as a run that holds nothing.
 */
export function runRow(r, workflow) {
  if (!r || typeof r !== 'object') return null;
  if (!Number.isSafeInteger(r.id) || r.id <= 0) return null;
  if (typeof r.event !== 'string' || r.event === '' || !RUN_STATUSES.includes(r.status)) return null;
  if (typeof r.display_title !== 'string' || typeof r.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(r.head_sha)) return null;
  if (r.conclusion !== undefined && r.conclusion !== null && typeof r.conclusion !== 'string') return null;
  return {
    workflow, id: r.id, event: r.event, status: r.status, conclusion: r.conclusion ?? null,
    display_title: r.display_title, head_sha: r.head_sha.toLowerCase(), updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
  };
}

/**
 * One list of a workflow's runs, every page, as runRow gives each, or null when it could not be read
 * in full: a page that failed or was not a run list, a malformed row, a list that does not end
 * within MAX_PAGES pages, pages that do not add up to the total the first page gave, or a run id
 * twice. Each of those is noted on stderr, naming the list and page, for the run's log. `get(path)`
 * answers the parsed JSON of one GitHub API path, or throws.
 */
export function readRunList(get, repo, workflow, query) {
  const unread = (page, why) => {
    process.stderr.write(`drift-heal-plan: ${workflow} runs (${query}) page ${page}: ${why}\n`);
    return null;
  };
  const rows = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try {
      data = get(`repos/${repo}/actions/workflows/${workflow}/runs?${query}&per_page=100&page=${page}`);
    } catch (err) {
      return unread(page, `could not be read: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}`);
    }
    if (page === 1) {
      total = data?.total_count;
      if (!Number.isInteger(total) || total < 0) return unread(page, 'no total_count');
    }
    const list = data?.workflow_runs;
    if (!Array.isArray(list)) return unread(page, 'no workflow_runs list');
    for (const [i, r] of list.entries()) {
      const row = runRow(r, workflow);
      if (row === null) return unread(page, `row ${i + 1} is not a run that can be classified`);
      rows.push(row);
    }
    if (list.length < 100) {
      if (rows.length !== total) return unread(page, `${rows.length} runs read, the first page said ${total}`);
      if (new Set(rows.map((r) => r.id)).size !== rows.length) return unread(page, 'a run id twice');
      return rows;
    }
  }
  return unread(MAX_PAGES, `the list does not end within ${MAX_PAGES} pages`);
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

/** The drift branches in `git ls-remote --heads` output, as a Map of branch name to head. */
export function driftRefs(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/heads\/(\S+)$/.exec(line.trim());
    if (m && DRIFT_PREFIXES.some((p) => m[2].startsWith(p))) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * The first drift branch that changed on origin since the plan, or '' when none did. `baseline` and
 * `now` are `git ls-remote --heads` output as the plan read it and as it reads now; `planned` maps
 * each planned PR's branch to the head origin must show for it (the planned head, or the head this
 * run pushed: origin has a push at once). Every other drift branch must be as the baseline had it,
 * and no new one may appear.
 */
export function refsChange(baseline, now, planned) {
  const was = driftRefs(baseline);
  const is = driftRefs(now);
  const want = new Map(was);
  for (const [b, oid] of Object.entries(planned)) want.set(b, String(oid));
  for (const [b, oid] of want) {
    if (!is.has(b)) return `${b} is gone from origin`;
    if (is.get(b) !== oid) return `${b} is at ${is.get(b).slice(0, 7)} on origin, not ${oid.slice(0, 7)}`;
  }
  for (const [b, oid] of is) if (!want.has(b)) return `${b} appeared on origin at ${oid.slice(0, 7)}`;
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
    if (cmd === 'refs' && args.length === 3) {
      const planned = readJson(args[2]);
      if (!planned || typeof planned !== 'object' || Array.isArray(planned)) throw new Error('planned.json is not a map');
      const change = refsChange(readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8'), planned);
      if (change) out(`${change}\n`);
      return 0;
    }
    process.stderr.write('usage: drift-heal-plan.mjs check <owner/repo> <pr> <head-sha> | busy <owner/repo> <pr> <head-sha> <runs.json> | floor <floor> <own-version> <held.json> | changed <expected.json> <drift.json> [<pr> <base>] | refs <baseline.txt> <now.txt> <planned.json>\n');
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

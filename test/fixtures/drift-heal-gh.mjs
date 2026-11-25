// A stand-in for gh, for test/drift-heal-e2e.mjs. It answers the calls drift-pr-heal.yml's Heal step
// makes, from the fixture in HEAL_FIXTURE, and logs each call with the token it carried:
//   gh pr list ... --json ...
//        -> fixture.prs; from the second call on, fixture.prsLater when the fixture has it.
//   gh api repos/<o>/<r>/actions/workflows/<wf>/runs?status=<s>&per_page=100&page=<p>
//        -> { total_count, workflow_runs }: the fixture.runs of <wf> with that status, 100 a page.
//           A run is shown once <wf> and <s> have been listed `appearAfter` times (first pages,
//           default 1). A run with `changeAfter: { key, calls, status }` has that status once
//           `key` (`<wf>|<status>`) has been read `calls` times, any page; one with
//           `goneAfter: { key, calls }` is gone from every list from then on. A workflow named in
//           fixture.failRuns fails.
//   gh api repos/<o>/<r>/actions/workflows/<wf>/runs?event=workflow_dispatch&head_sha=<h>&per_page=100&page=<p>
//        -> the fixture.runs of <wf> dispatched at that head, any status (`<wf>|head`).
//   gh api repos/<o>/<r>/issues/<n>/comments?per_page=100&page=<p>
//        -> fixture.comments[n], 100 a page; fixture.failComments fails it.
// fixture.sideEffects run git when a list is read: { key: '<wf>|<status>', call: k, git: [...] }
// runs `git ...` on the k-th first-page read of that workflow and status (a branch moved mid-run).
// Output is written synchronously and the process ends on its own, so a long answer is never cut.
// Anything else fails, so a call the step was not expected to make shows up in the test.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.HEAL_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.HEAL_GHLOG, `${JSON.stringify({ token: process.env.GH_TOKEN, args })}\n`);
const counts = existsSync(process.env.HEAL_COUNTS) ? JSON.parse(readFileSync(process.env.HEAL_COUNTS, 'utf8')) : {};
const save = () => writeFileSync(process.env.HEAL_COUNTS, JSON.stringify(counts));
const pageOf = (rows, page) => rows.slice((page - 1) * 100, page * 100);
const answer = (data) => { writeSync(1, typeof data === 'string' ? data : JSON.stringify(data)); };
const refuse = (message) => { writeSync(2, `${message}\n`); process.exitCode = 1; };

function main() {
  if (args[0] === 'pr' && args[1] === 'list') {
    counts['pr list'] = (counts['pr list'] ?? 0) + 1;
    save();
    return answer(counts['pr list'] >= 2 && fixture.prsLater ? fixture.prsLater : fixture.prs);
  }
  const runs = args[0] === 'api'
    ? /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/?]+)\/runs\?(?:status=([a-z_]+)|event=workflow_dispatch&head_sha=([0-9a-f]{40}))&per_page=100&page=(\d+)$/.exec(args[1] ?? '')
    : null;
  if (runs) {
    const [, wf, status, headSha, pageText] = runs;
    const page = Number(pageText);
    const key = status ? `${wf}|${status}` : `${wf}|head`;
    if (page === 1) counts[key] = (counts[key] ?? 0) + 1;
    counts[`all|${key}`] = (counts[`all|${key}`] ?? 0) + 1;
    save();
    const n = counts[key] ?? 1;
    for (const e of fixture.sideEffects ?? []) {
      if (e.key === key && e.call === n && page === 1) execFileSync('git', e.git, { stdio: 'ignore' });
    }
    if ((fixture.failRuns ?? []).includes(wf)) return refuse('gh: HTTP 502');
    const statusOf = (r) => (r.changeAfter && (counts[`all|${r.changeAfter.key}`] ?? 0) >= r.changeAfter.calls ? r.changeAfter.status : r.status);
    const gone = (r) => r.goneAfter && (counts[`all|${r.goneAfter.key}`] ?? 0) >= r.goneAfter.calls;
    const shown = (fixture.runs ?? [])
      .filter((r) => !gone(r))
      .filter((r) => r.workflow === wf && (status ? statusOf(r) === status : r.event === 'workflow_dispatch' && r.head_sha === headSha))
      .filter((r) => (r.appearAfter ?? 1) <= (status ? n : Infinity))
      .map(({ workflow, appearAfter, changeAfter, goneAfter, ...r }) => ({ ...r, status: statusOf({ ...r, changeAfter }) }));
    return answer({ total_count: shown.length, workflow_runs: pageOf(shown, page) });
  }
  const comments = args[0] === 'api' ? /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '') : null;
  if (comments) {
    if (fixture.failComments) return refuse('gh: HTTP 502');
    return answer(pageOf(fixture.comments?.[comments[1]] ?? [], Number(comments[2])));
  }
  return refuse(`gh stand-in: unexpected call: ${args.join(' ')}`);
}

main();

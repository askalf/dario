// A stand-in for gh, for test/drift-heal-e2e.mjs. It answers the calls drift-pr-heal.yml's Heal step
// makes, from the fixture in HEAL_FIXTURE, and logs each call with the token it carried:
//   gh pr list ... --json ...
//        -> fixture.prs; from the second call on, fixture.prsLater when the fixture has it.
//   gh api repos/<o>/<r>/actions/workflows/<wf>/runs?status=<s>&per_page=100&page=<p>
//        -> { workflow_runs }: the fixture.runs of <wf> with that status, 100 a page. A run is
//           shown once <wf> and <s> have been listed `appearAfter` times (default 1). A workflow
//           named in fixture.failRuns fails.
//   gh api repos/<o>/<r>/actions/workflows/<wf>/runs?head_sha=<h>&per_page=100&page=<p>
//        -> the fixture.runs of <wf> at that head, any status, counted under `<wf>|head`.
//   gh api repos/<o>/<r>/issues/<n>/comments?per_page=100&page=<p>
//        -> fixture.comments[n], 100 a page; fixture.failComments fails it.
// fixture.sideEffects run git when a list is read: { key: '<wf>|<status>', call: k, git: [...] }
// runs `git ...` on the k-th listing of that workflow and status (a branch moved mid-run).
// Anything else fails, so a call the step was not expected to make shows up in the test.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.HEAL_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.HEAL_GHLOG, `${JSON.stringify({ token: process.env.GH_TOKEN, args })}\n`);
const counts = existsSync(process.env.HEAL_COUNTS) ? JSON.parse(readFileSync(process.env.HEAL_COUNTS, 'utf8')) : {};
const bump = (key) => {
  counts[key] = (counts[key] ?? 0) + 1;
  writeFileSync(process.env.HEAL_COUNTS, JSON.stringify(counts));
  return counts[key];
};
const pageOf = (rows, page) => rows.slice((page - 1) * 100, page * 100);

if (args[0] === 'pr' && args[1] === 'list') {
  const n = bump('pr list');
  process.stdout.write(JSON.stringify(n >= 2 && fixture.prsLater ? fixture.prsLater : fixture.prs));
  process.exit(0);
}

const runs = args[0] === 'api' ? /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/?]+)\/runs\?(?:status=([a-z_]+)|head_sha=([0-9a-f]{40}))&per_page=100&page=(\d+)$/.exec(args[1] ?? '') : null;
if (runs) {
  const [, wf, status, headSha, page] = runs;
  const key = status ? `${wf}|${status}` : `${wf}|head`;
  const n = Number(page) === 1 ? bump(key) : (counts[key] ?? 1);
  for (const e of fixture.sideEffects ?? []) {
    if (e.key === key && e.call === n && Number(page) === 1) execFileSync('git', e.git, { stdio: 'ignore' });
  }
  if ((fixture.failRuns ?? []).includes(wf)) {
    process.stderr.write('gh: HTTP 502\n');
    process.exit(1);
  }
  const shown = (fixture.runs ?? [])
    .filter((r) => r.workflow === wf && (status ? r.status === status : r.head_sha === headSha) && (r.appearAfter ?? 1) <= n)
    .map(({ workflow, appearAfter, ...r }) => r);
  process.stdout.write(JSON.stringify({ total_count: shown.length, workflow_runs: pageOf(shown, Number(page)) }));
  process.exit(0);
}

const comments = args[0] === 'api' ? /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '') : null;
if (comments) {
  if (fixture.failComments) {
    process.stderr.write('gh: HTTP 502\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(pageOf(fixture.comments?.[comments[1]] ?? [], Number(comments[2]))));
  process.exit(0);
}

process.stderr.write(`gh stand-in: unexpected call: ${args.join(' ')}\n`);
process.exit(1);

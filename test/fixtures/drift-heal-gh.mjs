// A stand-in for gh, for test/drift-heal-e2e.mjs. It answers the two calls drift-pr-heal.yml's Heal
// step makes, from the fixture in HEAL_FIXTURE, and logs each call with the token it carried:
//   gh pr list ... --json ...                          -> fixture.prs
//   gh api repos/<o>/<r>/actions/workflows/<wf>/runs?per_page=100
//        -> { workflow_runs } of fixture.runs for <wf>, each shown once that workflow's list has
//           been read `appearAfter` times (default 1); a workflow named in fixture.failRuns fails.
// Anything else fails, so a call the step was not expected to make shows up in the test.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.HEAL_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.HEAL_GHLOG, `${JSON.stringify({ token: process.env.GH_TOKEN, args })}\n`);

if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(fixture.prs));
  process.exit(0);
}

const runs = args[0] === 'api' ? /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs\?per_page=100$/.exec(args[1] ?? '') : null;
if (runs) {
  const wf = runs[1];
  const counts = existsSync(process.env.HEAL_COUNTS) ? JSON.parse(readFileSync(process.env.HEAL_COUNTS, 'utf8')) : {};
  counts[wf] = (counts[wf] ?? 0) + 1;
  writeFileSync(process.env.HEAL_COUNTS, JSON.stringify(counts));
  if ((fixture.failRuns ?? []).includes(wf)) {
    process.stderr.write('gh: HTTP 502\n');
    process.exit(1);
  }
  const shown = (fixture.runs ?? [])
    .filter((r) => r.workflow === wf && (r.appearAfter ?? 1) <= counts[wf])
    .map(({ workflow, appearAfter, ...r }) => r);
  process.stdout.write(JSON.stringify({ total_count: shown.length, workflow_runs: shown }));
  process.exit(0);
}

process.stderr.write(`gh stand-in: unexpected call: ${args.join(' ')}\n`);
process.exit(1);

#!/usr/bin/env node
/**
 * Which drift PRs drift-pr-heal.yml leaves alone this pass: those whose head Redline is reviewing,
 * fixing or posting a verdict on. A heal moves the head, and a run still working on the old head
 * would finish with nothing to show for it. This is best effort: the dispatcher can start a run
 * after the last check and before the push, and nothing here can stop that.
 *
 *   node scripts/drift-heal-busy.mjs plan  <repo> <candidates.json> <runs.json>
 *     candidates: [{ number, head_sha, version }]. Prints { "busy": { "<number>": "<why>" },
 *     "floor": "<version>" }: the busy PRs, and the highest version a busy PR holds ("" when none),
 *     which the healer reserves before it numbers any other PR, so a later PR is never given it.
 *   node scripts/drift-heal-busy.mjs check <repo> <pr> <head_sha> <runs.json>
 *     Prints why that PR is busy, or nothing.
 *
 * runs.json is the queued and running runs of the three Redline workflows, each
 * { id, path, display_title, head_sha, event, status }, or null when they could not be listed. A run's
 * head_sha is the commit it executes, which for a dispatched run is the default branch, not the PR:
 * a review or fix dispatched for a PR is matched by the "<repo>#<pr> @ <sha>" its run-name carries,
 * and a review the PR's own push started by its head. A verdict post runs on the default branch
 * after a review and its run does not say which PR it posts to, so any post running counts.
 */

export const REDLINE_WORKFLOWS = [
  '.github/workflows/redline.yml',
  '.github/workflows/redline-fix.yml',
  '.github/workflows/redline-post.yml',
];

/** Why the PR is busy, or '' when it is not. Pure. */
export function busyReason(repo, pr, headSha, runs) {
  if (!Array.isArray(runs)) return 'the Redline runs could not be listed';
  const named = `${repo}#${pr} @ `;
  for (const r of runs) {
    const path = String(r?.path ?? '');
    if (!REDLINE_WORKFLOWS.includes(path)) continue;
    const state = String(r?.status ?? 'active');
    if (path.endsWith('/redline-post.yml')) return `a Redline verdict post (run ${r?.id}) is ${state}, and its run does not say which PR it posts to`;
    const title = String(r?.display_title ?? '');
    if (title.includes(named)) return `"${title}" (run ${r?.id}) is ${state}`;
    if (r?.event === 'pull_request' && headSha && r?.head_sha === headSha) return `the Redline review of ${headSha.slice(0, 7)} (run ${r?.id}) is ${state}`;
  }
  return '';
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The higher of two x.y.z versions. Pure. */
function higher(a, b) {
  const pa = VERSION.exec(a).slice(1).map(Number);
  const pb = VERSION.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? a : b;
  return a;
}

/** The busy PRs among `candidates` and the highest version they hold. Order of candidates does not matter. Pure. */
export function plan(repo, candidates, runs) {
  const busy = {};
  let floor = '';
  for (const c of candidates ?? []) {
    const why = busyReason(repo, c?.number, c?.head_sha, runs);
    if (!why) continue;
    busy[String(c.number)] = why;
    const v = String(c?.version ?? '');
    if (VERSION.test(v)) floor = floor ? higher(floor, v) : v;
  }
  return { busy, floor };
}

async function main(argv) {
  const { readFileSync } = await import('node:fs');
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const [cmd, ...rest] = argv;
  if (cmd === 'plan' && rest.length === 3) {
    const [repo, candidates, runs] = rest;
    process.stdout.write(`${JSON.stringify(plan(repo, json(candidates), json(runs)))}\n`);
    return 0;
  }
  if (cmd === 'check' && rest.length === 4) {
    const [repo, pr, headSha, runs] = rest;
    const why = busyReason(repo, Number(pr), headSha, json(runs));
    if (why) process.stdout.write(`${why}\n`);
    return 0;
  }
  process.stderr.write('usage: drift-heal-busy.mjs plan <repo> <candidates.json> <runs.json> | check <repo> <pr> <head_sha> <runs.json>\n');
  return 2;
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main(process.argv.slice(2)));
}

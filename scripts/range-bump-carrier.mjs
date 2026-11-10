#!/usr/bin/env node
/**
 * One release for a Claude Code version whose prompt or tools changed.
 *
 * A new Claude Code version used to ship as two dario releases half an hour
 * apart: cc-drift-watch.yml moved SUPPORTED_CC_RANGE.maxTested, and once that
 * merge had brought the self-hosted runner up to the new version,
 * cc-drift-template-watch.yml found the bundled template out of step and
 * shipped a rebake. Now cc-drift-watch.yml asks the template watcher first:
 * it dispatches it for the new version, waits for that run, and drafts its own
 * PR only when no rebake PR came out of it. A rebake PR captured from the new
 * version moves maxTested itself (scripts/rebake-release-prep.mjs), so one PR
 * and one release carry both.
 *
 * Every way this can fail to find a rebake PR ends in the PR cc-drift-watch
 * drafted before this file existed: no dispatch, a run that never shows up, a
 * run that is still going at the deadline, an upstream check with no verdict.
 *
 *   node scripts/range-bump-carrier.mjs find <X.Y.Z>
 *   node scripts/range-bump-carrier.mjs await <X.Y.Z> <since ISO time> [seconds]
 *
 * Both print one JSON object and exit 0. `find`: {"carried":bool,"pr":N|null}.
 * `await`: {"found":bool,"completed":bool,"conclusion":string|null,"run":id|null}.
 * A usage error exits 2.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { isOlderThan } from './_drift-patch-helpers.mjs';

export const TEMPLATE_WATCH = 'cc-drift-template-watch.yml';
export const REBAKE_HEAD = /^bot\/template-rebake-/;
/** Where maxTested lives; the file a rebake PR changes to carry the bump. */
export const RANGE_FILE = 'src/live-fingerprint.ts';

export const isPlainVersion = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

/**
 * The run name cc-drift-template-watch.yml takes when it is dispatched for a
 * Claude Code version. The workflow's `run-name` writes the same words, and
 * test/range-bump-carrier.mjs holds the two together.
 */
export const runTitleFor = (ccVersion) => `CC template drift watch for Claude Code ${ccVersion}`;

/** SUPPORTED_CC_RANGE.maxTested as written in the source text, or null. */
export function maxTestedOf(source) {
  const m = /\bmaxTested\s*:\s*['"]([^'"]+)['"]/.exec(typeof source === 'string' ? source : '');
  return m && isPlainVersion(m[1]) ? m[1] : null;
}

/** True when source text claims `ccVersion` or a newer one as tested. */
export function carriesRange(source, ccVersion) {
  const claimed = maxTestedOf(source);
  return claimed !== null && isPlainVersion(ccVersion) && !isOlderThan(claimed, ccVersion);
}

/**
 * The open rebake PR that carries the bump to `ccVersion`: the lowest-numbered
 * one from this repository on a rebake branch whose head claims the version.
 * `sourceAt(pr)` returns the range file's text at that PR's head, or null when
 * it cannot be read, which counts as not carrying.
 */
export async function pickCarrier(prs, sourceAt, ccVersion) {
  const mine = (Array.isArray(prs) ? prs : [])
    .filter((p) => p && p.isCrossRepository === false && REBAKE_HEAD.test(String(p.headRefName ?? '')))
    .sort((a, b) => a.number - b.number);
  for (const pr of mine) {
    let text = null;
    try { text = await sourceAt(pr); } catch { text = null; }
    if (carriesRange(text, ccVersion)) return pr.number;
  }
  return null;
}

/**
 * The template watcher run dispatched for `ccVersion` at or after `sinceMs`:
 * the oldest such run, since a later one with the same name is someone else's
 * dispatch. Runs without the version in their name (the hourly ones) are not
 * ours: they do not bring the runner up to the version.
 */
export function runFor(runs, ccVersion, sinceMs) {
  const title = runTitleFor(ccVersion);
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.displayTitle === title && Date.parse(r.createdAt) >= sinceMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

/**
 * Poll for the dispatched run until it completes or `timeoutMs` passes.
 * `listRuns()` returns the watcher's recent runs; a call that throws is one
 * missed poll, not a failure.
 */
export async function awaitRun({ listRuns, ccVersion, sinceMs, timeoutMs, intervalMs, sleep, now = Date.now }) {
  const deadline = now() + timeoutMs;
  let run = null;
  for (;;) {
    try { run = runFor(await listRuns(), ccVersion, sinceMs) ?? run; } catch { /* next poll */ }
    if (run && run.status === 'completed') {
      return { found: true, completed: true, conclusion: run.conclusion ?? null, run: run.databaseId ?? null };
    }
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return { found: run !== null, completed: false, conclusion: null, run: run?.databaseId ?? null };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

async function main(argv) {
  const [cmd, ccVersion, ...rest] = argv;
  const repo = process.env.GITHUB_REPOSITORY;
  const usage = () => {
    process.stderr.write('usage: range-bump-carrier.mjs find <X.Y.Z> | await <X.Y.Z> <since ISO time> [seconds]\n');
    process.exit(2);
  };
  if (!isPlainVersion(ccVersion) || !repo) usage();

  if (cmd === 'find') {
    const prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--search', 'head:bot/template-rebake-',
      '--json', 'number,headRefName,headRefOid,isCrossRepository']));
    const sourceAt = (pr) => gh(['api', `repos/${repo}/contents/${RANGE_FILE}?ref=${pr.headRefOid}`,
      '-H', 'Accept: application/vnd.github.raw']);
    const pr = await pickCarrier(prs, sourceAt, ccVersion);
    process.stdout.write(JSON.stringify({ carried: pr !== null, pr }) + '\n');
    return;
  }
  if (cmd === 'await') {
    const sinceMs = Date.parse(rest[0] ?? '');
    const seconds = rest[1] === undefined ? 600 : Number(rest[1]);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(seconds) || seconds <= 0) usage();
    const result = await awaitRun({
      listRuns: () => JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', TEMPLATE_WATCH, '--event', 'workflow_dispatch',
        '--limit', '10', '--json', 'databaseId,displayTitle,status,conclusion,createdAt'])),
      ccVersion,
      sinceMs,
      timeoutMs: seconds * 1000,
      intervalMs: 20_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  usage();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}

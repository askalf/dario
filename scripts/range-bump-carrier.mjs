#!/usr/bin/env node
/**
 * The decisions behind "a template rebake carries the maxTested bump".
 *
 * cc-drift-watch.yml dispatches cc-drift-template-watch.yml for a new Claude
 * Code version before it drafts a maxTested bump, and drafts nothing when a
 * rebake PR carries the bump (docs/drift-monitor.md, "One release for a new
 * Claude Code version"). This file holds what the two workflows decide:
 *
 *   find         which open rebake PR, if any, claims the version as tested
 *   await        the state of the template watcher run dispatched for it
 *   pick-binary  which installed `claude` reports exactly that version
 *   may-carry    whether a rebake may move maxTested itself
 *
 * Each answer that cannot be established is the conservative one: no carrier,
 * no run, no binary, do not carry. In every such case cc-drift-watch.yml
 * drafts the bump itself, as it does when no rebake is needed.
 *
 *   node scripts/range-bump-carrier.mjs find <X.Y.Z>
 *   node scripts/range-bump-carrier.mjs await <X.Y.Z> <since ISO time> [seconds]
 *   node scripts/range-bump-carrier.mjs pick-binary <X.Y.Z> <path>...
 *   node scripts/range-bump-carrier.mjs may-carry
 *
 * `find` prints {"carried":bool,"pr":N|null}; `await` prints
 * {"found":bool,"completed":bool,"conclusion":string|null,"run":id|null};
 * `pick-binary` prints the path, or nothing; `may-carry` prints
 * {"carry":bool,"reason":string} from RANGE_PR_OPEN, UPSTREAM, WIRE_EXIT,
 * WIRE_REPORT (a file) and BAKED_VERSION in the environment. All exit 0; a
 * usage error exits 2.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isOlderThan } from './_drift-patch-helpers.mjs';

export const TEMPLATE_WATCH = 'cc-drift-template-watch.yml';
export const REBAKE_HEAD = /^bot\/template-rebake-/;
/** Where maxTested lives; the file a rebake PR changes to carry the bump. */
export const RANGE_FILE = 'src/live-fingerprint.ts';
/**
 * The label and title prefix of a wire-drift report (wire-drift-self-hosted.yml
 * files it, and the template watcher does when its own check fails). The merge
 * gate holds every rebake while one is open, whatever this run's check found.
 */
export const WIRE_DRIFT_LABEL = 'cc-drift';
export const WIRE_DRIFT_TITLE_PREFIX = 'Wire drift detected';

/** A bare x.y.z and nothing after it: no suffix, no whitespace, no trailing newline. */
export const isPlainVersion = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+(?![\s\S])/.test(v);

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

/**
 * The first of `paths` whose `claude` reports exactly `wanted`, or null.
 *
 * The self-hosted runner holds more than one install: the system one and a
 * copy under the tool-cache Node that actions/setup-node puts first on PATH.
 * They can be versions apart. A run dispatched for a version has to capture,
 * bake and check wire drift with one binary, and it has to be the one at that
 * version, so the binary is chosen by what it reports and not by PATH order.
 * `versionOf(path)` returns the version a path reports, or null (missing, not
 * runnable). Empty and repeated paths are skipped.
 */
export function pickBinary(paths, versionOf, wanted) {
  if (!isPlainVersion(wanted)) return null;
  const seen = new Set();
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || p === '' || seen.has(p)) continue;
    seen.add(p);
    let v = null;
    try { v = versionOf(p); } catch { v = null; }
    if (v === wanted) return p;
  }
  return null;
}

/** The Claude Code version a wire-drift report measured, or null. The report may follow log lines. */
export function wireVersionOf(reportText) {
  if (typeof reportText !== 'string') return null;
  const at = reportText.search(/^\{/m);
  try {
    const v = JSON.parse(reportText.slice(at < 0 ? 0 : at)).ccVersion;
    return isPlainVersion(v) ? v : null;
  } catch {
    return null;
  }
}

/** How many open issues are wire-drift reports. Pull requests listed among issues are not. */
export function openWireIssueCount(issues) {
  if (!Array.isArray(issues)) return null;
  return issues.filter((i) => i && i.pull_request == null && String(i.title ?? '').startsWith(WIRE_DRIFT_TITLE_PREFIX)).length;
}

/**
 * Whether a rebake may move maxTested itself (rebake-release-prep.mjs
 * --carry-range). A carrying rebake is the only PR for the bump, so it has to
 * be one that merges unattended, and the claim it makes has to be about the
 * version that was measured:
 *
 *   - no PR of cc-drift-watch.yml's own is open for a bump;
 *   - upstream accepted requests rebuilt from the bundle;
 *   - the wire-drift check passed, on the same Claude Code version the bundle
 *     was captured from (two installs on the runner can differ);
 *   - no wire-drift issue is open, since the merge gate holds a rebake for an
 *     open one even when this run's check is clean.
 *
 * Anything unread or unknown counts against carrying. Pure.
 */
export function mayCarry({ rangePrOpen, upstream, wireExit, wireVersion, bakedVersion, openWireIssues }) {
  const no = (reason) => ({ carry: false, reason });
  if (rangePrOpen !== false) return no('a CC version PR is open (or could not be listed) and moves maxTested itself');
  if (upstream !== 'pass') return no(`the upstream check did not pass (${upstream || 'no verdict'}), so this rebake waits for a person`);
  if (wireExit !== 0) return no(`the wire-drift check failed (exit ${wireExit}), so this rebake waits for its issue to close`);
  if (!isPlainVersion(bakedVersion)) return no('the bundle does not name the Claude Code version it was captured from');
  if (wireVersion !== bakedVersion) {
    return no(`the wire-drift check measured Claude Code ${wireVersion ?? 'an unknown version'}, not the ${bakedVersion} the bundle was captured from`);
  }
  if (openWireIssues !== 0) {
    return no(openWireIssues === null
      ? 'the open wire-drift issues could not be read'
      : `${openWireIssues} wire-drift issue${openWireIssues === 1 ? ' is' : 's are'} open, and the merge gate holds a rebake until none is`);
  }
  return { carry: true, reason: `upstream and wire drift are clean for Claude Code ${bakedVersion}, and no other PR moves maxTested` };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/** The version `<path> --version` prints first ("2.1.323 (Claude Code)"), or null. */
function reportedVersion(path) {
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
    const first = out.trim().split(/\s+/)[0];
    return isPlainVersion(first) ? first : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const repo = process.env.GITHUB_REPOSITORY;
  const usage = () => {
    process.stderr.write('usage: range-bump-carrier.mjs find <X.Y.Z> | await <X.Y.Z> <since ISO time> [seconds] | pick-binary <X.Y.Z> <path>... | may-carry\n');
    process.exit(2);
  };

  if (cmd === 'may-carry') {
    const env = process.env;
    let reportText = null;
    try { reportText = readFileSync(env.WIRE_REPORT ?? '', 'utf-8'); } catch { reportText = null; }
    let openWireIssues = null;
    if (repo) {
      try {
        openWireIssues = openWireIssueCount(JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', WIRE_DRIFT_LABEL,
          '--state', 'open', '--limit', '100', '--json', 'title'])));
      } catch {
        openWireIssues = null;
      }
    }
    const wireExit = /^\d+$/.test(env.WIRE_EXIT ?? '') ? Number(env.WIRE_EXIT) : null;
    process.stdout.write(JSON.stringify(mayCarry({
      // The workflow step writes 'true' or nothing; anything else is unknown.
      rangePrOpen: env.RANGE_PR_OPEN === '' ? false : env.RANGE_PR_OPEN === 'true' ? true : null,
      upstream: env.UPSTREAM ?? '',
      wireExit,
      wireVersion: wireVersionOf(reportText),
      bakedVersion: env.BAKED_VERSION ?? '',
      openWireIssues,
    })) + '\n');
    return;
  }

  const ccVersion = rest.shift();
  if (!isPlainVersion(ccVersion)) usage();

  if (cmd === 'pick-binary') {
    const bin = pickBinary(rest, reportedVersion, ccVersion);
    if (bin !== null) process.stdout.write(bin + '\n');
    return;
  }

  if (!repo) usage();
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

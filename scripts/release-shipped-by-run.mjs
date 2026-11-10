#!/usr/bin/env node
/**
 * Which release, if any, a run of cc-drift-auto-release.yml published.
 *
 * homebrew-tap-notify.yml runs after every successful run of the release
 * workflow, and most of those runs release nothing: the workflow fires on
 * every push to master and hourly, and its gate exits when the version is
 * already shipped. The tap is told only about a release the run published,
 * and the run's own outputs are not readable from another workflow, so the
 * release is recognised by when it was published: at or after the run
 * started, and no later than it ended.
 *
 * A run that only finished a release an earlier run began (the GitHub release
 * existed, npm or GHCR did not) published no release, so it is not announced
 * here. The tap finds that version on its own six-hourly schedule.
 *
 *   RUN_STARTED=<ISO> RUN_ENDED=<ISO> node scripts/release-shipped-by-run.mjs
 *
 * Reads the repository's newest releases with `gh` (GITHUB_REPOSITORY,
 * GH_TOKEN). Prints the version (x.y.z) and exits 0, or prints nothing and
 * exits 0 when the run published none. A usage error or a failed listing
 * exits 1: the caller then announces nothing.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Slack for clocks: the release is stamped by GitHub, the run by the Actions service. */
export const SKEW_MS = 60_000;

const TAG = /^v(\d+\.\d+\.\d+)(?![\s\S])/;

/**
 * The version of the release published inside the run's window, or null.
 * Drafts, pre-releases and tags that are not vX.Y.Z are not announced. With
 * two releases inside one window (two runs cannot overlap, so this would be a
 * release cut by hand during the run) the newest is taken.
 */
export function shippedBy(releases, runStartedAt, runEndedAt, skewMs = SKEW_MS) {
  const from = Date.parse(runStartedAt ?? '');
  const to = Date.parse(runEndedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const inWindow = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && r.draft !== true && r.prerelease !== true && TAG.test(String(r.tag_name ?? '')))
    .map((r) => ({ version: TAG.exec(r.tag_name)[1], at: Date.parse(r.published_at ?? '') }))
    .filter((r) => Number.isFinite(r.at) && r.at >= from - skewMs && r.at <= to + skewMs)
    .sort((a, b) => b.at - a.at);
  return inWindow[0]?.version ?? null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { GITHUB_REPOSITORY: repo, RUN_STARTED: started, RUN_ENDED: ended } = process.env;
  if (!repo || !Number.isFinite(Date.parse(started ?? '')) || !Number.isFinite(Date.parse(ended ?? ''))) {
    process.stderr.write('usage: RUN_STARTED=<ISO> RUN_ENDED=<ISO> GITHUB_REPOSITORY=<owner/repo> release-shipped-by-run.mjs\n');
    process.exit(1);
  }
  let releases;
  try {
    releases = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases?per_page=10`], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    process.stderr.write(`could not list releases: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}\n`);
    process.exit(1);
  }
  const version = shippedBy(releases, started, ended);
  if (version !== null) process.stdout.write(version + '\n');
}

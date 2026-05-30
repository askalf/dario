#!/usr/bin/env node
/**
 * Claude Agent SDK drift watcher — cheap, metadata-only.
 *
 * Fetches @anthropic-ai/claude-agent-sdk metadata from npm (no download) and
 * compares three upstream signals against what dario's bundled template is
 * pinned to:
 *
 *   1. Agent SDK version — tracks the CC-parity cadence (e.g. 0.2.114 ↔ CC 2.1.114)
 *   2. Stainless low-level SDK version — the `@anthropic-ai/sdk` dep, whose
 *      version ends up on the wire as `x-stainless-package-version`
 *   3. CC version string the Agent SDK's major mirrors
 *
 * Complements scripts/check-cc-drift.mjs (which downloads the ~235MB native
 * binary and scans it). This check runs in seconds on metadata alone and is
 * suitable for high-frequency signals or pre-release gating where downloading
 * the full CC binary is too heavy.
 *
 * Exit codes: 0 = aligned, 1 = drift (stale pinned constants), 2 = infra
 * error — npm registry/network failed after retries, so drift could not be
 * determined. The workflow treats exit 2 as a skipped run (warn + pass),
 * never as drift, so a flaky registry doesn't page or churn the drift issue.
 * JSON report to stdout in all cases.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** Raised when npm metadata can't be fetched or parsed after retries — an
 *  infra/registry problem, NOT drift. Caught in run() → exit 2. */
class InfraError extends Error {}

/** Synchronous sleep — we're in a sync execSync flow, no event loop to await. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Shell out with a few retries to ride out transient npm-registry blips
 *  (5xx, rate-limit, DNS). Throws InfraError only after every attempt fails. */
function sh(cmd, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) sleepSync(400 * (i + 1));
    }
  }
  throw new InfraError(`\`${cmd}\` failed after ${attempts} attempts: ${(lastErr && (lastErr.stderr || lastErr.message)) || lastErr}`);
}

function npmView(pkg, field) {
  // `npm view <pkg> <field> --json` prints NOTHING (empty stdout) when the
  // field is absent — e.g. @anthropic-ai/claude-agent-sdk@0.3.x bundles its
  // deps and exposes no top-level `dependencies`. JSON.parse('') would throw
  // "Unexpected end of JSON input", so treat empty as "field not present".
  const out = sh(`npm view ${pkg} ${field} --json`);
  if (!out) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    // Non-empty but unparseable = npm returned garbage (a proxy's partial/HTML
    // error page, say). That's infra, not drift.
    throw new InfraError(`npm view ${pkg} ${field} returned non-JSON output`);
  }
}

function loadBundled() {
  return JSON.parse(readFileSync(join(ROOT, 'src/cc-template-data.json'), 'utf-8'));
}

function run() {
  const bundled = loadBundled();
  const bundledStainless = bundled.header_values?.['x-stainless-package-version'];
  const bundledUa = bundled.header_values?.['user-agent'];
  const bundledCcVersion = bundled._version;

  let agentSdkVersion, agentSdkDeps, ccVersion;
  try {
    agentSdkVersion = npmView('@anthropic-ai/claude-agent-sdk', 'version');
    agentSdkDeps = npmView('@anthropic-ai/claude-agent-sdk', 'dependencies');
    ccVersion = npmView('@anthropic-ai/claude-code', 'version');
  } catch (err) {
    if (err instanceof InfraError) {
      // Registry/network problem — emit a valid JSON report and exit 2 so the
      // workflow skips this run (warn + pass) instead of paging or churning
      // the drift issue. See the exit-code contract in the header.
      console.log(JSON.stringify({
        checkedAt: new Date().toISOString(),
        status: 'infra_error',
        error: String(err.message),
      }, null, 2));
      process.exit(2);
    }
    throw err;
  }
  const stainlessRange = agentSdkDeps?.['@anthropic-ai/sdk'];
  const upstreamStainless = stainlessRange ? String(stainlessRange).replace(/^[\^~>=\s]+/, '') : null;

  const drift = [];

  if (ccVersion && bundledCcVersion && ccVersion !== bundledCcVersion) {
    drift.push({
      field: 'cc_version',
      bundled: bundledCcVersion,
      upstream: ccVersion,
      source: '@anthropic-ai/claude-code@latest',
    });
  }

  if (upstreamStainless && bundledStainless && upstreamStainless !== bundledStainless) {
    drift.push({
      field: 'x-stainless-package-version',
      bundled: bundledStainless,
      upstream: upstreamStainless,
      source: `@anthropic-ai/claude-agent-sdk@${agentSdkVersion}.dependencies[@anthropic-ai/sdk]`,
    });
  }

  const report = {
    checkedAt: new Date().toISOString(),
    bundled: {
      cc_version: bundledCcVersion,
      stainless: bundledStainless,
      user_agent: bundledUa,
    },
    upstream: {
      cc_version: ccVersion,
      agent_sdk_version: agentSdkVersion,
      stainless_dep: upstreamStainless,
    },
    drift,
    status: drift.length === 0 ? 'clean' : 'drift',
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(drift.length === 0 ? 0 : 1);
}

run();

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
 * Exits 1 on any drift (stale pinned constants) and 0 when everything aligns.
 * JSON report to stdout.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function npmView(pkg, field) {
  const out = execSync(`npm view ${pkg} ${field} --json`, { encoding: 'utf-8' });
  return JSON.parse(out);
}

function loadBundled() {
  return JSON.parse(readFileSync(join(ROOT, 'src/cc-template-data.json'), 'utf-8'));
}

function run() {
  const bundled = loadBundled();
  const bundledStainless = bundled.header_values?.['x-stainless-package-version'];
  const bundledUa = bundled.header_values?.['user-agent'];
  const bundledCcVersion = bundled._version;

  const agentSdkVersion = npmView('@anthropic-ai/claude-agent-sdk', 'version');
  const agentSdkDeps = npmView('@anthropic-ai/claude-agent-sdk', 'dependencies');
  const stainlessRange = agentSdkDeps?.['@anthropic-ai/sdk'];
  const upstreamStainless = stainlessRange ? String(stainlessRange).replace(/^[\^~>=\s]+/, '') : null;
  const ccVersion = npmView('@anthropic-ai/claude-code', 'version');

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

#!/usr/bin/env node
/**
 * Capture a fresh template from the user's installed CC, scrub it, and
 * write it to `src/cc-template-data.json` as the bundled fallback.
 *
 * Only run this from the dario repo on a maintainer's own machine — the
 * scrubber strips host-identifying data before bake, but the raw capture
 * does pass through the capturing user's CC install.
 *
 * Usage:
 *   npm run build          # the script imports from dist/
 *   node scripts/capture-and-bake.mjs              # capture + scrub + write
 *   node scripts/capture-and-bake.mjs --check      # capture + diff; exit 2 on shape drift, 3 on label-only drift, 0 on full match
 *
 * The --check mode is non-destructive: it captures + scrubs but does not
 * write to disk. Useful from a scheduled cron (see docs/drift-monitor.md)
 * to detect same-binary remote-config drift — the class of change
 * documented in v4.2.1's CHANGELOG entry where CC's wire output shifts
 * within a single npm version. On non-zero exit, the wrapping cron / CI
 * step can open an issue or auto-PR a re-bake.
 *
 * Exits:
 *   0 — capture succeeded; in default mode wrote OUT; in --check mode, full match
 *       (wire shape AND _version label both current)
 *   1 — infrastructure failure (CC not on PATH, capture timeout, scrub failure)
 *   2 — --check mode only: wire-SHAPE drift vs current OUT (tools / system_prompt /
 *       beta / field order changed — needs a real re-bake; human-reviewed)
 *   3 — --check mode only: LABEL-only drift — wire shape matches but the bundled
 *       `_version` lags the live CC version. computeDrift ignores `_version` (its
 *       job is within-version shape drift), so this slips past exit 2, yet
 *       sdk-drift-watch.yml flags it against npm. Distinct code so the workflow
 *       can ship a deterministic label bump (scripts/label-sync.mjs) instead of
 *       waiting for a shape rebake to happen to ride along. On exit 3 the live
 *       version is written to `label-target.txt` for the workflow to consume.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureLiveTemplateAsync, findInstalledCC } from '../dist/live-fingerprint.js';
import { scrubTemplate, findUserPathHits } from '../dist/scrub-template.js';
import { PLATFORM_ONLY_TOOLS } from '../dist/cc-template.js';
import { computeDrift, formatDriftReport, interpretDrift, formatDriftSummary, stripModelConditionalBetas } from './drift-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const OUT = join(repoRoot, 'src/cc-template-data.json');

const CHECK_MODE = process.argv.includes('--check');

function log(msg) {
  console.error(`[bake] ${msg}`);
}

const { path: ccPath, version: ccVersion } = findInstalledCC();
if (!ccPath) {
  log('error: no `claude` binary on PATH. Install @anthropic-ai/claude-code before running bake.');
  process.exit(1);
}
log(`using CC at ${ccPath} (version ${ccVersion ?? 'unknown'})${CHECK_MODE ? ' [--check mode: dry-run]' : ''}`);

log('spawning CC against loopback MITM to capture /v1/messages...');
const captured = await captureLiveTemplateAsync(20_000);
if (!captured) {
  log('error: capture timed out or CC did not send a /v1/messages request within 20s.');
  process.exit(1);
}

log(`captured: CC v${captured._version}, ${captured.tools.length} tools, ${captured.system_prompt.length} char system prompt`);

const scrubbed = scrubTemplate(captured);
// Strip the model-conditional betas betaForModel() appends per-request
// (context-1m on [1m] requests, fallback-credit on fable) so the baked BASE set
// matches #475's design — they're re-added per-request at runtime, not part of
// the canonical base. Without this, a capture that rode one (the drift runner's
// capture carries context-1m) would re-introduce it to the base on every rebake,
// undoing #475. Same set the drift detector ignores (drift-report.mjs).
const beforeBeta = scrubbed.anthropic_beta || '';
scrubbed.anthropic_beta = stripModelConditionalBetas(beforeBeta);
if (scrubbed.anthropic_beta !== beforeBeta) {
  log(`stripped model-conditional beta(s) from baked base: ${beforeBeta} → ${scrubbed.anthropic_beta}`);
}
scrubbed._source = 'bundled';
scrubbed._supportedMaxTested = captured._version;

const residualHits = findUserPathHits(JSON.stringify(scrubbed));
if (residualHits.length > 0) {
  log(`error: scrub left residual user paths in the serialized template:`);
  for (const h of residualHits.slice(0, 10)) log(`  - ${h}`);
  process.exit(1);
}

const droppedMcp = captured.tools.length - scrubbed.tools.length;
const strippedAutoMemory = captured.system_prompt.includes('# auto memory') && !scrubbed.system_prompt.includes('# auto memory');

log(`scrubbed:`);
log(`  tools: ${captured.tools.length} → ${scrubbed.tools.length} (dropped ${droppedMcp} mcp__* tool${droppedMcp === 1 ? '' : 's'})`);
log(`  system_prompt: ${captured.system_prompt.length} → ${scrubbed.system_prompt.length} chars${strippedAutoMemory ? ' (# auto memory section removed)' : ''}`);

const prev = JSON.parse(readFileSync(OUT, 'utf-8'));

// Preserve other-platform tools from the previous bundle so the baked file
// remains a union across maintainers' platforms. A bake on Linux must not
// drop Windows-only tools (e.g. PowerShell) or vice versa — the bundled
// JSON is filtered down to per-platform at request time by
// filterToolsForPlatform(); the bundle itself must remain a superset.
const currentPlat = process.platform;
const scrubbedNames = new Set(scrubbed.tools.map((t) => t.name));
const preservedOtherPlatTools = (prev.tools || []).filter((t) => {
  if (scrubbedNames.has(t.name)) return false;
  for (const [plat, names] of Object.entries(PLATFORM_ONLY_TOOLS)) {
    if (names.has(t.name) && plat !== currentPlat) return true;
  }
  return false;
});
if (preservedOtherPlatTools.length > 0) {
  log(`preserved ${preservedOtherPlatTools.length} other-platform tool${preservedOtherPlatTools.length === 1 ? '' : 's'} from previous bundle: ${preservedOtherPlatTools.map((t) => t.name).join(', ')}`);
  // CC sends tools alphabetically by name — sort after merge so the preserved
  // tools insert at their natural position rather than appending at the end.
  scrubbed.tools = [...scrubbed.tools, ...preservedOtherPlatTools].sort((a, b) => a.name.localeCompare(b.name));
}
log(`previous baked template: CC v${prev._version} captured ${prev._captured}, ${prev.tools.length} tools, ${prev.system_prompt.length} char system prompt`);

// ── --check mode: diff and exit; do not write ────────────────────────
if (CHECK_MODE) {
  const diff = computeDrift(prev, scrubbed);
  if (diff.length === 0) {
    // Wire shape matches. But the bundled _version LABEL may still lag the
    // live CC version: computeDrift intentionally ignores _version (its job
    // is to catch within-version SHAPE drift), so a stale label reads as
    // "no drift" here — yet sdk-drift-watch.yml, which compares _version
    // against npm's claude-code@latest, flags it with nothing to re-bake.
    // Signal that label-only case distinctly (exit 3) so the workflow can
    // ship a deterministic label bump (scripts/label-sync.mjs). Safe to
    // auto-merge precisely because this empty diff PROVES the shape is
    // identical at the live version — only the label moves.
    if (prev._version !== captured._version) {
      log(`check: no wire-shape drift, but bundled _version (${prev._version}) lags live CC (${captured._version}) — label-only drift.`);
      writeFileSync(join(repoRoot, 'label-target.txt'), captured._version + '\n');
      process.exit(3);
    }
    log('check: no drift detected. Bundled template matches live capture.');
    process.exit(0);
  }
  // v4.7.0: lead with a one-line verdict + per-axis breakdown so the
  // workflow embedding this output (and any human reading the log)
  // sees the ship/investigate signal before the line-by-line detail.
  const interp = interpretDrift(diff);
  log(`check: drift detected — ${diff.length} differing slot${diff.length === 1 ? '' : 's'} (verdict: ${interp.verdict}):`);
  for (const line of formatDriftSummary(interp)) log(line);
  log('');
  log('check: per-slot detail:');
  for (const line of formatDriftReport(diff)) log(line);
  log('check: bundled template is stale relative to live CC. Run `node scripts/capture-and-bake.mjs` to re-bake.');

  // Also write a clean markdown summary file (v4.7.0) so the wrapping
  // workflow can drop the verdict into a PR body without grep-parsing
  // the [bake]-prefixed log output. Path is fixed and intentionally
  // colocated with where the workflow runs the script.
  const summaryPath = join(repoRoot, 'drift-summary.md');
  writeFileSync(summaryPath, formatDriftSummary(interp).join('\n') + '\n');
  log(`wrote drift-summary.md for workflow embedding`);

  process.exit(2);
}

// ── Default mode: write the new template ─────────────────────────────
writeFileSync(OUT, JSON.stringify(scrubbed, null, 2) + '\n');
log(`wrote ${OUT}`);
log(`summary: CC v${prev._version} → v${scrubbed._version}, tools ${prev.tools.length} → ${scrubbed.tools.length}, system_prompt ${prev.system_prompt.length} → ${scrubbed.system_prompt.length} chars`);


// `computeDrift` + `unifiedDiff` + `formatDriftReport` live in
// `./drift-report.mjs` so they can be unit-tested without importing this
// file (top-level `await captureLiveTemplateAsync` would block the test
// runner on a live CC capture). Imported above.

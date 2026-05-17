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
 *   node scripts/capture-and-bake.mjs --check      # capture + diff; exit 1 on drift, 0 on match
 *
 * The --check mode is non-destructive: it captures + scrubs but does not
 * write to disk. Useful from a scheduled cron (see docs/drift-monitor.md)
 * to detect same-binary remote-config drift — the class of change
 * documented in v4.2.1's CHANGELOG entry where CC's wire output shifts
 * within a single npm version. On non-zero exit, the wrapping cron / CI
 * step can open an issue or auto-PR a re-bake.
 *
 * Exits:
 *   0 — capture succeeded; in default mode wrote OUT; in --check mode, no drift detected
 *   1 — infrastructure failure (CC not on PATH, capture timeout, scrub failure)
 *   2 — --check mode only: drift detected vs current OUT (exit code distinct from
 *       infra failure so cron wrappers can treat them differently)
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureLiveTemplateAsync, findInstalledCC } from '../dist/live-fingerprint.js';
import { scrubTemplate, findUserPathHits } from '../dist/scrub-template.js';
import { PLATFORM_ONLY_TOOLS } from '../dist/cc-template.js';

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
    log('check: no drift detected. Bundled template matches live capture.');
    process.exit(0);
  }
  log(`check: drift detected — ${diff.length} differing slot${diff.length === 1 ? '' : 's'}:`);
  for (const item of diff) log(`  • ${item}`);
  log('check: bundled template is stale relative to live CC. Run `node scripts/capture-and-bake.mjs` to re-bake.');
  process.exit(2);
}

// ── Default mode: write the new template ─────────────────────────────
writeFileSync(OUT, JSON.stringify(scrubbed, null, 2) + '\n');
log(`wrote ${OUT}`);
log(`summary: CC v${prev._version} → v${scrubbed._version}, tools ${prev.tools.length} → ${scrubbed.tools.length}, system_prompt ${prev.system_prompt.length} → ${scrubbed.system_prompt.length} chars`);


/**
 * Compute the meaningful template drift between `prev` (current bundled)
 * and `now` (freshly captured + scrubbed). Returns an array of human-
 * readable diff strings; empty array = no drift.
 *
 * Intentionally ignores transient fields that always differ between runs:
 *   - `_captured` (timestamp)
 *   - `header_values['user-agent']` (varies by CC version string; replayed at runtime anyway)
 *   - `_version`, `_supportedMaxTested` (these are the version markers; the
 *     point of --check is to catch drift WITHIN the same version, so a
 *     version-string diff isn't itself drift — the wire shape changing IS)
 *
 * Catches drift in:
 *   - tools (added / removed by name)
 *   - anthropic_beta header value
 *   - system_prompt content (any character delta)
 *   - body_field_order
 *   - header_order
 *   - agent_identity content
 *
 * dario#XXX (v4.2.2 — same-binary remote-config drift detection).
 */
function computeDrift(prev, now) {
  const out = [];

  // tools — by name set
  const prevTools = new Set((prev.tools || []).map((t) => t.name));
  const nowTools = new Set((now.tools || []).map((t) => t.name));
  const addedTools = [...nowTools].filter((n) => !prevTools.has(n));
  const removedTools = [...prevTools].filter((n) => !nowTools.has(n));
  if (addedTools.length > 0) out.push(`tools added: ${addedTools.join(', ')}`);
  if (removedTools.length > 0) out.push(`tools removed: ${removedTools.join(', ')}`);

  // anthropic_beta — exact string match
  if ((prev.anthropic_beta || '') !== (now.anthropic_beta || '')) {
    const prevBetas = new Set((prev.anthropic_beta || '').split(',').filter(Boolean));
    const nowBetas = new Set((now.anthropic_beta || '').split(',').filter(Boolean));
    const addedB = [...nowBetas].filter((b) => !prevBetas.has(b));
    const removedB = [...prevBetas].filter((b) => !nowBetas.has(b));
    if (addedB.length > 0) out.push(`anthropic_beta added: ${addedB.join(', ')}`);
    if (removedB.length > 0) out.push(`anthropic_beta removed: ${removedB.join(', ')}`);
  }

  // system_prompt — content (length is a proxy for cheaper signal; full
  // string compare for definitive)
  if ((prev.system_prompt || '') !== (now.system_prompt || '')) {
    const delta = (now.system_prompt || '').length - (prev.system_prompt || '').length;
    out.push(`system_prompt content changed (${prev.system_prompt.length} → ${now.system_prompt.length} chars, delta ${delta >= 0 ? '+' : ''}${delta})`);
  }

  // body_field_order — array deep-equal
  if (JSON.stringify(prev.body_field_order || []) !== JSON.stringify(now.body_field_order || [])) {
    out.push(`body_field_order changed: ${JSON.stringify(prev.body_field_order)} → ${JSON.stringify(now.body_field_order)}`);
  }

  // header_order — array deep-equal
  if (JSON.stringify(prev.header_order || []) !== JSON.stringify(now.header_order || [])) {
    out.push(`header_order changed`);
  }

  // agent_identity — exact string
  if ((prev.agent_identity || '') !== (now.agent_identity || '')) {
    out.push(`agent_identity content changed (${prev.agent_identity?.length || 0} → ${now.agent_identity?.length || 0} chars)`);
  }

  return out;
}
